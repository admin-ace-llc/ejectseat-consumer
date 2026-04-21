// app/api/beacon/route.ts — EjectSeat Consumer
// Lightweight page visit tracking — fires on every page load

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const sessionId = req.cookies.get('es_session')?.value;

    await supabase.from('analytics_events').insert({
      session_id: sessionId,
      event_type: 'page_viewed',
      payload: {
        referrer:   body.referrer || req.headers.get('referer') || null,
        userAgent:  req.headers.get('user-agent')?.slice(0, 120) || null,
        pathname:   body.pathname || '/',
        timestamp:  new Date().toISOString(),
      },
    });

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: true });
  }
}
