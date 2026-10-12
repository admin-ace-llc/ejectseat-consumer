// lib/events/warn.ts — state WARN Act layoff notices (public, machine-readable sources only).
//
// Employers must give notice to the state before a mass layoff or plant closing.
// These notices cover private companies too, which SEC filings do not.
// Sources (each verified live): Texas Workforce Commission open-data feed (Socrata JSON)
// and Maryland Department of Labor's WARN table (HTML). A failing source is skipped,
// never fatal, so the page always renders whatever is reachable.

export interface WarnNotice {
  id: string;
  state: 'TX' | 'MD';
  company: string;
  location: string;      // "Plano, TX" / street + county for MD
  employees: number | null;
  noticeDate: string;    // YYYY-MM-DD
  effectiveDate: string | null;
  type: string | null;
  sourceName: string;
  sourceUrl: string;
}

const UA = 'EjectSeat/1.0 (enquiries.talkace@gmail.com)';
const TX_URL = 'https://data.texas.gov/resource/8w53-c4f6.json';
const TX_PAGE = 'https://data.texas.gov/d/8w53-c4f6';
const MD_URL = 'https://labor.maryland.gov/employment/warn.shtml';

const ymd = (s: string | undefined | null) => (s ? s.slice(0, 10) : null);
const mdy = (s: string): string | null => {
  const m = s.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : null;
};
const clean = (s: string) =>
  s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/&rsquo;|&#8217;/g, '’').replace(/\s+/g, ' ').trim();

async function fetchTexas(days: number): Promise<WarnNotice[]> {
  try {
    const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
    const url = `${TX_URL}?$where=${encodeURIComponent(`notice_date >= '${since}'`)}&$order=${encodeURIComponent('notice_date DESC')}&$limit=200`;
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000), next: { revalidate: 3600 } });
    if (!res.ok) return [];
    const rows: any[] = await res.json();
    return rows
      .filter((r) => r.job_site_name && r.notice_date)
      .map((r, i) => ({
        id: `tx-${ymd(r.notice_date)}-${i}-${String(r.job_site_name).slice(0, 24)}`,
        state: 'TX' as const,
        company: clean(String(r.job_site_name)),
        location: [r.city_name, 'TX'].filter(Boolean).join(', '),
        employees: r.total_layoff_number ? parseInt(String(r.total_layoff_number).replace(/,/g, ''), 10) || null : null,
        noticeDate: ymd(r.notice_date)!,
        effectiveDate: ymd(r.layoff_date),
        type: null,
        sourceName: 'Texas Workforce Commission',
        sourceUrl: TX_PAGE,
      }));
  } catch {
    return [];
  }
}

async function fetchMaryland(): Promise<WarnNotice[]> {
  try {
    const res = await fetch(MD_URL, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000), next: { revalidate: 3600 } });
    if (!res.ok) return [];
    const html = await res.text();
    const out: WarnNotice[] = [];
    for (const tr of html.match(/<tr[\s\S]*?<\/tr>/gi) ?? []) {
      const cells = (tr.match(/<td[\s\S]*?<\/td>/gi) ?? []).map(clean);
      if (cells.length < 8) continue;
      const noticeDate = mdy(cells[0]);
      if (!noticeDate) continue; // header or malformed row
      const [, , company, location, area, total, effective, type] = cells;
      out.push({
        id: `md-${noticeDate}-${company.slice(0, 24)}`,
        state: 'MD',
        company,
        location: [location.split(',').slice(-2).join(',').trim() || area, 'MD'].filter(Boolean).join(', '),
        employees: parseInt(total.replace(/,/g, ''), 10) || null,
        noticeDate,
        effectiveDate: mdy(effective),
        type: type || null,
        sourceName: 'Maryland Dept. of Labor',
        sourceUrl: MD_URL,
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** WARN notices from all reachable sources, newest first. */
export async function fetchWarnNotices(days = 90): Promise<WarnNotice[]> {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const [tx, md] = await Promise.all([fetchTexas(days), fetchMaryland()]);
  return [...tx, ...md].filter((n) => n.noticeDate >= cutoff).sort((a, b) => b.noticeDate.localeCompare(a.noticeDate));
}
