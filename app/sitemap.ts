import type { MetadataRoute } from 'next';
import { listScoredTickers } from '@/lib/supabase-server';
import { fetchLayoffEvents } from '@/lib/events/layoffs';
import { listArticles } from '@/lib/content';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const staticEntries: MetadataRoute.Sitemap = [
    { url: 'https://ejectseat.io/', changeFrequency: 'hourly', priority: 1 },
    { url: 'https://ejectseat.io/layoffs', changeFrequency: 'hourly', priority: 0.9 },
    { url: 'https://ejectseat.io/warn', changeFrequency: 'daily', priority: 0.8 },
    { url: 'https://ejectseat.io/insights', changeFrequency: 'daily', priority: 0.8 },
    { url: 'https://ejectseat.io/about', changeFrequency: 'monthly', priority: 0.5 },
    { url: 'https://ejectseat.io/check.html', changeFrequency: 'weekly', priority: 0.6 },
    { url: 'https://ejectseat.io/how.html', changeFrequency: 'monthly', priority: 0.5 },
    { url: 'https://ejectseat.io/privacy.html', changeFrequency: 'yearly', priority: 0.1 },
    { url: 'https://ejectseat.io/terms.html', changeFrequency: 'yearly', priority: 0.1 },
  ];

  let companyEntries: MetadataRoute.Sitemap = [];
  try {
    const rows = await listScoredTickers();
    const seen = new Set<string>();
    companyEntries = rows
      .filter((r) => {
        const t = (r.ticker || '').toUpperCase();
        if (!t || seen.has(t)) return false;
        seen.add(t);
        return true;
      })
      .map((r) => ({
        url: `https://ejectseat.io/company/${r.ticker!.toUpperCase()}`,
        lastModified: r.cached_at ? new Date(r.cached_at) : undefined,
        changeFrequency: 'daily' as const,
        priority: 0.8,
      }));
  } catch {
    // DB unreachable at build/request time — ship the static entries only.
  }

  // One layoff-history page per ticker that filed an Item 2.05 8-K in the last 120 days.
  let historyEntries: MetadataRoute.Sitemap = [];
  try {
    const events = await fetchLayoffEvents({ days: 120, limit: 100 });
    const seen = new Set<string>();
    for (const e of events) {
      if (!e.ticker || seen.has(e.ticker)) continue;
      seen.add(e.ticker);
      historyEntries.push({ url: `https://ejectseat.io/layoffs/${e.ticker}`, lastModified: new Date(e.filedAt + 'T00:00:00Z'), changeFrequency: 'weekly', priority: 0.7 });
    }
  } catch {
    // SEC unreachable — skip history pages this time.
  }

  const articleEntries: MetadataRoute.Sitemap = listArticles().map((a) => ({
    url: `https://ejectseat.io/insights/${a.slug}`,
    lastModified: new Date(a.updated + 'T00:00:00Z'),
    changeFrequency: 'monthly' as const,
    priority: 0.7,
  }));

  return [...staticEntries, ...articleEntries, ...historyEntries, ...companyEntries];
}
