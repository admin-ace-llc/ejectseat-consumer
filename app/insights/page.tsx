import type { Metadata } from 'next';
import Link from 'next/link';
import SiteHeader from '@/components/SiteHeader';
import SiteFooter from '@/components/SiteFooter';
import { listArticles } from '@/lib/content';

export const metadata: Metadata = {
  title: 'Layoff analysis and guides',
  description: 'Analysis of US layoffs drawn from SEC filings and state WARN notices, plus practical guides for people who work at companies in trouble.',
  alternates: { canonical: 'https://ejectseat.io/insights', types: { 'application/rss+xml': 'https://ejectseat.io/insights/feed.xml' } },
};

export default function InsightsPage() {
  const articles = listArticles();
  return (
    <>
      <SiteHeader current="insights" />
      <main className="wrap">
        <section className="hero">
          <h1>Layoff analysis and guides</h1>
          <p className="lede">What the filings say, what they mean, and what to do about it. Every number links back to its source.</p>
        </section>
        {articles.length === 0 ? (
          <p className="empty">First articles coming soon.</p>
        ) : (
          <ul className="feed">
            {articles.map((a) => (
              <li key={a.slug} className="strip">
                <div>
                  <h3><Link href={`/insights/${a.slug}`}>{a.title}</Link></h3>
                  <p>{a.description}</p>
                  <span className="meta">{a.date}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </main>
      <SiteFooter />
    </>
  );
}
