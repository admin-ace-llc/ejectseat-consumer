import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import SiteHeader from '@/components/SiteHeader';
import SiteFooter from '@/components/SiteFooter';
import Prose from '@/components/Prose';
import { getArticle, listArticles } from '@/lib/content';

export const dynamicParams = false;

export function generateStaticParams() {
  return listArticles().map((a) => ({ slug: a.slug }));
}

export function generateMetadata({ params }: { params: { slug: string } }): Metadata {
  const a = getArticle(params.slug);
  if (!a) return {};
  const url = `https://ejectseat.io/insights/${a.slug}`;
  return {
    title: a.title,
    description: a.description,
    alternates: { canonical: url },
    openGraph: { type: 'article', title: a.title, description: a.description, url, publishedTime: a.date, modifiedTime: a.updated },
  };
}

export default function ArticlePage({ params }: { params: { slug: string } }) {
  const a = getArticle(params.slug);
  if (!a) notFound();
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: a.title,
    description: a.description,
    datePublished: a.date,
    dateModified: a.updated,
    mainEntityOfPage: `https://ejectseat.io/insights/${a.slug}`,
    author: { '@type': 'Organization', name: 'EjectSeat', url: 'https://ejectseat.io/' },
    publisher: { '@type': 'Organization', name: 'EjectSeat', url: 'https://ejectseat.io/' },
    keywords: a.tags.join(', '),
  };
  return (
    <>
      <SiteHeader current="insights" />
      <main className="wrap">
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
        <article>
          <p className="meta"><a href="/insights">Analysis</a> · {a.date}{a.updated !== a.date ? ` · updated ${a.updated}` : ''}</p>
          <h1>{a.title}</h1>
          <Prose body={a.body} />
          <p className="meta">Sources are linked inline. Figures come from company filings with the SEC and state WARN notices. <a href="/about">How we source</a>.</p>
        </article>
      </main>
      <SiteFooter />
    </>
  );
}
