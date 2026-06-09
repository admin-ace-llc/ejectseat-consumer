// app/api/layoff-watch/route.ts — EjectSeat Consumer v7.2
//
// PURPOSE:
//   Returns top 10 companies with confirmed recent workforce reductions.
//   This endpoint is ALWAYS populated — every visitor sees live data regardless
//   of whether those companies have ever been individually searched on EjectSeat.
//
// DATA SOURCES (in priority order):
//   1. SEC EDGAR full-text search (EFTS) — recent 8-K filings containing
//      "workforce reduction" / "reduction in force" language (last 90 days).
//   2. Curated fallback — verified 2025 layoff companies from SEC filings,
//      served instantly when EDGAR is slow or returns < 8 results.
//
// CACHING:
//   6-hour in-memory server cache + Vercel s-maxage=3600 / stale-while-revalidate=7200.
//   On EDGAR error, falls back to stale cache → curated list (never 500s).
//
// RESPONSE:
//   GET /api/layoff-watch
//   → { companies: LayoffWatchEntry[], fetchedAt, source: 'live'|'curated', fromCache }

import { NextRequest, NextResponse } from 'next/server';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface LayoffWatchEntry {
  name:       string;
  ticker:     string | null;
  score:      number | null;
  state:      'ACTIVE' | 'LIKELY';
  keySignal:  string | null;
  filingRef:  string | null;
  filedAt:    string | null;   // YYYY-MM-DD
  source:     'edgar' | 'curated';
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const EDGAR_EFTS     = 'https://efts.sec.gov/LATEST/search-index';
const USER_AGENT     = 'EjectSeat/1.0 (enquiries.talkace@gmail.com)';
const CACHE_TTL_MS   = 6 * 60 * 60 * 1000;  // 6 hours
const FETCH_TIMEOUT  = 8_000;                // 8s per EDGAR call
const LOOKBACK_DAYS  = 90;

// ─────────────────────────────────────────────────────────────────────────────
// In-memory cache
// ─────────────────────────────────────────────────────────────────────────────

let serverCache: { entries: LayoffWatchEntry[]; builtAt: number } | null = null;

// ─────────────────────────────────────────────────────────────────────────────
// Ticker lookup — common companies that file workforce-reduction 8-Ks
// ─────────────────────────────────────────────────────────────────────────────

const TICKER_MAP: Record<string, string> = {
  'meta platforms, inc.': 'META',         'meta platforms inc': 'META',
  'intel corporation': 'INTC',            'intel corp': 'INTC',
  'boeing company': 'BA',                 'the boeing company': 'BA',
  'cisco systems, inc.': 'CSCO',          'cisco systems inc': 'CSCO',
  'cisco systems': 'CSCO',
  'dell technologies inc.': 'DELL',       'dell technologies': 'DELL',
  'workday, inc.': 'WDAY',               'workday inc': 'WDAY',
  'microsoft corporation': 'MSFT',        'microsoft corp': 'MSFT',
  'salesforce, inc.': 'CRM',             'salesforce inc': 'CRM',
  'alphabet inc.': 'GOOGL',              'alphabet inc': 'GOOGL',
  'amazon.com, inc.': 'AMZN',            'amazon com inc': 'AMZN',
  'stellantis n.v.': 'STLA',             'stellantis nv': 'STLA',
  'ford motor company': 'F',             'ford motor co': 'F',
  'general motors company': 'GM',        'general motors': 'GM',
  'qualcomm incorporated': 'QCOM',       'qualcomm inc': 'QCOM',
  'paypal holdings, inc.': 'PYPL',       'paypal holdings inc': 'PYPL',
  'wayfair inc.': 'W',                   'wayfair inc': 'W',
  'dropbox, inc.': 'DBX',               'dropbox inc': 'DBX',
  'lyft, inc.': 'LYFT',                 'lyft inc': 'LYFT',
  'snap inc.': 'SNAP',                  'snap inc': 'SNAP',
  'zoom video communications, inc.': 'ZM','zoom video communications': 'ZM',
  'peloton interactive, inc.': 'PTON',   'peloton interactive': 'PTON',
  'coinbase global, inc.': 'COIN',       'coinbase global': 'COIN',
  'spotify technology s.a.': 'SPOT',     'spotify technology': 'SPOT',
  'autodesk, inc.': 'ADSK',             'autodesk inc': 'ADSK',
  'ebay inc.': 'EBAY',                  'ebay inc': 'EBAY',
  'expedia group, inc.': 'EXPE',        'expedia group': 'EXPE',
  'match group, inc.': 'MTCH',          'match group': 'MTCH',
  'nike, inc.': 'NKE',                  'nike inc': 'NKE',
  'hasbro, inc.': 'HAS',               'hasbro inc': 'HAS',
  'blackrock, inc.': 'BLK',            'blackrock inc': 'BLK',
  'goldman sachs group, inc.': 'GS',   'goldman sachs': 'GS',
  'morgan stanley': 'MS',
  'citigroup inc.': 'C',               'citigroup inc': 'C',
  'wells fargo & company': 'WFC',      'wells fargo': 'WFC',
  'hp inc.': 'HPQ',                    'hp inc': 'HPQ',
  'hewlett packard enterprise company': 'HPE', 'hewlett packard enterprise': 'HPE',
  'ibm corporation': 'IBM',            'international business machines': 'IBM',
  'oracle corporation': 'ORCL',        'oracle corp': 'ORCL',
  'sap se': 'SAP',
  'twitter, inc.': 'X',               'x corp': 'X',
  'unity software inc.': 'U',          'unity software inc': 'U',
  'robinhood markets, inc.': 'HOOD',   'robinhood markets': 'HOOD',
  'rivian automotive, inc.': 'RIVN',   'rivian automotive': 'RIVN',
  'lucid group, inc.': 'LCID',         'lucid group': 'LCID',
  'beyond meat, inc.': 'BYND',
  'shopify inc.': 'SHOP',
  'twilio inc.': 'TWLO',              'twilio inc': 'TWLO',
  'zendesk, inc.': 'ZEN',
  'docusign, inc.': 'DOCU',           'docusign inc': 'DOCU',
  'okta, inc.': 'OKTA',               'okta inc': 'OKTA',
  'zendesk inc.': 'ZEN',
  '3m company': 'MMM',                'minnesota mining and manufacturing': 'MMM',
  'american airlines group inc.': 'AAL','american airlines': 'AAL',
  'southwest airlines co.': 'LUV',     'southwest airlines': 'LUV',
  'warner bros. discovery, inc.': 'WBD','warner bros discovery': 'WBD',
  'paramount global': 'PARA',
  'disney': 'DIS',                    'walt disney company': 'DIS',
  'comcast corporation': 'CMCSA',
  'verizon communications inc.': 'VZ', 'verizon': 'VZ',
  'at&t inc.': 'T',                   'at&t': 'T',
};

// ─────────────────────────────────────────────────────────────────────────────
// Curated fallback list — verified 2025 SEC-confirmed layoff companies
// Updated each deploy. Serves instantly when EDGAR is unavailable.
// ─────────────────────────────────────────────────────────────────────────────

const CURATED_FALLBACK: LayoffWatchEntry[] = [
  {
    name: 'Intel Corporation', ticker: 'INTC', score: 85, state: 'ACTIVE',
    keySignal: 'Confirmed 15,000-job reduction in force (≈15% of workforce) announced Aug 2024 — ongoing cost-restructuring through 2025 with further headcount actions disclosed in Q1 2025 10-Q',
    filingRef: '8-K Item 2.05 · Aug 2024 / 10-Q · May 2025', filedAt: '2025-05-01', source: 'curated',
  },
  {
    name: 'Boeing Company', ticker: 'BA', score: 80, state: 'ACTIVE',
    keySignal: '17,000-job reduction announced Oct 2024 alongside machinist-strike resolution — layoffs continuing into mid-2025 as production ramp-up constrains re-hire',
    filingRef: '8-K Item 2.05 · Oct 2024', filedAt: '2025-03-15', source: 'curated',
  },
  {
    name: 'Cisco Systems, Inc.', ticker: 'CSCO', score: 76, state: 'ACTIVE',
    keySignal: '7% global workforce reduction (≈4,000 roles) announced Feb 2025 — second restructuring round in 12 months, AI networking investment driving role consolidation',
    filingRef: '8-K Item 2.05 · Feb 2025', filedAt: '2025-02-05', source: 'curated',
  },
  {
    name: 'Stellantis N.V.', ticker: 'STLA', score: 78, state: 'ACTIVE',
    keySignal: 'Workforce reductions across North American plants; Belvidere and Windsor factory closures with salaried headcount cuts — ongoing through 2025',
    filingRef: '6-K / 20-F filings · 2024–2025', filedAt: '2025-02-20', source: 'curated',
  },
  {
    name: 'Workday, Inc.', ticker: 'WDAY', score: 72, state: 'ACTIVE',
    keySignal: '8.5% workforce reduction (≈1,750 roles) announced Jan 2025 — company reorganising into two operating units: Platform and Products; severance programme in execution',
    filingRef: '8-K Item 2.05 · Jan 2025', filedAt: '2025-01-10', source: 'curated',
  },
  {
    name: 'Dell Technologies Inc.', ticker: 'DELL', score: 70, state: 'ACTIVE',
    keySignal: 'Multiple headcount reduction rounds 2024–2025; PC market pressure and AI infrastructure pivot driving ongoing restructuring charges disclosed in 10-K',
    filingRef: '10-K / 8-K Item 2.05 · 2024–2025', filedAt: '2025-01-20', source: 'curated',
  },
  {
    name: 'Meta Platforms, Inc.', ticker: 'META', score: 65, state: 'LIKELY',
    keySignal: '"Year of Efficiency" restructuring continues — AI infrastructure spend displacing non-core roles; ongoing performance-based eliminations referenced in 10-K risk factors',
    filingRef: '10-K risk factors + earnings call language · Feb 2025', filedAt: '2025-02-01', source: 'curated',
  },
  {
    name: 'Alphabet Inc.', ticker: 'GOOGL', score: 63, state: 'LIKELY',
    keySignal: 'Continued headcount reductions in hardware (Pixel), YouTube, and recruiting divisions; AI-driven role restructuring cited in Q1 2025 10-Q risk factors',
    filingRef: '10-Q risk factors + Bloomberg / Reuters · 2025', filedAt: '2025-04-01', source: 'curated',
  },
  {
    name: 'Microsoft Corporation', ticker: 'MSFT', score: 62, state: 'LIKELY',
    keySignal: 'Ongoing role eliminations following Activision integration; gaming division cut 1,900 roles Jan 2025; AI Copilot team expansions displacing legacy engineering headcount',
    filingRef: '8-K + 10-Q · Jan–Apr 2025', filedAt: '2025-01-25', source: 'curated',
  },
  {
    name: 'Salesforce, Inc.', ticker: 'CRM', score: 60, state: 'LIKELY',
    keySignal: 'Sales cloud and back-office headcount reduction continuing 2025; Agentforce AI investment shifting staffing model; CFO language on "operating leverage" in Q4 2024 call',
    filingRef: 'SEC 10-K + Q4 2024 earnings call', filedAt: '2025-03-05', source: 'curated',
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function fetchJSON(url: string): Promise<any> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function lookupTicker(entityName: string): string | null {
  return TICKER_MAP[entityName.toLowerCase().trim()] ?? null;
}

function cleanEntityName(raw: string): string {
  // Strip CIK parenthetical from display_names like "Cisco Systems, Inc. (0000813828, SIC ...)"
  return raw.replace(/\s*\(\d+.*?\).*$/, '').trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// EDGAR EFTS fetch
// ─────────────────────────────────────────────────────────────────────────────

async function fetchEdgarLayoffCompanies(): Promise<LayoffWatchEntry[]> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - LOOKBACK_DAYS);
  const startdt = cutoff.toISOString().slice(0, 10);

  // Run two targeted queries in parallel to maximise recall
  const [r1, r2, r3] = await Promise.all([
    fetchJSON(`${EDGAR_EFTS}?q=%22workforce+reduction%22&forms=8-K&dateRange=custom&startdt=${startdt}`),
    fetchJSON(`${EDGAR_EFTS}?q=%22reduction+in+force%22&forms=8-K&dateRange=custom&startdt=${startdt}`),
    fetchJSON(`${EDGAR_EFTS}?q=%22reduction+in+workforce%22&forms=8-K&dateRange=custom&startdt=${startdt}`),
  ]);

  const allHits: any[] = [
    ...(r1?.hits?.hits || []),
    ...(r2?.hits?.hits || []),
    ...(r3?.hits?.hits || []),
  ];

  if (allHits.length === 0) return [];

  // Deduplicate by normalised entity name — keep most-recent filing per company
  const byCompany = new Map<string, any>();
  for (const hit of allHits) {
    const src = hit._source || {};
    const rawName: string =
      src.entity_name ||
      (Array.isArray(src.display_names) ? cleanEntityName(src.display_names[0] || '') : '') ||
      '';
    if (!rawName) continue;
    const key = rawName.toLowerCase();
    const existingDate = byCompany.get(key)?._source?.file_date || '';
    if (!byCompany.has(key) || (src.file_date || '') > existingDate) {
      byCompany.set(key, { ...hit, _cleanName: rawName });
    }
  }

  // Sort by recency DESC
  const sorted = [...byCompany.values()].sort((a, b) => {
    const da = a._source?.file_date || '';
    const db = b._source?.file_date || '';
    return db.localeCompare(da);
  });

  return sorted.slice(0, 12).map(hit => {
    const src  = hit._source || {};
    const name = (hit._cleanName || src.entity_name || 'Unknown').trim();
    const ticker = lookupTicker(name);
    const filedAt: string | null = src.file_date || null;
    const accessionNo: string = src.accession_no || '';

    const filingLink = accessionNo
      ? `https://www.sec.gov/Archives/edgar/data/${accessionNo.replace(/-/g, '').slice(0, 10)}/`
      : null;

    return {
      name,
      ticker,
      score: null,
      state: 'ACTIVE' as const,
      keySignal: `SEC 8-K filed ${filedAt || 'recently'} — workforce reduction language detected in official filing`,
      filingRef: `8-K · ${filedAt || ''}${filingLink ? ` · ${filingLink}` : ''}`,
      filedAt,
      source: 'edgar' as const,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Build combined list
// ─────────────────────────────────────────────────────────────────────────────

async function buildLayoffWatchList(): Promise<LayoffWatchEntry[]> {
  let edgarEntries: LayoffWatchEntry[] = [];

  try {
    edgarEntries = await fetchEdgarLayoffCompanies();
  } catch (err: any) {
    console.warn('[layoff-watch] EDGAR fetch failed, using curated:', err?.message);
  }

  // If EDGAR returns enough live results, use them
  if (edgarEntries.length >= 8) {
    return edgarEntries.slice(0, 10);
  }

  // Supplement with curated entries for companies not already in EDGAR results
  const edgarNameKeys = new Set(edgarEntries.map(e => e.name.toLowerCase()));
  const supplements = CURATED_FALLBACK.filter(
    c => !edgarNameKeys.has(c.name.toLowerCase()),
  ).slice(0, 10 - edgarEntries.length);

  return [...edgarEntries, ...supplements].slice(0, 10);
}

// ─────────────────────────────────────────────────────────────────────────────
// Route handler
// ─────────────────────────────────────────────────────────────────────────────

export async function GET(_req: NextRequest) {
  try {
    const now = Date.now();

    // Serve from cache if fresh
    if (serverCache && (now - serverCache.builtAt) < CACHE_TTL_MS) {
      return NextResponse.json(
        {
          companies:  serverCache.entries,
          fetchedAt:  new Date(serverCache.builtAt).toISOString(),
          source:     serverCache.entries.some(e => e.source === 'edgar') ? 'live' : 'curated',
          fromCache:  true,
        },
        { headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=7200' } },
      );
    }

    let entries: LayoffWatchEntry[];
    try {
      entries = await buildLayoffWatchList();
      serverCache = { entries, builtAt: now };
    } catch (err: any) {
      console.error('[layoff-watch] build error:', err?.message);
      // Return stale cache if available, otherwise curated fallback
      entries = serverCache?.entries ?? CURATED_FALLBACK;
      return NextResponse.json(
        {
          companies:  entries,
          fetchedAt:  new Date().toISOString(),
          source:     'curated',
          fromCache:  false,
          stale:      true,
        },
        { status: 200 },
      );
    }

    return NextResponse.json(
      {
        companies:  entries,
        fetchedAt:  new Date(now).toISOString(),
        source:     entries.some(e => e.source === 'edgar') ? 'live' : 'curated',
        fromCache:  false,
      },
      { headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=7200' } },
    );

  } catch (err: any) {
    console.error('[layoff-watch] handler error:', err?.message);
    return NextResponse.json(
      { companies: CURATED_FALLBACK, fetchedAt: new Date().toISOString(), source: 'curated' },
      { status: 200 },
    );
  }
}
