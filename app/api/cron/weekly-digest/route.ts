// Weekly layoff digest (Vercel Cron, Mondays). Sends only to people who opted in
// through /api/subscribe (beta_signups.context.digest = true).
// Needs RESEND_API_KEY and a sender on a domain verified in Resend (DIGEST_FROM).
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { fetchLayoffEvents, fmtDate } from '@/lib/events/layoffs';
import { signEmail } from '@/lib/digest-token';

export const maxDuration = 60;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export async function GET(req: NextRequest) {
  if (process.env.CRON_SECRET && req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const key = process.env.RESEND_API_KEY;
  if (!key) return NextResponse.json({ ok: false, error: 'RESEND_API_KEY not set' });

  const events = await fetchLayoffEvents({ days: 7, limit: 30 });
  if (events.length === 0) return NextResponse.json({ ok: true, sent: 0, reason: 'no events this week' });

  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { data: rows, error } = await supabase.from('beta_signups').select('email, context').filter('context->>digest', 'eq', 'true').limit(500);
  if (error) return NextResponse.json({ ok: false, error: error.message });

  const from = process.env.DIGEST_FROM || 'EjectSeat <digest@ejectseat.io>';
  const list = events
    .map((e) => `<li style="margin:0 0 14px"><a href="${esc(e.filingUrl)}" style="font-weight:700;color:#0f1722">${esc(e.headline)}</a><br><span style="color:#556070;font-size:13px">${esc(e.name)}${e.ticker ? ' (' + esc(e.ticker) + ')' : ''} · filed ${fmtDate(e.filedAt)}</span></li>`)
    .join('');

  let sent = 0, failed = 0;
  for (const r of rows ?? []) {
    const unsub = `https://ejectseat.io/api/unsubscribe?e=${encodeURIComponent(r.email)}&t=${signEmail(r.email)}`;
    const html = `<div style="font-family:system-ui,sans-serif;max-width:560px"><h2>${events.length} layoff filing${events.length === 1 ? '' : 's'} this week</h2><ul style="padding-left:18px">${list}</ul><p><a href="https://ejectseat.io/layoffs">See all on EjectSeat</a></p><p style="color:#556070;font-size:12px">You asked for this digest at ejectseat.io. <a href="${unsub}">Unsubscribe</a></p></div>`;
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: r.email, subject: `${events.length} layoff filings this week`, html, headers: { 'List-Unsubscribe': `<${unsub}>` } }),
    });
    res.ok ? sent++ : failed++;
    if (!res.ok && failed === 1) console.error('[digest] resend error:', res.status, await res.text());
  }
  return NextResponse.json({ ok: true, events: events.length, sent, failed });
}
