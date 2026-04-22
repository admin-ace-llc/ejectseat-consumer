// app/api/resolve/route.ts — EjectSeat Consumer v7 (preserved from v6.1)
// Fast company-name autocomplete / resolution endpoint for the search bar.

import { NextRequest, NextResponse } from 'next/server';

const USER_AGENT = 'EjectSeat/1.0 (enquiries.talkace@gmail.com)';
const TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';

interface ResolvedSuggestion {
  name:       string;
  ticker?:    string;
  cik?:       string;
  category:   'public' | 'private' | 'index' | 'unknown';
  hint?:      string;
}

const CURATED: ResolvedSuggestion[] = [
  { name: 'Alphabet Inc.',             ticker: 'GOOGL', cik: '0001652044', category: 'public' },
  { name: 'Amazon.com Inc.',           ticker: 'AMZN',  cik: '0001018724', category: 'public' },
  { name: 'Apple Inc.',                ticker: 'AAPL',  cik: '0000320193', category: 'public' },
  { name: 'Meta Platforms Inc.',       ticker: 'META',  cik: '0001326801', category: 'public' },
  { name: 'Microsoft Corporation',     ticker: 'MSFT',  cik: '0000789019', category: 'public' },
  { name: 'Netflix Inc.',              ticker: 'NFLX',  cik: '0001065280', category: 'public' },
  { name: 'Tesla Inc.',                ticker: 'TSLA',  cik: '0001318605', category: 'public' },
  { name: 'NVIDIA Corporation',        ticker: 'NVDA',  cik: '0001045810', category: 'public' },
  { name: 'Salesforce Inc.',           ticker: 'CRM',   cik: '0001108524', category: 'public' },
  { name: 'Oracle Corporation',        ticker: 'ORCL',  cik: '0001341439', category: 'public' },
  { name: 'Intel Corporation',         ticker: 'INTC',  cik: '0000050863', category: 'public' },
  { name: 'Snap Inc.',                 ticker: 'SNAP',  cik: '0001564408', category: 'public' },
  { name: 'Spotify Technology S.A.',   ticker: 'SPOT',  cik: '0001639920', category: 'public' },
  { name: 'Airbnb Inc.',               ticker: 'ABNB',  cik: '0001559720', category: 'public' },
  { name: 'Coinbase Global Inc.',      ticker: 'COIN',  cik: '0001679788', category: 'public' },
  { name: 'Palantir Technologies Inc.',ticker: 'PLTR',  cik: '0001321655', category: 'public' },
  { name: 'Cloudflare Inc.',           ticker: 'NET',   cik: '0001477333', category: 'public' },
  { name: 'Marsh & McLennan Companies, Inc.', ticker: 'MMC', cik: '0000062709', category: 'public' },
  { name: 'Novo Nordisk A/S',          ticker: 'NVO',   cik: '0000353278', category: 'public' },
  { name: 'Johnson & Johnson',         ticker: 'JNJ',   cik: '0000200406', category: 'public' },

  // Private
  { name: 'Stripe',    category: 'private', hint: 'Private company — news-only signal available' },
  { name: 'Anthropic', category: 'private', hint: 'Private company — news-only signal available' },
  { name: 'OpenAI',    category: 'private', hint: 'Private company — news-only signal available' },
  { name: 'Databricks',category: 'private', hint: 'Private company — news-only signal available' },
  { name: 'Canva',     category: 'private', hint: 'Private company — news-only signal available' },

  // Indexes — explicitly excluded from scoring
  { name: 'Dow Jones Industrial Average', ticker: 'DJIA', category: 'index',
    hint: 'Market index — EjectSeat scores individual companies only' },
  { name: 'S&P 500',  ticker: 'SPX',  category: 'index',
    hint: 'Market index — EjectSeat scores individual companies only' },
  { name: 'NASDAQ Composite', ticker: 'COMP', category: 'index',
    hint: 'Market index — EjectSeat scores individual companies only' },
];

let tickerCache: Array<{ name: string; ticker: string; cik: string }> | null = null;
let tickerCacheAt = 0;

async function loadTickerList(): Promise<Array<{ name: string; ticker: string; cik: string }>> {
  if (tickerCache && Date.now() - tickerCacheAt < 24 * 3600 * 1000) return tickerCache;
  try {
    const res = await fetch(TICKERS_URL, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) return tickerCache || [];
    const data = await res.json();
    const entries = Object.values(data) as any[];
    tickerCache = entries.map(e => ({
      name:   e.title,
      ticker: e.ticker,
      cik:    String(e.cik_str).padStart(10, '0'),
    }));
    tickerCacheAt = Date.now();
    return tickerCache;
  } catch {
    return tickerCache || [];
  }
}

export async function GET(req: NextRequest) {
  try {
    const q = (new URL(req.url).searchParams.get('q') || '').trim().toLowerCase();
    if (!q || q.length < 2) return NextResponse.json({ suggestions: [] });

    const curated = CURATED.filter(c =>
      c.name.toLowerCase().includes(q) ||
      (c.ticker && c.ticker.toLowerCase().includes(q))
    ).slice(0, 6);

    let sec: ResolvedSuggestion[] = [];
    if (curated.length < 6) {
      const list = await loadTickerList();
      sec = list
        .filter(e => e.name.toLowerCase().includes(q) || e.ticker.toLowerCase().includes(q))
        .sort((a, b) => {
          const aExact = a.ticker.toLowerCase() === q || a.name.toLowerCase().startsWith(q) ? 0 : 1;
          const bExact = b.ticker.toLowerCase() === q || b.name.toLowerCase().startsWith(q) ? 0 : 1;
          if (aExact !== bExact) return aExact - bExact;
          return a.name.length - b.name.length;
        })
        .slice(0, 6 - curated.length)
        .map(e => ({
          name: e.name, ticker: e.ticker, cik: e.cik, category: 'public' as const,
        }));
    }

    const seen = new Set(curated.map(c => c.name.toLowerCase()));
    const merged = [
      ...curated,
      ...sec.filter(s => !seen.has(s.name.toLowerCase())),
    ].slice(0, 8);

    return NextResponse.json({ suggestions: merged });
  } catch (err: any) {
    console.error('[resolve] error:', err);
    return NextResponse.json({ suggestions: [] });
  }
}
