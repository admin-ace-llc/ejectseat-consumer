// lib/signals/sec.ts — EjectSeat Consumer v7
//
// ROLE CHANGE vs v5/v6.1:
//   v5 interpreted XBRL + classified charges + scored them.
//   v7 is a PURE FETCHER. All interpretation happens in nlp-analyzer's
//   comprehensive Sonnet call. This file only retrieves raw evidence.
//
// Exports:
//   - fetchEvidenceBundle(cik, companyName) → EvidenceBundle for Sonnet
//   - fetchLegacyAuditSignals(cik) → Signal[] for the UI audit strip (human-
//     readable list of what was in the bundle, NOT used for scoring in v7)
//   - collectSECSignals(...) → thin wrapper preserved for v5 fallback path
//     when USE_COMPREHENSIVE_V2=false
//
// 8-K / 6-K / NT filings are fetched WITHOUT Item-number filtering — the
// full text goes to Sonnet which decides what matters. This is the key
// architectural fix for Snap-type cases where a layoff 8-K was filed under
// an Item number we weren't scanning.

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

const FETCH_TIMEOUT_MS = 8_000;

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

async function fetchText(url: string, maxChars = 80_000): Promise<string> {
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
// HTML cleanup + smart slicing for long annual filings
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

/**
 * For very long annual filings (10-K, 20-F often 200K+ chars after strip),
 * target the sections where restructuring discussion actually lives.
 * Falls back to head slice if no anchor matches.
 */
export function sliceAroundSections(text: string, maxChars: number): string {
  const anchors = [
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
// PUBLIC — fetchEvidenceBundle for v7 comprehensive Sonnet call
// ─────────────────────────────────────────────────────────────────────────────

export async function fetchEvidenceBundle(
  cik: string,
  companyName: string,
  lookbackDays: number = 365,
): Promise<{ companyFacts: any | null; filings: FilingEvidence[]; headcountHistory: HeadcountRecord[] }> {

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

  // First pass: pick up to 8 relevant filings, newest first
  for (let i = 0; i < forms.length && targets.length < 4; i++) {
    const form = forms[i];
    if (!FORMS_RELEVANT.has(form)) continue;
    if (!accs[i] || !docs[i]) continue;
    if (Date.parse(dates[i]) < cutoff) continue;
    targets.push({ acc: accs[i], form, date: dates[i], doc: docs[i] });
  }

  // Ensure latest 10-K / 10-Q / 20-F always included even if older than lookback
  const hasAnnual = targets.some(t => t.form === '10-K' || t.form === '20-F');
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

  // Fetch filings in parallel; strip HTML; slice annual filings
  const filings: FilingEvidence[] = (await Promise.all(targets.map(async (t): Promise<FilingEvidence | null> => {
    const accClean = t.acc.replace(/-/g, '');
    const url = `${EDGAR}/Archives/edgar/data/${cikNum}/${accClean}/${t.doc}`;
    const raw = await fetchText(url, 300_000);
    if (!raw) return null;
    const stripped = stripHtml(raw);
    const isAnnual = /10-K|20-F/i.test(t.form);
 const text = stripped.length > 30_000
      ? (isAnnual ? sliceAroundSections(stripped, 30_000) : stripped.slice(0, 30_000))
      : stripped;
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

  return { companyFacts: facts, filings, headcountHistory };
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC — fetchLegacyAuditSignals
// In v7, this produces a human-readable list of what's in the evidence bundle
// for the UI audit strip. These do NOT drive scoring — Sonnet does. They're
// displayed so users can see what the system looked at.
// ─────────────────────────────────────────────────────────────────────────────

export async function fetchLegacyAuditSignals(cik: string): Promise<Signal[]> {
  const out: Signal[] = [];
  const paddedCik = padCik(cik);
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - 2);

  const [facts, submissions] = await Promise.all([
    fetchJSON(`${EDGAR}/api/xbrl/companyfacts/CIK${paddedCik}.json`),
    fetchJSON(`${EDGAR}/submissions/CIK${paddedCik}.json`),
  ]);

  const usGaap = facts?.facts?.['us-gaap'] || {};
  const ifrs   = facts?.facts?.['ifrs-full'] || {};

  // Restructuring charges (surface only — no scoring in v7)
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

  // Headcount drop
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

  // Sustained losses
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

  // NT filings
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

  // Recent 8-K / 6-K (just the existence — Sonnet reads the content)
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
// Thin wrapper so the feature-flag fallback path still compiles/runs.
// Delegates to fetchLegacyAuditSignals. Does NOT score — v5 fallback path
// in engine.ts normalises rawPoints from type hints.
// ─────────────────────────────────────────────────────────────────────────────

export async function collectSECSignals(
  cik: string,
  _companyName: string,
  _isRegistered = false,
): Promise<Signal[]> {
  return fetchLegacyAuditSignals(cik);
}

// Re-export for the v5 fallback orchestrator
export async function fetchFullFilingsForAnalysis(cik: string): Promise<{
  companyFacts: any | null;
  filings: FilingEvidence[];
  headcountHistory: HeadcountRecord[];
}> {
  return fetchEvidenceBundle(cik, '', 365);
}
