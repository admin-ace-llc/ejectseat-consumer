import { ImageResponse } from 'next/og';
import { getCompanyByTicker } from '@/lib/supabase-server';

export const runtime = 'edge';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

const STATE_COLOR: Record<string, string> = {
  CLEAR: '#059669',
  WATCH: '#2563eb',
  LIKELY: '#d97706',
  ACTIVE: '#dc2626',
};

export default async function OgImage({ params }: { params: { ticker: string } }) {
  const row = await getCompanyByTicker(params.ticker);
  const name = row?.legal_name || row?.name || params.ticker.toUpperCase();
  const ticker = row?.ticker || params.ticker.toUpperCase();
  const state = row?.cached_state || 'CLEAR';
  const score = row?.cached_score ?? '—';
  const color = STATE_COLOR[state] || STATE_COLOR.CLEAR;

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
        <div style={{ fontSize: 28, fontWeight: 600, color: '#475569', marginBottom: 16, display: 'flex' }}>
          {name} · {ticker}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
          <div style={{ fontSize: 100, fontWeight: 700, color: '#0f172a', display: 'flex' }}>
            {score}
            <span style={{ fontSize: 32, color: '#94a3b8', marginLeft: 8, alignSelf: 'flex-end', marginBottom: 16 }}>/100</span>
          </div>
          <div style={{ padding: '10px 22px', borderRadius: 10, background: color, color: 'white', fontSize: 24, fontWeight: 700, letterSpacing: 2, display: 'flex' }}>
            {state}
          </div>
        </div>
        <div style={{ fontSize: 22, color: '#475569', marginTop: 28, display: 'flex' }}>
          Layoff risk score from SEC filings, earnings calls &amp; Tier A/B media
        </div>
      </div>
    ),
    { ...size },
  );
}
