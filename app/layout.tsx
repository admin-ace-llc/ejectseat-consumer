import type { Metadata } from 'next';

export const metadata: Metadata = {
  metadataBase: new URL('https://ejectseat.io'),
  // Defaults for any page that doesn't set its own metadata (company pages override these).
  title: 'EjectSeat — Layoff Risk Scores for US-Listed Companies',
  description:
    'EjectSeat scores layoff risk for US-listed public companies using SEC filings, earnings call transcripts, and Tier A/B media.',
  openGraph: {
    siteName: 'EjectSeat',
    type: 'website',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, padding: 0 }}>{children}</body>
    </html>
  );
}
