// app/api/beta/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(req: NextRequest) {
  const { email, useCase, referrer } = await req.json();
  if (!email?.includes('@')) {
    return NextResponse.json({ error: 'Valid email required' }, { status: 400 });
  }
  const { error } = await supabase.from('beta_signups').insert({
    email: email.toLowerCase().trim(),
    use_case: useCase,
    referrer: referrer || req.headers.get('referer'),
  });
  if (error?.code === '23505') {
    return NextResponse.json({ message: 'Already on the list!' });
  }
  if (error) {
    return NextResponse.json({ error: 'Signup failed' }, { status: 500 });
  }
  return NextResponse.json({ message: 'Success' });
}
