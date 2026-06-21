// app/api/warn-ca/route.ts — EjectSeat Consumer v7.3
//
// Public read route for California WARN Act notices, last 7 days. Backs the
// homepage's CA WARN sub-section. Returns explicit `sourceUrl` and `asOf`
// (last successful fetch timestamp) so the UI can show provenance, and an
// explicit empty list rather than silence/error when there's nothing new —
// per product requirement to never mislead about what's actually known.

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { CA_WARN_SOURCE_URL } from '@/lib/warn/ca';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

export async function GET(_req: NextRequest) {
  try {
    const cutoff = new Date(Date.now() - 7 * 24 * 3_600_000).toISOString().slice(0, 10);

    const { data, error } = await supabase
      .from('ca_warn_notices')
      .select('company_name, county, notice_date, effective_date, received_date, employees_affected, layoff_type, fetched_at')
      .or(`effective_date.gte.${cutoff},notice_date.gte.${cutoff}`)
      .order('effective_date', { ascending: false })
      .limit(50);

    if (error) throw new Error(`Supabase: ${error.message}`);

    const { data: latest } = await supabase
      .from('ca_warn_notices')
      .select('fetched_at')
      .order('fetched_at', { ascending: false })
      .limit(1);

    const notices = (data || []).map(row => ({
      companyName: row.company_name,
      county: row.county || null,
      noticeDate: row.notice_date || null,
      effectiveDate: row.effective_date || null,
      receivedDate: row.received_date || null,
      employeesAffected: row.employees_affected ?? null,
      layoffType: row.layoff_type || null,
    }));

    return NextResponse.json(
      {
        notices,
        sourceUrl: CA_WARN_SOURCE_URL,
        asOf: latest?.[0]?.fetched_at || null,
      },
      { headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' } },
    );
  } catch (err: any) {
    console.error('[warn-ca] handler error:', err?.message || err);
    return NextResponse.json({ notices: [], sourceUrl: CA_WARN_SOURCE_URL, asOf: null, error: 'Internal error' }, { status: 200 });
  }
}
