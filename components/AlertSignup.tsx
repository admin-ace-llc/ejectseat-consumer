'use client';
import { useState } from 'react';

export default function AlertSignup({ source = 'digest' }: { source?: string }) {
  const [email, setEmail] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(ev: React.FormEvent) {
    ev.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch('/api/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, source }),
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok) {
        setMsg({ ok: true, text: 'You are on the list. The first digest arrives next Monday.' });
        setEmail('');
      } else {
        setMsg({ ok: false, text: j.error || 'Could not save your email. Check the address and try again.' });
      }
    } catch {
      setMsg({ ok: false, text: 'Network error. Try again in a moment.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate>
      <div className="signup">
        <label htmlFor={`alert-${source}`} style={{ position: 'absolute', left: -9999 }}>Email address</label>
        <input id={`alert-${source}`} type="email" inputMode="email" autoComplete="email" placeholder="you@example.com"
          value={email} onChange={(e) => setEmail(e.target.value)} required />
        <button className="btn" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Email me the digest'}</button>
      </div>
      <div className="signup-msg" role="status" aria-live="polite" style={{ color: msg?.ok ? 'var(--ok)' : 'var(--alert)' }}>
        {msg?.text}
      </div>
    </form>
  );
}
