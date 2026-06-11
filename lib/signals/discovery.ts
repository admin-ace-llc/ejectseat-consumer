// lib/signals/discovery.ts — EjectSeat Consumer v7
//
// NEW MODULE — "Active Layoffs" discovery layer.
//
// Unlike the rest of lib/signals/*, this module is NOT part of the per-company
// /api/score evidence bundle. It runs from a scheduled cron job and answers a
// different question: "which companies, across the ENTIRE market, have fresh
// layoff-related signals RIGHT NOW — regardless of whether anyone has searched
// them on EjectSeat?"
//
// Two independent discovery sources, merged and deduped:
//   1. SEC EDGAR full-text search — scans ALL 8-K / 10-K / 10-Q filings filed
//      in the lookback window for layoff/restructuring language (Items 2.05 /
//      2.06 are the classic "exit or disposal costs" / "material impairments"
//      triggers, but we also full-text match broader language since v7's
//      philosophy is "don't filter by item number, read the text").
//   2. Tier A/B media — Google News RSS, same tiering rules as news.ts, broad
//      "layoffs announced" queries (not company-scoped, since we don't know
//      the company yet — that's the point).
//
// Output is a deduped list of { companyName, ticker, cik, sourceType, sourceRef,
// filedAt } candidates. The cron route then runs each candidate through the
// EXISTING /api/score pipeline (10-K/10-Q/8-K + transcripts + Tier A/B/C news)
// — so the final score is just as comprehensive as a user-triggered search.
// Discovery only decides WHO to score, not HOW.

const UA = 'EjectSeat/1.0 (enquiries.talkace@gmail.com)';

export type DiscoverySourceType = 'sec_8k' | 'sec_10k' | 'sec_10q' | 'media';

export interface DiscoveryCandidate {
  companyName: string;
  ticker:      string | null;
  cik:         string | null;
  sourceType:  DiscoverySourceType;
  sourceRef:   string;   // accession number or article URL
  filedAt:     string;   // YYYY-MM-DD
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. SEC EDGAR full-text search
// ─────────────────────────────────────────────────────────────────────────────

// Full-text search phrases. Kept broad on purpose — v7's whole thesis is that
// item-number filtering misses real disclosures (the "Snap bug"). The scoring
// pipeline does the actual judgment call; discovery just needs to be inclusive.
const EDGAR_FTS_QUERIES: string[] = [
  '"workforce reduction"',
  '"reduction in force"',
  '"restructuring plan"',
  '"headcount reduction"',
  '"plan of reorganization"',
  '"exit or disposal"',
];

const EDGAR_FORMS = ['8-K', '10-K', '10-Q'];

interface EdgarFtsHit {
  _id: string;
  _source: {
    display_names: string[];   // e.g. ["SNAP INC (CIK 0001564408)"]
    form: string;
    file_date: string;
    adsh: string;               // accession number
    ciks?: string[];
  };
}

function formToSourceType(form: string): DiscoverySourceType {
  if (form.startsWith('10-K')) return 'sec_10k';
  if (form.startsWith('10-Q')) return 'sec_10q';
  return 'sec_8k';
}

function parseDisplayName(displayName: string): { name: string; cik: string | null } {
  // "SNAP INC (CIK 0001564408)" → { name: "SNAP INC", cik: "0001564408" }
  const m = displayName.match(/^(.*?)\s*\(CIK\s*(\d+)\)\s*$/);
  if (m) return { name: m[1].trim(), cik: m[2] };
  return { name: displayName.trim(), cik: null };
}

/**
 * Query SEC EDGAR's full-text search for filings in the last `lookbackHours`
 * matching layoff-related language. Returns one candidate per matching filing.
 *
 * Docs: https://www.sec.gov/cgi-bin/browse-edgar (legacy) — v7 uses the modern
 * full-text search index at efts.sec.gov, which covers filings since 2001 and
 * supports `startdt`/`enddt` date filters.
 */
export async function discoverFromEdgar(lookbackHours: number = 6): Promise<DiscoveryCandidate[]> {
  const out: DiscoveryCandidate[] = [];
  const seen = new Set<string>(); // dedupe by accession number

  const now = new Date();
  const start = new Date(now.getTime() - lookbackHours * 3_600_000);
  const startdt = start.toISOString().slice(0, 10);
  const enddt = now.toISOString().slice(0, 10);

  for (const q of EDGAR_FTS_QUERIES) {
    for (const form of EDGAR_FORMS) {
      try {
        const url = `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(q)}&forms=${form}&startdt=${startdt}&enddt=${enddt}`;
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 8000);
        const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' }, signal: controller.signal });
        clearTimeout(t);
        if (!res.ok) continue;

        const json = await res.json();
        const hits: EdgarFtsHit[] = json?.hits?.hits || [];

        for (const hit of hits) {
          const adsh = hit._source?.adsh;
          if (!adsh || seen.has(adsh)) continue;
          seen.add(adsh);

          const displayName = hit._source?.display_names?.[0] || '';
          const { name, cik } = parseDisplayName(displayName);
          if (!name) continue;

          out.push({
            companyName: name,
            ticker:      null, // resolved later by validateCompany() in the cron route
            cik,
            sourceType:  formToSourceType(hit._source?.form || form),
            sourceRef:   `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=${form}&accession_number=${adsh}`,
            filedAt:     hit._source?.file_date || enddt,
          });
        }
      } catch (err: any) {
        console.error(`[discovery] EDGAR FTS failed for "${q}" / ${form}:`, err?.message || err);
      }
    }
  }

  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Tier A/B media — broad layoff-announcement scan (not company-scoped)
// ─────────────────────────────────────────────────────────────────────────────

const TIER_A_NAMES = ['reuters', 'bloomberg', 'financial times', 'wall street journal', 'wsj', 'associated press', 'ap news', 'marketwatch'];
const TIER_B_NAMES = ['cnbc', 'the information', 'techcrunch', 'axios', 'fortune', 'business insider', 'variety'];
const TIER_A_URLS  = ['reuters.com', 'bloomberg.com', 'ft.com', 'wsj.com', 'marketwatch.com', 'apnews.com'];
const TIER_B_URLS  = ['cnbc.com', 'theinformation.com', 'techcrunch.com', 'axios.com', 'fortune.com', 'businessinsider.com', 'variety.com'];

const MEDIA_QUERIES = [
  '"layoffs" announced',
  '"job cuts" company',
  '"workforce reduction" announces',
  '"to lay off" employees',
];

// Heuristic company-name extractor: looks for capitalized sequences before a
// layoff verb, e.g. "Acme Corp to lay off 500 employees" → "Acme Corp".
// Deliberately conservative — false negatives are fine (EDGAR is the primary
// source for company-level data); false positives would pollute the feed.
const COMPANY_BEFORE_VERB = /([A-Z][A-Za-z0-9&.,'-]*(?:\s+[A-Z][A-Za-z0-9&.,'-]*){0,4})\s+(?:to lay off|lays off|laying off|to cut|cuts|announces layoffs|will cut|plans to cut|is cutting)/;

function isTierAOrB(item: { link?: string; source?: string; title?: string }): 'tier_a' | 'tier_b' | null {
  const url = (item.link || '').toLowerCase();
  const combined = `${(item.title || '').toLowerCase()} ${(item.source || '').toLowerCase()}`;
  if (TIER_A_URLS.some(d => url.includes(d)) || TIER_A_NAMES.some(n => combined.includes(n))) return 'tier_a';
  if (TIER_B_URLS.some(d => url.includes(d)) || TIER_B_NAMES.some(n => combined.includes(n))) return 'tier_b';
  return null;
}

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
    for (const block of blocks.slice(0, 15)) {
      const title = block.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)?.[1]
                  || block.match(/<title>(.*?)<\/title>/)?.[1] || '';
      const link  = block.match(/<link>(.*?)<\/link>/)?.[1] || '';
      const pubDate = block.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] || '';
      const source  = block.match(/<source[^>]*>(.*?)<\/source>/)?.[1] || '';
      if (title && link) items.push({ title, link, pubDate, source });
    }
    return items;
  } catch { return []; }
}

/**
 * Scans recent Tier A/B media for layoff announcements and extracts company
 * names heuristically. This is intentionally a SECONDARY source — most
 * candidates will come from EDGAR. Media catches large private companies and
 * gives earlier signal (announcements often precede the 8-K by days).
 */
export async function discoverFromMedia(maxAgeHours: number = 24): Promise<DiscoveryCandidate[]> {
  const out: DiscoveryCandidate[] = [];
  const seen = new Set<string>();
  const cutoff = Date.now() - maxAgeHours * 3_600_000;

  const resultGroups = await Promise.all(MEDIA_QUERIES.map(q => fetchGoogleNewsRSS(q)));
  for (const items of resultGroups) {
    for (const item of items) {
      const tier = isTierAOrB(item);
      if (!tier) continue;

      const pub = item.pubDate ? new Date(item.pubDate).getTime() : Date.now();
      if (pub < cutoff) continue;

      const m = (item.title || '').match(COMPANY_BEFORE_VERB);
      if (!m) continue;
      const companyName = m[1].trim();
      if (companyName.length < 3 || companyName.length > 60) continue;

      const dedupeKey = companyName.toLowerCase();
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      out.push({
        companyName,
        ticker: null,
        cik: null,
        sourceType: 'media',
        sourceRef: item.link || '',
        filedAt: new Date(pub).toISOString().slice(0, 10),
      });
    }
  }

  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Combined entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Runs both discovery sources and merges, deduping by normalised company name
 * (EDGAR results win on conflict since they carry a CIK).
 */
export async function discoverActiveLayoffCandidates(opts?: {
  edgarLookbackHours?: number;
  mediaLookbackHours?: number;
}): Promise<DiscoveryCandidate[]> {
  const [edgar, media] = await Promise.all([
    discoverFromEdgar(opts?.edgarLookbackHours ?? 26),
    discoverFromMedia(opts?.mediaLookbackHours ?? 26),
  ]);

  const byName = new Map<string, DiscoveryCandidate>();
  for (const c of [...edgar, ...media]) {
    const key = c.companyName.toLowerCase().replace(/[.,]/g, '').replace(/\s+(inc|corp|corporation|co|llc|ltd|plc)\.?$/, '').trim();
    const existing = byName.get(key);
    if (!existing || (existing.cik === null && c.cik !== null)) {
      byName.set(key, c);
    }
  }

  return Array.from(byName.values());
}
