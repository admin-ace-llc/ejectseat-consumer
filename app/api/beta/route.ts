// app/api/beta/route.ts — EjectSeat Consumer v7 (preserved)
// Beta / waitlist email capture.

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

export async function POST(req: NextRequest) {
  try {
    const { email, source, context } = await req.json();

    if (!email?.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ error: 'Valid email required' }, { status: 400 });
    }

    const { error } = await supabase.from('beta_signups').upsert({
      email:   email.trim().toLowerCase(),
      source:  source || 'unknown',
      context: context || null,
      signed_up_at: new Date().toISOString(),
    }, { onConflict: 'email' });

    if (error) {
      console.error('[beta] upsert error:', error);
      return NextResponse.json({ error: 'Could not save your email' }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error('[beta] route error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
