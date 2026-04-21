// lib/signals/landingzone.ts — EjectSeat Consumer
// Dynamic LandingZone using Adzuna Jobs API

const ADZUNA_BASE = 'https://api.adzuna.com/v1/api/jobs';

export const LOCATION_OPTIONS: Record<string, { label: string; flag: string; countries: string[] }> = {
  remote:  { label: 'Remote (anywhere)', flag: '🌐', countries: ['us','gb'] },
  us:      { label: 'United States',     flag: '🇺🇸', countries: ['us'] },
  gb:      { label: 'United Kingdom',    flag: '🇬🇧', countries: ['gb'] },
  sg:      { label: 'Singapore',         flag: '🇸🇬', countries: ['sg'] },
  in:      { label: 'India',             flag: '🇮🇳', countries: ['in'] },
  au:      { label: 'Australia',         flag: '🇦🇺', countries: ['au'] },
  ca:      { label: 'Canada',            flag: '🇨🇦', countries: ['ca'] },
  de:      { label: 'Germany',           flag: '🇩🇪', countries: ['de'] },
  nl:      { label: 'Netherlands',       flag: '🇳🇱', countries: ['nl'] },
  fr:      { label: 'France',            flag: '🇫🇷', countries: ['fr'] },
  sea:     { label: 'Southeast Asia',    flag: '🌏', countries: ['sg','in'] },
  europe:  { label: 'Europe',            flag: '🌍', countries: ['gb','de','nl','fr'] },
};

export const ROLE_CATEGORIES: Record<string, { label: string; adzunaTag: string }> = {
  all:          { label: 'All roles',               adzunaTag: '' },
  engineering:  { label: 'Engineering & Tech',      adzunaTag: 'it-jobs' },
  product:      { label: 'Product Management',      adzunaTag: 'it-jobs' },
  trust_safety: { label: 'Trust & Safety / Policy', adzunaTag: 'legal-jobs' },
  data:         { label: 'Data & Analytics',        adzunaTag: 'it-jobs' },
  design:       { label: 'Design & UX',             adzunaTag: 'it-jobs' },
  sales:        { label: 'Sales & BD',              adzunaTag: 'sales-jobs' },
  finance:      { label: 'Finance & Accounting',    adzunaTag: 'accounting-finance-jobs' },
  hr:           { label: 'People & HR',             adzunaTag: 'hr-jobs' },
  marketing:    { label: 'Marketing & Comms',       adzunaTag: 'pr-advertising-marketing-jobs' },
  legal:        { label: 'Legal & Compliance',      adzunaTag: 'legal-jobs' },
};

export interface LocationBreakdown {
  locationKey: string; label: string; flag: string; count: number;
}

export interface CategoryBreakdown {
  label: string; count: number;
}

export interface LZCompany {
  name: string;
  ticker?: string;
  totalRoles: number;
  weeklyTrend: 'surging' | 'growing' | 'stable' | 'cooling';
  trendPct: number;
  locationBreakdown: LocationBreakdown[];
  topCategories: CategoryBreakdown[];
  sampleTitles: string[];
  riskScore?: number;
  riskBand?: string;
  riskCrossRef?: string;
  matchScore: number;
}

export interface LZResult {
  companies: LZCompany[];
  totalJobs: number;
  role: string;
  locations: string[];
  generatedAt: string;
}

const SEED_COMPANIES = [
  'Google','Microsoft','Amazon','Apple','Meta','Netflix','Salesforce',
  'Oracle','Intel','Cisco','IBM','Uber','Lyft','Snap','Spotify',
  'Airbnb','Coinbase','Palantir','Cloudflare','Workday','Stripe',
  'Anthropic','OpenAI','Adobe','Nvidia','Tesla','Shopify','Zoom',
  'Atlassian','Datadog','MongoDB','Twilio','ServiceNow','Okta',
  'Crowdstrike','Palo Alto Networks','Snowflake',
];

async function fetchAdzuna(
  country: string, company: string, roleTag: string, isRemote: boolean, maxDays = 30
): Promise<{ count: number; titles: string[]; locations: string[] }> {
  const appId  = process.env.ADZUNA_APP_ID;
  const appKey = process.env.ADZUNA_APP_KEY;
  if (!appId || !appKey) return { count: 0, titles: [], locations: [] };

  try {
    const params = new URLSearchParams({
      app_id: appId, app_key: appKey, what_or: company,
      max_days_old: String(maxDays), results_per_page: '20',
      'content-type': 'application/json',
    });
    if (roleTag) params.set('category', roleTag);
    if (isRemote) params.set('where', 'remote');

    const res = await fetch(`${ADZUNA_BASE}/${country}/search/1?${params}`);
    if (!res.ok) return { count: 0, titles: [], locations: [] };

    const data    = await res.json();
    const results = (data.results || []) as any[];

    const rawTitles    = results.map((j: any) => j.title?.slice(0, 60)).filter((t: any): t is string => Boolean(t));
    const rawLocations = results.map((j: any) => j.location?.display_name).filter((l: any): l is string => Boolean(l));
    const titles    = Array.from(new Set(rawTitles)).slice(0, 5);
    const locations = Array.from(new Set(rawLocations)).slice(0, 5);

    return { count: data.count || 0, titles, locations };
  } catch {
    return { count: 0, titles: [], locations: [] };
  }
}

async function fetchTrend(country: string, company: string, roleTag: string): Promise<{
  trend: 'surging' | 'growing' | 'stable' | 'cooling'; pct: number;
}> {
  const [recent, older] = await Promise.all([
    fetchAdzuna(country, company, roleTag, false, 7),
    fetchAdzuna(country, company, roleTag, false, 30),
  ]);

  const recentRate = (recent.count / 7) * 30;
  const olderRate  = older.count || 1;
  const pct        = Math.round(((recentRate - olderRate) / olderRate) * 100);

  let trend: 'surging' | 'growing' | 'stable' | 'cooling';
  if (pct >= 50)       trend = 'surging';
  else if (pct >= 15)  trend = 'growing';
  else if (pct >= -10) trend = 'stable';
  else                 trend = 'cooling';

  return { trend, pct };
}

export async function getLandingZoneData(
  role: string,
  locationKeys: string[],
  companiesFromAnalytics: string[] = [],
  cachedRiskScores: Record<string, { score: number; band: string }> = {}
): Promise<LZResult> {
  const roleConfig = ROLE_CATEGORIES[role] || ROLE_CATEGORIES.all;
  const roleTag    = roleConfig.adzunaTag;

  const seen = new Set(companiesFromAnalytics.map(c => c.toLowerCase()));
  const seedFiltered = SEED_COMPANIES.filter(c => !seen.has(c.toLowerCase()));
  const allCompanies = [...companiesFromAnalytics, ...seedFiltered].slice(0, 40);

  const selectedLocations = locationKeys.slice(0, 5);
  const isRemoteSelected  = selectedLocations.includes('remote');

  const rawCountries = selectedLocations.flatMap(loc => LOCATION_OPTIONS[loc]?.countries || ['us']);
  const countries    = Array.from(new Set(rawCountries));

  const results: LZCompany[] = [];
  let totalJobs = 0;

  const batchSize = 6;
  for (let i = 0; i < Math.min(allCompanies.length, 24); i += batchSize) {
    const batch = allCompanies.slice(i, i + batchSize);

    const batchResults = await Promise.all(batch.map(async (company) => {
      const locationResults: LocationBreakdown[] = [];
      let companyTotal = 0;
      const allTitles: string[] = [];

      for (const country of countries.slice(0, 4)) {
        const locEntry = Object.entries(LOCATION_OPTIONS).find(
          ([key, v]) => v.countries.length === 1 && v.countries[0] === country
        );
        const locKey = locEntry ? locEntry[0] : country;
        const locOpt = locEntry ? locEntry[1] : { label: country.toUpperCase(), flag: '🌐', countries: [country] };

        const data = await fetchAdzuna(country, company, roleTag, isRemoteSelected && country === countries[0], 30);
        if (data.count > 0) {
          locationResults.push({
            locationKey: locKey, label: locOpt.label, flag: locOpt.flag, count: data.count,
          });
          companyTotal += data.count;
          allTitles.push(...data.titles);
        }
      }

      if (companyTotal === 0) return null;

      const { trend, pct } = await fetchTrend(countries[0] || 'us', company, roleTag);

      const categoryMap: Record<string, number> = {};
      for (const title of allTitles) {
        const t = title.toLowerCase();
        if (t.includes('engineer') || t.includes('developer') || t.includes('software'))
          categoryMap['Engineering'] = (categoryMap['Engineering'] || 0) + 1;
        else if (t.includes('product') || t.includes(' pm'))
          categoryMap['Product'] = (categoryMap['Product'] || 0) + 1;
        else if (t.includes('trust') || t.includes('safety') || t.includes('policy'))
          categoryMap['Trust & Safety'] = (categoryMap['Trust & Safety'] || 0) + 1;
        else if (t.includes('data') || t.includes('analyst') || t.includes('scientist'))
          categoryMap['Data & Analytics'] = (categoryMap['Data & Analytics'] || 0) + 1;
        else if (t.includes('sales') || t.includes('account executive'))
          categoryMap['Sales'] = (categoryMap['Sales'] || 0) + 1;
        else if (t.includes('design') || t.includes('ux') || t.includes('ui'))
          categoryMap['Design'] = (categoryMap['Design'] || 0) + 1;
        else
          categoryMap['Other'] = (categoryMap['Other'] || 0) + 1;
      }

      const topCategories = Object.entries(categoryMap)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([label, count]) => ({ label, count }));

      const risk = cachedRiskScores[company.toLowerCase()];
      let riskCrossRef: string | undefined;
      if (risk?.band === 'HIGH') {
        riskCrossRef = '⚠ Active restructuring signals alongside hiring — selective cuts likely';
      } else if (risk?.band === 'MEDIUM') {
        riskCrossRef = '~ Some risk signals present alongside hiring activity';
      }

      const locationScore = Math.min((locationResults.length / Math.max(countries.length, 1)) * 40, 40);
      const trendScore    = trend === 'surging' ? 30 : trend === 'growing' ? 20 : trend === 'stable' ? 10 : 0;
      const volumeScore   = Math.min((companyTotal / 500) * 20, 20);
      const riskBonus     = risk?.band === 'LOW' ? 10 : risk?.band === 'MEDIUM' ? 5 : risk?.band === 'HIGH' ? 0 : 8;
      const matchScore    = Math.round(locationScore + trendScore + volumeScore + riskBonus);

      totalJobs += companyTotal;

      const uniqueTitles = Array.from(new Set(allTitles)).slice(0, 4);

      return {
        name: company, totalRoles: companyTotal,
        weeklyTrend: trend, trendPct: pct,
        locationBreakdown: locationResults.sort((a, b) => b.count - a.count).slice(0, 5),
        topCategories, sampleTitles: uniqueTitles,
        riskScore: risk?.score, riskBand: risk?.band, riskCrossRef, matchScore,
      } as LZCompany;
    }));

    results.push(...batchResults.filter((r): r is LZCompany => r !== null));
  }

  results.sort((a, b) => {
    if (a.riskBand === 'HIGH' && b.riskBand !== 'HIGH') return 1;
    if (b.riskBand === 'HIGH' && a.riskBand !== 'HIGH') return -1;
    return b.matchScore - a.matchScore;
  });

  return {
    companies: results.slice(0, 20),
    totalJobs, role,
    locations: selectedLocations,
    generatedAt: new Date().toISOString(),
  };
}
