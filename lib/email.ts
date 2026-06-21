// lib/email.ts — EjectSeat Consumer v7.3
//
// Thin wrapper around Resend for the two transactional flows that need real
// email delivery: watch-alert notifications and enterprise-lead notices.
// Single place so the API key and "from" address aren't duplicated.

import { Resend } from 'resend';

const FROM_ADDRESS = 'EjectSeat <alerts@ejectseat.io>';

function getClient(): Resend | null {
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  return new Resend(key);
}

export async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  const client = getClient();
  if (!client) {
    console.warn('[email] RESEND_API_KEY not set — skipping send to', to);
    return false;
  }
  try {
    const { error } = await client.emails.send({ from: FROM_ADDRESS, to, subject, html });
    if (error) {
      console.error('[email] Resend send failed:', error);
      return false;
    }
    return true;
  } catch (err: any) {
    console.error('[email] send error:', err?.message || err);
    return false;
  }
}
