// lib/signals/company-validator.ts — EjectSeat Consumer v7 (preserved from v6.1)
// Name/ticker → CIK resolution for SEC EDGAR lookups.

import { CompanyEligibility } from '@/types';

const USER_AGENT   = 'EjectSeat/1.0 (enquiries.talkace@gmail.com)';
const TICKERS_URL  = 'https://www.sec.gov/files/company_tickers.json';
const EDGAR_SEARCH = 'https://efts.sec.gov/LATEST/search-index?q=';

const NAME_MAP: Record<string, { legalName: string; cik: string; ticker: string }> = {
  'google':             { legalName: 'Alphabet Inc.',                        cik: '0001652044', ticker: 'GOOGL' },
  'alphabet':           { legalName: 'Alphabet Inc.',                        cik: '0001652044', ticker: 'GOOGL' },
  'facebook':           { legalName: 'Meta Platforms Inc.',                  cik: '0001326801', ticker: 'META'  },
  'meta':               { legalName: 'Meta Platforms Inc.',                  cik: '0001326801', ticker: 'META'  },
  'amazon':             { legalName: 'Amazon.com Inc.',                      cik: '0001018724', ticker: 'AMZN'  },
  'apple':              { legalName: 'Apple Inc.',                           cik: '0000320193', ticker: 'AAPL'  },
  'microsoft':          { legalName: 'Microsoft Corporation',                cik: '0000789019', ticker: 'MSFT'  },
  'netflix':            { legalName: 'Netflix Inc.',                         cik: '0001065280', ticker: 'NFLX'  },
  'tesla':              { legalName: 'Tesla Inc.',                           cik: '0001318605', ticker: 'TSLA'  },
  'nvidia':             { legalName: 'NVIDIA Corporation',                   cik: '0001045810', ticker: 'NVDA'  },
  'salesforce':         { legalName: 'Salesforce Inc.',                      cik: '0001108524', ticker: 'CRM'   },
  'oracle':             { legalName: 'Oracle Corporation',                   cik: '0001341439', ticker: 'ORCL'  },
  'intel':              { legalName: 'Intel Corporation',                    cik: '0000050863', ticker: 'INTC'  },
  'cisco':              { legalName: 'Cisco Systems Inc.',                   cik: '0000858877', ticker: 'CSCO'  },
  'ibm':                { legalName: 'International Business Machines Corp.',cik: '0000051143', ticker: 'IBM'   },
  'uber':               { legalName: 'Uber Technologies Inc.',               cik: '0001543151', ticker: 'UBER'  },
  'lyft':               { legalName: 'Lyft Inc.',                            cik: '0001759509', ticker: 'LYFT'  },
  'snap':               { legalName: 'Snap Inc.',                            cik: '0001564408', ticker: 'SNAP'  },
  'snapchat':           { legalName: 'Snap Inc.',                            cik: '0001564408', ticker: 'SNAP'  },
  'workday':            { legalName: 'Workday Inc.',                         cik: '0001327811', ticker: 'WDAY'  },
  'spotify':            { legalName: 'Spotify Technology S.A.',              cik: '0001639920', ticker: 'SPOT'  },
  'shopify':            { legalName: 'Shopify Inc.',                         cik: '0001594805', ticker: 'SHOP'  },
  'airbnb':             { legalName: 'Airbnb Inc.',                          cik: '0001559720', ticker: 'ABNB'  },
  'coinbase':           { legalName: 'Coinbase Global Inc.',                 cik: '0001679788', ticker: 'COIN'  },
  'palantir':           { legalName: 'Palantir Technologies Inc.',           cik: '0001321655', ticker: 'PLTR'  },
  'cloudflare':         { legalName: 'Cloudflare Inc.',                      cik: '0001477333', ticker: 'NET'   },
  'zoom':               { legalName: 'Zoom Video Communications Inc.',       cik: '0001585521', ticker: 'ZM'    },
  'slack':              { legalName: 'Salesforce Inc.',                      cik: '0001108524', ticker: 'CRM'   },
  'linkedin':           { legalName: 'Microsoft Corporation',                cik: '0000789019', ticker: 'MSFT'  },
  'datadog':            { legalName: 'Datadog Inc.',                         cik: '0001459417', ticker: 'DDOG'  },
  'mongodb':            { legalName: 'MongoDB Inc.',                         cik: '0001441816', ticker: 'MDB'   },
  'twilio':             { legalName: 'Twilio Inc.',                          cik: '0001418819', ticker: 'TWLO'  },
  'servicenow':         { legalName: 'ServiceNow Inc.',                      cik: '0001373670', ticker: 'NOW'   },
  'okta':               { legalName: 'Okta Inc.',                            cik: '0001660134', ticker: 'OKTA'  },
  'crowdstrike':        { legalName: 'CrowdStrike Holdings Inc.',            cik: '0001535527', ticker: 'CRWD'  },
  'snowflake':          { legalName: 'Snowflake Inc.',                       cik: '0001640147', ticker: 'SNOW'  },
  'palo alto':          { legalName: 'Palo Alto Networks Inc.',              cik: '0001327567', ticker: 'PANW'  },
  'palo alto networks': { legalName: 'Palo Alto Networks Inc.',              cik: '0001327567', ticker: 'PANW'  },
  'atlassian':          { legalName: 'Atlassian Corporation',                cik: '0001650372', ticker: 'TEAM'  },
  'adobe':              { legalName: 'Adobe Inc.',                           cik: '0000796343', ticker: 'ADBE'  },
  'marsh mclennan':     { legalName: 'Marsh & McLennan Companies, Inc.',     cik: '0000062709', ticker: 'MMC'   },
  'marsh & mclennan':   { legalName: 'Marsh & McLennan Companies, Inc.',     cik: '0000062709', ticker: 'MMC'   },
  'mmc':                { legalName: 'Marsh & McLennan Companies, Inc.',     cik: '0000062709', ticker: 'MMC'   },
  'novo nordisk':       { legalName: 'Novo Nordisk A/S',                     cik: '0000353278', ticker: 'NVO'   },
  'novonordisk':        { legalName: 'Novo Nordisk A/S',                     cik: '0000353278', ticker: 'NVO'   },
  'johnson johnson':    { legalName: 'Johnson & Johnson',                    cik: '0000200406', ticker: 'JNJ'   },
  'johnson & johnson':  { legalName: 'Johnson & Johnson',                    cik: '0000200406', ticker: 'JNJ'   },
  'j&j':                { legalName: 'Johnson & Johnson',                    cik: '0000200406', ticker: 'JNJ'   },
  'jpmorgan':           { legalName: 'JPMorgan Chase & Co.',                 cik: '0000019617', ticker: 'JPM'   },
  'jp morgan':          { legalName: 'JPMorgan Chase & Co.',                 cik: '0000019617', ticker: 'JPM'   },
  'goldman sachs':      { legalName: 'Goldman Sachs Group Inc.',             cik: '0000886982', ticker: 'GS'    },
  'boeing':             { legalName: 'Boeing Co.',                           cik: '0000012927', ticker: 'BA'    },
  'walmart':            { legalName: 'Walmart Inc.',                         cik: '0000104169', ticker: 'WMT'   },
  'disney':             { legalName: 'Walt Disney Co.',                      cik: '0001001039', ticker: 'DIS'   },
  'walt disney':        { legalName: 'Walt Disney Co.',                      cik: '0001001039', ticker: 'DIS'   },
  'exxon':              { legalName: 'Exxon Mobil Corporation',              cik: '0000034088', ticker: 'XOM'   },
  'exxon mobil':        { legalName: 'Exxon Mobil Corporation',              cik: '0000034088', ticker: 'XOM'   },
  'pfizer':             { legalName: 'Pfizer Inc.',                          cik: '0000078003', ticker: 'PFE'   },
  'chevron':            { legalName: 'Chevron Corporation',                  cik: '0000093410', ticker: 'CVX'   },
  'bank of america':    { legalName: 'Bank of America Corp',                 cik: '0000070858', ticker: 'BAC'   },
  'morgan stanley':     { legalName: 'Morgan Stanley',                       cik: '0000895421', ticker: 'MS'    },
  'wells fargo':        { legalName: 'Wells Fargo & Company',                cik: '0000072971', ticker: 'WFC'   },
  'blackrock':          { legalName: 'BlackRock Inc.',                       cik: '0001364742', ticker: 'BLK'   },
  'visa':               { legalName: 'Visa Inc.',                            cik: '0001403161', ticker: 'V'     },
  'mastercard':         { legalName: 'Mastercard Incorporated',              cik: '0001141391', ticker: 'MA'    },
  'paypal':             { legalName: 'PayPal Holdings Inc.',                 cik: '0001633917', ticker: 'PYPL'  },
  'block':              { legalName: 'Block Inc.',                           cik: '0001512673', ticker: 'SQ'    },
  'square':             { legalName: 'Block Inc.',                           cik: '0001512673', ticker: 'SQ'    },
  'dow jones':          { legalName: 'INDEX_NOT_COMPANY', cik: '', ticker: 'DJIA' },
  'dow jones industrial average': { legalName: 'INDEX_NOT_COMPANY', cik: '', ticker: 'DJIA' },
  'djia':               { legalName: 'INDEX_NOT_COMPANY', cik: '', ticker: 'DJIA' },
  's&p 500':            { legalName: 'INDEX_NOT_COMPANY', cik: '', ticker: 'SPX' },
  'sp500':              { legalName: 'INDEX_NOT_COMPANY', cik: '', ticker: 'SPX' },
  'nasdaq':             { legalName: 'INDEX_NOT_COMPANY', cik: '', ticker: 'COMP' },
  'stripe':             { legalName: 'PRIVATE', cik: '', ticker: '' },
  'anthropic':          { legalName: 'PRIVATE', cik: '', ticker: '' },
  'databricks':         { legalName: 'PRIVATE', cik: '', ticker: '' },
  'openai':             { legalName: 'PRIVATE', cik: '', ticker: '' },
  'canva':              { legalName: 'PRIVATE', cik: '', ticker: '' },
  'klarna':             { legalName: 'PRIVATE', cik: '', ticker: '' },
  'revolut':            { legalName: 'PRIVATE', cik: '', ticker: '' },
  'chime':              { legalName: 'PRIVATE', cik: '', ticker: '' },
};

let tickerCache: Record<string, { cik: string; name: string; ticker: string }> | null = null;
let tickerCacheTime = 0;
const TICKER_CACHE_TTL = 24 * 3600 * 1000;

async function getTickerMap(): Promise<Record<string, { cik: string; name: string; ticker: string }>> {
  if (tickerCache && Date.now() - tickerCacheTime < TICKER_CACHE_TTL) return tickerCache;
  try {
    const res = await fetch(TICKERS_URL, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) return {};
    const data = await res.json();
    const map: Record<string, { cik: string; name: string; ticker: string }> = {};
    for (const entry of Object.values(data) as any[]) {
      const ticker = (entry.ticker || '').toLowerCase();
      const name   = (entry.title  || '').toLowerCase();
      const cik    = String(entry.cik_str || '').padStart(10, '0');
      if (ticker) map[ticker] = { cik, name: entry.title, ticker: entry.ticker };
      if (name)   map[name]   = { cik, name: entry.title, ticker: entry.ticker };
    }
    tickerCache = map;
    tickerCacheTime = Date.now();
    return map;
  } catch { return {}; }
}

export async function validateCompany(
  companyName: string,
  ticker?: string,
): Promise<CompanyEligibility> {
  const key = companyName.toLowerCase().trim();

  const mapped = NAME_MAP[key];
  if (mapped) {
    if (mapped.legalName === 'PRIVATE') {
      return {
        isUSListed: false, isPublicCompany: false, secFilingFound: false,
        legalName: companyName,
        ineligibilityReason: `${companyName} is a private company. SEC signals unavailable. Score based on news signals only.`,
      };
    }
    if (mapped.legalName === 'INDEX_NOT_COMPANY') {
      return {
        isUSListed: false, isPublicCompany: false, secFilingFound: false,
        legalName: companyName,
        ineligibilityReason: `${companyName} is a market index, not a company. EjectSeat scores individual companies only.`,
      };
    }
    return {
      isUSListed: true, isPublicCompany: true, secFilingFound: true,
      cik: mapped.cik, legalName: mapped.legalName, ticker: mapped.ticker,
    };
  }

  try {
    const tickerMap = await getTickerMap();
    if (ticker) {
      const byTicker = tickerMap[ticker.toLowerCase()];
      if (byTicker) {
        return { isUSListed: true, isPublicCompany: true, secFilingFound: true,
          cik: byTicker.cik, legalName: byTicker.name, ticker: byTicker.ticker };
      }
    }
    const byName = tickerMap[key];
    if (byName) {
      return { isUSListed: true, isPublicCompany: true, secFilingFound: true,
        cik: byName.cik, legalName: byName.name, ticker: byName.ticker };
    }
    const startsWith = Object.values(tickerMap).filter(entry =>
      entry.name.toLowerCase().startsWith(key)
    ).sort((a, b) => a.name.length - b.name.length);
    if (startsWith.length > 0) {
      const best = startsWith[0];
      return { isUSListed: true, isPublicCompany: true, secFilingFound: true,
        cik: best.cik, legalName: best.name, ticker: best.ticker };
    }
    const fuzzy = Object.values(tickerMap).filter(entry =>
      entry.name.toLowerCase().includes(key)
    ).sort((a, b) => a.name.length - b.name.length);
    if (fuzzy.length > 0) {
      const best = fuzzy[0];
      return { isUSListed: true, isPublicCompany: true, secFilingFound: true,
        cik: best.cik, legalName: best.name, ticker: best.ticker };
    }
  } catch { /* fall through */ }

  try {
    const url  = `${EDGAR_SEARCH}"${encodeURIComponent(companyName)}"&dateRange=custom&startdt=2022-01-01&forms=10-K`;
    const res  = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    const data = await res.json();
    if (data?.hits?.hits?.length > 0) {
      const top = data.hits.hits[0]._source;
      return { isUSListed: true, isPublicCompany: true, secFilingFound: true,
        cik: top.entity_id, legalName: top.display_names?.[0] || companyName };
    }
  } catch (err) {
    console.error('[company-validator] EDGAR search error:', err);
  }

  return {
    isUSListed: false, isPublicCompany: false, secFilingFound: false,
    legalName: companyName,
    ineligibilityReason: `No SEC filing found for "${companyName}". This may be a private company, non-US listed, or a search term that doesn't match an SEC registrant.`,
  };
}
