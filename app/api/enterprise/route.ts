// app/api/enterprise/route.ts — EjectSeat Consumer v7.3
//
// Bulk-data / report enquiry intake (layoffs.fyi-style monetization hook).
// Inserts into enterprise_leads and notifies enquiries.talkace@gmail.com.

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { sendEmail } from '@/lib/email';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NOTIFY_TO = 'enquiries.talkace@gmail.com';

export async function POST(req: NextRequest) {
  try {
    const { name, email, company, useCase, message } = await req.json();
    const cleanEmail = String(email || '').trim().toLowerCase();

    if (!EMAIL_RE.test(cleanEmail)) {
      return NextResponse.json({ error: 'Invalid email' }, { status: 400 });
    }

    const cleanName = String(name || '').trim().slice(0, 200) || null;
    const cleanCompany = String(company || '').trim().slice(0, 200) || null;
    const cleanUseCase = String(useCase || '').trim().slice(0, 200) || null;
    const cleanMessage = String(message || '').trim().slice(0, 2000) || null;

    const { error } = await supabase
      .from('enterprise_leads')
      .insert({ name: cleanName, email: cleanEmail, company: cleanCompany, use_case: cleanUseCase, message: cleanMessage });

    if (error) {
      console.error('[enterprise] insert failed:', error.message);
      return NextResponse.json({ error: 'Failed to submit enquiry' }, { status: 500 });
    }

    await sendEmail(
      NOTIFY_TO,
      `New enterprise enquiry: ${cleanCompany || cleanEmail}`,
      `<p><strong>Name:</strong> ${cleanName || '—'}</p>
       <p><strong>Email:</strong> ${cleanEmail}</p>
       <p><strong>Company:</strong> ${cleanCompany || '—'}</p>
       <p><strong>Use case:</strong> ${cleanUseCase || '—'}</p>
       <p><strong>Message:</strong> ${cleanMessage || '—'}</p>`,
    );

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error('[enterprise] POST handler error:', err?.message || err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
