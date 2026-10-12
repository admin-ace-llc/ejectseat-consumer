import { NextResponse } from 'next/server';
import { fetchLayoffEvents } from '@/lib/events/layoffs';
import { listArticles } from '@/lib/content';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

// Cheap liveness check for monitoring: is the SEC feed answering and how fresh is it?
export async function GET() {
  const t = Date.now();
  let latest: string | null = null;
  let count = 0;
  let sec = false;
  try {
    const ev = await fetchLayoffEvents({ days: 30, limit: 20 });
    sec = true;
    count = ev.length;
    latest = ev[0]?.filedAt ?? null;
  } catch {}
  const ageDays = latest ? Math.floor((Date.now() - Date.parse(latest + 'T00:00:00Z')) / 86400000) : null;
  const articles = listArticles();
  const ok = sec && count > 0 && (ageDays === null || ageDays <= 10);
  return NextResponse.json(
    { ok, secReachable: sec, events30d: count, latestFiling: latest, latestFilingAgeDays: ageDays, articles: articles.length, latestArticle: articles[0]?.date ?? null, tookMs: Date.now() - t },
    { status: ok ? 200 : 503 },
  );
}
