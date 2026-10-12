// POST { email, source } → opt in to the weekly layoff digest.
// Stored in the existing beta_signups table (context.digest = true), so no schema change is needed.
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export async function POST(req: NextRequest) {
  try {
    const { email, source } = await req.json();
    const addr = String(email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr) || addr.length > 200) {
      return NextResponse.json({ error: 'Enter a valid email address.' }, { status: 400 });
    }
    const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

    const { data: existing } = await supabase.from('beta_signups').select('context, source').eq('email', addr).maybeSingle();
    const context = { ...((existing?.context as object) ?? {}), digest: true, digest_at: new Date().toISOString() };
    const { error } = await supabase.from('beta_signups').upsert(
      { email: addr, source: existing?.source ?? String(source || 'digest').slice(0, 40), context, signed_up_at: new Date().toISOString() },
      { onConflict: 'email' },
    );
    if (error) {
      console.error('[subscribe] upsert error:', error.message);
      return NextResponse.json({ error: 'Could not save your email. Try again shortly.' }, { status: 500 });
    }
    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error('[subscribe] error:', err?.message || err);
    return NextResponse.json({ error: 'Something went wrong. Try again shortly.' }, { status: 500 });
  }
}
