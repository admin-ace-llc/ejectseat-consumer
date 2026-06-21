'use client';

import { useState } from 'react';

export default function EnterpriseForm() {
  const [status, setStatus] = useState<'idle' | 'submitting' | 'done' | 'error'>('idle');

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setStatus('submitting');
    const form = e.currentTarget;
    const body = {
      name: (form.elements.namedItem('name') as HTMLInputElement).value,
      email: (form.elements.namedItem('email') as HTMLInputElement).value,
      company: (form.elements.namedItem('company') as HTMLInputElement).value,
      useCase: (form.elements.namedItem('useCase') as HTMLSelectElement).value,
      message: (form.elements.namedItem('message') as HTMLTextAreaElement).value,
    };
    try {
      const res = await fetch('/api/enterprise', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      setStatus(res.ok ? 'done' : 'error');
    } catch {
      setStatus('error');
    }
  }

  if (status === 'done') {
    return (
      <div style={{ padding: '20px 22px', background: '#ecfdf5', border: '1px solid #a7f3d0', borderRadius: 10, color: '#047857', fontSize: 14 }}>
        Thanks — we&apos;ll be in touch shortly.
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: 'grid', gap: 14, maxWidth: 480 }}>
      <input name="name" placeholder="Your name" required style={input} />
      <input name="email" type="email" placeholder="Work email" required style={input} />
      <input name="company" placeholder="Company" style={input} />
      <select name="useCase" defaultValue="" style={input}>
        <option value="" disabled>Use case</option>
        <option value="recruiting">Recruiting / staffing</option>
        <option value="investing">Investing / research</option>
        <option value="insurance">Insurance / underwriting</option>
        <option value="journalism">Journalism</option>
        <option value="other">Other</option>
      </select>
      <textarea name="message" placeholder="What data or reports are you looking for?" rows={4} style={input} />
      <button type="submit" disabled={status === 'submitting'} style={cta}>
        {status === 'submitting' ? 'Sending…' : 'Request access'}
      </button>
      {status === 'error' && <div style={{ color: '#b91c1c', fontSize: 13 }}>Something went wrong — try again.</div>}
    </form>
  );
}

const input: React.CSSProperties = {
  padding: '11px 14px',
  fontSize: 14,
  border: '1px solid #e4e8ef',
  borderRadius: 8,
  fontFamily: 'inherit',
};

const cta: React.CSSProperties = {
  background: '#2563eb',
  color: 'white',
  border: 0,
  padding: '12px 20px',
  borderRadius: 8,
  fontSize: 14,
  fontWeight: 600,
  cursor: 'pointer',
};
