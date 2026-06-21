// lib/supabase-server.ts — read-only server client for statically/ISR-rendered pages.
// Separate from the service-role client in app/api/score/route.ts so the
// permalink pages have a single, obvious place to read cached company rows.

import { createClient } from '@supabase/supabase-js';

export function getSupabaseServerClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

export interface CachedCompanyRow {
  id: string;
  name: string;
  legal_name: string | null;
  ticker: string | null;
  cik: string | null;
  cached_score: number | null;
  cached_band: string | null;
  cached_state: string | null;
  cached_at: string | null;
  cached_programme: any | null;
  cached_headcount: any | null;
  cached_function_risk: any | null;
  cached_bankruptcy: any | null;
  cached_large_employer_flag: boolean | null;
  cached_intelligence: any | null;
  cached_pipeline_version: string | null;
  last_scored_at: string | null;
}

export async function getCompanyByTicker(ticker: string): Promise<CachedCompanyRow | null> {
  const supabase = getSupabaseServerClient();
  const { data } = await supabase
    .from('companies')
    .select(
      'id, name, legal_name, ticker, cik, cached_score, cached_band, cached_state, cached_at, ' +
      'cached_programme, cached_headcount, cached_function_risk, cached_bankruptcy, ' +
      'cached_large_employer_flag, cached_intelligence, cached_pipeline_version, last_scored_at',
    )
    .ilike('ticker', ticker)
    .not('cached_score', 'is', null)
    .order('cached_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as CachedCompanyRow | null) ?? null;
}

export interface ScoreHistoryEntry {
  score: number;
  band: string;
  quarter_label: string | null;
  scored_at: string;
  key_signal: string | null;
  company_state: string | null;
}

export async function getScoreHistory(companyId: string): Promise<ScoreHistoryEntry[]> {
  const supabase = getSupabaseServerClient();
  const { data } = await supabase
    .from('score_history')
    .select('score, band, quarter_label, scored_at, key_signal, company_state')
    .eq('company_id', companyId)
    .order('scored_at', { ascending: false })
    .limit(6);
  return (data || []).reverse() as ScoreHistoryEntry[];
}

export async function listScoredTickers(): Promise<{ ticker: string; cached_at: string | null }[]> {
  const supabase = getSupabaseServerClient();
  const { data } = await supabase
    .from('companies')
    .select('ticker, cached_at')
    .not('ticker', 'is', null)
    .not('cached_score', 'is', null);
  return (data as { ticker: string; cached_at: string | null }[] | null) ?? [];
}
