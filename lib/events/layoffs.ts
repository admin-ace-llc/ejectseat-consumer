// lib/events/layoffs.ts — the news layer.
//
// Every US-listed company that files an 8-K with Item 2.05 ("Costs Associated
// with Exit or Disposal Activities") is a first-hand, primary-source layoff or
// restructuring event. We read them straight from SEC EDGAR, parse the item
// text deterministically (lib/events/parse.ts) and serve them as a news feed.
// No LLM and no database are required, so the feed is cheap, fresh and never
// blocked behind the (expensive) risk-scoring pipeline.

import { buildHeadline, extractItem205, htmlToText, parseDisplayName, parseItem205, prettyName, EventKind } from './parse';

const EFTS = 'https://efts.sec.gov/LATEST/search-index';
const UA = 'EjectSeat/1.0 (enquiries.talkace@gmail.com)';

export interface LayoffEvent {
  id: string;                 // accession number
  name: string;
  ticker: string | null;
  cik: string | null;
  filedAt: string;            // YYYY-MM-DD
  kind: EventKind;
  headline: string;
  summary: string;
  pctWorkforce: number | null;
  employees: number | null;
  chargesUsdM: number | null;
  chargesMaxUsdM: number | null;
  filingUrl: string;          // the 8-K itself on sec.gov
  items: string[];
}

interface EftsHit {
  _id: string; // "<adsh>:<filename>"
  _source: {
    adsh: string;
    display_names?: string[];
    file_date: string;
    file_type?: string;
    form?: string;
    items?: string[];
    ciks?: string[];
  };
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

async function getJson(url: string, revalidate: number): Promise<any | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(7000),
      next: { revalidate },
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

async function getText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(7000),
      next: { revalidate: 60 * 60 * 24 * 7 }, // filings never change
    });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}

function filingUrl(cik: string, adsh: string, file: string): string {
  return `https://www.sec.gov/Archives/edgar/data/${parseInt(cik, 10)}/${adsh.replace(/-/g, '')}/${file}`;
}

/** Run `fn` over `items` with a small concurrency cap (SEC asks for ≤10 req/s). */
async function pool<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    }),
  );
  return out;
}

const PHRASE = encodeURIComponent('"Costs Associated with Exit or Disposal Activities"');

/** Turn EFTS hits into events: one main document per filing, Item 2.05 only, newest first. */
async function hitsToEvents(hits: EftsHit[], limit: number): Promise<LayoffEvent[]> {
  const byAdsh = new Map<string, EftsHit>();
  for (const h of hits) {
    const s = h._source;
    if (!s?.adsh || !(s.items ?? []).includes('2.05')) continue;
    const isMain = (s.file_type ?? '') === '8-K' || h._id.split(':')[1]?.includes('8k');
    const prev = byAdsh.get(s.adsh);
    if (!prev || (isMain && prev._source.file_type !== '8-K')) byAdsh.set(s.adsh, h);
  }

  const picked = [...byAdsh.values()]
    .sort((a, b) => b._source.file_date.localeCompare(a._source.file_date))
    .slice(0, limit);

  const events = await pool(picked, 4, async (h): Promise<LayoffEvent | null> => {
    const s = h._source;
    const parsedName = parseDisplayName(s.display_names?.[0] ?? '');
    const { ticker, cik } = parsedName;
    const name = prettyName(parsedName.name);
    const cikRaw = cik ?? s.ciks?.[0] ?? null;
    const file = h._id.split(':')[1];
    if (!name || !cikRaw || !file) return null;

    const url = filingUrl(cikRaw, s.adsh, file);
    const html = await getText(url);
    const section = html ? extractItem205(htmlToText(html)) : null;
    if (!section) return null; // can't verify the item text → don't publish it

    const parsed = parseItem205(section);
    return {
      id: s.adsh,
      name,
      ticker,
      cik: cikRaw,
      filedAt: s.file_date,
      kind: parsed.kind,
      headline: buildHeadline(name, parsed),
      summary: parsed.summary,
      pctWorkforce: parsed.pctWorkforce,
      employees: parsed.employees,
      chargesUsdM: parsed.chargesUsdM,
      chargesMaxUsdM: parsed.chargesMaxUsdM,
      filingUrl: url,
      items: s.items ?? [],
    };
  });
  return events.filter((e): e is LayoffEvent => !!e);
}

/**
 * Latest Item 2.05 8-Ks, newest first.
 * @param days    look-back window (EDGAR ignores startdt without enddt — both are always sent)
 * @param limit   max events returned
 */
export async function fetchLayoffEvents(opts: { days?: number; limit?: number } = {}): Promise<LayoffEvent[]> {
  const days = opts.days ?? 45;
  const limit = opts.limit ?? 40;
  const end = new Date();
  const start = new Date(end.getTime() - days * 86_400_000);
  const base = `${EFTS}?q=${PHRASE}&forms=8-K&dateRange=custom&startdt=${iso(start)}&enddt=${iso(end)}`;
  const pages = await Promise.all([0, 100].map((from) => getJson(`${base}&from=${from}`, 1800)));
  return hitsToEvents(pages.flatMap((p) => p?.hits?.hits ?? []), limit);
}

export interface CompanyRef { name: string; ticker: string; cik: string }

/** Ticker → CIK via SEC's public company list (cached for a day). */
export async function lookupCompany(ticker: string): Promise<CompanyRef | null> {
  const t = ticker.toUpperCase();
  if (!/^[A-Z0-9.\-]{1,10}$/.test(t)) return null;
  const list = await getJson('https://www.sec.gov/files/company_tickers.json', 86_400);
  if (!list) return null;
  const row = Object.values(list as Record<string, { cik_str: number; ticker: string; title: string }>).find((r) => r.ticker.toUpperCase() === t);
  return row ? { name: prettyName(row.title), ticker: row.ticker.toUpperCase(), cik: String(row.cik_str).padStart(10, '0') } : null;
}

/** Every Item 2.05 8-K a company has filed since 2023, newest first. */
export async function fetchCompanyEvents(cik: string, limit = 12): Promise<LayoffEvent[]> {
  const end = new Date();
  const url = `${EFTS}?q=${PHRASE}&forms=8-K&ciks=${cik}&dateRange=custom&startdt=2023-01-01&enddt=${iso(end)}`;
  const page = await getJson(url, 3600);
  return hitsToEvents(page?.hits?.hits ?? [], limit);
}

export function fmtDate(iso: string): string {
  const d = new Date(iso + 'T00:00:00Z');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

export function daysAgo(iso: string): string {
  const d = Math.floor((Date.now() - new Date(iso + 'T00:00:00Z').getTime()) / 86_400_000);
  if (d <= 0) return 'today';
  if (d === 1) return 'yesterday';
  if (d < 14) return `${d} days ago`;
  return `${Math.round(d / 7)} weeks ago`;
}
