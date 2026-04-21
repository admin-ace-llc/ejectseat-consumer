// app/api/resolve/route.ts — EjectSeat Consumer
// Fast company name resolution — returns match + confidence in <500ms
// No AI calls. Hits NAME_MAP + EDGAR company_tickers.json only.

import { NextRequest, NextResponse } from 'next/server';

const USER_AGENT  = 'EjectSeat/1.0 (enquiries.talkace@gmail.com)';
const TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';

const NAME_MAP: Record<string, {
  legalName: string; cik: string; ticker: string;
  type?: string; exchange?: string; description?: string;
}> = {
  'google':             { legalName: 'Alphabet Inc.',                        cik: '0001652044', ticker: 'GOOGL', exchange: 'NASDAQ', description: 'Parent company of Google' },
  'alphabet':           { legalName: 'Alphabet Inc.',                        cik: '0001652044', ticker: 'GOOGL', exchange: 'NASDAQ' },
  'facebook':           { legalName: 'Meta Platforms Inc.',                  cik: '0001326801', ticker: 'META',  exchange: 'NASDAQ' },
  'meta':               { legalName: 'Meta Platforms Inc.',                  cik: '0001326801', ticker: 'META',  exchange: 'NASDAQ', description: 'Parent company of Facebook, Instagram, WhatsApp' },
  'amazon':             { legalName: 'Amazon.com Inc.',                      cik: '0001018724', ticker: 'AMZN',  exchange: 'NASDAQ' },
  'apple':              { legalName: 'Apple Inc.',                           cik: '0000320193', ticker: 'AAPL',  exchange: 'NASDAQ' },
  'microsoft':          { legalName: 'Microsoft Corporation',                cik: '0000789019', ticker: 'MSFT',  exchange: 'NASDAQ' },
  'netflix':            { legalName: 'Netflix Inc.',                         cik: '0001065280', ticker: 'NFLX',  exchange: 'NASDAQ' },
  'tesla':              { legalName: 'Tesla Inc.',                           cik: '0001318605', ticker: 'TSLA',  exchange: 'NASDAQ' },
  'nvidia':             { legalName: 'NVIDIA Corporation',                   cik: '0001045810', ticker: 'NVDA',  exchange: 'NASDAQ' },
  'salesforce':         { legalName: 'Salesforce Inc.',                      cik: '0001108524', ticker: 'CRM',   exchange: 'NYSE'   },
  'oracle':             { legalName: 'Oracle Corporation',                   cik: '0001341439', ticker: 'ORCL',  exchange: 'NYSE'   },
  'intel':              { legalName: 'Intel Corporation',                    cik: '0000050863', ticker: 'INTC',  exchange: 'NASDAQ' },
  'cisco':              { legalName: 'Cisco Systems Inc.',                   cik: '0000858877', ticker: 'CSCO',  exchange: 'NASDAQ' },
  'ibm':                { legalName: 'International Business Machines Corp.',cik: '0000051143', ticker: 'IBM',   exchange: 'NYSE'   },
  'uber':               { legalName: 'Uber Technologies Inc.',               cik: '0001543151', ticker: 'UBER',  exchange: 'NYSE'   },
  'lyft':               { legalName: 'Lyft Inc.',                            cik: '0001759509', ticker: 'LYFT',  exchange: 'NASDAQ' },
  'snap':               { legalName: 'Snap Inc.',                            cik: '0001564408', ticker: 'SNAP',  exchange: 'NYSE'   },
  'snapchat':           { legalName: 'Snap Inc.',                            cik: '0001564408', ticker: 'SNAP',  exchange: 'NYSE',  description: 'Parent company of Snapchat' },
  'workday':            { legalName: 'Workday Inc.',                         cik: '0001327811', ticker: 'WDAY',  exchange: 'NASDAQ' },
  'spotify':            { legalName: 'Spotify Technology S.A.',              cik: '0001639920', ticker: 'SPOT',  exchange: 'NYSE',  description: 'Swedish company · NYSE ADR' },
  'shopify':            { legalName: 'Shopify Inc.',                         cik: '0001594805', ticker: 'SHOP',  exchange: 'NYSE',  description: 'Canadian company · NYSE listed' },
  'airbnb':             { legalName: 'Airbnb Inc.',                          cik: '0001559720', ticker: 'ABNB',  exchange: 'NASDAQ' },
  'coinbase':           { legalName: 'Coinbase Global Inc.',                 cik: '0001679788', ticker: 'COIN',  exchange: 'NASDAQ' },
  'palantir':           { legalName: 'Palantir Technologies Inc.',           cik: '0001321655', ticker: 'PLTR',  exchange: 'NYSE'   },
  'cloudflare':         { legalName: 'Cloudflare Inc.',                      cik: '0001477333', ticker: 'NET',   exchange: 'NYSE'   },
  'zoom':               { legalName: 'Zoom Video Communications Inc.',       cik: '0001585521', ticker: 'ZM',    exchange: 'NASDAQ' },
  'datadog':            { legalName: 'Datadog Inc.',                         cik: '0001459417', ticker: 'DDOG',  exchange: 'NASDAQ' },
  'mongodb':            { legalName: 'MongoDB Inc.',                         cik: '0001441816', ticker: 'MDB',   exchange: 'NASDAQ' },
  'twilio':             { legalName: 'Twilio Inc.',                          cik: '0001418819', ticker: 'TWLO',  exchange: 'NYSE'   },
  'servicenow':         { legalName: 'ServiceNow Inc.',                      cik: '0001373670', ticker: 'NOW',   exchange: 'NYSE'   },
  'okta':               { legalName: 'Okta Inc.',                            cik: '0001660134', ticker: 'OKTA',  exchange: 'NASDAQ' },
  'crowdstrike':        { legalName: 'CrowdStrike Holdings Inc.',            cik: '0001535527', ticker: 'CRWD',  exchange: 'NASDAQ' },
  'snowflake':          { legalName: 'Snowflake Inc.',                       cik: '0001640147', ticker: 'SNOW',  exchange: 'NYSE'   },
  'palo alto':          { legalName: 'Palo Alto Networks Inc.',              cik: '0001327567', ticker: 'PANW',  exchange: 'NASDAQ' },
  'palo alto networks': { legalName: 'Palo Alto Networks Inc.',              cik: '0001327567', ticker: 'PANW',  exchange: 'NASDAQ' },
  'atlassian':          { legalName: 'Atlassian Corporation',                cik: '0001650372', ticker: 'TEAM',  exchange: 'NASDAQ', description: 'Australian company · NASDAQ listed' },
  'adobe':              { legalName: 'Adobe Inc.',                           cik: '0000796343', ticker: 'ADBE',  exchange: 'NASDAQ' },
  'novo nordisk':       { legalName: 'Novo Nordisk A/S',                     cik: '0000353278', ticker: 'NVO',   exchange: 'NYSE',  description: 'Danish pharmaceutical company · NYSE ADR' },
  'novonordisk':        { legalName: 'Novo Nordisk A/S',                     cik: '0000353278', ticker: 'NVO',   exchange: 'NYSE',  description: 'Danish pharmaceutical company · NYSE ADR' },
  'marsh mclennan':     { legalName: 'Marsh & McLennan Companies, Inc.',     cik: '0000062709', ticker: 'MMC',   exchange: 'NYSE',  description: 'Insurance broker · "Thrive" programme' },
  'marsh & mclennan':   { legalName: 'Marsh & McLennan Companies, Inc.',     cik: '0000062709', ticker: 'MMC',   exchange: 'NYSE',  description: 'Insurance broker · "Thrive" programme' },
  'mmc':                { legalName: 'Marsh & McLennan Companies, Inc.',     cik: '0000062709', ticker: 'MMC',   exchange: 'NYSE'   },
  'johnson johnson':    { legalName: 'Johnson & Johnson',                     cik: '0000200406', ticker: 'JNJ',   exchange: 'NYSE'   },
  'johnson & johnson':  { legalName: 'Johnson & Johnson',                     cik: '0000200406', ticker: 'JNJ',   exchange: 'NYSE'   },
  'j&j':                { legalName: 'Johnson & Johnson',                     cik: '0000200406', ticker: 'JNJ',   exchange: 'NYSE'   },
  'jpmorgan':           { legalName: 'JPMorgan Chase & Co.',                  cik: '0000019617', ticker: 'JPM',   exchange: 'NYSE'   },
  'jp morgan':          { legalName: 'JPMorgan Chase & Co.',                  cik: '0000019617', ticker: 'JPM',   exchange: 'NYSE'   },
  'goldman sachs':      { legalName: 'Goldman Sachs Group Inc.',              cik: '0000886982', ticker: 'GS',    exchange: 'NYSE'   },
  'boeing':             { legalName: 'Boeing Co.',                            cik: '0000012927', ticker: 'BA',    exchange: 'NYSE'   },
  'walmart':            { legalName: 'Walmart Inc.',                          cik: '0000104169', ticker: 'WMT',   exchange: 'NYSE'   },
  'disney':             { legalName: 'Walt Disney Co.',                       cik: '0001001039', ticker: 'DIS',   exchange: 'NYSE',  description: 'Parent of Disney+, ESPN, theme parks' },
  'walt disney':        { legalName: 'Walt Disney Co.',                       cik: '0001001039', ticker: 'DIS',   exchange: 'NYSE'   },
  'exxon':              { legalName: 'Exxon Mobil Corporation',               cik: '0000034088', ticker: 'XOM',   exchange: 'NYSE'   },
  'exxon mobil':        { legalName: 'Exxon Mobil Corporation',               cik: '0000034088', ticker: 'XOM',   exchange: 'NYSE'   },
  'pfizer':             { legalName: 'Pfizer Inc.',                           cik: '0000078003', ticker: 'PFE',   exchange: 'NYSE'   },
  'chevron':            { legalName: 'Chevron Corporation',                   cik: '0000093410', ticker: 'CVX',   exchange: 'NYSE'   },
  'bank of america':    { legalName: 'Bank of America Corp',                  cik: '0000070858', ticker: 'BAC',   exchange: 'NYSE'   },
  'morgan stanley':     { legalName: 'Morgan Stanley',                        cik: '0000895421', ticker: 'MS',    exchange: 'NYSE'   },
  'wells fargo':        { legalName: 'Wells Fargo & Company',                 cik: '0000072971', ticker: 'WFC',   exchange: 'NYSE'   },
  'blackrock':          { legalName: 'BlackRock Inc.',                        cik: '0001364742', ticker: 'BLK',   exchange: 'NYSE'   },
  'visa':               { legalName: 'Visa Inc.',                             cik: '0001403161', ticker: 'V',     exchange: 'NYSE'   },
  'mastercard':         { legalName: 'Mastercard Incorporated',               cik: '0001391801', ticker: 'MA',    exchange: 'NYSE'   },
  'paypal':             { legalName: 'PayPal Holdings Inc.',                  cik: '0001633917', ticker: 'PYPL',  exchange: 'NASDAQ' },
  'block':              { legalName: 'Block Inc.',                            cik: '0001512673', ticker: 'SQ',    exchange: 'NYSE',  description: 'Parent company of Square and Cash App' },
  'square':             { legalName: 'Block Inc.',                            cik: '0001512673', ticker: 'SQ',    exchange: 'NYSE',  description: 'Now known as Block Inc.' },
  'dow jones':          { legalName: 'INDEX_NOT_COMPANY', cik: '', ticker: 'DJIA', type: 'index', description: 'Market index — not a company. Try searching "Dow Inc." for the chemicals company.' },
  'dow jones industrial average': { legalName: 'INDEX_NOT_COMPANY', cik: '', ticker: 'DJIA', type: 'index', description: 'Market index — not a company.' },
  'djia':               { legalName: 'INDEX_NOT_COMPANY', cik: '', ticker: 'DJIA', type: 'index' },
  's&p 500':            { legalName: 'INDEX_NOT_COMPANY', cik: '', ticker: 'SPX',  type: 'index' },
  'sp500':              { legalName: 'INDEX_NOT_COMPANY', cik: '', ticker: 'SPX',  type: 'index' },
  'nasdaq':             { legalName: 'INDEX_NOT_COMPANY', cik: '', ticker: 'COMP', type: 'index', description: 'Market index — not a company.' },
  'stripe':             { legalName: 'PRIVATE', cik: '', ticker: '', type: 'private' },
  'anthropic':          { legalName: 'PRIVATE', cik: '', ticker: '', type: 'private' },
  'databricks':         { legalName: 'PRIVATE', cik: '', ticker: '', type: 'private' },
  'openai':             { legalName: 'PRIVATE', cik: '', ticker: '', type: 'private' },
  'canva':              { legalName: 'PRIVATE', cik: '', ticker: '', type: 'private' },
  'klarna':             { legalName: 'PRIVATE', cik: '', ticker: '', type: 'private' },
  'revolut':            { legalName: 'PRIVATE', cik: '', ticker: '', type: 'private' },
};

let _tickerMap: any = null;
let _tickerCacheTime = 0;

async function getTickerMap(): Promise<Record<string, any>> {
  if (_tickerMap && Date.now() - _tickerCacheTime < 24 * 3600 * 1000) return _tickerMap;
  try {
    const res = await fetch(TICKERS_URL, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) return {};
    const data = await res.json();
    const map: Record<string, any> = {};
    for (const entry of Object.values(data) as any[]) {
      const ticker = (entry.ticker || '').toLowerCase();
      const name   = (entry.title  || '').toLowerCase();
      const cik    = String(entry.cik_str || '').padStart(10, '0');
      if (ticker) map[ticker] = { cik, legalName: entry.title, ticker: entry.ticker };
      if (name)   map[name]   = { cik, legalName: entry.title, ticker: entry.ticker };
    }
    _tickerMap     = map;
    _tickerCacheTime = Date.now();
    return map;
  } catch { return {}; }
}

export interface ResolveResult {
  confidence:  'high' | 'medium' | 'low';
  matches:     ResolveMatch[];
  inputQuery:  string;
}

export interface ResolveMatch {
  legalName:   string;
  ticker:      string;
  cik:         string;
  exchange?:   string;
  description?: string;
  type:        'public' | 'private' | 'index' | 'unknown';
  source:      'mapped' | 'ticker_json' | 'not_found';
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const query  = searchParams.get('q')?.trim() || '';
  const ticker = searchParams.get('ticker')?.trim() || '';

  if (!query) return NextResponse.json({ error: 'q required' }, { status: 400 });

  const key = query.toLowerCase();

  const mapped = NAME_MAP[key];
  if (mapped) {
    const type = mapped.legalName === 'PRIVATE' ? 'private'
               : mapped.legalName === 'INDEX_NOT_COMPANY' ? 'index'
               : 'public';
    return NextResponse.json({
      confidence: 'high',
      inputQuery: query,
      matches: [{
        legalName:   type === 'public' ? mapped.legalName : query,
        ticker:      mapped.ticker,
        cik:         mapped.cik,
        exchange:    mapped.exchange,
        description: mapped.description,
        type,
        source: 'mapped',
      }],
    } as ResolveResult);
  }

  const tickerMap = await getTickerMap();
  const matches: ResolveMatch[] = [];

  if (ticker) {
    const byTicker = tickerMap[ticker.toLowerCase()];
    if (byTicker) {
      return NextResponse.json({
        confidence: 'high',
        inputQuery: query,
        matches: [{ ...byTicker, type: 'public', source: 'ticker_json' }],
      } as ResolveResult);
    }
  }

  const exactName = tickerMap[key];
  if (exactName) {
    return NextResponse.json({
      confidence: 'high',
      inputQuery: query,
      matches: [{ ...exactName, type: 'public', source: 'ticker_json' }],
    } as ResolveResult);
  }

  // v6.1: smarter fuzzy — prefer starts-with over contains, prefer shorter names
  const startsWithMatches = Object.values(tickerMap).filter((entry: any) =>
    entry.legalName.toLowerCase().startsWith(key)
  ).sort((a: any, b: any) => a.legalName.length - b.legalName.length).slice(0, 4);

  if (startsWithMatches.length > 0) {
    if (startsWithMatches.length === 1) {
      matches.push({ ...startsWithMatches[0], type: 'public', source: 'ticker_json' } as ResolveMatch);
      return NextResponse.json({ confidence: 'high', inputQuery: query, matches } as ResolveResult);
    }
    for (const m of startsWithMatches) {
      matches.push({ ...m, type: 'public', source: 'ticker_json' } as ResolveMatch);
    }
    return NextResponse.json({ confidence: 'medium', inputQuery: query, matches } as ResolveResult);
  }

  const queryWords = key.split(' ').filter(w => w.length > 2);
  const fuzzyMatches = Object.values(tickerMap).filter((entry: any) => {
    const name = entry.legalName.toLowerCase();
    return queryWords.every((w: string) => name.includes(w));
  }).sort((a: any, b: any) => a.legalName.length - b.legalName.length).slice(0, 4);

  if (fuzzyMatches.length === 1) {
    matches.push({ ...fuzzyMatches[0], type: 'public', source: 'ticker_json' } as ResolveMatch);
    return NextResponse.json({
      confidence: 'medium',
      inputQuery: query,
      matches,
    } as ResolveResult);
  }

  if (fuzzyMatches.length > 1) {
    for (const m of fuzzyMatches) {
      matches.push({ ...m, type: 'public', source: 'ticker_json' } as ResolveMatch);
    }
    return NextResponse.json({
      confidence: 'low',
      inputQuery: query,
      matches,
    } as ResolveResult);
  }

  return NextResponse.json({
    confidence: 'low',
    inputQuery: query,
    matches: [{
      legalName:   query,
      ticker:      '',
      cik:         '',
      type:        'unknown',
      source:      'not_found',
      description: 'No SEC listing found. May be private, non-US, or a different spelling.',
    }],
  } as ResolveResult);
}
