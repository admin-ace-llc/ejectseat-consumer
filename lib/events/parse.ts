// lib/events/parse.ts — pure text helpers that turn an SEC 8-K "Item 2.05"
// section into a structured, human-readable layoff event. No network, no LLM:
// deterministic, so it is cheap to run on every filing and easy to unit test.

export type EventKind = 'workforce' | 'restructuring';

export interface ParsedEvent {
  kind: EventKind;
  pctWorkforce: number | null;   // e.g. 2.5
  employees: number | null;      // e.g. 1200
  chargesUsdM: number | null;    // restructuring charge (low end), USD millions
  chargesMaxUsdM: number | null; // high end when a range is given
  summary: string;               // 1–3 plain sentences from the filing
}

// Strong workforce language only: a bare "employee" appears in many non-layoff
// restructurings (store closures, product exits) via "employee separation benefits".
const WORKFORCE_RE =
  /\b(workforce|headcount|reductions? in force|layoffs?|laid off|job (?:cuts|losses)|severance)\b|(?:reduc\w+|eliminat\w+|terminat\w+|notif\w+)[^.]{0,80}\b(?:employees|positions|roles|jobs)\b/i;

/** Strip tags/entities from raw filing HTML into collapsed plain text. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;|&#xa0;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#8217;|&rsquo;|&#x2019;/gi, '’')
    .replace(/&#8220;|&#8221;|&ldquo;|&rdquo;/gi, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}

/** Returns the text of Item 2.05 up to the next Item heading (max ~2,000 chars). */
export function extractItem205(text: string): string | null {
  // Skip table-of-contents style mentions: take the LAST heading-like match
  // that is followed by a sentence, falling back to the first.
  const re = /Item\s*2\.05\.?\s*[-–—:]?\s*Costs Associated with Exit or Disposal Activities\.?/gi;
  const matches = [...text.matchAll(re)];
  if (!matches.length) return null;
  const m = matches[matches.length - 1];
  const start = (m.index ?? 0) + m[0].length;
  const rest = text.slice(start);
  const next = rest.search(/Item\s*\d\.\d{2}\b/i);
  const sig = rest.search(/\bSIGNATURES?\b/);
  const ends = [next, sig].filter((n) => n > 0);
  const end = ends.length ? Math.min(...ends) : 2000;
  return rest.slice(0, Math.min(end, 2000)).trim() || null;
}

function firstSentences(s: string, maxChars = 420): string {
  // Split only where a sentence really ends (period + space + capital), so
  // "$1.5 billion" and "Inc." do not break the text.
  const sentences = s.split(/(?<=[.!?])\s+(?=[A-Z“"(])/);
  let out = '';
  for (const sent of sentences) {
    if (out && (out + ' ' + sent).length > maxChars) break;
    out = out ? `${out} ${sent}` : sent;
    if (out.length >= 220) break;
  }
  return out.length > maxChars + 40 ? out.slice(0, maxChars).replace(/\s+\S*$/, '') + '…' : out;
}

export function parseItem205(section: string): ParsedEvent {
  const isWorkforce = WORKFORCE_RE.test(section);

  // "2.5% of Workday's current workforce", "15% of positions", "approximately 9 percent of employees"
  let pct: number | null = null;
  const pctRe = /(\d{1,2}(?:\.\d+)?)\s*(?:%|percent)[^.]{0,70}?\b(workforce|employees|positions|headcount|staff)\b/i;
  const pm = section.match(pctRe);
  if (pm) {
    const v = parseFloat(pm[1]);
    if (v > 0 && v <= 60) pct = v;
  }

  // "approximately 1,200 employees", "about 300 positions", "up to 450 roles"
  let employees: number | null = null;
  const empRe = /(?:approximately|about|up to|roughly|around|~)?\s*(\d{1,3}(?:,\d{3})+|\d{2,6})\s+(?:full[- ]time\s+)?(?:employees|positions|jobs|roles|team members|associates)/i;
  const em = section.match(empRe);
  if (em) {
    const v = parseInt(em[1].replace(/,/g, ''), 10);
    if (v >= 10 && v < 1_000_000) employees = v;
  }

  // First dollar amount in the section = headline restructuring charge.
  let charges: number | null = null;
  let chargesMax: number | null = null;
  const toM = (n: string, unit: string) => parseFloat(n.replace(/,/g, '')) * (/billion/i.test(unit) ? 1000 : 1);
  const rm = section.match(/\$\s?([\d,]+(?:\.\d+)?)\s*(million|billion)?\s*(?:to|and|-|–)\s*\$?\s?([\d,]+(?:\.\d+)?)\s*(million|billion)/i);
  const cm = section.match(/\$\s?([\d,]+(?:\.\d+)?)\s*(million|billion)/i);
  if (rm) {
    charges = toM(rm[1], rm[2] || rm[4]);
    chargesMax = toM(rm[3], rm[4]);
  } else if (cm) {
    charges = toM(cm[1], cm[2]);
  }

  return {
    kind: isWorkforce ? 'workforce' : 'restructuring',
    pctWorkforce: pct,
    employees,
    chargesUsdM: charges,
    chargesMaxUsdM: chargesMax,
    summary: firstSentences(section),
  };
}

/** "Quantum-Si Inc  (QSI)  (CIK 0001816431)" → { name, ticker, cik } */
export function parseDisplayName(raw: string): { name: string; ticker: string | null; cik: string | null } {
  const cik = raw.match(/\(CIK\s*(\d+)\)/i)?.[1] ?? null;
  const withoutCik = raw.replace(/\(CIK\s*\d+\)/i, '').trim();
  const tm = withoutCik.match(/\(([A-Z][A-Z0-9.\-]*(?:,\s*[A-Z0-9.\-]+)*)\)\s*$/);
  const ticker = tm ? tm[1].split(',')[0].trim() : null;
  const name = (tm ? withoutCik.slice(0, tm.index) : withoutCik).replace(/\s+/g, ' ').trim();
  return { name, ticker, cik };
}

/** One-line headline built only from facts found in the filing. */
export function buildHeadline(name: string, p: ParsedEvent): string {
  const short = name.replace(/,?\s+(inc|corp|corporation|co|company|ltd|plc|llc|holdings?)\.?$/i, '').trim();
  if (p.kind === 'workforce') {
    if (p.pctWorkforce && p.employees) return `${short} to cut about ${p.employees.toLocaleString('en-US')} jobs (${p.pctWorkforce}% of workforce)`;
    if (p.pctWorkforce) return `${short} cutting about ${p.pctWorkforce}% of its workforce`;
    if (p.employees) return `${short} to cut about ${p.employees.toLocaleString('en-US')} jobs`;
    return `${short} discloses a workforce reduction`;
  }
  return `${short} files a restructuring plan`;
}
