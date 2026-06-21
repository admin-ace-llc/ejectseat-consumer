'use client';

import { useState } from 'react';

export default function WatchForm({ ticker }: { ticker: string }) {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'submitting' | 'done' | 'error'>('idle');

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setStatus('submitting');
    try {
      const res = await fetch('/api/watch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, ticker }),
      });
      setStatus(res.ok ? 'done' : 'error');
    } catch {
      setStatus('error');
    }
  }

  if (status === 'done') {
    return (
      <div style={{ fontSize: 13.5, color: '#047857' }}>
        ✓ You&apos;ll get an email if {ticker}&apos;s risk state changes.
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      <input
        type="email"
        required
        placeholder="you@example.com"
        value={email}
        onChange={e => setEmail(e.target.value)}
        style={{ flex: 1, minWidth: 180, padding: '9px 12px', fontSize: 13.5, border: '1px solid #e4e8ef', borderRadius: 7 }}
      />
      <button
        type="submit"
        disabled={status === 'submitting'}
        style={{ background: '#0f172a', color: 'white', border: 0, padding: '9px 16px', borderRadius: 7, fontSize: 13.5, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}
      >
        {status === 'submitting' ? 'Saving…' : `Watch ${ticker}`}
      </button>
      {status === 'error' && <div style={{ fontSize: 12.5, color: '#b91c1c', width: '100%' }}>Something went wrong — try again.</div>}
    </form>
  );
}
