import type { Metadata } from 'next';
import SiteHeader from '@/components/SiteHeader';
import SiteFooter from '@/components/SiteFooter';

export const metadata: Metadata = {
  title: 'How EjectSeat sources layoff news',
  description: 'Where our layoff data comes from, what it covers, what it misses, and how to report a correction.',
  alternates: { canonical: 'https://ejectseat.io/about' },
};

export default function About() {
  return (
    <>
      <SiteHeader current="about" />
      <main className="wrap" style={{ maxWidth: 680 }}>
        <section className="hero">
          <h1>How we source layoff news</h1>
          <p className="lede">Every item on EjectSeat links to a document you can read yourself.</p>
        </section>

        <h2>Where the data comes from</h2>
        <p>
          US public companies must file a Form 8-K within four business days of committing to a plan that involves
          exit or disposal costs, such as layoffs, site closures or product exits. That disclosure is Item 2.05. We
          search the SEC&apos;s EDGAR database for those filings, read the item text, and pull out the figures the
          company states: share of workforce, number of jobs, and restructuring charges.
        </p>

        <h2>What it covers</h2>
        <ul>
          <li>US-listed companies, when their 8-K appears on EDGAR.</li>
          <li>Numbers exactly as the company states them. If a filing gives no figure, we show none.</li>
          <li>Restructurings without job cuts, labelled as restructuring and not as layoffs.</li>
        </ul>

        <h2>What it misses</h2>
        <ul>
          <li>Private companies and subsidiaries of foreign companies that do not file 8-Ks.</li>
          <li>Layoffs a company judges too small to disclose, and cuts reported only by the press.</li>
          <li>Layoffs announced in a press release before the 8-K is filed. We publish when the filing appears.</li>
          <li>Government WARN notices. We do not read them yet.</li>
        </ul>

        <h2>Risk scores</h2>
        <p>
          The <a href="/check.html">risk checker</a> is a separate, forward-looking estimate based on filings,
          earnings-call transcripts and news. It is not a statement of fact and not investment advice.
        </p>

        <h2>Report a correction</h2>
        <p>
          If a figure or summary does not match the filing, email{' '}
          <a href="mailto:enquiries.talkace@gmail.com?subject=EjectSeat%20correction">enquiries.talkace@gmail.com</a>{' '}
          with the link to the filing. We correct confirmed errors promptly.
        </p>
      </main>
      <SiteFooter />
    </>
  );
}
