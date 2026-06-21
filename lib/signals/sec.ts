// lib/signals/sec.ts — EjectSeat Consumer v7.2
//
// v7.2 ACCURACY FIXES:
//
//   1. Separate text budgets for annual vs interim filings.
//      v7.1 applied 12K to ALL filing types. 10-Qs (interim) carry the most
//      current restructuring disclosures but are shorter documents — 20K gives
//      full coverage. Annual 10-Ks are much longer; 15K with section targeting
//      is sufficient. 8-Ks get a dedicated slicer (see below).
//
//   2. 8-K filings: dedicated section slicer prioritising Item 2.05/2.06/5.02.
//      8-K Item 2.05 (Entry into Material Employment Agreements / workforce
//      reductions), Item 2.06 (Material Impairments), and Item 5.02 (Departure
//      of Directors/Officers) are the highest-signal items for layoff detection.
//      sliceAroundSections now includes these as top-priority anchors, and 8-Ks
//      get their own dedicated slicer that leads with them.
//
//   3. Deduplicate EDGAR fetches.
//      fetchLegacyAuditSignals previously made its own companyfacts + submissions
//      requests. Now it accepts an optional pre-fetched facts/submissions object
//      from fetchEvidenceBundle, eliminating the second EDGAR round-trip.
//
// PRIOR VERSION NOTES:
//   v7.1: FETCH_TIMEOUT_MS 8s→5s (preserved)
//   v7.1: fetchText cap 300K→150K (preserved)
//   v7:   Pure fetcher — no signal scoring in this file

import type {
  Signal, EvidenceBundle, FilingEvidence, HeadcountRecord,
} from '@/types';
import { fmtUSD } from '@/lib/format';

const USER_AGENT = 'EjectSeat/1.0 (enquiries.talkace@gmail.com)';
const EDGAR = 'https://data.sec.gov';

const FORMS_RELEVANT = new Set([
  '8-K', '8-K/A',
  '10-K', '10-K/A',
  '10-Q', '10-Q/A',
  '20-F', '20-F/A',
  '6-K',  '6-K/A',
  'NT 10-K', 'NT 10-Q', 'NT 20-F',
]);

// v7.1: reduced from 8_000 — fail faster on slow EDGAR endpoints
const FETCH_TIMEOUT_MS = 5_000;

// v7.2: separate text budgets per filing type
// 10-Q / 6-K (interim): higher budget — most current, shorter documents
const TEXT_BUDGET_INTERIM  = 20_000;
// 10-K / 20-F (annual): section-targeted slice of longer document
const TEXT_BUDGET_ANNUAL   = 15_000;
// 8-K: Item-targeted slice (smaller; 8-Ks are focused documents)
const TEXT_BUDGET_8K       = 10_000;

// ─────────────────────────────────────────────────────────────────────────────
// Low-level fetch helpers
// ─────────────────────────────────────────────────────────────────────────────

async function fetchJSON(url: string): Promise<any> {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: controller.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

async function fetchText(url: string, maxChars = 150_000): Promise<string> {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: controller.signal });
    clearTimeout(t);
    if (!res.ok) return '';
    const text = await res.text();
    return text.slice(0, maxChars);
  } catch { return ''; }
}

function padCik(cik: string): string {
  return cik.replace(/^0+/, '').padStart(10, '0');
}

// ─────────────────────────────────────────────────────────────────────────────
// HTML cleanup
// ─────────────────────────────────────────────────────────────────────────────

export function stripHtml(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Section slicer for annual filings (10-K, 20-F)
// Targets restructuring-relevant sections; falls back to head slice.
// ─────────────────────────────────────────────────────────────────────────────

export function sliceAroundSections(text: string, maxChars: number): string {
  const anchors = [
    // v7.2: 8-K Items added as top-priority anchors for annual filings that
    // incorporate 8-K content, and used by slice8K below for pure 8-Ks.
    /item\s*2\.05/i,
    /item\s*2\.06/i,
    /item\s*5\.02/i,
    /item\s*1\.03/i,
    // Standard annual sections
    /management['']?s discussion and analysis/i,
    /results of operations/i,
    /restructuring/i,
    /workforce|reduction in force|severance/i,
    /notes to (?:consolidated )?financial statements/i,
    /commitments and contingencies/i,
    /transformation|programme|program(?!ming)/i,
    /chapter\s*1[15]|voluntary petition|debtor-in-possession/i,
  ];

  const segments: Array<{ start: number; end: number }> = [];
  const perAnchor = Math.floor(maxChars / Math.max(anchors.length, 1));

  for (const anchor of anchors) {
    const m = text.match(anchor);
    if (!m || m.index == null) continue;
    segments.push({
      start: Math.max(0, m.index - 300),
      end: Math.min(text.length, m.index + perAnchor),
    });
  }

  if (segments.length === 0) return text.slice(0, maxChars);

  segments.sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [segments[0]];
  for (let i = 1; i < segments.length; i++) {
    const last = merged[merged.length - 1];
    if (segments[i].start <= last.end) last.end = Math.max(last.end, segments[i].end);
    else merged.push(segments[i]);
  }

  let total = 0;
  const parts: string[] = [];
  for (const seg of merged) {
    if (total >= maxChars) break;
    const remaining = maxChars - total;
    const chunk = text.slice(seg.start, Math.min(seg.end, seg.start + remaining));
    parts.push(`[…section break…]\n${chunk}`);
    total += chunk.length + 20;
  }
  return parts.join('\n\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// v7.2: Dedicated 8-K slicer — leads with Item 2.05/2.06/5.02 content.
// 8-Ks are short focused documents; the entire doc is usually <15K stripped.
// If the doc fits in budget we return it all; otherwise we prioritise items.
// ─────────────────────────────────────────────────────────────────────────────

function slice8K(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;

  // Priority items for workforce/restructuring detection
  const priorityItems = [
    /item\s*2\.05/i,
    /item\s*2\.06/i,
    /item\s*5\.02/i,
    /item\s*1\.03/i,
    /workforce|reduction in force|severance|restructur/i,
  ];

  const parts: string[] = [];
  let total = 0;
  const perItem = Math.floor(maxChars / priorityItems.length);

  for (const pattern of priorityItems) {
    if (total >= maxChars) break;
    const m = text.match(pattern);
    if (!m || m.index == null) continue;
    const start = Math.max(0, m.index - 200);
    const end = Math.min(text.length, m.index + perItem);
    const chunk = text.slice(start, end);
    parts.push(`[Item section]\n${chunk}`);
    total += chunk.length + 15;
  }

  // If nothing matched, fall through to head slice
  if (parts.length === 0) return text.slice(0, maxChars);
  return parts.join('\n\n').slice(0, maxChars);
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC — fetchEvidenceBundle for v7 comprehensive Sonnet call
// Returns pre-fetched facts and submissions so fetchLegacyAuditSignals can
// reuse them without a second EDGAR round-trip (v7.2 dedup fix).
// ─────────────────────────────────────────────────────────────────────────────

export async function fetchEvidenceBundle(
  cik: string,
  companyName: string,
  lookbackDays: number = 365,
): Promise<{
  companyFacts: any | null;
  filings: FilingEvidence[];
  headcountHistory: HeadcountRecord[];
  // v7.2: expose for reuse in fetchLegacyAuditSignals
  _rawFacts: any | null;
  _rawSubmissions: any | null;
}> {

  const paddedCik = padCik(cik);
  const cikNum = parseInt(cik.replace(/^0+/, ''), 10);

  const [facts, submissions] = await Promise.all([
    fetchJSON(`${EDGAR}/api/xbrl/companyfacts/CIK${paddedCik}.json`),
    fetchJSON(`${EDGAR}/submissions/CIK${paddedCik}.json`),
  ]);

  const recent = submissions?.filings?.recent;
  const forms  = recent?.form            || [];
  const dates  = recent?.filingDate      || [];
  const accs   = recent?.accessionNumber || [];
  const docs   = recent?.primaryDocument || [];

  const cutoff = Date.now() - lookbackDays * 24 * 60 * 60 * 1000;
  type FilingTarget = { acc: string; form: string; date: string; doc: string };
  const targets: FilingTarget[] = [];

  for (let i = 0; i < forms.length && targets.length < 4; i++) {
    const form = forms[i];
    if (!FORMS_RELEVANT.has(form)) continue;
    if (!accs[i] || !docs[i]) continue;
    if (Date.parse(dates[i]) < cutoff) continue;
    targets.push({ acc: accs[i], form, date: dates[i], doc: docs[i] });
  }

  const hasAnnual  = targets.some(t => t.form === '10-K' || t.form === '20-F');
  const hasInterim = targets.some(t => t.form === '10-Q' || t.form === '6-K');

  if (!hasAnnual) {
    for (let i = 0; i < forms.length; i++) {
      if (forms[i] === '10-K' || forms[i] === '20-F') {
        if (accs[i] && docs[i]) {
          targets.push({ acc: accs[i], form: forms[i], date: dates[i], doc: docs[i] });
          break;
        }
      }
    }
  }
  if (!hasInterim) {
    for (let i = 0; i < forms.length; i++) {
      if (forms[i] === '10-Q' || forms[i] === '6-K') {
        if (accs[i] && docs[i]) {
          targets.push({ acc: accs[i], form: forms[i], date: dates[i], doc: docs[i] });
          break;
        }
      }
    }
  }

  const filings: FilingEvidence[] = (await Promise.all(targets.map(async (t): Promise<FilingEvidence | null> => {
    const accClean = t.acc.replace(/-/g, '');
    const url = `${EDGAR}/Archives/edgar/data/${cikNum}/${accClean}/${t.doc}`;
    const raw = await fetchText(url, 150_000);
    if (!raw) return null;
    const stripped = stripHtml(raw);

    // v7.2: per-type text budgets
    let text: string;
    const form = t.form.toUpperCase();
    if (form === '8-K' || form === '8-K/A') {
      text = slice8K(stripped, TEXT_BUDGET_8K);
    } else if (form === '10-K' || form === '20-F' || form === '10-K/A' || form === '20-F/A') {
      text = stripped.length > TEXT_BUDGET_ANNUAL
        ? sliceAroundSections(stripped, TEXT_BUDGET_ANNUAL)
        : stripped;
    } else {
      // 10-Q, 10-Q/A, 6-K, 6-K/A, NT filings
      text = stripped.length > TEXT_BUDGET_INTERIM
        ? stripped.slice(0, TEXT_BUDGET_INTERIM)
        : stripped;
    }

    return { accession: t.acc, form: t.form, filingDate: t.date, url, text };
  }))).filter((f): f is FilingEvidence => f !== null);

  // Headcount history from EntityNumberOfEmployees
  const headcountHistory: HeadcountRecord[] = [];
  const empKey = facts?.facts?.dei?.EntityNumberOfEmployees;
  if (empKey) {
    const units = empKey.units?.['pure'] || empKey.units?.['shares'] || [];
    if (Array.isArray(units)) {
      for (const e of units) {
        if (e.fp === 'FY' && e.fy && e.val) {
          headcountHistory.push({ fiscalYear: Number(e.fy), employees: Number(e.val) });
        }
      }
      headcountHistory.sort((a, b) => a.fiscalYear - b.fiscalYear);
    }
  }

  return {
    companyFacts: facts,
    filings,
    headcountHistory,
    _rawFacts: facts,
    _rawSubmissions: submissions,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC — fetchLegacyAuditSignals
// v7.2: accepts pre-fetched facts + submissions to avoid duplicate EDGAR calls.
// Pass the _rawFacts and _rawSubmissions returned by fetchEvidenceBundle.
// ─────────────────────────────────────────────────────────────────────────────

export async function fetchLegacyAuditSignals(
  cik: string,
  prefetchedFacts?: any,
  prefetchedSubmissions?: any,
): Promise<Signal[]> {
  const out: Signal[] = [];
  const paddedCik = padCik(cik);
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - 2);

  // v7.2: reuse pre-fetched data when available; only hit EDGAR if not provided
  const [facts, submissions] = await Promise.all([
    prefetchedFacts      ? Promise.resolve(prefetchedFacts)      : fetchJSON(`${EDGAR}/api/xbrl/companyfacts/CIK${paddedCik}.json`),
    prefetchedSubmissions ? Promise.resolve(prefetchedSubmissions) : fetchJSON(`${EDGAR}/submissions/CIK${paddedCik}.json`),
  ]);

  const usGaap = facts?.facts?.['us-gaap'] || {};
  const ifrs   = facts?.facts?.['ifrs-full'] || {};

  const keys = [
    { ns: usGaap, key: 'RestructuringCharges' },
    { ns: usGaap, key: 'RestructuringCostsAndAssetImpairmentCharges' },
    { ns: usGaap, key: 'SeveranceCosts1' },
    { ns: usGaap, key: 'BusinessExitCosts1' },
    { ns: ifrs,   key: 'RestructuringProvision' },
  ];
  for (const { ns, key } of keys) {
    const entries = (ns[key]?.units?.USD || ns[key]?.units?.EUR || ns[key]?.units?.GBP || [])
      .filter((e: any) => e.val > 0
        && ['10-K','10-Q','20-F','6-K'].includes(e.form)
        && new Date(e.filed) >= cutoff
        && (!e.start || !e.end || (new Date(e.end).getTime() - new Date(e.start).getTime()) / 86_400_000 <= 400))
      .sort((a: any, b: any) => Date.parse(b.filed) - Date.parse(a.filed));

    for (const e of entries.slice(0, 1)) {
      out.push({
        type: 'restructuring_charge',
        source: `SEC EDGAR · ${e.form} · ${e.filed}`,
        sourceTier: 'sec',
        rawPoints: 0, weightedPoints: 0, temporalTag: 'Context',
        alertMessage: `Restructuring charge ${fmtUSD(e.val)} in ${e.form} filed ${e.filed}`,
        filingDate: e.filed,
        verified: true,
        edgarFilingUrl: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=${e.form}`,
      });
    }
  }

  const hc = (usGaap['EntityNumberOfEmployees']?.units?.pure || [])
    .filter((e: any) => (e.form === '10-K' || e.form === '20-F') && e.val > 0)
    .sort((a: any, b: any) => Date.parse(b.filed) - Date.parse(a.filed));
  if (hc.length >= 2) {
    const [latest, prior] = hc;
    const dropPct = ((prior.val - latest.val) / prior.val) * 100;
    if (dropPct >= 5 && new Date(latest.filed) >= cutoff) {
      out.push({
        type: 'headcount_reduction',
        source: `SEC EDGAR · ${latest.form} · ${latest.filed}`,
        sourceTier: 'sec',
        rawPoints: 0, weightedPoints: 0, temporalTag: 'Context',
        alertMessage: `Headcount fell ${dropPct.toFixed(0)}% (${prior.val.toLocaleString()} → ${latest.val.toLocaleString()}) per ${latest.form}`,
        filingDate: latest.filed,
        verified: true,
      });
    }
  }

  const losses = (usGaap['NetIncomeLoss']?.units?.USD || [])
    .filter((e: any) => e.form === '10-K' || e.form === '20-F')
    .sort((a: any, b: any) => Date.parse(b.filed) - Date.parse(a.filed))
    .slice(0, 4);
  const consecutive = losses.filter((e: any) => e.val < 0).length;
  if (consecutive >= 3 && losses[0]) {
    out.push({
      type: 'sustained_net_losses',
      source: `SEC EDGAR · ${losses[0].form} · ${consecutive} consecutive years`,
      sourceTier: 'sec',
      rawPoints: 0, weightedPoints: 0, temporalTag: 'Context',
      alertMessage: `Net losses in ${consecutive} consecutive annual filings — sustained financial pressure`,
      filingDate: losses[0].filed,
      verified: true,
    });
  }

  const recent = submissions?.filings?.recent;
  if (recent) {
    const forms = recent.form || [];
    const dates = recent.filingDate || [];
    for (let i = 0; i < forms.length; i++) {
      if (forms[i]?.startsWith('NT') && new Date(dates[i]) >= cutoff) {
        out.push({
          type: 'nt_filing',
          source: `SEC EDGAR · ${forms[i]} · ${dates[i]}`,
          sourceTier: 'sec',
          rawPoints: 0, weightedPoints: 0, temporalTag: 'Context',
          alertMessage: `${forms[i]} filed ${dates[i]} — late filing notice`,
          filingDate: dates[i],
          verified: true,
        });
        break;
      }
    }
  }

  if (recent) {
    const forms = recent.form || [];
    const dates = recent.filingDate || [];
    let recentInterimCount = 0;
    for (let i = 0; i < forms.length && recentInterimCount < 2; i++) {
      if ((forms[i] === '8-K' || forms[i] === '6-K') && new Date(dates[i]) >= cutoff) {
        out.push({
          type: 'recent_interim_filing',
          source: `SEC EDGAR · ${forms[i]} · ${dates[i]}`,
          sourceTier: 'sec',
          rawPoints: 0, weightedPoints: 0, temporalTag: 'Context',
          alertMessage: `${forms[i]} filed ${dates[i]} — included in analysis bundle`,
          filingDate: dates[i],
          verified: true,
        });
        recentInterimCount++;
      }
    }
  }

  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPATIBILITY — v5 collectSECSignals
// ─────────────────────────────────────────────────────────────────────────────

export async function collectSECSignals(
  cik: string,
  _companyName: string,
  _isRegistered = false,
): Promise<Signal[]> {
  return fetchLegacyAuditSignals(cik);
}

export async function fetchFullFilingsForAnalysis(cik: string): Promise<{
  companyFacts: any | null;
  filings: FilingEvidence[];
  headcountHistory: HeadcountRecord[];
}> {
  const result = await fetchEvidenceBundle(cik, '', 365);
  return {
    companyFacts: result.companyFacts,
    filings: result.filings,
    headcountHistory: result.headcountHistory,
  };
}
