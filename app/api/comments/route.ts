// app/api/comments/route.ts — EjectSeat Consumer v7.3
//
// Anonymous, no-login anecdote board per /company/[ticker]. Backs the
// "What people are saying" section on the company page.
//
// GET  ?ticker=AAPL   -> recent, non-hidden comments for that ticker
// POST {ticker, body} -> insert a new comment, IP-rate-limited (no auth)

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createHash } from 'crypto';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const MAX_BODY_LEN = 1000;
const MIN_BODY_LEN = 3;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_PER_WINDOW = 3;

function hashIp(ip: string): string {
  return createHash('sha256').update(ip + (process.env.CRON_SECRET || 'ejectseat')).digest('hex');
}

function clientIp(req: NextRequest): string {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
}

export async function GET(req: NextRequest) {
  const ticker = req.nextUrl.searchParams.get('ticker')?.trim().toUpperCase();
  if (!ticker) return NextResponse.json({ comments: [] }, { status: 200 });

  const { data, error } = await supabase
    .from('company_comments')
    .select('id, body, created_at')
    .eq('ticker', ticker)
    .eq('hidden', false)
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) {
    console.error('[comments] GET failed:', error.message);
    return NextResponse.json({ comments: [] }, { status: 200 });
  }

  return NextResponse.json({ comments: data || [] });
}

export async function POST(req: NextRequest) {
  try {
    const { ticker, body } = await req.json();
    const cleanTicker = String(ticker || '').trim().toUpperCase();
    const cleanBody = String(body || '').trim();

    if (!cleanTicker || cleanBody.length < MIN_BODY_LEN || cleanBody.length > MAX_BODY_LEN) {
      return NextResponse.json({ error: 'Invalid comment' }, { status: 400 });
    }

    const ipHash = hashIp(clientIp(req));

    const { count } = await supabase
      .from('company_comments')
      .select('id', { count: 'exact', head: true })
      .eq('ip_hash', ipHash)
      .gte('created_at', new Date(Date.now() - RATE_LIMIT_WINDOW_MS).toISOString());

    if ((count || 0) >= RATE_LIMIT_MAX_PER_WINDOW) {
      return NextResponse.json({ error: 'Rate limited — try again shortly' }, { status: 429 });
    }

    const { error } = await supabase
      .from('company_comments')
      .insert({ ticker: cleanTicker, body: cleanBody, ip_hash: ipHash });

    if (error) {
      console.error('[comments] insert failed:', error.message);
      return NextResponse.json({ error: 'Failed to post comment' }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error('[comments] POST handler error:', err?.message || err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
