import type { MetadataRoute } from 'next';
import { listScoredTickers } from '@/lib/supabase-server';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const staticEntries: MetadataRoute.Sitemap = [
    { url: 'https://ejectseat.io/', changeFrequency: 'hourly', priority: 1 },
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

  return [...staticEntries, ...companyEntries];
}
