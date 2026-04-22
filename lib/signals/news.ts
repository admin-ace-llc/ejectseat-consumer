// lib/signals/news.ts — EjectSeat Consumer v7
//
// ROLE CHANGE vs v5/v6.1:
//   v5 scored each article with tier weights, escalation type, age decay.
//   v7 is a thin fetcher. News goes into the evidence bundle as structured
//   NewsEvidence records. Sonnet reads and weighs them contextually alongside
//   filings and transcripts.
//
// Exports:
//   - fetchRecentNews(company, days) → NewsEvidence[] for the bundle
//   - fetchRecentHeadlines(company) → string[] (preserved shape for legacy callers)
//   - collectMediaSignals(...) → preserved for v5 fallback, delegates to v7

import type { NewsEvidence, Signal } from '@/types';

const UA = 'EjectSeat/1.0 (enquiries.talkace@gmail.com)';

// Source tiering — preserved from v5 so Sonnet has this context
const TIER_A_URLS  = ['reuters.com','bloomberg.com','ft.com','wsj.com','marketwatch.com','apnews.com'];
const TIER_B_URLS  = ['cnbc.com','theinformation.com','techcrunch.com','axios.com','fortune.com','businessinsider.com','variety.com','theverge.com'];
const TIER_C_URLS  = ['arstechnica.com','wired.com','venturebeat.com','semafor.com','hollywoodreporter.com','zdnet.com','cnet.com'];

const TIER_A_NAMES = ['reuters','bloomberg','financial times','wall street journal','wsj','associated press','ap news','marketwatch'];
const TIER_B_NAMES = ['cnbc','the information','techcrunch','axios','fortune','business insider','variety'];
const TIER_C_NAMES = ['the verge','ars technica','wired','venturebeat','semafor','hollywood reporter','zdnet','cnet'];

function detectTier(item: { link?: string; source?: string; title?: string; description?: string }): 'tier_a' | 'tier_b' | 'tier_c' | 'excluded' {
  const url = (item.link || '').toLowerCase();
  const src = (item.source || '').toLowerCase();
  const combined = `${(item.title || '').toLowerCase()} ${(item.description || '').toLowerCase()} ${src}`;
  if (TIER_A_URLS.some(d => url.includes(d)) || TIER_A_NAMES.some(n => combined.includes(n))) return 'tier_a';
  if (TIER_B_URLS.some(d => url.includes(d)) || TIER_B_NAMES.some(n => combined.includes(n))) return 'tier_b';
  if (TIER_C_URLS.some(d => url.includes(d)) || TIER_C_NAMES.some(n => combined.includes(n))) return 'tier_c';
  return 'excluded';
}

function domainFromTier(tier: 'tier_a'|'tier_b'|'tier_c'): string[] {
  if (tier === 'tier_a') return TIER_A_URLS;
  if (tier === 'tier_b') return TIER_B_URLS;
  return TIER_C_URLS;
}

// Keyword filter to remove obviously off-topic results before bundling
const TOPIC_KEYWORDS = [
  'layoff','laid off','job cut','workforce','reduction in force','rif',
  'restructur','severance','headcount','retrench','reorgani',
  'activist','shareholder','cost cut','cost saving','cost reduction',
  'profitab','savings','right-siz','rightsiz','streamlin','downsiz',
  'thrive','transformation','efficiency','optimiz',
  'bankruptcy','chapter 11','chapter 7','chapter 15','voluntary petition','debtor',
  'closure','plant','facility','furlough','hiring freeze',
];

function hasTopicKeyword(text: string): boolean {
  const lower = text.toLowerCase();
  return TOPIC_KEYWORDS.some(kw => lower.includes(kw));
}

const SEARCH_QUERIES = (company: string): string[] => [
  `"${company}" layoffs OR "job cuts" OR "workforce reduction" OR "reduction in force"`,
  `"${company}" restructuring OR severance OR "headcount reduction" OR downsizing`,
  `"${company}" "activist investor" OR "shareholder pressure" OR "cost cutting" OR "cost savings"`,
  `"${company}" "path to profitability" OR "annualized savings" OR bankruptcy OR "Chapter 11"`,
];

async function fetchGoogleNewsRSS(query: string): Promise<any[]> {
  try {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: controller.signal });
    clearTimeout(t);
    if (!res.ok) return [];
    const xml = await res.text();
    const items: any[] = [];
    const blocks = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
    for (const block of blocks.slice(0, 10)) {
      const title   = block.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)?.[1]
                   || block.match(/<title>(.*?)<\/title>/)?.[1] || '';
      const link    = block.match(/<link>(.*?)<\/link>/)?.[1]
                   || block.match(/<guid[^>]*>(.*?)<\/guid>/)?.[1] || '';
      const pubDate = block.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] || '';
      const desc    = block.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/)?.[1]
                   || block.match(/<description>(.*?)<\/description>/)?.[1] || '';
      const source  = block.match(/<source[^>]*>(.*?)<\/source>/)?.[1] || '';
      if (title && link) items.push({ title, link, pubDate, description: desc, source });
    }
    return items;
  } catch { return []; }
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC — fetchRecentNews: structured NewsEvidence[] for the bundle
// ─────────────────────────────────────────────────────────────────────────────

export async function fetchRecentNews(company: string, maxAgeDays: number = 30): Promise<NewsEvidence[]> {
  try {
    const queries = SEARCH_QUERIES(company);
    const resultGroups = await Promise.all(queries.map(q => fetchGoogleNewsRSS(q)));
    const all = resultGroups.flat();

    const seenTitles = new Set<string>();
    const out: NewsEvidence[] = [];
    const cutoff = Date.now() - maxAgeDays * 86_400_000;

    for (const item of all) {
      const titleKey = (item.title || '').slice(0, 80).toLowerCase();
      if (seenTitles.has(titleKey)) continue;
      seenTitles.add(titleKey);

      const combined = `${item.title || ''}. ${item.description || ''}`;
      if (!hasTopicKeyword(combined)) continue;

      const tier = detectTier(item);
      if (tier === 'excluded') continue;

      const pub = item.pubDate ? new Date(item.pubDate).getTime() : Date.now();
      if (pub < cutoff) continue;
      const pubDateStr = new Date(pub).toISOString().slice(0, 10);

      // Figure out the source label. Prefer URL-matched domain, else source text
      const url = (item.link || '').toLowerCase();
      const domains = domainFromTier(tier);
      const matchedDomain = domains.find(d => url.includes(d));
      const sourceLabel = matchedDomain || (item.source || 'News');

      out.push({
        title:       item.title || '',
        link:        item.link || '',
        pubDate:     pubDateStr,
        source:      sourceLabel,
        tier,
        description: (item.description || '').slice(0, 500),
      });

      if (out.length >= 14) break;
    }

    // Sort newest first
    out.sort((a, b) => Date.parse(b.pubDate) - Date.parse(a.pubDate));
    return out.slice(0, 12);
  } catch (err: any) {
    console.error('[news] fetchRecentNews failed:', err?.message || err);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC — fetchRecentHeadlines (legacy shape preserved)
// Used by v5 fallback path for classifyCompanyState text context.
// ─────────────────────────────────────────────────────────────────────────────

export async function fetchRecentHeadlines(company: string): Promise<string[]> {
  try {
    const items = await fetchGoogleNewsRSS(`"${company}" layoffs OR restructuring OR "job cuts" OR "workforce reduction"`);
    return items.slice(0, 10).map(i =>
      `${i.source ? i.source + ': ' : ''}${i.title}${i.pubDate ? ' (' + new Date(i.pubDate).toDateString() + ')' : ''}`
    );
  } catch { return []; }
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPATIBILITY — collectMediaSignals (v5 shape, used by fallback path)
// Returns audit-strip-only Signal[]; scoring no longer happens here.
// ─────────────────────────────────────────────────────────────────────────────

export async function collectMediaSignals(
  company: string,
  _state?: any,
): Promise<Signal[]> {
  const news = await fetchRecentNews(company, 30);
  return news.slice(0, 6).map(n => ({
    type: 'media_coverage',
    source: n.source,
    sourceTier: n.tier,
    rawPoints: 0, weightedPoints: 0, temporalTag: 'Context',
    alertMessage: n.title.slice(0, 140),
    filingDate: n.pubDate,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Compact news for Sonnet prompt
// ─────────────────────────────────────────────────────────────────────────────

export function compactNewsForPrompt(news: NewsEvidence[]): string {
  if (news.length === 0) return '(no recent Tier A/B/C media found)';
  return news.map(n =>
    `[${n.tier.toUpperCase()}] ${n.source} · ${n.pubDate}\n  ${n.title}\n  ${n.description.slice(0, 200)}\n  URL: ${n.link}`
  ).join('\n\n');
}
