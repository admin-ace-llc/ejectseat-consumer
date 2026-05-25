// app/api/high-risk/route.ts — EjectSeat Consumer v7
//
// Returns a ranked list of HIGH-band companies from score_history.
// Used by the homepage "Elevated Risk Watch" section.
//
// Self-populates from user searches — no manual curation required.
// Hides on fresh deployments when no HIGH-band scores exist yet.
//
// PERFORMANCE:
//   Server-side in-memory cache (30-min TTL) with stale-cache fallback.
//   Client polls every 5 minutes. Cache-Control headers instruct Vercel
//   edge to cache for 5 minutes with 10-min stale-while-revalidate window.
//
// QUERY:
//   Fetches most-recent HIGH score per company (last 90 days),
//   sorted by score DESC then scored_at DESC, capped at 20.
//   Uses over-fetch + JS dedup pattern (avoids DISTINCT ON in Supabase client).

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface HighRiskEntry {
  name:          string;        // legal name preferred
  ticker:        string | null;
  score:         number;        // 65–90
  band:          string;        // 'HIGH'
  state:         string;        // 'ACTIVE' | 'LIKELY' | 'WATCH'
  keySignal:     string | null; // top signal description ≤80 chars
  programmeName: string | null; // named restructuring programme if any
  scoredAt:      string;        // ISO datetime
}

// ─────────────────────────────────────────────────────────────────────────────
// In-memory cache (survives across warm invocations on the same instance)
// ─────────────────────────────────────────────────────────────────────────────

let serverCache: { entries: HighRiskEntry[]; builtAt: number } | null = null;
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

// ─────────────────────────────────────────────────────────────────────────────
// Build the ranked list from Supabase
// ─────────────────────────────────────────────────────────────────────────────

async function buildHighRiskList(): Promise<HighRiskEntry[]> {
  const cutoff = new Date(Date.now() - 90 * 24 * 3_600_000).toISOString();

  // Over-fetch 200 rows, sorted newest-first so dedup takes the most recent.
  // Supabase auto-resolves the company_id FK → companies row (service role key
  // bypasses RLS on both tables).
  const { data, error } = await supabase
    .from('score_history')
    .select(`
      score,
      band,
      company_state,
      key_signal,
      programme_name,
      scored_at,
      companies ( name, legal_name, ticker )
    `)
    .eq('band', 'HIGH')
    .gte('scored_at', cutoff)
    .order('scored_at', { ascending: false })
    .limit(200);

  if (error) throw new Error(`Supabase: ${error.message}`);
  if (!data || data.length === 0) return [];

  // Deduplicate: first occurrence per company name = most recent (sorted above)
  const seen = new Map<string, HighRiskEntry>();

  for (const row of data) {
    // Supabase's generated types infer the FK join as an array; cast via unknown
    // then normalise — at runtime it arrives as a single object for n:1 FKs.
    const raw = row.companies as unknown;
    const company: { name: string; legal_name?: string | null; ticker?: string | null } | null =
      Array.isArray(raw) ? (raw[0] ?? null) : (raw as any) ?? null;

    if (!company?.name) continue;

    const dedupeKey = company.name.toLowerCase();
    if (seen.has(dedupeKey)) continue;

    seen.set(dedupeKey, {
      name:          company.legal_name || company.name,
      ticker:        company.ticker    || null,
      score:         typeof row.score === 'number' ? row.score : 0,
      band:          row.band          || 'HIGH',
      state:         row.company_state || 'ACTIVE',
      keySignal:     row.key_signal    || null,
      programmeName: row.programme_name || null,
      scoredAt:      row.scored_at,
    });
  }

  // Sort: score DESC, then recency DESC as tiebreak
  return Array.from(seen.values())
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return new Date(b.scoredAt).getTime() - new Date(a.scoredAt).getTime();
    })
    .slice(0, 20);
}

// ─────────────────────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────────────────────

export async function GET(_req: NextRequest) {
  try {
    const now = Date.now();

    // Serve from in-memory cache if fresh
    if (serverCache && (now - serverCache.builtAt) < CACHE_TTL_MS) {
      return NextResponse.json(
        {
          companies: serverCache.entries,
          builtAt:   new Date(serverCache.builtAt).toISOString(),
          fromCache: true,
        },
        {
          headers: {
            'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600',
          },
        },
      );
    }

    // Build fresh list; fall back to stale cache on DB error
    let entries: HighRiskEntry[];
    try {
      entries = await buildHighRiskList();
      serverCache = { entries, builtAt: now };
    } catch (err: any) {
      console.error('[high-risk] DB error:', err?.message || err);
      entries = serverCache?.entries || [];
      return NextResponse.json(
        {
          companies: entries,
          builtAt:   serverCache ? new Date(serverCache.builtAt).toISOString() : null,
          fromCache: true,
          stale:     true,
        },
        { status: 200 },
      );
    }

    return NextResponse.json(
      {
        companies: entries,
        builtAt:   new Date(now).toISOString(),
        fromCache: false,
      },
      {
        headers: {
          'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600',
        },
      },
    );
  } catch (err: any) {
    console.error('[high-risk] handler error:', err?.message || err);
    // Always return 200 — client section simply stays hidden on empty array
    return NextResponse.json({ companies: [], error: 'Internal error' }, { status: 200 });
  }
}
