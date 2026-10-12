import { fetchLayoffEvents } from '@/lib/events/layoffs';

export const revalidate = 900;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export async function GET() {
  const events = await fetchLayoffEvents({ days: 60, limit: 50 });
  const items = events
    .map(
      (e) => `<item>
<title>${esc(e.headline)}</title>
<link>${esc(e.filingUrl)}</link>
<guid isPermaLink="false">sec-${esc(e.id)}</guid>
<pubDate>${new Date(e.filedAt + 'T12:00:00Z').toUTCString()}</pubDate>
<description>${esc(`${e.name}${e.ticker ? ' (' + e.ticker + ')' : ''}: ${e.summary}`)}</description>
</item>`,
    )
    .join('\n');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel>
<title>EjectSeat — latest layoffs from SEC filings</title>
<link>https://ejectseat.io/layoffs</link>
<atom:link href="https://ejectseat.io/layoffs/feed.xml" rel="self" type="application/rss+xml"/>
<description>US public-company layoffs and restructurings disclosed in SEC 8-K Item 2.05 filings.</description>
<language>en-us</language>
${items}
</channel></rss>`;
  return new Response(xml, {
    headers: { 'Content-Type': 'application/rss+xml; charset=utf-8', 'Cache-Control': 'public, s-maxage=900, stale-while-revalidate=3600' },
  });
}
