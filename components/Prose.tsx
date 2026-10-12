import React from 'react';

// Tiny markdown subset: ## / ### headings, paragraphs, - lists, **bold**, [text](url).
function inline(text: string, key: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /\*\*([^*]+)\*\*|\[([^\]]+)\]\((https?:\/\/[^)\s]+|\/[^)\s]*)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1]) out.push(<strong key={`${key}b${n++}`}>{m[1]}</strong>);
    else {
      const ext = m[3].startsWith('http');
      out.push(
        <a key={`${key}a${n++}`} href={m[3]} {...(ext ? { rel: 'noopener noreferrer' } : {})}>
          {m[2]}
        </a>,
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export default function Prose({ body }: { body: string }) {
  const blocks = body.replace(/\r\n/g, '\n').split(/\n{2,}/);
  return (
    <div className="prose">
      {blocks.map((b, i) => {
        const t = b.trim();
        if (!t) return null;
        if (t.startsWith('### ')) return <h3 key={i}>{inline(t.slice(4), `h${i}`)}</h3>;
        if (t.startsWith('## ')) return <h2 key={i}>{inline(t.slice(3), `h${i}`)}</h2>;
        if (/^[-*] /.test(t)) {
          const items = t.split('\n').filter((l) => /^[-*] /.test(l));
          return <ul key={i}>{items.map((l, j) => <li key={j}>{inline(l.slice(2), `l${i}-${j}`)}</li>)}</ul>;
        }
        return <p key={i}>{inline(t.replace(/\n/g, ' '), `p${i}`)}</p>;
      })}
    </div>
  );
}
