// app/api/landingzone/route.ts — EjectSeat Consumer
// Dynamic LandingZone endpoint
// GET /api/landingzone?role=engineering&locations=us,sg,remote

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getLandingZoneData, LOCATION_OPTIONS, ROLE_CATEGORIES } from '@/lib/signals/landingzone';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const role      = searchParams.get('role') || 'all';
  const locParam  = searchParams.get('locations') || 'us,remote';
  const locations = locParam.split(',').filter(l => LOCATION_OPTIONS[l]).slice(0, 5);

  if (!ROLE_CATEGORIES[role]) {
    return NextResponse.json({ error: 'Invalid role' }, { status: 400 });
  }

  try {
    const { data: topSearches } = await supabase
      .from('analytics_events')
      .select('payload')
      .eq('event_type', 'company_searched')
      .order('created_at', { ascending: false })
      .limit(100);

    const analyticsCompanies: string[] = [];
    const seen = new Set<string>();
    for (const row of (topSearches || [])) {
      const name = row.payload?.companyName;
      if (name && !seen.has(name.toLowerCase())) {
        seen.add(name.toLowerCase());
        analyticsCompanies.push(name);
      }
    }

    const { data: riskCache } = await supabase
      .from('companies')
      .select('name, cached_score, cached_band')
      .not('cached_score', 'is', null)
      .limit(100);

    const cachedRiskScores: Record<string, { score: number; band: string }> = {};
    for (const row of (riskCache || [])) {
      if (row.cached_score !== null) {
        cachedRiskScores[row.name.toLowerCase()] = {
          score: row.cached_score,
          band:  row.cached_band || 'LOW',
        };
      }
    }

    const cacheKey = `lz_${role}_${locations.sort().join('_')}`;
    const sixHoursAgo = new Date(Date.now() - 6 * 3600 * 1000).toISOString();

    const { data: cached } = await supabase
      .from('analytics_events')
      .select('payload, created_at')
      .eq('event_type', 'landingzone_cache')
      .eq('payload->>cache_key', cacheKey)
      .gte('created_at', sixHoursAgo)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (cached?.payload?.result) {
      return NextResponse.json({ ...cached.payload.result, fromCache: true });
    }

    const result = await getLandingZoneData(
      role,
      locations,
      analyticsCompanies.slice(0, 20),
      cachedRiskScores
    );

    await supabase.from('analytics_events').insert({
      event_type: 'landingzone_cache',
      payload:    { cache_key: cacheKey, result },
    });

    return NextResponse.json(result);

  } catch (err) {
    console.error('[landingzone/route]', err);
    return NextResponse.json({ error: 'Failed to load LandingZone data' }, { status: 500 });
  }
}
