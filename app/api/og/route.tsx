// app/api/og/route.tsx — default brand OG card for the static public/*.html pages
// (those pages aren't Next.js routes, so they can't use the opengraph-image
// file convention — they link here directly instead of a missing og-image.png).

import { ImageResponse } from 'next/og';

export const runtime = 'edge';

export async function GET() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%', height: '100%', display: 'flex', flexDirection: 'column',
          justifyContent: 'center', background: '#f6f8fb', padding: '72px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 36 }}>
          <div style={{ width: 48, height: 48, borderRadius: 12, background: 'linear-gradient(135deg,#2563eb,#60a5fa)', display: 'flex' }} />
          <div style={{ fontSize: 34, fontWeight: 700, color: '#0f172a', display: 'flex' }}>
            Eject<span style={{ color: '#2563eb' }}>Seat</span>
          </div>
        </div>
        <div style={{ fontSize: 42, fontWeight: 700, color: '#0f172a', maxWidth: 760, lineHeight: 1.15, display: 'flex' }}>
          Is your company heading for layoffs?
        </div>
        <div style={{ fontSize: 24, color: '#475569', marginTop: 20, maxWidth: 760, display: 'flex' }}>
          Search any US-listed public company for a forward-looking risk score.
        </div>
      </div>
    ),
    { width: 1200, height: 630 },
  );
}
