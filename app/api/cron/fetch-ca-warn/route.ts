// app/api/cron/fetch-ca-warn/route.ts — EjectSeat Consumer v7.3
//
// Daily cron: fetches the California EDD WARN Act report and upserts parsed
// rows into ca_warn_notices. See lib/warn/ca.ts for the parsing/safety rules
// — this route trusts that module to never return fabricated rows, and
// simply persists whatever it returns (which may be an empty list).
//
// Triggered by Vercel Cron, same auth convention as the other cron routes:
// Authorization: Bearer <CRON_SECRET>.

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { fetchCaWarnNotices } from '@/lib/warn/ca';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const startedAt = Date.now();
  const result = await fetchCaWarnNotices();

  if (result.warning) {
    return NextResponse.json({
      ok: false,
      warning: result.warning,
      sourceUrl: result.sourceUrl,
      fetchedAt: result.fetchedAt,
      upserted: 0,
      tookMs: Date.now() - startedAt,
    });
  }

  let upserted = 0;
  let errors = 0;
  for (const row of result.rows) {
    const { error } = await supabase
      .from('ca_warn_notices')
      .upsert({
        company_name: row.companyName,
        county: row.county,
        notice_date: row.noticeDate,
        effective_date: row.effectiveDate,
        received_date: row.receivedDate,
        employees_affected: row.employeesAffected,
        layoff_type: row.layoffType,
        raw: row.raw,
        fetched_at: result.fetchedAt,
      }, { onConflict: 'company_name,county,notice_date,effective_date' });

    if (error) {
      console.error(`[fetch-ca-warn] upsert failed for ${row.companyName}:`, error.message);
      errors++;
    } else {
      upserted++;
    }
  }

  return NextResponse.json({
    ok: true,
    sourceUrl: result.sourceUrl,
    fetchedAt: result.fetchedAt,
    parsed: result.rows.length,
    upserted,
    errors,
    tookMs: Date.now() - startedAt,
  });
}
