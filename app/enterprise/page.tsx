import type { Metadata } from 'next';
import Link from 'next/link';
import EnterpriseForm from './EnterpriseForm';

export const metadata: Metadata = {
  title: 'Enterprise & Bulk Data | EjectSeat',
  description: 'Bulk layoff-risk data, confirmed-event feeds, and custom reports for recruiters, investors, insurers, and journalists.',
  alternates: { canonical: 'https://ejectseat.io/enterprise' },
};

export default function EnterprisePage() {
  return (
    <main style={page}>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 40 }}>
        <Link href="/" style={{ fontWeight: 700, fontSize: 18, color: '#0f172a', textDecoration: 'none' }}>
          Eject<span style={{ color: '#2563eb' }}>Seat</span>
        </Link>
        <nav style={{ display: 'flex', gap: 18, fontSize: 14 }}>
          <Link href="/how.html" style={{ color: '#475569' }}>How it works</Link>
        </nav>
      </header>

      <h1 style={{ fontSize: 32, lineHeight: 1.15, letterSpacing: '-0.02em', marginBottom: 14 }}>
        Layoff-risk data for teams that need to know first
      </h1>
      <p style={{ fontSize: 16, lineHeight: 1.6, color: '#475569', marginBottom: 32, maxWidth: 620 }}>
        EjectSeat scores every US public company from SEC filings, earnings call transcripts,
        and Tier A/B media. Recruiters, investors, insurers, and journalists use bulk access to
        this dataset to spot workforce risk before it&apos;s widely known.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 14, marginBottom: 40 }}>
        <Card title="Confirmed-event feed" desc="Real-time feed of confirmed layoff filings and Tier A/B media events, deduped and scored." />
        <Card title="Full risk-score dataset" desc="Bulk CSV/API export of every scored company — score, band, state, and signal history." />
        <Card title="Custom reports" desc="Sector, geography, or watchlist-specific reports built from the same evidence pipeline." />
      </div>

      <h2 style={{ fontSize: 18, marginBottom: 16 }}>Request access</h2>
      <EnterpriseForm />

      <p style={{ fontSize: 13, color: '#64748b', marginTop: 32 }}>
        Or email us directly at{' '}
        <a href="mailto:enquiries.talkace@gmail.com" style={{ color: '#2563eb' }}>enquiries.talkace@gmail.com</a>.
      </p>

      <footer style={{ marginTop: 48, paddingTop: 20, borderTop: '1px solid #e4e8ef', fontSize: 13, color: '#64748b' }}>
        © Admin-Ace LLC · Operated from the United States
      </footer>
    </main>
  );
}

function Card({ title, desc }: { title: string; desc: string }) {
  return (
    <div style={{ padding: '16px 18px', background: '#f8fafc', border: '1px solid #e4e8ef', borderRadius: 10 }}>
      <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 6 }}>{title}</div>
      <div style={{ fontSize: 13, color: '#475569', lineHeight: 1.5 }}>{desc}</div>
    </div>
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
