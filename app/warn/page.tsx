import type { Metadata } from 'next';
import SiteHeader from '@/components/SiteHeader';
import SiteFooter from '@/components/SiteFooter';
import { fetchWarnNotices } from '@/lib/events/warn';
import { daysAgo, fmtDate } from '@/lib/events/layoffs';

export const revalidate = 3600;

export const metadata: Metadata = {
  title: 'WARN layoff notices from state labor departments',
  description:
    'Mass layoff and plant closing notices filed with state labor departments (WARN Act), including private companies. Currently Texas and Maryland, with links to each state source.',
  alternates: { canonical: 'https://ejectseat.io/warn' },
};

export default async function WarnPage() {
  const notices = await fetchWarnNotices(120);
  const total = notices.reduce((n, r) => n + (r.employees ?? 0), 0);

  return (
    <>
      <SiteHeader current="warn" />
      <main className="wrap">
        <section className="hero">
          <h1>WARN notices: layoffs filed with the state</h1>
          <p className="lede">
            Employers must warn the state before a mass layoff or plant closing. These notices include private companies
            that never file with the SEC. We read the public lists from Texas and Maryland; more states are planned.
          </p>
        </section>

        <div className="feed-head">
          <h2>Last 120 days</h2>
          <span className="meta">
            {notices.length} notices{total ? `, about ${total.toLocaleString('en-US')} jobs` : ''}
          </span>
        </div>

        {notices.length === 0 ? (
          <p className="empty">The state lists did not respond just now. Refresh in a minute.</p>
        ) : (
          <ul className="feed">
            {notices.map((n) => (
              <li key={n.id} className="strip">
                <div className="when">
                  <b>{fmtDate(n.noticeDate).replace(/, \d{4}$/, '')}</b>
                  {n.noticeDate.slice(0, 4)}
                </div>
                <div>
                  <h3>{n.company}</h3>
                  <div className="co">
                    {n.location} · notice filed {daysAgo(n.noticeDate)}
                  </div>
                  <div className="chips">
                    {n.employees != null && <span className="chip hot">{n.employees.toLocaleString('en-US')} employees</span>}
                    {n.effectiveDate && <span className="chip">Effective {fmtDate(n.effectiveDate)}</span>}
                    {n.type && <span className="chip">{n.type}</span>}
                    <a href={n.sourceUrl} target="_blank" rel="noopener noreferrer">{n.sourceName} ↗</a>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
        <p className="empty" style={{ fontSize: 14 }}>
          A WARN notice is advance warning, so the layoff date can differ from the filing date. Some states publish with
          a delay; Texas&apos;s list is updated less often than Maryland&apos;s.
        </p>
      </main>
      <SiteFooter />
    </>
  );
}
