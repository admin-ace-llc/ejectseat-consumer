// app/api/admin/reports/route.ts — EjectSeat Consumer v7.3
//
// Owner-only data export. Lets the code owner pull CSV/JSON dumps of the
// tables that back the enterprise/monetization story, without needing direct
// Supabase dashboard access every time.
//
// USAGE:
//   curl -H "Authorization: Bearer <CRON_SECRET>" \
//     "https://ejectseat.io/api/admin/reports?table=active_layoffs_feed&format=csv"
//
// Same Bearer CRON_SECRET auth convention as the other admin/cron routes.

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// Allowlist — only tables relevant to reporting/monetization, never raw
// internal scoring internals or anything containing secrets.
const ALLOWED_TABLES: Record<string, string> = {
  companies: 'id, name, legal_name, ticker, cik, cached_score, cached_band, cached_state, cached_at, last_scored_at',
  active_layoffs_feed: 'id, company_name, ticker, cik, score, band, state, key_signal, source_type, source_ref, filed_at, scored_at',
  enterprise_leads: 'id, name, email, company, use_case, message, created_at',
  company_comments: 'id, ticker, body, created_at, hidden',
  watches: 'id, email, ticker, last_known_state, last_notified_at, created_at',
  ca_warn_notices: 'id, company_name, county, notice_date, effective_date, received_date, employees_affected, layoff_type, fetched_at',
};

const MAX_ROWS = 5000;

function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  const escape = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.join(',')];
  for (const row of rows) lines.push(headers.map(h => escape(row[h])).join(','));
  return lines.join('\n');
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const table = req.nextUrl.searchParams.get('table') || '';
  const format = (req.nextUrl.searchParams.get('format') || 'json').toLowerCase();
  const limitParam = Number(req.nextUrl.searchParams.get('limit'));
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, MAX_ROWS) : MAX_ROWS;

  const columns = ALLOWED_TABLES[table];
  if (!columns) {
    return NextResponse.json(
      { error: `Unknown or disallowed table. Allowed: ${Object.keys(ALLOWED_TABLES).join(', ')}` },
      { status: 400 },
    );
  }

  const { data, error } = await supabase.from(table).select(columns).limit(limit);

  if (error) {
    console.error(`[admin/reports] query failed for ${table}:`, error.message);
    return NextResponse.json({ error: 'Query failed' }, { status: 500 });
  }

  const rows = (data || []) as unknown as Record<string, unknown>[];

  if (format === 'csv') {
    return new NextResponse(toCsv(rows), {
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="${table}.csv"`,
      },
    });
  }

  return NextResponse.json({ table, count: rows.length, rows: data });
}
