// app/api/beacon/route.ts — EjectSeat Consumer v7 (preserved)
// Lightweight page-visit + event beacon used by the frontend.

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { eventType, sessionId, payload } = body;

    if (!eventType) return NextResponse.json({ error: 'eventType required' }, { status: 400 });

    let userId: string | null = null;
    const authHeader = req.headers.get('Authorization');
    if (authHeader?.startsWith('Bearer ')) {
      const { data: { user } } = await supabase.auth.getUser(authHeader.replace('Bearer ', ''));
      if (user) userId = user.id;
    }

    await supabase.from('analytics_events').insert({
      user_id:    userId,
      session_id: sessionId || req.cookies.get('es_session')?.value || null,
      event_type: String(eventType).slice(0, 60),
      payload:    payload || {},
      ip_address: req.headers.get('x-forwarded-for')?.split(',')[0] || null,
      user_agent: req.headers.get('user-agent') || null,
    });

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error('[beacon] route error:', err?.message || err);
    return NextResponse.json({ ok: false }, { status: 200 });
  }
}
