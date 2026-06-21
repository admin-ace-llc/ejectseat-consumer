// app/api/watch/route.ts — EjectSeat Consumer v7.3
//
// "Watch this ticker" email capture. Upserts into watches and sends a
// confirmation email. State-change alerts are sent separately, from
// app/api/score/route.ts, whenever a fresh score changes a watched ticker's
// company_state.

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { sendEmail } from '@/lib/email';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(req: NextRequest) {
  try {
    const { email, ticker } = await req.json();
    const cleanEmail = String(email || '').trim().toLowerCase();
    const cleanTicker = String(ticker || '').trim().toUpperCase();

    if (!EMAIL_RE.test(cleanEmail) || !cleanTicker) {
      return NextResponse.json({ error: 'Invalid email or ticker' }, { status: 400 });
    }

    const { data: company } = await supabase
      .from('companies')
      .select('cached_state')
      .ilike('ticker', cleanTicker)
      .limit(1)
      .maybeSingle();

    const { error } = await supabase
      .from('watches')
      .upsert(
        { email: cleanEmail, ticker: cleanTicker, last_known_state: company?.cached_state || null },
        { onConflict: 'email,ticker' },
      );

    if (error) {
      console.error('[watch] upsert failed:', error.message);
      return NextResponse.json({ error: 'Failed to set up watch' }, { status: 500 });
    }

    await sendEmail(
      cleanEmail,
      `You're now watching ${cleanTicker} on EjectSeat`,
      `<p>You'll get an email if ${cleanTicker}'s layoff-risk state changes.</p>
       <p><a href="https://ejectseat.io/company/${encodeURIComponent(cleanTicker)}">View ${cleanTicker} now →</a></p>`,
    );

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error('[watch] POST handler error:', err?.message || err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
