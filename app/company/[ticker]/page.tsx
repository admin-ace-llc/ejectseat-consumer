import type { Metadata } from 'next';
import Link from 'next/link';
import { getCompanyByTicker, getScoreHistory, getSupabaseServerClient } from '@/lib/supabase-server';
import { fmtUSD, fmtRange, fmtPct, fmtDate, fmtAccession, fmtRelative } from '@/lib/format';
import WatchForm from './WatchForm';
import CommentsSection from './CommentsSection';

const VERDICT: Record<string, string> = {
  CLEAR: 'No layoffs are currently expected based on public evidence.',
  WATCH: 'Some forward-looking signals exist, but nothing confirmed yet.',
  LIKELY: 'Multiple signals point toward layoffs, but no confirmed event yet — treat as a strong warning, not a certainty.',
  ACTIVE: 'A layoff event has been confirmed via official filing or verified media.',
};

export const revalidate = 21600; // 6h — matches the registered-user cache TTL on /api/score
export const dynamicParams = true;

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

async function loadCompany(ticker: string) {
  return getCompanyByTicker(ticker);
}

export async function generateMetadata({
  params,
}: { params: { ticker: string } }): Promise<Metadata> {
  const ticker = params.ticker.toUpperCase();
  const row = await loadCompany(ticker);

  if (!row) {
    return {
      title: `${ticker} Layoff Risk — Not Yet Scored | EjectSeat`,
      description: `EjectSeat hasn't scored ${ticker} yet. Search it now to get a forward-looking layoff risk score from SEC filings, earnings calls, and Tier A/B media.`,
      robots: { index: false, follow: true },
    };
  }

  const name = row.legal_name || row.name;
  const state = row.cached_state || 'CLEAR';
  const score = row.cached_score ?? 0;
  const title = `Is ${name} (${row.ticker}) Planning Layoffs? Risk Score: ${state} ${score}/100`;
  const description = `${name} layoff risk: ${state} (${score}/100). ${
    row.cached_intelligence?.summary || STATE_DESC[state] || ''
  } Based on SEC filings, earnings calls, and Tier A/B media.`.slice(0, 300);
  const ogImage = `/company/${row.ticker}/opengraph-image`;

  return {
    title,
    description,
    alternates: { canonical: `https://ejectseat.io/company/${row.ticker}` },
    openGraph: {
      title,
      description,
      url: `https://ejectseat.io/company/${row.ticker}`,
      siteName: 'EjectSeat',
      images: [ogImage],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: [ogImage],
    },
  };
}

export default async function CompanyPage({ params }: { params: { ticker: string } }) {
  const ticker = params.ticker.toUpperCase();
  const row = await loadCompany(ticker);

  if (!row) {
    return (
      <main style={page}>
        <Header />
        <h1 style={{ fontSize: 28, marginBottom: 10 }}>{ticker} hasn&apos;t been scored yet</h1>
        <p style={{ color: '#475569', marginBottom: 24, lineHeight: 1.55 }}>
          We haven&apos;t run a layoff-risk analysis for {ticker} yet. Search it on the
          homepage and EjectSeat will read its SEC filings, earnings call transcripts, and
          Tier A/B media to produce a fresh score in under a minute.
        </p>
        <Link href={`/?company=${encodeURIComponent(ticker)}&ticker=${encodeURIComponent(ticker)}`} style={cta}>
          Check {ticker} now →
        </Link>
        <Footer />
      </main>
    );
  }

  const name = row.legal_name || row.name;
  const state = row.cached_state || 'CLEAR';
  const score = row.cached_score ?? 0;
  const colors = STATE_COLOR[state] || STATE_COLOR.CLEAR;
  const intel = row.cached_intelligence || {};
  const summary: string = intel.summary || '';
  const programme = row.cached_programme || intel.programme;
  const headcount = row.cached_headcount || intel.headcount;
  const bankruptcy = row.cached_bankruptcy || intel.bankruptcy;
  const functionRisk = row.cached_function_risk || intel.function_risk;
  const confirmedEvents = intel.confirmed_events || [];
  const forwardSignals = intel.forward_signals || [];

  const [history, comments] = await Promise.all([
    getScoreHistory(row.id),
    loadInitialComments(row.ticker || ticker),
  ]);

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: `${name} layoff risk score`,
    url: `https://ejectseat.io/company/${row.ticker}`,
    description: summary || STATE_DESC[state],
    breadcrumb: {
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'EjectSeat', item: 'https://ejectseat.io/' },
        { '@type': 'ListItem', position: 2, name: `${name} (${row.ticker})`, item: `https://ejectseat.io/company/${row.ticker}` },
      ],
    },
    dateModified: row.cached_at || undefined,
  };

  return (
    <main style={page}>
      <Header />

      <nav style={{ fontSize: 13, color: '#64748b', marginBottom: 18 }}>
        <Link href="/" style={{ color: '#64748b' }}>Home</Link> / {name} ({row.ticker})
      </nav>

      <div style={{ fontSize: 13, letterSpacing: '0.04em', textTransform: 'uppercase', color: '#64748b', fontWeight: 600, marginBottom: 10 }}>
        {name} · {row.ticker}
      </div>

      <h1 style={{ fontSize: 30, lineHeight: 1.15, letterSpacing: '-0.02em', margin: '0 0 18px' }}>
        Is {name} planning layoffs?
      </h1>

      <span
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 8, padding: '7px 14px',
          borderRadius: 6, fontSize: 11, fontWeight: 700, letterSpacing: '0.1em',
          textTransform: 'uppercase', marginBottom: 20, border: `1px solid ${colors.border}`,
          background: colors.bg, color: colors.text,
        }}
      >
        {state} — {STATE_DESC[state]}
      </span>

      <p style={{ fontSize: 15, lineHeight: 1.55, color: colors.text, fontWeight: 600, marginBottom: 18 }}>
        {VERDICT[state] || VERDICT.CLEAR}
      </p>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, marginBottom: 12 }}>
        <div style={{ fontSize: 48, fontWeight: 700, letterSpacing: '-0.02em' }}>{score}</div>
        <div style={{ fontSize: 13, color: '#64748b', fontWeight: 600 }}>/ 100</div>
      </div>

      <div style={{ marginBottom: 24 }}>
        <WatchForm ticker={row.ticker || ticker} />
      </div>

      {summary && <p style={{ fontSize: 16, lineHeight: 1.6, color: '#0f172a', marginBottom: 24 }}>{summary}</p>}

      {(headcount?.low != null || headcount?.mid != null || bankruptcy?.detected) && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 12, marginBottom: 24 }}>
          {(headcount?.low != null || headcount?.mid != null) && (
            <Card title="Headcount estimate">
              <div style={{ fontSize: 17, fontWeight: 700 }}>{fmtRange(headcount.low, headcount.high)}</div>
              <div style={{ fontSize: 12.5, color: '#475569', marginTop: 4 }}>
                {headcount.basis || ''}{headcount.pct_of_workforce ? ` · ${fmtPct(headcount.pct_of_workforce)} of workforce` : ''}
              </div>
            </Card>
          )}
          {bankruptcy?.detected && (
            <Card title="Bankruptcy" danger>
              <div style={{ fontSize: 17, fontWeight: 700, color: '#b91c1c' }}>
                Chapter {bankruptcy.chapter || '—'}{bankruptcy.debtor_in_possession ? ' · DIP' : ''}
              </div>
              <div style={{ fontSize: 12.5, color: '#475569', marginTop: 4 }}>
                {bankruptcy.description || bankruptcy.evidence_quote || ''}
                {bankruptcy.filing_date ? ` · Filed ${fmtDate(bankruptcy.filing_date)}` : ''}
              </div>
            </Card>
          )}
        </div>
      )}

      {programme?.name && (
        <div style={{ background: '#f8fafc', border: '1px solid #e4e8ef', borderRadius: 10, padding: '18px 20px', marginBottom: 24 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10, marginBottom: 8 }}>
            <strong style={{ fontSize: 14 }}>{programme.name} programme</strong>
            <span style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#64748b', fontWeight: 600 }}>
              {programme.phase || 'unknown'} phase · {programme.timeline || 'unknown'}
            </span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#64748b', fontWeight: 500 }}>
            <span>{programme.recognised_to_date_usd != null ? `${fmtUSD(programme.recognised_to_date_usd)} recognised` : '—'}</span>
            <span>{programme.total_size_usd != null ? `${fmtUSD(programme.total_size_usd)} total` : '—'}</span>
          </div>
        </div>
      )}

      {(functionRisk?.at_risk?.length || functionRisk?.protected?.length) ? (
        <div style={{ marginBottom: 24 }}>
          <h2 style={{ fontSize: 13, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#64748b', marginBottom: 10 }}>
            Function exposure
          </h2>
          {(functionRisk.at_risk || []).map((f: any, i: number) => (
            <FunctionRow key={`risk-${i}`} name={f.function} atRisk />
          ))}
          {(functionRisk.protected || []).map((f: any, i: number) => (
            <FunctionRow key={`prot-${i}`} name={f.function} />
          ))}
        </div>
      ) : null}

      {(confirmedEvents.length > 0 || forwardSignals.length > 0) && (
        <div style={{ marginBottom: 24 }}>
          <h2 style={{ fontSize: 13, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#64748b', marginBottom: 10 }}>
            Signals in evidence bundle
          </h2>
          {confirmedEvents.map((e: any, i: number) => (
            <SignalRow key={`ce-${i}`} tag="CONFIRMED" confirmed msg={e.description} src={e.filing_type || fmtAccession(e.source_ref)} />
          ))}
          {forwardSignals.slice(0, 8).map((s: any, i: number) => (
            <SignalRow key={`fs-${i}`} tag={(s.signal_type?.replace(/_/g, ' ') || 'predicted').toUpperCase()} msg={s.description} src={s.source_ref} />
          ))}
        </div>
      )}

      {history.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <h2 style={{ fontSize: 13, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#64748b', marginBottom: 10 }}>
            History
          </h2>
          {history.map((h, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '8px 0', borderBottom: '1px solid #e4e8ef', fontSize: 13.5 }}>
              <span style={{ color: '#0f172a' }}>
                <strong>{h.company_state || '—'}</strong> · {h.score}/100
                {h.key_signal ? ` — ${h.key_signal}` : ''}
              </span>
              <span style={{ color: '#94a3b8', fontSize: 12, whiteSpace: 'nowrap', marginLeft: 12 }}>{fmtRelative(h.scored_at)}</span>
            </div>
          ))}
        </div>
      )}

      <div style={{ background: '#eff4ff', border: '1px solid #bfdbfe', borderRadius: 10, padding: '16px 18px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 14, flexWrap: 'wrap', marginBottom: 24 }}>
        <div style={{ fontSize: 14, color: '#0f172a' }}>
          This is a cached score from {fmtDate(row.cached_at)}. Run it live for the freshest evidence.
        </div>
        <Link href={`/?company=${encodeURIComponent(name)}&ticker=${encodeURIComponent(row.ticker || '')}`} style={cta}>
          Run live score →
        </Link>
      </div>

      <div style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 13, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#64748b', marginBottom: 10 }}>
          What people are saying
        </h2>
        <CommentsSection ticker={row.ticker || ticker} initialComments={comments} />
      </div>

      <p style={{ fontSize: 12.5, color: '#64748b', lineHeight: 1.55 }}>
        EjectSeat is not investment advice and not a guarantee of any outcome. Scores are based
        only on public SEC filings, earnings call transcripts, and Tier A/B media —{' '}
        <Link href="/how.html">read how scoring works</Link>.
      </p>

      <Footer />

      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
    </main>
  );
}

function Header() {
  return (
    <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 32 }}>
      <Link href="/" style={{ fontWeight: 700, fontSize: 18, color: '#0f172a', textDecoration: 'none' }}>
        Eject<span style={{ color: '#2563eb' }}>Seat</span>
      </Link>
      <nav style={{ display: 'flex', gap: 18, fontSize: 14 }}>
        <Link href="/how.html" style={{ color: '#475569' }}>How it works</Link>
        <Link href="/privacy.html" style={{ color: '#475569' }}>Privacy</Link>
      </nav>
    </header>
  );
}

function Footer() {
  return (
    <footer style={{ marginTop: 48, paddingTop: 20, borderTop: '1px solid #e4e8ef', fontSize: 13, color: '#64748b' }}>
      © Admin-Ace LLC · Operated from the United States
    </footer>
  );
}

function Card({ title, danger, children }: { title: string; danger?: boolean; children: React.ReactNode }) {
  return (
    <div style={{ padding: '14px 16px', background: danger ? '#fef2f2' : '#f8fafc', border: `1px solid ${danger ? '#fecaca' : '#e4e8ef'}`, borderRadius: 10 }}>
      <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#64748b', marginBottom: 6 }}>{title}</div>
      {children}
    </div>
  );
}

function FunctionRow({ name, atRisk }: { name: string; atRisk?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '7px 0', fontSize: 13, borderBottom: '1px solid #e4e8ef' }}>
      <span style={{ fontWeight: 500 }}>{name}</span>
      <span
        style={{
          fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', padding: '2px 7px',
          borderRadius: 999, fontWeight: 700,
          background: atRisk ? '#fef2f2' : '#ecfdf5', color: atRisk ? '#b91c1c' : '#047857',
        }}
      >
        {atRisk ? 'At risk' : 'Protected'}
      </span>
    </div>
  );
}

function SignalRow({ tag, msg, src, confirmed }: { tag: string; msg: string; src: string; confirmed?: boolean }) {
  const tagStyle = confirmed
    ? { background: '#fef2f2', color: '#b91c1c', border: '1px solid #fecaca' }
    : { background: '#fffbeb', color: '#92400e', border: '1px solid #fde68a' };
  return (
    <div style={{ display: 'flex', gap: 14, padding: '11px 0', borderBottom: '1px solid #e4e8ef' }}>
      <span style={{ flexShrink: 0, fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', padding: '3px 8px', borderRadius: 4, minWidth: 76, textAlign: 'center', ...tagStyle }}>
        {tag}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, color: '#0f172a', lineHeight: 1.5 }}>{msg}</div>
        {src && <div style={{ fontSize: 12, color: '#64748b', marginTop: 3 }}>{src}</div>}
      </div>
    </div>
  );
}

async function loadInitialComments(ticker: string) {
  const supabase = getSupabaseServerClient();
  const { data } = await supabase
    .from('company_comments')
    .select('id, body, created_at')
    .eq('ticker', ticker)
    .eq('hidden', false)
    .order('created_at', { ascending: false })
    .limit(20);
  return data || [];
}

const page: React.CSSProperties = {
  maxWidth: 760,
  margin: '0 auto',
  padding: '28px 24px 80px',
  fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
  color: '#0f172a',
  background: '#f6f8fb',
};

const cta: React.CSSProperties = {
  background: '#2563eb',
  color: 'white',
  border: 0,
  padding: '10px 20px',
  borderRadius: 8,
  fontSize: 14,
  fontWeight: 600,
  textDecoration: 'none',
  whiteSpace: 'nowrap',
};
