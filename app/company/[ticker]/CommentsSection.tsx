'use client';

import { useState } from 'react';

interface Comment {
  id: string;
  body: string;
  created_at: string;
}

export default function CommentsSection({ ticker, initialComments }: { ticker: string; initialComments: Comment[] }) {
  const [comments, setComments] = useState(initialComments);
  const [body, setBody] = useState('');
  const [status, setStatus] = useState<'idle' | 'submitting' | 'error'>('idle');

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (body.trim().length < 3) return;
    setStatus('submitting');
    try {
      const res = await fetch('/api/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticker, body }),
      });
      if (res.ok) {
        setComments([{ id: `${Date.now()}`, body, created_at: new Date().toISOString() }, ...comments]);
        setBody('');
        setStatus('idle');
      } else {
        setStatus('error');
      }
    } catch {
      setStatus('error');
    }
  }

  return (
    <div>
      <form onSubmit={handleSubmit} style={{ marginBottom: 16 }}>
        <textarea
          value={body}
          onChange={e => setBody(e.target.value)}
          placeholder="Heard something about this company? Share it anonymously."
          rows={3}
          maxLength={1000}
          style={{ width: '100%', padding: '10px 12px', fontSize: 13.5, border: '1px solid #e4e8ef', borderRadius: 7, fontFamily: 'inherit', boxSizing: 'border-box' }}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
          <button
            type="submit"
            disabled={status === 'submitting' || body.trim().length < 3}
            style={{ background: '#0f172a', color: 'white', border: 0, padding: '8px 16px', borderRadius: 7, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
          >
            {status === 'submitting' ? 'Posting…' : 'Post anonymously'}
          </button>
        </div>
        {status === 'error' && <div style={{ fontSize: 12.5, color: '#b91c1c', marginTop: 6 }}>Couldn&apos;t post — try again shortly.</div>}
      </form>

      {comments.length === 0 ? (
        <div style={{ fontSize: 13.5, color: '#64748b' }}>No comments yet — be the first to share what you know.</div>
      ) : (
        comments.map(c => (
          <div key={c.id} style={{ padding: '10px 0', borderBottom: '1px solid #e4e8ef', fontSize: 13.5, color: '#0f172a', lineHeight: 1.5 }}>
            {c.body}
            <div style={{ fontSize: 11.5, color: '#94a3b8', marginTop: 4 }}>
              {new Date(c.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} · anonymous
            </div>
          </div>
        ))
      )}
    </div>
  );
}
