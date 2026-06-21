// lib/warn/ca.ts — EjectSeat Consumer v7.3
//
// California EDD WARN Act report fetcher/parser.
//
// Source of truth: the EDD's own published .xlsx report. There is no clean
// CSV/JSON endpoint, so we parse the spreadsheet directly. Column headers in
// that file are not under our control and can shift between releases, so
// this module detects columns by matching header text against synonyms
// rather than hardcoding column positions or exact header strings.
//
// HARD RULE (do not relax this): if the expected columns can't be confidently
// located, return an empty result and log a warning — never fabricate or
// guess rows. Every row we DO return must trace back to an actual parsed
// cell in the source file.

import * as XLSX from 'xlsx';

export const CA_WARN_SOURCE_URL =
  'https://edd.ca.gov/siteassets/files/jobs_and_training/warn/warn_report1.xlsx';

export interface CaWarnRow {
  companyName: string;
  county: string | null;
  noticeDate: string | null;     // YYYY-MM-DD
  effectiveDate: string | null;  // YYYY-MM-DD
  receivedDate: string | null;   // YYYY-MM-DD
  employeesAffected: number | null;
  layoffType: string | null;
  raw: Record<string, unknown>;
}

export interface CaWarnFetchResult {
  rows: CaWarnRow[];
  sourceUrl: string;
  fetchedAt: string;
  warning: string | null;
}

// Synonyms for each field we need. Matched case-insensitively against
// header cell text, trimmed of whitespace. Order matters: first match wins.
const FIELD_SYNONYMS: Record<string, RegExp[]> = {
  companyName:        [/company/i, /employer/i, /business\s*name/i],
  county:              [/county/i, /parish/i],
  noticeDate:          [/notice\s*date/i, /^date\s*of\s*notice/i],
  effectiveDate:       [/effective\s*date/i, /^layoff\s*date/i],
  receivedDate:        [/received\s*date/i, /date\s*received/i],
  employeesAffected:   [/employees?\s*affected/i, /no\.?\s*of\s*employees/i, /number\s*of\s*employees/i, /total\s*employees/i],
  layoffType:          [/layoff\/closure/i, /type\s*of\s*notice/i, /closure\s*\/\s*layoff/i, /\blayoff\b/i],
};

// Minimum number of REQUIRED fields (company, at least one date, employees)
// that must be confidently mapped before we trust a row as the header row.
const REQUIRED_FIELDS = ['companyName', 'employeesAffected'];

function matchHeaderCell(cell: unknown): string | null {
  if (typeof cell !== 'string') return null;
  const text = cell.trim();
  if (!text) return null;
  for (const [field, patterns] of Object.entries(FIELD_SYNONYMS)) {
    if (patterns.some(re => re.test(text))) return field;
  }
  return null;
}

function findHeaderRow(rows: unknown[][]): { rowIndex: number; columnMap: Record<string, number> } | null {
  // Scan the first 15 rows for one that maps enough recognizable columns.
  const scanLimit = Math.min(rows.length, 15);
  for (let i = 0; i < scanLimit; i++) {
    const row = rows[i];
    if (!Array.isArray(row)) continue;
    const columnMap: Record<string, number> = {};
    row.forEach((cell, colIdx) => {
      const field = matchHeaderCell(cell);
      if (field && columnMap[field] === undefined) columnMap[field] = colIdx;
    });
    const hasRequired = REQUIRED_FIELDS.every(f => columnMap[f] !== undefined);
    if (hasRequired && Object.keys(columnMap).length >= 3) {
      return { rowIndex: i, columnMap };
    }
  }
  return null;
}

function toIsoDate(value: unknown): string | null {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed.toISOString().slice(0, 10);
  }
  return null;
}

function toEmployeeCount(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? Math.round(n) : null;
}

/**
 * Fetches and parses the CA EDD WARN report. Returns an empty `rows` array
 * (with `warning` set) rather than guessed data if the file can't be fetched
 * or its layout doesn't match what we expect — per explicit product
 * requirement: never mislead or hallucinate WARN data.
 */
export async function fetchCaWarnNotices(): Promise<CaWarnFetchResult> {
  const fetchedAt = new Date().toISOString();

  let buf: ArrayBuffer;
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 20_000);
    const res = await fetch(CA_WARN_SOURCE_URL, {
      headers: { 'User-Agent': 'EjectSeat/1.0 (enquiries.talkace@gmail.com)' },
      signal: controller.signal,
    });
    clearTimeout(t);
    if (!res.ok) {
      console.warn(`[warn/ca] fetch failed: HTTP ${res.status}`);
      return { rows: [], sourceUrl: CA_WARN_SOURCE_URL, fetchedAt, warning: `Fetch failed: HTTP ${res.status}` };
    }
    buf = await res.arrayBuffer();
  } catch (err: any) {
    console.warn('[warn/ca] fetch error:', err?.message || err);
    return { rows: [], sourceUrl: CA_WARN_SOURCE_URL, fetchedAt, warning: `Fetch error: ${err?.message || 'unknown'}` };
  }

  let sheetRows: unknown[][];
  try {
    const workbook = XLSX.read(buf, { type: 'array', cellDates: true });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) {
      return { rows: [], sourceUrl: CA_WARN_SOURCE_URL, fetchedAt, warning: 'Workbook has no sheets' };
    }
    sheetRows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: null, raw: true }) as unknown[][];
  } catch (err: any) {
    console.warn('[warn/ca] parse error:', err?.message || err);
    return { rows: [], sourceUrl: CA_WARN_SOURCE_URL, fetchedAt, warning: `Parse error: ${err?.message || 'unknown'}` };
  }

  const header = findHeaderRow(sheetRows);
  if (!header) {
    console.warn('[warn/ca] could not locate a recognizable header row — refusing to guess column layout');
    return { rows: [], sourceUrl: CA_WARN_SOURCE_URL, fetchedAt, warning: 'Could not detect expected columns in source file' };
  }

  const { rowIndex, columnMap } = header;
  const dataRows = sheetRows.slice(rowIndex + 1);

  const rows: CaWarnRow[] = [];
  for (const row of dataRows) {
    if (!Array.isArray(row) || row.every(c => c == null || c === '')) continue;

    const companyName = columnMap.companyName !== undefined
      ? String(row[columnMap.companyName] ?? '').trim()
      : '';
    if (!companyName) continue; // never fabricate a row with no company name

    const raw: Record<string, unknown> = {};
    for (const [field, colIdx] of Object.entries(columnMap)) raw[field] = row[colIdx];

    rows.push({
      companyName,
      county: columnMap.county !== undefined ? (String(row[columnMap.county] ?? '').trim() || null) : null,
      noticeDate: columnMap.noticeDate !== undefined ? toIsoDate(row[columnMap.noticeDate]) : null,
      effectiveDate: columnMap.effectiveDate !== undefined ? toIsoDate(row[columnMap.effectiveDate]) : null,
      receivedDate: columnMap.receivedDate !== undefined ? toIsoDate(row[columnMap.receivedDate]) : null,
      employeesAffected: columnMap.employeesAffected !== undefined ? toEmployeeCount(row[columnMap.employeesAffected]) : null,
      layoffType: columnMap.layoffType !== undefined ? (String(row[columnMap.layoffType] ?? '').trim() || null) : null,
      raw,
    });
  }

  return { rows, sourceUrl: CA_WARN_SOURCE_URL, fetchedAt, warning: null };
}
