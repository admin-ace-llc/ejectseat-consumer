import Link from 'next/link';
import type { LayoffEvent } from '@/lib/events/layoffs';
import { daysAgo } from '@/lib/events/layoffs';

function whenParts(iso: string) {
  const d = new Date(iso + 'T00:00:00Z');
  return {
    day: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }),
    year: d.getUTCFullYear(),
  };
}

export default function EventStrip({ e }: { e: LayoffEvent }) {
  const { day, year } = whenParts(e.filedAt);
  const ageDays = Math.floor((Date.now() - new Date(e.filedAt + 'T00:00:00Z').getTime()) / 86_400_000);
  const fresh = ageDays <= 3;
  const money = (m: number) => (m >= 1000 ? `$${(m / 1000).toFixed(1)}B` : `$${Math.round(m)}M`);
  const charges =
    e.chargesUsdM != null
      ? `${e.chargesMaxUsdM != null && e.chargesMaxUsdM > e.chargesUsdM ? `${money(e.chargesUsdM)}–${money(e.chargesMaxUsdM).replace('$', '')}` : money(e.chargesUsdM)} charges`
      : null;
  const scoreHref = e.ticker
    ? `/check.html?company=${encodeURIComponent(e.name)}&ticker=${encodeURIComponent(e.ticker)}`
    : `/check.html?company=${encodeURIComponent(e.name)}`;
  return (
    <li className={`strip${fresh ? ' fresh' : ''}`}>
      <div className="when">
        <b>{day}</b>
        {year}
      </div>
      <div>
        <h3>
          <a href={e.filingUrl} target="_blank" rel="noopener noreferrer">{e.headline}</a>
        </h3>
        <div className="co">
          {e.ticker ? <Link href={`/layoffs/${e.ticker}`} prefetch={false}>{e.name} ({e.ticker})</Link> : e.name} · filed {daysAgo(e.filedAt)}
        </div>
        <p className="sum">{e.summary}</p>
        <div className="chips">
          {e.pctWorkforce != null && <span className="chip hot">{e.pctWorkforce}% of workforce</span>}
          {e.employees != null && <span className="chip hot">~{e.employees.toLocaleString('en-US')} jobs</span>}
          {charges && <span className="chip">{charges}</span>}
          <span className="chip">{e.kind === 'workforce' ? 'Workforce reduction' : 'Restructuring'}</span>
          <a href={e.filingUrl} target="_blank" rel="noopener noreferrer">SEC filing ↗</a>
          <a href={scoreHref}>Check risk</a>
        </div>
      </div>
    </li>
  );
}
