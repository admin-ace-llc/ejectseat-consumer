// app/api/cron/discover-active-layoffs/route.ts — EjectSeat Consumer v7
//
// NEW ROUTE — scheduled discovery + scoring job for the "Active Layoffs"
// breaking-news ticker.
//
// Triggered by Vercel Cron (see vercel.json — every 6 hours). Vercel signs
// cron requests with a bearer token equal to process.env.CRON_SECRET, sent
// as `Authorization: Bearer <CRON_SECRET>`. We verify that here so the route
// can't be hammered by the public.
//
// FLOW:
//   1. discoverActiveLayoffCandidates() — SEC EDGAR full-text search (all
//      filers, last 6h) + Tier A/B media scan (last 24h).
//   2. Skip candidates already in active_layoffs_feed with scored_at within
//      the last 6 hours (avoid re-scoring the same company every run).
//   3. For each remaining candidate (capped per run to control cost/runtime),
//      call the existing /api/score pipeline — same comprehensive evidence
//      mix (10-K/10-Q/8-K + transcripts + Tier A/B/C news) as a user search.
//   4. If the resulting state is LIKELY or ACTIVE, upsert into
//      active_layoffs_feed (the table the public ticker reads from).
//
// This keeps "discovery" (who to look at) and "scoring" (how risky are they)
// fully decoupled — the ticker is exactly as rigorous as a manual search,
// just triggered proactively instead of waiting for a user to type the name.

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { discoverActiveLayoffCandidates, DiscoveryCandidate } from '@/lib/signals/discovery';
import type { RiskScore, ScoreApiRequest } from '@/types';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// Cap how many new companies we score per cron run. Each /api/score call is a
// full evidence-gather + Sonnet pass, so this bounds runtime and API cost.
const MAX_CANDIDATES_PER_RUN = 12;

// Don't re-score a company that's already in the feed with a recent score.
const RESCORE_COOLDOWN_HOURS = 6;

function baseUrl(req: NextRequest): string {
  // Prefer an explicit env var (set this to https://ejectseat.com in Vercel).
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
    console.error('[discover-active-layoffs] recentlyScored check failed:', error.message);
    return false; // fail open — better to occasionally re-score than to miss a company
  }
  return !!(data && data.length > 0);
}

async function scoreCandidate(req: NextRequest, candidate: DiscoveryCandidate): Promise<RiskScore | null> {
  try {
    const body: ScoreApiRequest = { companyName: candidate.companyName, ticker: candidate.ticker || undefined };
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 55_000); // /api/score can be slow (Sonnet pass)
    const res = await fetch(`${baseUrl(req)}/api/score`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(t);
    if (!res.ok) {
      console.error(`[discover-active-layoffs] /api/score ${res.status} for ${candidate.companyName}`);
      return null;
    }
    return await res.json();
  } catch (err: any) {
    console.error(`[discover-active-layoffs] scoring failed for ${candidate.companyName}:`, err?.message || err);
    return null;
  }
}

async function upsertFeedEntry(candidate: DiscoveryCandidate, score: RiskScore) {
  const state = score.companyState || 'WATCH';
  // Only "currently in active layoffs" states make the breaking-news ticker.
  if (state !== 'LIKELY' && state !== 'ACTIVE') return;

  const keySignal = score.signals?.[0]?.description
    || score.confirmedEvents?.[0]?.description
    || null;

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
    console.error(`[discover-active-layoffs] upsert failed for ${candidate.companyName}:`, error.message);
  }
}

export async function GET(req: NextRequest) {
  // Verify Vercel Cron auth (or manual trigger with the same secret).
  const authHeader = req.headers.get('authorization');
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const startedAt = Date.now();
  const summary = {
    discovered: 0,
    skippedRecentlyScored: 0,
    scored: 0,
    addedToFeed: 0,
    errors: 0,
  };

  try {
    const candidates = await discoverActiveLayoffCandidates({ edgarLookbackHours: 6, mediaLookbackHours: 24 });
    summary.discovered = candidates.length;

    const toScore: DiscoveryCandidate[] = [];
    for (const c of candidates) {
      if (await recentlyScored(c.companyName)) {
        summary.skippedRecentlyScored++;
        continue;
      }
      toScore.push(c);
      if (toScore.length >= MAX_CANDIDATES_PER_RUN) break;
    }

    for (const candidate of toScore) {
      const score = await scoreCandidate(req, candidate);
      if (!score) {
        summary.errors++;
        continue;
      }
      summary.scored++;
      const before = summary.addedToFeed;
      await upsertFeedEntry(candidate, score);
      // upsertFeedEntry doesn't return whether it wrote — re-check state cheaply
      if (score.companyState === 'LIKELY' || score.companyState === 'ACTIVE') summary.addedToFeed = before + 1;
    }

    return NextResponse.json({
      ok: true,
      tookMs: Date.now() - startedAt,
      ...summary,
    });
  } catch (err: any) {
    console.error('[discover-active-layoffs] handler error:', err?.message || err);
    return NextResponse.json({ ok: false, error: 'Internal error', ...summary }, { status: 200 });
  }
}
