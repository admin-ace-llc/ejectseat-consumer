// app/api/landingzone/route.ts — EjectSeat Consumer v7 (preserved)
// Returns a list of companies actively hiring for the user's role/location.

import { NextRequest, NextResponse } from 'next/server';
import { fetchLandingZoneCompanies } from '@/lib/signals/landingzone';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { country, remote, roleFunction, roleTier } = body;

    const companies = await fetchLandingZoneCompanies({
      country, remote: !!remote, roleFunction, roleTier,
    });

    return NextResponse.json({ companies });
  } catch (err: any) {
    console.error('[landingzone] route error:', err?.message || err);
    return NextResponse.json({ error: 'Could not fetch hiring data', companies: [] }, { status: 200 });
  }
}
