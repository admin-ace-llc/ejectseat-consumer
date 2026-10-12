import type { Metadata } from 'next';
import SiteHeader from '@/components/SiteHeader';
import SiteFooter from '@/components/SiteFooter';
import EventStrip from '@/components/EventStrip';
import { fetchLayoffEvents } from '@/lib/events/layoffs';

export const revalidate = 900;

export const metadata: Metadata = {
  title: 'Latest layoffs and restructurings from SEC filings',
  description:
    'Every US public-company layoff and restructuring disclosed in an SEC 8-K (Item 2.05), summarized with the share of workforce affected and a link to the filing.',
  alternates: { canonical: 'https://ejectseat.io/layoffs', types: { 'application/rss+xml': 'https://ejectseat.io/layoffs/feed.xml' } },
};

export default async function LayoffsPage() {
  const events = await fetchLayoffEvents({ days: 60, limit: 60 });
  const workforce = events.filter((e) => e.kind === 'workforce').length;

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: 'Latest layoffs and restructurings from SEC filings',
    url: 'https://ejectseat.io/layoffs',
    isPartOf: { '@type': 'WebSite', name: 'EjectSeat', url: 'https://ejectseat.io/' },
    mainEntity: {
      '@type': 'ItemList',
      itemListElement: events.slice(0, 30).map((e, i) => ({
        '@type': 'ListItem',
        position: i + 1,
        item: { '@type': 'NewsArticle', headline: e.headline, datePublished: e.filedAt, url: e.filingUrl, publisher: { '@type': 'Organization', name: 'EjectSeat' } },
      })),
    },
  };

  return (
    <>
      <SiteHeader current="layoffs" />
      <main className="wrap">
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
        <section className="hero">
          <h1>Latest layoffs, straight from the filing</h1>
          <p className="lede">
            US public companies must tell the SEC when they commit to cutting jobs or closing operations. We read each
            filing, pull out the numbers, and link to the original.
          </p>
        </section>

        <div className="feed-head">
          <h2>Last 60 days</h2>
          <span className="meta">
            {events.length} filings, {workforce} with workforce reductions · <a href="/layoffs/feed.xml">RSS</a>
          </span>
        </div>

        {events.length === 0 ? (
          <p className="empty">
            The SEC feed did not respond just now. Refresh in a minute, or read filings directly on{' '}
            <a href="https://www.sec.gov/edgar/search/" rel="noopener noreferrer">sec.gov</a>.
          </p>
        ) : (
          <ul className="feed">{events.map((e) => <EventStrip key={e.id} e={e} />)}</ul>
        )}
      </main>
      <SiteFooter />
    </>
  );
}
