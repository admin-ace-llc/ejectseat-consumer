import { NextRequest } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { verifyEmail } from '@/lib/digest-token';

const page = (msg: string, status = 200) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>EjectSeat digest</title><body style="font-family:system-ui;max-width:480px;margin:15vh auto;padding:0 20px"><h1 style="font-size:22px">${msg}</h1><p><a href="https://ejectseat.io/">Back to EjectSeat</a></p></body>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  );

export async function GET(req: NextRequest) {
  const email = (req.nextUrl.searchParams.get('e') || '').trim().toLowerCase();
  const token = req.nextUrl.searchParams.get('t') || '';
  if (!email || !verifyEmail(email, token)) return page('This unsubscribe link is not valid.', 400);

  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { data } = await supabase.from('beta_signups').select('context').eq('email', email).maybeSingle();
  if (data) {
    await supabase.from('beta_signups').update({ context: { ...((data.context as object) ?? {}), digest: false } }).eq('email', email);
  }
  return page('You are unsubscribed from the weekly digest.');
}
