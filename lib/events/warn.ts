// lib/events/warn.ts — state WARN Act layoff notices (public, machine-readable sources only).
//
// Employers must give notice to the state before a mass layoff or plant closing.
// These notices cover private companies too, which SEC filings do not.
// Sources: Texas open-data feed (Socrata JSON), Maryland's table, and a config-driven reader for
// states that publish a plain HTML table (columns are found by header name, so layout changes
// do not break us). A failing source is skipped, never fatal.

export interface WarnNotice {
  id: string;
  state: string;          // two-letter code
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
        state: 'TX',
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
      const [, , company, , area, total, effective, type] = cells;
      out.push({
        id: `md-${noticeDate}-${company.slice(0, 24)}`,
        state: 'MD',
        company,
        location: `${area || 'Maryland'}, MD`,
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


function decode(s: string) {
  return s.replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

/** Dates in M/D/YYYY, M/D/YY, M-D-YYYY, with an optional trailing time. */
function anyDate(raw: string | undefined): string | null {
  if (!raw) return null;
  const m = raw.trim().match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2}|\d{4})(?:\D.*)?$/);
  if (!m) return null;
  const yr = m[3].length === 2 ? `20${m[3]}` : m[3];
  const d = `${yr}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return Number.isNaN(Date.parse(d)) ? null : d;
}

interface TableSource {
  state: string;
  name: string;
  page: string;                       // link shown to readers
  urls: () => string[];
  columns: {                          // header-name patterns
    company: RegExp;
    notice: RegExp;
    employees: RegExp;
    city?: RegExp;
    county?: RegExp;
    location?: RegExp;
    effective?: RegExp;
    type?: RegExp;
  };
  place: (c: { city: string; county: string; location: string }) => string;
  company?: (raw: string) => string;
}

const yr = () => new Date().getFullYear();
const city = (st: string) => (c: { city: string; county: string; location: string }) =>
  c.city ? `${c.city}, ${st}` : c.county ? `${c.county} County, ${st}` : st;

const TABLE_SOURCES: TableSource[] = [
  {
    state: 'MO', name: 'Missouri Dept. of Higher Education & Workforce Development', page: 'https://jobs.mo.gov/warn',
    urls: () => [`https://jobs.mo.gov/warn/${yr()}`, `https://jobs.mo.gov/warn/${yr() - 1}`],
    columns: { company: /^title$/i, notice: /received/i, employees: /affected/i, city: /^location/i, county: /^county/i, effective: /layoff date/i, type: /^type/i },
    place: city('MO'),
  },
  {
    state: 'IN', name: 'Indiana Dept. of Workforce Development', page: 'https://www.in.gov/dwd/warn-notices/current-warn-notices',
    urls: () => ['https://www.in.gov/dwd/warn-notices/current-warn-notices'],
    columns: { company: /^company/i, notice: /notice date/i, employees: /affected/i, city: /^city/i, effective: /LO\/CL|effective/i, type: /notice type/i },
    place: city('IN'),
  },
  {
    state: 'NC', name: 'NC Dept. of Commerce', page: 'https://www.commerce.nc.gov/data-tools-reports/labor-market-data-tools/workforce-warn-reports',
    urls: () => [`https://www.commerce.nc.gov/data-tools-reports/labor-market-data-tools/workforce-warn-reports/report-workforce-warn-summary-list-${yr()}`],
    columns: { company: /warn notice name|^company|employer/i, notice: /date of notice/i, employees: /number affected/i, city: /^city/i, county: /^county/i, effective: /effective/i, type: /type of layoff|warn notice type/i },
    place: city('NC'),
  },
  {
    state: 'OR', name: 'Oregon HECC / Workforce', page: 'https://ccwd.hecc.oregon.gov/layoff/warn',
    urls: () => ['https://ccwd.hecc.oregon.gov/layoff/warn', 'https://ccwd.hecc.oregon.gov/layoff/warn?page=2'],
    columns: { company: /^employer/i, notice: /notification date/i, employees: /^count/i, city: /^city/i, type: /layoff type/i },
    place: (c) => (c.city ? (/,\s*[A-Z]{2}$/.test(c.city) ? c.city : `${c.city}, OR`) : 'OR'),
  },
  {
    state: 'TN', name: 'Tennessee Dept. of Labor & Workforce Development', page: 'https://www.tn.gov/workforce/general-resources/major-publications0/major-publications-redirect/reports.html',
    urls: () => ['https://www.tn.gov/workforce/general-resources/major-publications0/major-publications-redirect/reports.html'],
    columns: { company: /^company/i, notice: /date of posting/i, employees: /affected/i, county: /^county/i, effective: /closure\/layoff date/i },
    place: (c) => (c.county ? `${c.county} County, TN` : 'TN'),
  },
  {
    state: 'UT', name: 'Utah Dept. of Workforce Services', page: 'https://jobs.utah.gov/employer/business/warnnotices.html',
    urls: () => ['https://jobs.utah.gov/employer/business/warnnotices.html'],
    columns: { company: /company name/i, notice: /date of notice/i, employees: /affected/i, city: /^location/i },
    place: city('UT'),
  },
  {
    state: 'VA', name: 'Virginia Works', page: 'https://virginiaworks.gov/warn-notices',
    urls: () => ['https://virginiaworks.gov/warn-notices'],
    columns: { company: /^company/i, notice: /notice date/i, employees: /employees affected/i, location: /^location/i, effective: /impact date/i, type: /notice type/i },
    place: (c) => c.location || 'VA',
    // The company cell merges name and street address: keep the name only.
    company: (raw) => (raw.match(/^(.*?)\s+\d{1,6}\s+\S/)?.[1] || raw).trim(),
  },
  {
    state: 'NE', name: 'Nebraska Dept. of Labor', page: 'https://dol.nebraska.gov/ReemploymentServices/LayoffServices/LayoffsAndDownsizingWARN',
    urls: () => ['https://dol.nebraska.gov/ReemploymentServices/LayoffServices/LayoffsAndDownsizingWARN'],
    columns: { company: /^company/i, notice: /^date/i, employees: /jobs affected/i, city: /^location/i },
    place: (c) => (c.city && !/remote/i.test(c.city) ? `${c.city}, NE` : 'Nebraska'),
  },
];

function parseTables(html: string, src: TableSource): WarnNotice[] {
  const out: WarnNotice[] = [];
  const col = src.columns;
  for (const table of html.match(/<table[\s\S]*?<\/table>/gi) ?? []) {
    let idx: Record<string, number> | null = null;
    for (const tr of table.match(/<tr[\s\S]*?<\/tr>/gi) ?? []) {
      const cells = (tr.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) ?? []).map((c) => decode(clean(c)));
      if (cells.length < 3) continue;
      if (!idx) {
        const find = (re?: RegExp) => (re ? cells.findIndex((c) => re.test(c)) : -1);
        const found = { company: find(col.company), notice: find(col.notice), employees: find(col.employees), city: find(col.city), county: find(col.county), location: find(col.location), effective: find(col.effective), type: find(col.type) };
        if (found.company >= 0 && found.notice >= 0 && found.company !== found.notice) idx = found; // header row
        continue;
      }
      const get = (i: number) => (i >= 0 && i < cells.length ? cells[i] : '');
      const noticeDate = anyDate(get(idx.notice));
      const company = get(idx.company);
      if (!noticeDate || !company) continue; // footer / total / malformed row
      const emp = parseInt(get(idx.employees).replace(/[^\d]/g, ''), 10);
      const name = (src.company ? src.company(company) : company).slice(0, 120);
      const place = src.place({ city: get(idx.city), county: get(idx.county), location: get(idx.location) });
      out.push({
        id: `${src.state.toLowerCase()}-${noticeDate}-${name.slice(0, 24)}-${place.slice(0, 16)}`,
        state: src.state,
        company: name,
        location: place,
        employees: Number.isFinite(emp) && emp > 0 ? emp : null,
        noticeDate,
        effectiveDate: anyDate(get(idx.effective)),
        type: get(idx.type) || null,
        sourceName: src.name,
        sourceUrl: src.page,
      });
    }
  }
  return out;
}

async function fetchTableSource(src: TableSource): Promise<WarnNotice[]> {
  const pages = await Promise.all(
    src.urls().map(async (u) => {
      try {
        const res = await fetch(u, { headers: { 'User-Agent': UA, Accept: 'text/html' }, signal: AbortSignal.timeout(9000), next: { revalidate: 3600 } });
        return res.ok ? await res.text() : '';
      } catch {
        return '';
      }
    }),
  );
  const seen = new Set<string>();
  const all: WarnNotice[] = [];
  for (const html of pages) {
    if (!html) continue;
    try {
      for (const n of parseTables(html, src)) if (!seen.has(n.id)) { seen.add(n.id); all.push(n); }
    } catch {
      /* bad page: skip */
    }
  }
  return all;
}

export interface WarnReport {
  notices: WarnNotice[];
  sources: { state: string; name: string; count: number }[];
}

/** WARN notices from all reachable sources (newest first) plus per-source counts for monitoring. */
export async function fetchWarnReport(days = 90): Promise<WarnReport> {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const today = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10); // drop obviously future-dated typos
  const jobs: { state: string; name: string; run: Promise<WarnNotice[]> }[] = [
    { state: 'TX', name: 'Texas Workforce Commission', run: fetchTexas(days) },
    { state: 'MD', name: 'Maryland Dept. of Labor', run: fetchMaryland() },
    ...TABLE_SOURCES.map((s) => ({ state: s.state, name: s.name, run: fetchTableSource(s) })),
  ];
  const results = await Promise.all(jobs.map((j) => j.run.catch(() => [] as WarnNotice[])));
  const notices: WarnNotice[] = [];
  const sources = jobs.map((j, i) => {
    const kept = results[i].filter((n) => n.noticeDate >= cutoff && n.noticeDate <= today);
    notices.push(...kept);
    return { state: j.state, name: j.name, count: kept.length };
  });
  notices.sort((a, b) => b.noticeDate.localeCompare(a.noticeDate));
  return { notices, sources };
}

export async function fetchWarnNotices(days = 90): Promise<WarnNotice[]> {
  return (await fetchWarnReport(days)).notices;
}
