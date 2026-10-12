import { NextResponse } from 'next/server';
import { fetchLayoffEvents } from '@/lib/events/layoffs';

export const revalidate = 900;

// GET /api/events?days=45&limit=40 → { events, fetchedAt }
export async function GET(req: Request) {
  const u = new URL(req.url);
  const days = Math.min(120, Math.max(1, Number(u.searchParams.get('days')) || 45));
  const limit = Math.min(100, Math.max(1, Number(u.searchParams.get('limit')) || 40));
  const events = await fetchLayoffEvents({ days, limit });
  return NextResponse.json(
    { events, fetchedAt: new Date().toISOString() },
    { headers: { 'Cache-Control': 'public, s-maxage=900, stale-while-revalidate=3600' } },
  );
}
