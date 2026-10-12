import { NextResponse } from 'next/server';
import { fetchWarnReport } from '@/lib/events/warn';

export const revalidate = 3600;
export const maxDuration = 30;

// Public JSON of WARN notices plus per-state source counts (a count of 0 means that state's source needs attention).
export async function GET() {
  const { notices, sources } = await fetchWarnReport(120);
  return NextResponse.json({ updated: new Date().toISOString(), total: notices.length, sources, notices }, { headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=7200' } });
}
