// lib/signals/sec.ts — EjectSeat Consumer v6.1
// v5: XBRL signals cross-validated against filing text, period filter
// v6.1: + 20-F / 6-K (FPI) coverage
//       + sliceAroundSections smarter truncation for long 10-Ks/20-Fs
//       + fetchFullFilingsForAnalysis helper that returns full filings text
//         for the comprehensive Sonnet call (no per-XBRL Haiku verification)

import { Signal } from '@/types';
import { CHARGE_POINTS, temporalWeight } from '@/lib/scoring/engine';
import {
  prefilterFilingText,
  verifyXBRLSignal,
  analyzeText,
  SEVERITY_TO_POINTS,
} from '@/lib/signals/nlp-analyzer';

const USER_AGENT = 'EjectSeat/1.0 (enquiries.talkace@gmail.com)';
const EDGAR      = 'https://data.sec.gov';

async function fetchJSON(url: string): Promise<any> {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) return null;
    return res.json();
  } catch { return null; }
}

async function fetchText(url: string, maxChars = 60000): Promise<string> {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) return '';
    const text = await res.text();
    return text.slice(0, maxChars);
  } catch { return ''; }
}

// v6.1: clean HTML out of filing text before passing to LLM
function stripHtml(html: string): string {
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

// v6.1: For long annual filings (10-K, 20-F), restructuring discussion lives
// in MD&A and Notes to Consolidated Financial Statements — not the cover page,
// risk factors, or business overview. Slice around section anchors.
function sliceAroundSections(text: string, maxChars: number): string {
  const anchors = [
    /management['']?s discussion and analysis/i,
    /results of operations/i,
    /restructuring/i,
    /workforce|reduction in force|severance/i,
    /notes to (?:consolidated )?financial statements/i,
    /commitments and contingencies/i,
    /thrive|project|programme|transformation/i,
  ];

  const segments: Array<{ start: number; end: number }> = [];
  const sliceLen = Math.floor(maxChars / Math.max(anchors.length, 1));

  for (const anchor of anchors) {
    const m = text.match(anchor);
    if (!m || m.index == null) continue;
    const start = Math.max(0, m.index - 200);
    const end = Math.min(text.length, m.index + sliceLen);
    segments.push({ start, end });
  }

  if (segments.length === 0) return text.slice(0, maxChars);

  segments.sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [segments[0]];
  for (let i = 1; i < segments.length; i++) {
    const last = merged[merged.length - 1];
    if (segments[i].start <= last.end) {
      last.end = Math.max(last.end, segments[i].end);
    } else {
      merged.push(segments[i]);
    }
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

function padCik(cik: string): string {
  return cik.replace(/^0+/, '').padStart(10, '0');
}

function formatAmount(val: number): string {
  if (val >= 1e9) return `$${(val/1e9).toFixed(1)}B`;
  if (val >= 1e6) return `$${(val/1e6).toFixed(0)}M`;
  return `$${(val/1e3).toFixed(0)}K`;
}

function classifyCharge(date: string, prevCount: number) {
  const daysOld = (Date.now() - new Date(date).getTime()) / 86_400_000;
  if (prevCount === 0)                    return { ct: 'first_appearance'            as const, tag: 'Predictive' as const };
  if (prevCount >= 1 && daysOld <= 180)  return { ct: 'continuation_with_liability' as const, tag: 'Upcoming'   as const };
  if (prevCount >= 1 && daysOld >  180)  return { ct: 'continuation_expensed'       as const, tag: 'Context'    as const };
  return { ct: 'historical' as const, tag: 'Context' as const };
}

// ─────────────────────────────────────────────────────────────────────────────
// v6.1: NEW — fetch full filings text for comprehensive Sonnet analysis
// Returns full company-facts JSON + smart-truncated text of recent 8-K/10-K/10-Q
// (and 20-F/6-K for FPIs). Used by comprehensiveFilingAnalysis.
// ─────────────────────────────────────────────────────────────────────────────

export interface FullFilingsBundle {
  companyFacts: any | null;
  filings: Array<{
    accession: string;
    form: string;
    filingDate: string;
    url: string;
    text: string;
  }>;
  headcountHistory: Array<{ fiscalYear: number; employees: number }>;
}

export async function fetchFullFilingsForAnalysis(cik: string): Promise<FullFilingsBundle> {
  const paddedCik = padCik(cik);
  const cikNum = parseInt(cik.replace(/^0+/,''), 10);

  const [facts, submissionsData] = await Promise.all([
    fetchJSON(`${EDGAR}/api/xbrl/companyfacts/CIK${paddedCik}.json`),
    fetchJSON(`${EDGAR}/submissions/CIK${paddedCik}.json`),
  ]);

  const recent = submissionsData?.filings?.recent;
  const forms  = recent?.form            || [];
  const dates  = recent?.filingDate      || [];
  const accs   = recent?.accessionNumber || [];
  const docs   = recent?.primaryDocument || [];

  // v6.1: include FPI forms (20-F annual, 6-K interim) and amendments
  const RELEVANT_FORMS = new Set([
    '8-K', '10-K', '10-Q',
    '20-F', '6-K',
    '8-K/A', '10-K/A', '10-Q/A', '20-F/A', '6-K/A',
    'NT 10-K', 'NT 10-Q', 'NT 20-F',
  ]);

  const cutoff = Date.now() - 365 * 24 * 60 * 60 * 1000;
  const targets: Array<{ acc: string; form: string; date: string; doc: string }> = [];

  for (let i = 0; i < forms.length && targets.length < 6; i++) {
    if (!RELEVANT_FORMS.has(forms[i])) continue;
    if (!accs[i] || !docs[i]) continue;
    if (Date.parse(dates[i]) < cutoff) continue;
    targets.push({ acc: accs[i], form: forms[i], date: dates[i], doc: docs[i] });
  }

  const filings = await Promise.all(targets.map(async t => {
    const accClean = t.acc.replace(/-/g, '');
    const url      = `${EDGAR}/Archives/edgar/data/${cikNum}/${accClean}/${t.doc}`;
    const raw      = await fetchText(url, 200_000);
    const stripped = stripHtml(raw);
    const isAnnual = /10-K|20-F/i.test(t.form);
    const text     = stripped.length > 60_000
      ? (isAnnual ? sliceAroundSections(stripped, 60_000) : stripped.slice(0, 60_000))
      : stripped;
    return { accession: t.acc, form: t.form, filingDate: t.date, url, text };
  }));

  const headcountHistory: Array<{ fiscalYear: number; employees: number }> = [];
  const employeeKey = facts?.facts?.dei?.EntityNumberOfEmployees;
  if (employeeKey) {
    const units = employeeKey.units?.['pure'] || employeeKey.units?.['shares'];
    if (Array.isArray(units)) {
      for (const e of units) {
        if (e.fp === 'FY' && e.fy) {
          headcountHistory.push({ fiscalYear: e.fy, employees: Number(e.val) || 0 });
        }
      }
      headcountHistory.sort((a, b) => a.fiscalYear - b.fiscalYear);
    }
  }

  return { companyFacts: facts, filings, headcountHistory };
}

// ─────────────────────────────────────────────────────────────────────────────
// Existing v5 collectSECSignals — kept intact for the cross-signal scoring
// path. Comprehensive analysis runs in parallel via fetchFullFilingsForAnalysis.
// ─────────────────────────────────────────────────────────────────────────────

export async function collectSECSignals(
  cik:          string,
  companyName:  string,
  isRegistered  = false,
): Promise<Signal[]> {

  const signals: Signal[] = [];
  const paddedCik = padCik(cik);
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - 2);

  try {
    const [facts, submissionsData] = await Promise.all([
      fetchJSON(`${EDGAR}/api/xbrl/companyfacts/CIK${paddedCik}.json`),
      fetchJSON(`${EDGAR}/submissions/CIK${paddedCik}.json`),
    ]);

    const usGaap  = facts?.facts?.['us-gaap'] || {};
    const ifrs    = facts?.facts?.['ifrs-full'] || {}; // v6.1: FPI taxonomy
    const recent  = submissionsData?.filings?.recent;
    const forms   = recent?.form        || [];
    const dates   = recent?.filingDate  || [];
    const accs    = recent?.accessionNumber || [];
    const docs    = recent?.primaryDocument || [];

    // 1. XBRL restructuring charges (US GAAP + IFRS)
    const restructuringKeys = [
      'RestructuringCharges',
      'RestructuringCostsAndAssetImpairmentCharges',
      'RestructuringSettlementAndImpairmentProvisions',
      'RestructuringAndRelatedCostIncurredCost',
      'SeveranceCosts1',
      'BusinessExitCosts1',
    ];
    const ifrsKeys = [
      'RestructuringProvision',
      'AdjustmentsForProvisionsForRestructuring',
      'EmployeeBenefitsExpense',
    ];

    let restructCount  = 0;
    const seenDates    = new Set<string>();

    const allKeys = [
      ...restructuringKeys.map(k => ({ ns: usGaap, key: k })),
      ...ifrsKeys.map(k => ({ ns: ifrs, key: k })),
    ];

    for (const { ns, key } of allKeys) {
      const entries = (ns[key]?.units?.USD || ns[key]?.units?.EUR || ns[key]?.units?.GBP || [])
        .filter((e: any) => {
          if (e.val <= 0) return false;
          if (!['10-K','10-Q','20-F','6-K'].includes(e.form)) return false;
          if (new Date(e.filed) < cutoff) return false;
          if (e.start && e.end) {
            const periodDays = (new Date(e.end).getTime() - new Date(e.start).getTime()) / 86_400_000;
            if (periodDays > 400) return false;
          }
          return true;
        })
        .sort((a: any, b: any) => new Date(b.filed).getTime() - new Date(a.filed).getTime());

      for (const e of entries.slice(0, 2)) {
        if (seenDates.has(e.filed)) continue;

        const filingIdx = forms.findIndex((f: string, i: number) =>
          (f === '10-K' || f === '10-Q' || f === '20-F' || f === '6-K') && dates[i] === e.filed
        );

        let verified     = false;
        let verifyNote   = '';
        let filingText   = '';

        if (filingIdx >= 0 && accs[filingIdx] && docs[filingIdx]) {
          const accClean  = accs[filingIdx].replace(/-/g, '');
          const cikNum    = parseInt(cik.replace(/^0+/,''), 10);
          const url       = `${EDGAR}/Archives/edgar/data/${cikNum}/${accClean}/${docs[filingIdx]}`;
          filingText      = await fetchText(url, 30000);

          if (filingText) {
            const filtered  = await prefilterFilingText(filingText, companyName);
            if (filtered) {
              const period  = e.start && e.end ? `${e.start} to ${e.end}` : e.filed;
              const result  = await verifyXBRLSignal(key, e.val, period, filtered, companyName);
              verified      = result.isWorkforceRelated && result.confidence !== 'low';
              verifyNote    = result.actualDescription;

              if (!result.isWorkforceRelated) {
                console.log(`[sec] XBRL signal rejected: ${key} ${formatAmount(e.val)} — ${result.actualDescription}`);
                continue;
              }
            }
          }
        }

        // v6.1: 75% weight for unverified (v5 had 50%) — preserved fix from v5
        const verificationPenalty = verified ? 1.0 : 0.75;

        seenDates.add(e.filed);
        const { ct, tag } = classifyCharge(e.filed, restructCount);
        restructCount++;
        const rp  = CHARGE_POINTS[ct];
        const tw  = temporalWeight(e.filed);
        const amt = formatAmount(e.val);

        signals.push({
          type:           `restructuring_charge_${ct}`,
          source:         `SEC EDGAR · ${e.form} · ${e.filed}`,
          sourceTier:     'sec',
          rawPoints:      rp,
          weightedPoints: Math.round(rp * tw * verificationPenalty),
          temporalTag:    tag,
          alertMessage:   `Restructuring charge ${amt} (${ct.replace(/_/g,' ')}) in ${e.form} filed ${e.filed}${!verified ? ' — disclosure pending verification' : ''}.`,
          filingDate:     e.filed,
          chargeType:     ct,
          verified,
          verifyNote:     verifyNote || undefined,
          edgarFilingUrl: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=${e.form}`,
        });
      }
    }

    // 2. Headcount reduction (10-K or 20-F)
    const hcEntries = (usGaap['EntityNumberOfEmployees']?.units?.pure || [])
      .filter((e: any) => (e.form === '10-K' || e.form === '20-F') && e.val > 0)
      .sort((a: any, b: any) => new Date(b.filed).getTime() - new Date(a.filed).getTime());

    if (hcEntries.length >= 2) {
      const [latest, prior] = hcEntries;
      const dropPct = ((prior.val - latest.val) / prior.val) * 100;
      if (dropPct >= 5 && new Date(latest.filed) >= cutoff) {
        const tw = temporalWeight(latest.filed);
        signals.push({
          type:           'headcount_reduction',
          source:         `SEC EDGAR · ${latest.form} · ${latest.filed}`,
          sourceTier:     'sec',
          rawPoints:      16,
          weightedPoints: Math.round(16 * tw),
          temporalTag:    'Predictive',
          alertMessage:   `Headcount fell ${dropPct.toFixed(0)}% (${prior.val.toLocaleString()} → ${latest.val.toLocaleString()}) per ${latest.form} filed ${latest.filed}.`,
          filingDate:     latest.filed,
          verified:       true,
          edgarFilingUrl: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=${latest.form}`,
        });
      }
    }

    // 3. Sustained net losses
    const lossEntries = (usGaap['NetIncomeLoss']?.units?.USD || [])
      .filter((e: any) => e.form === '10-K' || e.form === '20-F')
      .sort((a: any, b: any) => new Date(b.filed).getTime() - new Date(a.filed).getTime())
      .slice(0, 4);

    const consecutiveLosses = lossEntries.filter((e: any) => e.val < 0).length;
    if (consecutiveLosses >= 3) {
      const latest = lossEntries[0];
      signals.push({
        type:           'sustained_net_losses',
        source:         `SEC EDGAR · ${latest?.form || '10-K'} · ${consecutiveLosses} consecutive years`,
        sourceTier:     'sec',
        rawPoints:      8,
        weightedPoints: Math.round(8 * temporalWeight(latest?.filed || '')),
        temporalTag:    'Context',
        alertMessage:   `Net losses in ${consecutiveLosses} consecutive annual filings — sustained financial pressure.`,
        filingDate:     latest?.filed,
        verified:       true,
        edgarFilingUrl: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=10-K`,
      });
    }

    // 4. Goodwill impairment
    for (const key of ['GoodwillImpairmentLoss','ImpairmentOfIntangibleAssetsFinitelived']) {
      const entries = (usGaap[key]?.units?.USD || [])
        .filter((e: any) => e.val > 0 && new Date(e.filed) >= cutoff)
        .sort((a: any, b: any) => new Date(b.filed).getTime() - new Date(a.filed).getTime());
      if (!entries.length) continue;
      const e  = entries[0];
      const tw = temporalWeight(e.filed);
      signals.push({
        type:           'goodwill_impairment',
        source:         `SEC EDGAR · ${e.form} · ${e.filed}`,
        sourceTier:     'sec',
        rawPoints:      10,
        weightedPoints: Math.round(10 * tw),
        temporalTag:    'Predictive',
        alertMessage:   `Goodwill/asset impairment ${formatAmount(e.val)} in ${e.form} filed ${e.filed}.`,
        filingDate:     e.filed,
        verified:       true,
        edgarFilingUrl: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=${e.form}`,
      });
      break;
    }

    // 5. NT filings (late filing notices)
    const ntFilings = forms
      .map((f: string, i: number) => ({ form: f, date: dates[i] }))
      .filter((f: any) => f.form?.startsWith('NT') && new Date(f.date) >= cutoff)
      .slice(0, 2);

    for (const nt of ntFilings) {
      const tw = temporalWeight(nt.date);
      signals.push({
        type:           'nt_filing',
        source:         `SEC EDGAR · ${nt.form} · ${nt.date}`,
        sourceTier:     'sec',
        rawPoints:      12,
        weightedPoints: Math.round(12 * tw),
        temporalTag:    'Predictive',
        alertMessage:   `${nt.form} filed ${nt.date} — unable to file on time.`,
        filingDate:     nt.date,
        verified:       true,
        edgarFilingUrl: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=NT`,
      });
    }

    // 6. 8-K / 6-K NLP analysis
    const interimFilings = forms
      .map((f: string, i: number) => ({ form: f, date: dates[i], acc: accs[i], doc: docs[i] }))
      .filter((f: any) => (f.form === '8-K' || f.form === '6-K') && new Date(f.date) >= cutoff)
      .slice(0, 6);

    for (const filing of interimFilings) {
      if (!filing.acc || !filing.doc) continue;
      const accClean = filing.acc.replace(/-/g, '');
      const cikNum   = parseInt(cik.replace(/^0+/,''), 10);
      const url      = `${EDGAR}/Archives/edgar/data/${cikNum}/${accClean}/${filing.doc}`;
      const rawText  = await fetchText(url, 40000);
      if (!rawText) continue;

      const filtered = await prefilterFilingText(rawText, companyName);
      if (!filtered) continue;

      const nlpResult = await analyzeText(filtered, `SEC ${filing.form} filed ${filing.date}`, companyName);

      for (const sig of nlpResult.signals) {
        const rp          = SEVERITY_TO_POINTS[sig.severity] || 9;
        const fwdBoost    = sig.forward_looking ? 1.25 : 1.0;
        const tw          = temporalWeight(filing.date);
        signals.push({
          type:           `8k_nlp_${sig.signal_type}`,
          source:         `SEC EDGAR · ${filing.form} · ${filing.date} · Haiku NLP`,
          sourceTier:     'sec',
          rawPoints:      rp,
          weightedPoints: Math.round(rp * fwdBoost * tw),
          temporalTag:    sig.forward_looking ? 'Predictive' : 'Context',
          alertMessage:   `${filing.form} (${filing.date}): "${sig.evidence}"`,
          filingDate:     filing.date,
          verified:       true,
          edgarFilingUrl: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=${filing.form}`,
        });
      }
      if (nlpResult.signals.length > 0) break;
    }

  } catch (err) {
    console.error('[sec] Error:', err);
  }

  return signals;
}
