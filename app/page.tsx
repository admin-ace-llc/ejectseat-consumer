import SiteHeader from '@/components/SiteHeader';
import SiteFooter from '@/components/SiteFooter';
import EventStrip from '@/components/EventStrip';
import AlertSignup from '@/components/AlertSignup';
import Link from 'next/link';
import { fetchLayoffEvents } from '@/lib/events/layoffs';

export const revalidate = 900;

export default async function Home() {
  const events = await fetchLayoffEvents({ days: 30, limit: 8 });

  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebSite',
        '@id': 'https://ejectseat.io/#website',
        url: 'https://ejectseat.io/',
        name: 'EjectSeat',
        description: 'Live feed of US public-company layoffs from SEC filings, plus layoff risk scores.',
        potentialAction: {
          '@type': 'SearchAction',
          target: { '@type': 'EntryPoint', urlTemplate: 'https://ejectseat.io/check.html?company={search_term_string}' },
          'query-input': 'required name=search_term_string',
        },
      },
      { '@type': 'Organization', name: 'EjectSeat', url: 'https://ejectseat.io/' },
    ],
  };

  return (
    <>
      <SiteHeader current="home" />
      <main className="wrap">
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
        <section className="hero">
          <h1>Layoffs, as they are filed.</h1>
          <p className="lede">
            When a US public company tells the SEC it is cutting jobs, EjectSeat reads the filing and posts the numbers
            here, with a link to the source. No rumours, no screenshots.
          </p>
          <form className="search" action="/check.html" method="get" role="search">
            <label htmlFor="home-q" style={{ position: 'absolute', left: -9999 }}>Company name or ticker</label>
            <input id="home-q" name="company" type="search" placeholder="Is your company next? Name or ticker" autoComplete="off" />
            <button className="btn" type="submit">Check risk</button>
          </form>
        </section>

        <div className="feed-head">
          <h2>Filed in the last 30 days</h2>
          <span className="meta"><Link href="/layoffs">All layoffs</Link> · <a href="/layoffs/feed.xml">RSS</a></span>
        </div>
        {events.length === 0 ? (
          <p className="empty">The SEC feed did not respond just now. <Link href="/layoffs">Open the full list</Link> to retry.</p>
        ) : (
          <ul className="feed">{events.map((e) => <EventStrip key={e.id} e={e} />)}</ul>
        )}
        <p style={{ marginTop: 14 }}><Link className="btn ghost" href="/layoffs">See every filing</Link></p>

        <section className="callout">
          <h2>Know before your company does</h2>
          <p>Get a Monday email with every layoff filed that week. Free, and you can unsubscribe in one click.</p>
          <AlertSignup source="digest" />
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
