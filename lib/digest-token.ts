import { createHmac, timingSafeEqual } from 'crypto';

// Unsubscribe links are HMAC-signed so nobody can unsubscribe someone else.
function secret(): string {
  return process.env.CRON_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || 'ejectseat-dev';
}
export function signEmail(email: string): string {
  return createHmac('sha256', secret()).update(email.trim().toLowerCase()).digest('hex').slice(0, 32);
}
export function verifyEmail(email: string, token: string): boolean {
  const a = Buffer.from(signEmail(email));
  const b = Buffer.from(token || '');
  return a.length === b.length && timingSafeEqual(a, b);
}
