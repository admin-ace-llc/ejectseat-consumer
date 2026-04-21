// lib/signals/earnings.ts — EjectSeat Consumer v3
// Claude Haiku NLP analysis of earnings call language from SEC 8-K filings

import { Signal } from '@/types';
import { EARNINGS_TIER_POINTS } from '@/lib/scoring/engine';
import { analyzeText, SEVERITY_TO_POINTS } from '@/lib/signals/nlp-analyzer';

const USER_AGENT = 'EjectSeat/1.0 (enquiries.talkace@gmail.com)';
const EDGAR      = 'https://data.sec.gov';

async function getRecentEarnings8K(cik: string): Promise<{ text: string; date: string } | null> {
  try {
    const paddedCik = cik.replace(/^0+/, '').padStart(10, '0');
    const sub = await fetch(`${EDGAR}/submissions/CIK${paddedCik}.json`, {
      headers: { 'User-Agent': USER_AGENT },
    });
    if (!sub.ok) return null;
    const data   = await sub.json();
    const recent = data.filings?.recent;
    if (!recent) return null;

    const forms = recent.form            || [];
    const dates = recent.filingDate      || [];
    const accs  = recent.accessionNumber || [];
    const docs  = recent.primaryDocument || [];

    for (let i = 0; i < Math.min(forms.length, 20); i++) {
      // v6.1: also accept 6-K for Foreign Private Issuers
      if (forms[i] !== '8-K' && forms[i] !== '6-K') continue;
      if (!accs[i] || !docs[i]) continue;

      const accClean = accs[i].replace(/-/g, '');
      const cikNum   = parseInt(cik, 10);
      const url      = `${EDGAR}/Archives/edgar/data/${cikNum}/${accClean}/${docs[i]}`;

      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
      if (!res.ok) continue;

      const text = (await res.text()).slice(0, 60000);
      const lower = text.toLowerCase();

      if (lower.includes('item 2.02') || lower.includes('results of operations') ||
          lower.includes('earnings') || lower.includes('revenue') ||
          lower.includes('quarterly') || lower.includes('annual results')) {
        return { text, date: dates[i] };
      }
    }
    return null;
  } catch { return null; }
}

export async function analyzeEarnings(companyName: string, cik: string): Promise<Signal[]> {
  const signals: Signal[] = [];
  try {
    const result = await getRecentEarnings8K(cik);
    if (!result) return signals;

    const nlpResult = await analyzeText(result.text, 'earnings call / 8-K filing', companyName);

    for (const sig of nlpResult.signals) {
      let rp: number;
      if (sig.signal_type === 'workforce_reduction')   rp = EARNINGS_TIER_POINTS.tier_1;
      else if (sig.signal_type === 'restructuring_charge' ||
               sig.signal_type === 'cost_cutting')     rp = EARNINGS_TIER_POINTS.tier_2;
      else if (sig.signal_type === 'profitability_pivot' ||
               sig.signal_type === 'strategic_distress') rp = EARNINGS_TIER_POINTS.tier_3;
      else if (sig.signal_type === 'hiring_freeze')    rp = EARNINGS_TIER_POINTS.tier_4;
      else rp = SEVERITY_TO_POINTS[sig.severity] || 9;

      const daysOld    = (Date.now() - new Date(result.date).getTime()) / 86_400_000;
      const tw         = daysOld <= 90 ? 1.0 : daysOld <= 180 ? 0.8 : 0.5;
      const fwdBoost   = sig.forward_looking ? 1.15 : 1.0;

      signals.push({
        type:           `earnings_nlp_${sig.signal_type}`,
        source:         `SEC 8-K · Earnings · ${result.date} · Claude Haiku`,
        sourceTier:     'sec',
        rawPoints:      rp,
        weightedPoints: Math.round(rp * tw * fwdBoost),
        temporalTag:    sig.forward_looking ? 'Predictive' : 'Context',
        alertMessage:   `Earnings (${result.date}): "${sig.evidence}"`,
        filingDate:     result.date,
      });
    }
  } catch (err) {
    console.error('[earnings] Error:', err);
  }
  return signals;
}
