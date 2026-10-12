import type { Metadata } from 'next';
import Link from 'next/link';
import { listScoredCompanies } from '@/lib/supabase-server';

// Crawlable index of every scored company. Gives Google (and visitors) a static
// path from the homepage to each /company/[ticker] page.
export const revalidate = 21600; // 6h — same cadence as the company pages

const STATE_ORDER = ['ACTIVE', 'LIKELY', 'WATCH', 'CLEAR'] as const;

const STATE_DESC: Record<string, string> = {
  CLEAR: 'No material layoff signals',
  WATCH: 'Forward indicators present',
  LIKELY: 'Multiple corroborating signals',
  ACTIVE: 'Confirmed event or programme in motion',
};

const STATE_COLOR: Record<string, { bg: string; text: string; border: string }> = {
  CLEAR:  { bg: '#ecfdf5', text: '#047857', border: '#a7f3d0' },
  WATCH:  { bg: '#eff4ff', text: '#1e40af', border: '#bfdbfe' },
  LIKELY: { bg: '#fffbeb', text: '#92400e', border: '#fde68a' },
  ACTIVE: { bg: '#fef2f2', text: '#b91c1c', border: '#fecaca' },
};

// Used by generateMetadata and the page (two small queries per 6h revalidation).
async function loadCompanies() {
  try {
    return await listScoredCompanies();
  } catch {
    return []; // DB unreachable — render an empty (noindex) page rather than fail the build
  }
}

export async function generateMetadata(): Promise<Metadata> {
  const rows = await loadCompanies();
  const title = 'Company Layoff Risk Scores | EjectSeat';
  const description = rows.length
    ? `Layoff risk scores for ${rows.length} US-listed companies, from active layoffs to no signals. Based on SEC filings, earnings calls and Tier A/B media.`
    : 'Layoff risk scores for US-listed companies, based on SEC filings, earnings calls and Tier A/B media.';

  return {
    title,
    description,
    alternates: { canonical: 'https://ejectseat.io/companies' },
    openGraph: { title, description, url: 'https://ejectseat.io/companies', siteName: 'EjectSeat' },
    // Never let a failed DB read get an empty page indexed.
    robots: rows.length ? undefined : { index: false, follow: true },
  };
}

export default async function CompaniesPage() {
  const rows = await loadCompanies();

  const groups = STATE_ORDER.map((state) => ({
    state,
    items: rows
      .filter((r) => (r.cached_state || 'CLEAR') === state)
      .sort((a, b) => (b.cached_score ?? 0) - (a.cached_score ?? 0) || a.name.localeCompare(b.name)),
  })).filter((g) => g.items.length > 0);

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: 'Company layoff risk scores',
    url: 'https://ejectseat.io/companies',
    description: 'Layoff risk scores for US-listed public companies.',
    isPartOf: { '@type': 'WebSite', name: 'EjectSeat', url: 'https://ejectseat.io/' },
  };

  return (
    <main style={page}>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 32 }}>
        <Link href="/" style={{ fontWeight: 700, fontSize: 18, color: '#0f172a', textDecoration: 'none' }}>
          Eject<span style={{ color: '#2563eb' }}>Seat</span>
        </Link>
        <nav style={{ display: 'flex', gap: 18, fontSize: 14 }}>
          <Link href="/how.html" style={{ color: '#475569' }}>How it works</Link>
          <Link href="/privacy.html" style={{ color: '#475569' }}>Privacy</Link>
        </nav>
      </header>

      <h1 style={{ fontSize: 30, lineHeight: 1.15, letterSpacing: '-0.02em', margin: '0 0 12px' }}>
        Company layoff risk scores
      </h1>
      <p style={{ color: '#475569', lineHeight: 1.6, margin: '0 0 28px' }}>
        EjectSeat reads SEC filings, earnings call transcripts and Tier A/B media to score how likely a
        US-listed company is to announce layoffs. Companies are grouped by current state, highest score
        first. Open a company to see the signals behind its score.
      </p>

      {groups.length === 0 ? (
        <p style={{ color: '#475569', lineHeight: 1.6 }}>
          Scores are being refreshed. Please check back shortly, or{' '}
          <Link href="/" style={{ color: '#2563eb' }}>search a company on the homepage</Link>.
        </p>
      ) : (
        groups.map(({ state, items }) => {
          const colors = STATE_COLOR[state];
          return (
            <section key={state} style={{ marginBottom: 32 }}>
              <h2 style={{ fontSize: 18, margin: '0 0 4px' }}>
                <span
                  style={{
                    display: 'inline-block', padding: '3px 10px', borderRadius: 6, fontSize: 11, fontWeight: 700,
                    letterSpacing: '0.1em', marginRight: 10, background: colors.bg, color: colors.text,
                    border: `1px solid ${colors.border}`,
                  }}
                >
                  {state}
                </span>
                {STATE_DESC[state]} ({items.length})
              </h2>
              <ul style={{ listStyle: 'none', padding: 0, margin: '12px 0 0', columnWidth: 240, columnGap: 24 }}>
                {items.map((r) => {
                  const name = r.legal_name || r.name;
                  return (
                    <li key={r.ticker} style={{ padding: '5px 0', fontSize: 14, breakInside: 'avoid' }}>
                      <Link href={`/company/${r.ticker}`} prefetch={false} style={{ color: '#0f172a' }}>
                        {name} ({r.ticker})
                      </Link>{' '}
                      <span style={{ color: '#64748b', fontSize: 12 }}>{r.cached_score ?? 0}/100</span>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })
      )}

      <footer style={{ marginTop: 48, paddingTop: 20, borderTop: '1px solid #e4e8ef', fontSize: 13, color: '#64748b' }}>
        © Admin-Ace LLC · Operated from the United States
      </footer>
    </main>
  );
}

const page: React.CSSProperties = {
  maxWidth: 760,
  margin: '0 auto',
  padding: '28px 24px 80px',
  fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
  color: '#0f172a',
  background: '#f6f8fb',
};
