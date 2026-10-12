import { listArticles } from '@/lib/content';

export const revalidate = 3600;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export async function GET() {
  const items = listArticles().slice(0, 30).map((a) => `<item>
<title>${esc(a.title)}</title>
<link>https://ejectseat.io/insights/${a.slug}</link>
<guid isPermaLink="true">https://ejectseat.io/insights/${a.slug}</guid>
<pubDate>${new Date(a.date + 'T12:00:00Z').toUTCString()}</pubDate>
<description>${esc(a.description)}</description>
</item>`).join('\n');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel>
<title>EjectSeat — layoff analysis</title>
<link>https://ejectseat.io/insights</link>
<atom:link href="https://ejectseat.io/insights/feed.xml" rel="self" type="application/rss+xml"/>
<description>Analysis and guides built on SEC filings and WARN notices.</description>
<language>en-us</language>
${items}
</channel></rss>`;
  return new Response(xml, { headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' } });
}
