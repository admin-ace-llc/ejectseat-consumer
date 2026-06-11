// app/api/admin/backfill-active-layoffs/route.ts — EjectSeat Consumer v7
//
// ONE-OFF BACKFILL — populates active_layoffs_feed with companies that are
// CURRENTLY in active layoffs but whose triggering filing/news is older than
// the daily cron's ~26h lookback window (app/api/cron/discover-active-layoffs).
//
// Same discovery + scoring + upsert logic as the daily cron, but with a much
// wider, configurable lookback so it can catch things like a Salesforce 8-K
// from a few months ago that's still relevant today.
//
// USAGE (run once, then you can leave this route in place or delete it):
//   curl -H "Authorization: Bearer <CRON_SECRET>" \
//     "https://ejectseat.com/api/admin/backfill-active-layoffs?days=120"
//
// `days` controls both the EDGAR and media lookback windows (default 90,
// max 365 to keep runtime/cost sane). Same MAX_CANDIDATES_PER_RUN cap and
// CRON_SECRET auth as the daily cron — safe to re-run, upserts are
// idempotent (one row per company_name).
//
// NOTE: a wide lookback can surface MANY candidates. This route caps how
// many get scored per call (BACKFILL_MAX_CANDIDATES) and reports how many
// were skipped so you can re-run with a narrower window or just re-call it
// (already-scored companies within RESCORE_COOLDOWN_HOURS are skipped, same
// as the daily cron, so repeated calls make forward progress).

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { discoverActiveLayoffCandidates, DiscoveryCandidate } from '@/lib/signals/discovery';
import type { RiskScore, ScoreApiRequest } from '@/types';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// Higher than the daily cron's cap since this is a deliberate one-off run,
// but still bounded — each candidate is a full /api/score (Sonnet) call.
const BACKFILL_MAX_CANDIDATES = 25;

// Same cooldown as the daily cron — lets you re-run this safely without
// re-scoring companies it already just handled.
const RESCORE_COOLDOWN_HOURS = 22;

const DEFAULT_DAYS = 90;
const MAX_DAYS = 365;

function baseUrl(req: NextRequest): string {
  if (process.env.NEXT_PUBLIC_SITE_URL) return process.env.NEXT_PUBLIC_SITE_URL;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return req.nextUrl.origin;
}

async function recentlyScored(companyName: string): Promise<boolean> {
  const cutoff = new Date(Date.now() - RESCORE_COOLDOWN_HOURS * 3_600_000).toISOString();
  const { data, error } = await supabase
    .from('active_layoffs_feed')
    .select('id, scored_at')
    .ilike('company_name', companyName)
    .gte('scored_at', cutoff)
    .limit(1);
  if (error) {
    console.error('[backfill-active-layoffs] recentlyScored check failed:', error.message);
    return false;
  }
  return !!(data && data.length > 0);
}

async function scoreCandidate(req: NextRequest, candidate: DiscoveryCandidate): Promise<RiskScore | null> {
  try {
    const body: ScoreApiRequest = { companyName: candidate.companyName, ticker: candidate.ticker || undefined };
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 55_000);
    const res = await fetch(`${baseUrl(req)}/api/score`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(t);
    if (!res.ok) {
      console.error(`[backfill-active-layoffs] /api/score ${res.status} for ${candidate.companyName}`);
      return null;
    }
    const json = await res.json();
    // /api/score returns { risk: RiskScore, company: {...} } — unwrap.
    return (json?.risk ?? json) as RiskScore;
  } catch (err: any) {
    console.error(`[backfill-active-layoffs] scoring failed for ${candidate.companyName}:`, err?.message || err);
    return null;
  }
}

async function upsertFeedEntry(candidate: DiscoveryCandidate, score: RiskScore): Promise<boolean> {
  const state = score.companyState || 'WATCH';
  if (state !== 'LIKELY' && state !== 'ACTIVE') return false;

  const firstSignal = score.signals?.[0] as any;
  const firstEvent = (score as any).confirmedEvents?.[0] as any;
  const keySignal =
    firstSignal?.description ||
    firstSignal?.summary ||
    firstSignal?.label ||
    firstSignal?.text ||
    firstSignal?.title ||
    firstEvent?.description ||
    firstEvent?.summary ||
    firstEvent?.label ||
    firstEvent?.text ||
    firstEvent?.title ||
    null;

  const { error } = await supabase
    .from('active_layoffs_feed')
    .upsert({
      company_name: candidate.companyName,
      ticker: candidate.ticker,
      cik: candidate.cik,
      score: score.score,
      band: score.band,
      state,
      key_signal: keySignal,
      source_type: candidate.sourceType,
      source_ref: candidate.sourceRef,
      filed_at: candidate.filedAt,
      scored_at: new Date().toISOString(),
    }, { onConflict: 'company_name' });

  if (error) {
    console.error(`[backfill-active-layoffs] upsert failed for ${candidate.companyName}:`, error.message);
    return false;
  }
  return true;
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const daysParam = Number(req.nextUrl.searchParams.get('days'));
  const days = Number.isFinite(daysParam) && daysParam > 0
    ? Math.min(daysParam, MAX_DAYS)
    : DEFAULT_DAYS;
  const lookbackHours = days * 24;

  const startedAt = Date.now();
  const summary = {
    lookbackDays: days,
    discovered: 0,
    skippedRecentlyScored: 0,
    skippedOverCap: 0,
    scored: 0,
    addedToFeed: 0,
    errors: 0,
  };

  try {
    const candidates = await discoverActiveLayoffCandidates({
      edgarLookbackHours: lookbackHours,
      mediaLookbackHours: lookbackHours,
    });
    summary.discovered = candidates.length;

    const toScore: DiscoveryCandidate[] = [];
    for (const c of candidates) {
      if (await recentlyScored(c.companyName)) {
        summary.skippedRecentlyScored++;
        continue;
      }
      if (toScore.length >= BACKFILL_MAX_CANDIDATES) {
        summary.skippedOverCap++;
        continue;
      }
      toScore.push(c);
    }

    for (const candidate of toScore) {
      const score = await scoreCandidate(req, candidate);
      if (!score) {
        summary.errors++;
        continue;
      }
      summary.scored++;
      const added = await upsertFeedEntry(candidate, score);
      if (added) summary.addedToFeed++;
    }

    return NextResponse.json({
      ok: true,
      tookMs: Date.now() - startedAt,
      note: summary.skippedOverCap > 0
        ? `Hit the per-run cap (${BACKFILL_MAX_CANDIDATES}). Re-run this same URL again — already-scored companies are skipped, so each call makes forward progress.`
        : undefined,
      ...summary,
    });
  } catch (err: any) {
    console.error('[backfill-active-layoffs] handler error:', err?.message || err);
    return NextResponse.json({ ok: false, error: 'Internal error', ...summary }, { status: 200 });
  }
}
