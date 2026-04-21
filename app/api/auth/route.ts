// app/api/auth/route.ts — EjectSeat Consumer
// Magic link auth via Supabase signInWithOtp
// POST with email → Supabase sends magic link email automatically

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(req: NextRequest) {
  try {
    const { email } = await req.json();

    if (!email || !email.includes('@')) {
      return NextResponse.json({ error: 'Valid email required' }, { status: 400 });
    }

    const appUrl = process.env.NEXT_PUBLIC_APP_URL
      || 'https://ejectseat-consumer-cfad.vercel.app';

    const { error } = await supabase.auth.signInWithOtp({
      email: email.toLowerCase().trim(),
      options: {
        emailRedirectTo: `${appUrl}`,
        shouldCreateUser: true,
      },
    });

    if (error) {
      console.error('[auth] signInWithOtp error:', error.message);
      if (error.message.includes('rate limit')) {
        return NextResponse.json({
          error: 'Too many requests — please wait a minute before trying again.',
        }, { status: 429 });
      }
      return NextResponse.json({
        error: 'Failed to send sign-in link. Please try again.',
      }, { status: 500 });
    }

    await supabaseAdmin.from('analytics_events').insert({
      event_type: 'signin_requested',
      payload:    { email: email.toLowerCase().trim() },
    }).then(() => {});

    return NextResponse.json({ message: 'Magic link sent' });

  } catch (err) {
    console.error('[auth]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
