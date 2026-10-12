import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import SiteHeader from '@/components/SiteHeader';
import SiteFooter from '@/components/SiteFooter';
import EventStrip from '@/components/EventStrip';
import AlertSignup from '@/components/AlertSignup';
import { fetchCompanyEvents, fmtDate, lookupCompany } from '@/lib/events/layoffs';

export const revalidate = 3600;

type Props = { params: { ticker: string } };

async function load(ticker: string) {
  const company = await lookupCompany(ticker);
  if (!company) return null;
  const events = await fetchCompanyEvents(company.cik);
  return { company, events };
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const data = await load(params.ticker);
  if (!data) return { title: 'Company not found', robots: { index: false } };
  const { company, events } = data;
  const latest = events[0];
  const title = `${company.name} layoffs and restructurings (${company.ticker})`;
  const description = latest
    ? `${company.name} most recently disclosed a ${latest.kind === 'workforce' ? 'workforce reduction' : 'restructuring'} in an SEC filing on ${fmtDate(latest.filedAt)}. Full history with links to each filing.`
    : `No layoff or restructuring disclosures (SEC 8-K Item 2.05) found for ${company.name} since 2023.`;
  return {
    title,
    description,
    alternates: { canonical: `https://ejectseat.io/layoffs/${company.ticker}` },
    openGraph: { title, description, url: `https://ejectseat.io/layoffs/${company.ticker}`, siteName: 'EjectSeat' },
    robots: events.length ? undefined : { index: false, follow: true },
  };
}

export default async function CompanyLayoffs({ params }: Props) {
  const data = await load(params.ticker);
  if (!data) notFound();
  const { company, events } = data;
  const latest = events[0];

  const answer = latest
    ? `Yes. ${company.name} has filed ${events.length} SEC 8-K${events.length === 1 ? '' : 's'} with Item 2.05 (exit or disposal costs) since 2023. The most recent, on ${fmtDate(latest.filedAt)}, ${latest.pctWorkforce ? `described a cut of about ${latest.pctWorkforce}% of its workforce` : latest.employees ? `described about ${latest.employees.toLocaleString('en-US')} job cuts` : latest.kind === 'workforce' ? 'disclosed a workforce reduction' : 'disclosed a restructuring plan'}.`
    : `No. We found no SEC 8-K with Item 2.05 (exit or disposal costs) for ${company.name} since 2023. Layoffs below the SEC disclosure threshold, or reported only by the press, would not appear here.`;

  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'FAQPage',
        mainEntity: [{ '@type': 'Question', name: `Has ${company.name} had layoffs?`, acceptedAnswer: { '@type': 'Answer', text: answer } }],
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Latest layoffs', item: 'https://ejectseat.io/layoffs' },
          { '@type': 'ListItem', position: 2, name: company.name, item: `https://ejectseat.io/layoffs/${company.ticker}` },
        ],
      },
    ],
  };

  return (
    <>
      <SiteHeader current="layoffs" />
      <main className="wrap">
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
        <section className="hero">
          <h1>{company.name} layoffs</h1>
          <p className="lede">{answer}</p>
          <a className="btn" href={`/check.html?company=${encodeURIComponent(company.name)}&ticker=${company.ticker}`}>
            Check {company.ticker} layoff risk
          </a>
        </section>

        <div className="feed-head">
          <h2>SEC filings since 2023</h2>
          <span className="meta">{events.length} found · <a href="/layoffs">All companies</a></span>
        </div>
        {events.length === 0 ? (
          <p className="empty">Nothing filed under Item 2.05. Get the weekly digest to see when that changes.</p>
        ) : (
          <ul className="feed">{events.map((e) => <EventStrip key={e.id} e={e} />)}</ul>
        )}

        <section className="callout">
          <h2>Know when {company.ticker} files again</h2>
          <p>The Monday digest lists every layoff filed that week, across all US public companies.</p>
          <AlertSignup source={`company-${company.ticker}`} />
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
