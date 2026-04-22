// lib/signals/landingzone.ts — EjectSeat Consumer v7 (preserved from v6.1)
// Adzuna API client for hiring velocity / LandingZone feature.

import type { LandingZoneCompany, LandingZoneRequest, RoleMatch, GeoSignal } from '@/types';

const ADZUNA_APP_ID  = process.env.ADZUNA_APP_ID  || '';
const ADZUNA_APP_KEY = process.env.ADZUNA_APP_KEY || '';
const ADZUNA_BASE    = 'https://api.adzuna.com/v1/api/jobs';

// Role tier mapping — maps generic tiers to Adzuna's category/keyword searches
const ROLE_KEYWORDS: Record<string, Record<string, string[]>> = {
  'software_engineering': {
    'ic':        ['software engineer', 'developer', 'programmer'],
    'senior_ic': ['senior engineer', 'staff engineer', 'principal engineer'],
    'manager':   ['engineering manager', 'tech lead'],
    'director':  ['engineering director', 'head of engineering'],
    'vp':        ['vp engineering', 'vice president engineering'],
  },
  'product_management': {
    'ic':        ['product manager', 'associate product manager'],
    'senior_ic': ['senior product manager', 'staff product manager'],
    'manager':   ['principal product manager', 'group product manager'],
    'director':  ['director of product'],
    'vp':        ['vp product', 'chief product officer'],
  },
  'design': {
    'ic':        ['product designer', 'ux designer', 'ui designer'],
    'senior_ic': ['senior designer', 'staff designer'],
    'manager':   ['design manager'],
    'director':  ['director of design', 'head of design'],
    'vp':        ['vp design', 'chief design officer'],
  },
  'data': {
    'ic':        ['data scientist', 'data analyst', 'data engineer'],
    'senior_ic': ['senior data scientist', 'staff data engineer'],
    'manager':   ['data science manager'],
    'director':  ['director of data'],
    'vp':        ['vp data'],
  },
  'marketing': {
    'ic':        ['marketing manager', 'growth marketer'],
    'senior_ic': ['senior marketing manager'],
    'manager':   ['marketing director'],
    'director':  ['head of marketing'],
    'vp':        ['vp marketing', 'chief marketing officer'],
  },
  'sales': {
    'ic':        ['account executive', 'sales representative'],
    'senior_ic': ['senior account executive', 'enterprise ae'],
    'manager':   ['sales manager'],
    'director':  ['sales director'],
    'vp':        ['vp sales', 'chief revenue officer'],
  },
};

function countryCode(country: string | undefined): string {
  const c = (country || 'us').toLowerCase();
  const valid = ['us','gb','au','ca','de','fr','in','nl','pl','sg','za','at','be','br','ch','es','it','mx','nz'];
  return valid.includes(c) ? c : 'us';
}

export async function fetchLandingZoneCompanies(
  req: LandingZoneRequest,
): Promise<LandingZoneCompany[]> {
  if (!ADZUNA_APP_ID || !ADZUNA_APP_KEY) {
    console.warn('[landingzone] Adzuna credentials missing');
    return [];
  }

  const country = countryCode(req.country);
  const keywords = req.roleFunction && req.roleTier
    ? (ROLE_KEYWORDS[req.roleFunction]?.[req.roleTier] || [])
    : [];

  const query = keywords.length > 0 ? keywords[0] : 'software';
  const url = new URL(`${ADZUNA_BASE}/${country}/search/1`);
  url.searchParams.set('app_id', ADZUNA_APP_ID);
  url.searchParams.set('app_key', ADZUNA_APP_KEY);
  url.searchParams.set('what', query);
  url.searchParams.set('results_per_page', '50');
  url.searchParams.set('sort_by', 'date');
  if (req.remote) url.searchParams.set('where', 'remote');

  try {
    const res = await fetch(url.toString());
    if (!res.ok) {
      console.error('[landingzone] Adzuna non-200:', res.status);
      return [];
    }
    const data = await res.json();
    const jobs: any[] = data.results || [];

    const byCompany = new Map<string, {
      count: number;
      locations: Set<string>;
      remote: boolean;
      recentDates: number[];
    }>();

    const now = Date.now();
    for (const job of jobs) {
      const name = job.company?.display_name || 'Unknown';
      const existing = byCompany.get(name) || {
        count: 0, locations: new Set<string>(), remote: false, recentDates: [],
      };
      existing.count++;
      const loc = job.location?.display_name || '';
      if (loc) existing.locations.add(loc);
      if (/remote/i.test(loc) || /remote/i.test(job.title || '')) existing.remote = true;
      if (job.created) {
        const age = (now - new Date(job.created).getTime()) / 86_400_000;
        if (age >= 0 && age <= 30) existing.recentDates.push(age);
      }
      byCompany.set(name, existing);
    }

    const results: LandingZoneCompany[] = [];
    for (const [name, stats] of byCompany.entries()) {
      if (stats.count < 2) continue;

      const avgAge = stats.recentDates.length > 0
        ? stats.recentDates.reduce((a, b) => a + b, 0) / stats.recentDates.length
        : 30;

      const hiringTrend: LandingZoneCompany['hiringTrend'] =
        stats.recentDates.length >= 3 && avgAge <= 10 ? 'surge'
        : stats.recentDates.length >= 2 && avgAge <= 20 ? 'stable'
        : 'declining';

      const matchScore = Math.min(100, Math.round(
        (stats.count * 10) + (hiringTrend === 'surge' ? 30 : hiringTrend === 'stable' ? 15 : 0)
      ));

      const matchTier: LandingZoneCompany['matchTier'] =
        matchScore >= 70 ? 'excellent'
        : matchScore >= 40 ? 'good'
        : 'fair';

      const roleMatches: RoleMatch[] = keywords.length > 0 && req.roleFunction && req.roleTier
        ? [{ roleType: req.roleFunction, tier: req.roleTier, openCount: stats.count }]
        : [];

      const geoSignal: GeoSignal = {
        matchState: 'match',
        remote: stats.remote,
        locations: Array.from(stats.locations).slice(0, 3),
      };

      results.push({
        companyName: name,
        hiringVelocity: stats.count,
        hiringTrend,
        roleMatches,
        matchScore,
        matchTier,
        matchReason: `${stats.count} open roles, avg posted ${Math.round(avgAge)} days ago`,
        geoSignal,
        openRoles: stats.count,
      });
    }

    results.sort((a, b) => b.hiringVelocity - a.hiringVelocity);
    return results.slice(0, 12);
  } catch (err: any) {
    console.error('[landingzone] fetch error:', err?.message || err);
    return [];
  }
}
