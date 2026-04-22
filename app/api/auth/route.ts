// app/api/auth/route.ts — EjectSeat Consumer v7 (preserved)
// Supabase magic-link authentication for the registered-user upgrade.

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

function originOf(req: NextRequest): string {
  const proto = req.headers.get('x-forwarded-proto') || 'https';
  const host  = req.headers.get('host') || 'ejectseat.io';
  return `${proto}://${host}`;
}

export async function POST(req: NextRequest) {
  try {
    const { email, action } = await req.json();

    if (!email?.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ error: 'Valid email required' }, { status: 400 });
    }

    if (action === 'signup' || action === 'magic-link') {
      const { error } = await supabase.auth.signInWithOtp({
        email: email.trim().toLowerCase(),
        options: {
          emailRedirectTo: `${originOf(req)}/`,
          shouldCreateUser: true,
        },
      });

      if (error) {
        console.error('[auth] signInWithOtp error:', error);
        return NextResponse.json({ error: error.message }, { status: 400 });
      }

      return NextResponse.json({
        success: true,
        message: 'Check your email for a sign-in link.',
      });
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  } catch (err: any) {
    console.error('[auth] route error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json({ user: null }, { status: 200 });
    }
    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return NextResponse.json({ user: null }, { status: 200 });
    return NextResponse.json({ user: { id: user.id, email: user.email } });
  } catch (err: any) {
    console.error('[auth] GET error:', err);
    return NextResponse.json({ user: null }, { status: 200 });
  }
}
