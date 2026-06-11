// app/api/active-layoffs/route.ts — EjectSeat Consumer v7
//
// NEW PUBLIC ROUTE — backs the homepage "Companies Currently Laying Off"
// scrolling ticker (breaking-news style).
//
// Data source: active_layoffs_feed table, populated proactively by
// app/api/cron/discover-active-layoffs (SEC EDGAR full-text search across
// ALL filers + Tier A/B media), independent of user search activity.
//
// Mirrors the caching pattern from app/api/high-risk/route.ts:
//   - In-memory server cache, 10-min TTL (shorter than high-risk's 30 min —
//     this feed is meant to feel "fresh", and the cron only writes every 6h
//     anyway so re-querying Supabase is cheap).
//   - Stale-cache fallback on DB error.
//   - Cache-Control headers for Vercel edge caching.
//
// Returns companies in LIKELY or ACTIVE state, most recently scored first,
// from the last 14 days (the feed table is upserted per-company so "last 14
// days" really means "still considered current as of the last cron run").

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

export interface ActiveLayoffEntry {
  name:       string;
  ticker:     string | null;
  score:      number;
  band:       string;
  state:      string;          // LIKELY | ACTIVE
  keySignal:  string | null;
  sourceType: string;          // sec_8k | sec_10k | sec_10q | media
  sourceRef:  string | null;
  filedAt:    string | null;
  scoredAt:   string;
}

let serverCache: { entries: ActiveLayoffEntry[]; builtAt: number } | null = null;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

async function buildActiveLayoffsList(): Promise<ActiveLayoffEntry[]> {
  const cutoff = new Date(Date.now() - 14 * 24 * 3_600_000).toISOString();
  const { data, error } = await supabase
    .from('active_layoffs_feed')
    .select('company_name, ticker, score, band, state, key_signal, source_type, source_ref, filed_at, scored_at')
    .in('state', ['LIKELY', 'ACTIVE'])
    .gte('scored_at', cutoff)
    .order('scored_at', { ascending: false })
    .limit(40);

  if (error) throw new Error(`Supabase: ${error.message}`);
  if (!data) return [];

  return data.map(row => ({
    name: row.company_name,
    ticker: row.ticker || null,
    score: typeof row.score === 'number' ? row.score : Number(row.score) || 0,
    band: row.band || 'MEDIUM',
    state: row.state,
    keySignal: row.key_signal || null,
    sourceType: row.source_type,
    sourceRef: row.source_ref || null,
    filedAt: row.filed_at || null,
    scoredAt: row.scored_at,
  }));
}

export async function GET(_req: NextRequest) {
  try {
    const now = Date.now();
    if (serverCache && (now - serverCache.builtAt) < CACHE_TTL_MS) {
      return NextResponse.json(
        { companies: serverCache.entries, builtAt: new Date(serverCache.builtAt).toISOString(), fromCache: true },
        { headers: { 'Cache-Control': 'public, s-maxage=180, stale-while-revalidate=300' } },
      );
    }

    let entries: ActiveLayoffEntry[];
    try {
      entries = await buildActiveLayoffsList();
      serverCache = { entries, builtAt: now };
    } catch (err: any) {
      console.error('[active-layoffs] DB error:', err?.message || err);
      entries = serverCache?.entries || [];
      return NextResponse.json(
        { companies: entries, builtAt: serverCache ? new Date(serverCache.builtAt).toISOString() : null, fromCache: true, stale: true },
        { status: 200 },
      );
    }

    return NextResponse.json(
      { companies: entries, builtAt: new Date(now).toISOString(), fromCache: false },
      { headers: { 'Cache-Control': 'public, s-maxage=180, stale-while-revalidate=300' } },
    );
  } catch (err: any) {
    console.error('[active-layoffs] handler error:', err?.message || err);
    return NextResponse.json({ companies: [], error: 'Internal error' }, { status: 200 });
  }
}
