// app/api/active-layoffs/route.ts — EjectSeat Consumer v7
//
// Returns a ranked list of companies with ACTIVE or LIKELY cached_state.
// Unlike /api/high-risk (which only surfaces user-searched companies in the
// last 90 days), this endpoint draws from the full companies table so the
// ticker is populated even on fresh deployments and always reflects the
// latest cached state regardless of when the company was last searched.
//
// USAGE: GET /api/active-layoffs
// RESPONSE: { companies: ActiveLayoffEntry[], builtAt: string }
//
// PERFORMANCE:
//   30-min in-memory cache + Vercel edge Cache-Control headers.
//   Falls back to stale cache on DB error rather than returning empty.

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ActiveLayoffEntry {
  name:            string;
  ticker:          string | null;
  score:           number;
  state:           'ACTIVE' | 'LIKELY';
  keySignal:       string | null;  // top signal from most-recent score_history row
  programmeName:   string | null;
  trajectoryDir:   string | null;  // 'escalating' | 'stable' | 'completing'
  wavesConfirmed:  number;
  scoredAt:        string;
}

// ─────────────────────────────────────────────────────────────────────────────
// In-memory cache
// ─────────────────────────────────────────────────────────────────────────────

let serverCache: { entries: ActiveLayoffEntry[]; builtAt: number } | null = null;
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

// ─────────────────────────────────────────────────────────────────────────────
// Build list
// ─────────────────────────────────────────────────────────────────────────────

async function buildActiveLayoffList(): Promise<ActiveLayoffEntry[]> {
  // 1. Pull all companies with ACTIVE or LIKELY cached_state
  const { data: companies, error } = await supabase
    .from('companies')
    .select('id, name, legal_name, ticker, cached_score, cached_state, cached_at, last_scored_at')
    .in('cached_state', ['ACTIVE', 'LIKELY'])
    .not('cached_score', 'is', null)
    .order('cached_score', { ascending: false })
    .limit(60);

  if (error) throw new Error(`Supabase companies: ${error.message}`);
  if (!companies || companies.length === 0) return [];

  // 2. Fetch most-recent score_history row per company for signal enrichment
  const ids = companies.map((c: any) => c.id).filter(Boolean);
  const { data: history } = await supabase
    .from('score_history')
    .select('company_id, key_signal, programme_name, trajectory, waves_confirmed, scored_at')
    .in('company_id', ids)
    .order('scored_at', { ascending: false })
    .limit(ids.length * 3); // over-fetch so JS dedup finds at least one per company

  // Index history by company_id (first = most recent due to sort above)
  const historyMap = new Map<string, any>();
  for (const row of (history || [])) {
    if (row.company_id && !historyMap.has(row.company_id)) {
      historyMap.set(row.company_id, row);
    }
  }

  // 3. Merge and shape
  const entries: ActiveLayoffEntry[] = companies.map((c: any) => {
    const hist = historyMap.get(c.id) || null;
    const state: 'ACTIVE' | 'LIKELY' =
      c.cached_state === 'ACTIVE' ? 'ACTIVE' : 'LIKELY';

    return {
      name:           c.legal_name || c.name,
      ticker:         c.ticker || null,
      score:          typeof c.cached_score === 'number' ? c.cached_score : 0,
      state,
      keySignal:      hist?.key_signal    || null,
      programmeName:  hist?.programme_name || null,
      trajectoryDir:  hist?.trajectory    || null,
      wavesConfirmed: typeof hist?.waves_confirmed === 'number' ? hist.waves_confirmed : 0,
      scoredAt:       c.last_scored_at || c.cached_at || new Date().toISOString(),
    };
  });

  // Sort: ACTIVE first, then LIKELY; within each group, score DESC
  return entries.sort((a, b) => {
    if (a.state !== b.state) return a.state === 'ACTIVE' ? -1 : 1;
    return b.score - a.score;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────────────────────

export async function GET(_req: NextRequest) {
  try {
    const now = Date.now();

    if (serverCache && (now - serverCache.builtAt) < CACHE_TTL_MS) {
      return NextResponse.json(
        { companies: serverCache.entries, builtAt: new Date(serverCache.builtAt).toISOString(), fromCache: true },
        { headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' } },
      );
    }

    let entries: ActiveLayoffEntry[];
    try {
      entries = await buildActiveLayoffList();
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
      { headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' } },
    );
  } catch (err: any) {
    console.error('[active-layoffs] handler error:', err?.message || err);
    return NextResponse.json({ companies: [], error: 'Internal error' }, { status: 200 });
  }
}
