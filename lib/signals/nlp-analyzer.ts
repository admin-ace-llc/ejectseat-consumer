// lib/signals/nlp-analyzer.ts — EjectSeat Consumer v7.2
//
// v7.2 ACCURACY FIXES:
//   1. max_tokens raised 1_500 → 3_500.
//      At 1_500 the JSON was truncating for any company with real signals.
//      safeParseJSON returned null, emptyIntelligence (CLEAR/0) was cached
//      silently. 3_500 gives comfortable headroom for the full schema including
//      a bounded reasoning_chain.
//
//   2. reasoning_chain capped at 3 sentences in the prompt schema.
//      Previously open-ended, it was the largest variable-length field and
//      consumed 600-1_000 tokens alone.
//
//   3. Parse failure no longer cached as CLEAR/0.
//      comprehensiveAnalysis now throws on JSON parse failure so the route
//      handler can catch it, skip the DB write, and return a 503 that the
//      client can retry. The old behaviour silently persisted bad data for
//      up to 72 hours.
//
//   4. System prompt: WATCH trigger for restructuring charges.
//      A restructuring charge in any 10-Q/10-K now earns at minimum WATCH
//      25-35 regardless of whether it is workforce-related. Previously the
//      model could return CLEAR even with a visible restructuring charge.
//
//   5. System prompt: clearer ACTIVE vs WATCH/LIKELY boundary.
//      ACTIVE requires an explicit workforce confirmation (8-K Item 2.05,
//      named programme with headcount target, WARN Act). A restructuring
//      charge alone in a quarterly filing does NOT qualify.
//
//   6. System prompt: scoring guidance anchors added.
//      Model had no numeric anchor points; guidance now states expected score
//      ranges for common evidence patterns, reducing variance.
//
// PRIOR VERSION NOTES (preserved for context):
//   v7.1: max_tokens 4_000→1_500 (too aggressive — reverted to 3_500)
//   v7.1: transcript budget 8_000→5_000 chars per transcript (preserved)
//   v7.1: XBRL facts compact 6_000→4_000 chars (preserved)
//
// EXPORTS:
//   - comprehensiveAnalysis(bundle) → ComprehensiveIntelligence  (v7 primary)
//   - classifyCompanyState(...)     → preserved for v5 fallback
//   - verifyXBRLSignal(...)         → preserved for v5 fallback
//   - analyzeText(...)              → preserved for v5 fallback
//   - generateSummary(...)          → preserved for v5 fallback
//   - prefilterFilingText(...)      → preserved for v5 fallback
//   - SEVERITY_TO_POINTS            → preserved constant

import Anthropic from '@anthropic-ai/sdk';
import type {
  EvidenceBundle, ComprehensiveIntelligence, CompanyState,
  IntelligenceConfirmedEvent, IntelligenceForwardSignal,
  ProgrammeIntelligence, HeadcountEstimate, FunctionRiskMap,
  BankruptcyFiling, WavesIntelligence, ConfidenceTier,
  TrajectoryDirection, ConfirmedEvent, PredictiveHorizon, ForwardSignalType,
} from '@/types';
import { fmtUSD, fmtCount } from '@/lib/format';
import { compactTranscriptForPrompt } from '@/lib/signals/transcripts';
import { compactNewsForPrompt } from '@/lib/signals/news';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

export const SEVERITY_TO_POINTS: Record<number, number> = { 1: 18, 2: 14, 3: 9, 4: 4 };

const STATE_BANDS: Record<CompanyState, { floor: number; ceiling: number }> = {
  CLEAR:  { floor: 0,  ceiling: 35 },
  WATCH:  { floor: 25, ceiling: 64 },
  LIKELY: { floor: 45, ceiling: 78 },
  ACTIVE: { floor: 60, ceiling: 90 },
};

export type LegacyCompanyState = 'CLEAR' | 'WATCHING' | 'ACTIVE' | 'ACTIVE_MULTI_YEAR' | 'CONTINUATION_RISK';

export interface StateClassification {
  state:          LegacyCompanyState;
  confirmed:      boolean;
  confirmedEvent: ConfirmedEvent | null;
  confidence:     ConfidenceTier;
  reasoning:      string;
  rawResponse:    string;
}

export interface XBRLVerification {
  isWorkforceRelated: boolean;
  actualDescription:  string;
  evidence:           string | null;
  confidence:         ConfidenceTier;
}

export interface NLPSignal {
  signal_type:     string;
  severity:        1 | 2 | 3 | 4;
  confidence:      ConfidenceTier;
  evidence:        string;
  forward_looking: boolean;
  escalation_type: 'escalation' | 'completion' | 'neutral';
}

export interface NLPResult {
  signals:     NLPSignal[];
  source_type: string;
  analyzed_at: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// JSON parsing utility — tolerates common LLM output issues
// ─────────────────────────────────────────────────────────────────────────────

function safeParseJSON<T>(text: string, fallback: T): T {
  try {
    const noFences = text.replace(/```json|```/g, '').trim();
    const firstBracket = Math.min(
      noFences.indexOf('[') === -1 ? Infinity : noFences.indexOf('['),
      noFences.indexOf('{') === -1 ? Infinity : noFences.indexOf('{'),
    );
    if (firstBracket === Infinity) return fallback;
    const lastBracket = Math.max(noFences.lastIndexOf(']'), noFences.lastIndexOf('}'));
    if (lastBracket === -1) return fallback;
    const cleaned = noFences.slice(firstBracket, lastBracket + 1);
    return JSON.parse(cleaned) as T;
  } catch {
    return fallback;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Compact the companyFacts XBRL JSON for the prompt (token budget)
// ─────────────────────────────────────────────────────────────────────────────

// v7.2: any of these line items, when they recur across multiple distinct
// fiscal periods with positive values, indicate an ONGOING restructuring
// programme even if no programme name appears anywhere in the filings.
const RESTRUCTURING_TREND_KEYS = new Set([
  'RestructuringCharges',
  'RestructuringCostsAndAssetImpairmentCharges',
  'SeveranceCosts1',
  'BusinessExitCosts1',
  'RestructuringProvision',
]);

function compactCompanyFacts(facts: any): string {
  if (!facts?.facts) return '(no XBRL facts available)';
  const lines: string[] = [];
  const cutoff = Date.now() - 730 * 86_400_000; // 2 years

  const priorityKeys = new Set([
    'RestructuringCharges',
    'RestructuringCostsAndAssetImpairmentCharges',
    'SeveranceCosts1',
    'BusinessExitCosts1',
    'EntityNumberOfEmployees',
    'NetIncomeLoss',
    'GoodwillImpairmentLoss',
    'ImpairmentOfIntangibleAssetsFinitelived',
    'RestructuringProvision',
    'EmployeeBenefitsExpense',
  ]);

  // v7.2: track distinct (fy, fp) periods carrying a positive restructuring/
  // severance/exit charge so we can surface a trend line below.
  const restructuringPeriods = new Map<string, { val: number; end: string; fy: any; fp: any }>();

  for (const taxonomy of ['us-gaap', 'ifrs-full', 'dei']) {
    const items = facts.facts[taxonomy];
    if (!items) continue;
    for (const key of Object.keys(items)) {
      if (!priorityKeys.has(key)) continue;
      const item = items[key];
      const units = item.units || {};
      for (const unitKey of Object.keys(units)) {
        const entries = units[unitKey];
        if (!Array.isArray(entries)) continue;
        const recent = entries
          .filter((e: any) => {
            const end = e.end || (e.fy ? `${e.fy}-12-31` : null);
            return end ? Date.parse(end) >= cutoff : false;
          })
          .slice(-6);
        for (const e of recent) {
          const val = unitKey === 'pure' ? fmtCount(e.val) : fmtUSD(e.val);
          lines.push(`${taxonomy}:${key} | FY${e.fy || '?'} ${e.fp || ''} | end=${e.end || '?'} | ${val} | accn=${e.accn || '?'} | filed=${e.filed || '?'}`);

          if (RESTRUCTURING_TREND_KEYS.has(key) && e.val > 0) {
            const periodLabel = `${e.fy || '?'}-${e.fp || (e.end ? e.end.slice(0, 7) : '?')}`;
            const end = e.end || (e.fy ? `${e.fy}-12-31` : '');
            const existing = restructuringPeriods.get(periodLabel);
            if (!existing || e.val > existing.val) {
              restructuringPeriods.set(periodLabel, { val: e.val, end, fy: e.fy, fp: e.fp });
            }
          }
        }
      }
    }
  }

  if (lines.length === 0) return '(no relevant XBRL line items in last 2 years)';

  // v7.2: emit an explicit RESTRUCTURING TREND summary line. When charges
  // recur across 2+ distinct fiscal periods, this is a strong signal of an
  // ongoing (even if unnamed) cost-reduction programme — surface it plainly
  // so it isn't missed in 4,000 chars of raw XBRL line items.
  if (restructuringPeriods.size > 0) {
    const periods = [...restructuringPeriods.values()].sort((a, b) => Date.parse(a.end || '1970-01-01') - Date.parse(b.end || '1970-01-01'));
    const total = periods.reduce((sum, p) => sum + p.val, 0);
    const periodLabels = periods.map(p => `FY${p.fy || '?'} ${p.fp || ''}`.trim()).join(', ');
    if (periods.length >= 2) {
      lines.push('');
      lines.push(`RESTRUCTURING TREND: charges recorded in ${periods.length} DISTINCT fiscal periods (${periodLabels}), cumulative ${fmtUSD(total)}. ` +
        `No period shows a $0 value, which would indicate completion. Treat this as an ONGOING cost-reduction programme even though no formal programme name may be disclosed.`);
    } else {
      lines.push('');
      lines.push(`RESTRUCTURING TREND: charge recorded in 1 fiscal period so far (${periodLabels}), ${fmtUSD(total)}. Watch for recurrence in subsequent filings.`);
    }
  }

  return lines.join('\n').slice(0, 4_200);
}

// ─────────────────────────────────────────────────────────────────────────────
// v7 PRIMARY — comprehensiveAnalysis
// v7.2: throws NLP_PARSE_FAILURE instead of returning emptyIntelligence on
//        JSON parse errors — prevents bad results being cached.
// ─────────────────────────────────────────────────────────────────────────────

export async function comprehensiveAnalysis(bundle: EvidenceBundle): Promise<ComprehensiveIntelligence> {
  const empty = emptyIntelligence();

  if (!process.env.ANTHROPIC_API_KEY) {
    empty.low_confidence_reason = 'ANTHROPIC_API_KEY not configured';
    empty.requires_review = true;
    empty.validator_notes.push('No API key — returned empty intelligence');
    return empty;
  }

  if (!bundle.filings.length && !bundle.transcripts.length && !bundle.news.length && !bundle.companyFacts) {
    empty.low_confidence_reason = 'No evidence available for this company';
    return empty;
  }

  const factsCompact = compactCompanyFacts(bundle.companyFacts);

  const filingsBlock = bundle.filings.map(f =>
    `── FILING: ${f.form} | Filed ${f.filingDate} | accession=${f.accession} | ${f.url} ──\n${f.text}`
  ).join('\n\n') || '(no recent SEC filings retrieved)';

  // Transcript budget: 5_000 chars per transcript (v7.1 preserved)
  const transcriptsBlock = bundle.transcripts.length > 0
    ? bundle.transcripts.map(t => compactTranscriptForPrompt(t, 5_000)).join('\n\n')
    : '(no earnings call transcripts available for this ticker)';

  const newsBlock = compactNewsForPrompt(bundle.news);

  const headcountBlock = bundle.headcountHistory.length > 0
    ? bundle.headcountHistory.map(h => `FY${h.fiscalYear}: ${fmtCount(h.employees)} employees`).join('\n')
    : '(no structured headcount disclosure)';

  const todayISO = new Date().toISOString().slice(0, 10);

  // v7.2: system prompt hardened with explicit WATCH trigger, ACTIVE definition,
  //        and scoring anchors to reduce variance across companies.
  const systemPrompt = `You are a senior financial intelligence analyst at a layoff-risk prediction company. You read SEC filings, earnings call transcripts, and Tier A/B media coverage for US-listed public companies and Foreign Private Issuers, and produce structured intelligence about workforce reduction risk.

CRITICAL RULES — violations cause downstream validation failures:

1. CONTEXT ISOLATION. Base your analysis ONLY on the evidence bundle provided below. Do not reference any knowledge about this company from your training data. If a fact is not in the evidence bundle, it does not exist for this analysis. You may not invent dates, programme names, headcount numbers, severance amounts, CEO statements, or news coverage.

2. EVIDENCE BINDING. Every factual claim (confirmed events, forward signals, programme details, headcount, function risk, bankruptcy) MUST include:
   - source_ref: the accession number from filings, OR the URL from news/transcripts, OR the exact source tier name — must match something in the bundle
   - source_quote: a direct quote from that source, minimum 10 characters, maximum 200 characters
   If you cannot produce both, you must omit the claim.

3. CONFIDENCE FLOORS.
   - high confidence: requires at least 3 independent corroborating sources in the bundle
   - medium confidence: requires at least 2 independent sources
   - low confidence: 1 source or ambiguous evidence
   These are HARD floors. Do not override.

4. NO INVENTION. If unsure, omit. If evidence is thin, return low confidence and insufficient_signal reasoning. Do not extrapolate beyond what is directly stated. For inferences (e.g. headcount math from severance dollars) set inferred=true and state the basis.

5. NUMBER FORMATTING. All dollar amounts in output must be in business shorthand: $4.7M, $1.2B, $847K. Headcounts use comma grouping: 1,000 / 3,400. Never write out zeros.

6. HEADLINE STATE. Risk level (CLEAR / WATCH / LIKELY / ACTIVE) is the headline in the UI. Earn the state from the evidence.

STATE DEFINITIONS:
- CLEAR  (score 0–35):  No material signals. No restructuring charges. No forward indicators of cost reduction or workforce pressure.
- WATCH  (score 25–64): Forward indicators present. IMPORTANT: ANY restructuring charge in a 10-Q/10-K, ANY cost-reduction language from the CEO, ANY sustained net losses, or ANY activist pressure AUTOMATICALLY qualifies for at minimum WATCH score 25-35. Do NOT return CLEAR if a restructuring charge exists in the XBRL data or filing text, even if the charge appears non-workforce (real estate exits, operational restructuring) — all restructuring signals financial stress.
- LIKELY (score 45–78): Multiple independent corroborating signals across filings, calls, and news, OR a confirmed small cut with additional pressure, OR restructuring charge + CEO cost language + news coverage together, OR a RECURRING/MULTI-PERIOD restructuring charge pattern (see rule 7 below).
- ACTIVE (score 60–90): Confirmed layoff event evidenced by one or more of: (a) 8-K Item 2.05 or 2.06 in the filing bundle, (b) a named multi-year transformation programme currently mid-cycle with explicit headcount targets, (c) court-filed bankruptcy, OR (d) news coverage with confirmed headcount figures AND corroborating SEC language. A restructuring charge in a 10-Q alone, without explicit workforce announcement, does NOT qualify for ACTIVE — it qualifies for WATCH or LIKELY (and can reach the upper end of LIKELY under rule 7).

90-DAY RECENCY RULE: ACTIVE is appropriate when the confirmed event is within 90 days of today AND/OR there are explicit escalation signals. Older events with no fresh signals should be LIKELY or WATCH.

7. MULTI-PERIOD RESTRUCTURING ESCALATION (recurring charges = ongoing programme). The XBRL FINANCIAL FACTS block may include a "RESTRUCTURING TREND" line that has already identified whether restructuring/severance/business-exit charges were recorded in 2+ DISTINCT fiscal periods (e.g. a full fiscal year AND a subsequent quarter), with no period showing completion ($0 or a sharp step-down).
   - If this trend line shows charges across 2+ distinct periods, treat the company as having an ONGOING, UNNAMED cost-reduction programme — even if no 8-K, press release, or named programme exists. Set programme.timeline = "multi_year" and programme.phase = "mid" (or "late" only if a later period's charge is materially smaller than earlier ones, suggesting wind-down). Populate programme.recognised_to_date_usd with the cumulative figure from the trend line, and set programme.evidence_quote to a quote drawn from the XBRL trend line or the underlying filing text.
   - This pattern alone is sufficient for LIKELY, NOT just WATCH. Recurring restructuring charges almost always carry a severance/headcount component even when filings don't break it out explicitly — set inferred=true on any headcount estimate derived this way.
   - Calibrate the score within LIKELY based on scale and persistence: 2 distinct periods with cumulative charges under $100M → score ~46-55. 2 distinct periods with cumulative charges over $250M, OR 3+ distinct periods at any size → score ~56-70 (this can push the overall risk into the "HIGH" band even without an explicit workforce announcement). Do not let the absence of an 8-K Item 2.05/2.06 cap the score at WATCH when this trend pattern is present — that absence affects the STATE choice (LIKELY vs ACTIVE), not the ceiling within LIKELY.
   - Still apply confidence floors normally: a recurring-charge-only pattern with no corroborating news or transcript commentary should generally be "medium" confidence, not "high".

SCORING ANCHORS — use these as calibration:
- Score 0–15:   Truly no signals. Zero restructuring charges. Positive headcount trend. No news.
- Score 16–30:  Minor signal — single restructuring charge in ONE fiscal period only, cost-efficiency language only, no confirmed event, no recurrence yet.
- Score 31–45:  WATCH territory — restructuring charge + CEO cost language, OR multiple quarters of losses, OR news coverage without SEC confirmation. (If charges recur across 2+ distinct periods, use rule 7 instead — this band is for single-period charges only.)
- Score 46–60:  LIKELY territory — multiple corroborating signals, OR small confirmed cut with ongoing programme language, OR a recurring restructuring charge pattern (rule 7) of moderate scale (2 periods, cumulative under $100M).
- Score 61–75:  ACTIVE — confirmed event within 90 days, single wave, programme in early/mid phase. ALSO applies under rule 7 to a recurring restructuring charge pattern (2+ periods) with cumulative charges over $250M or 3+ distinct periods, even without a confirmed workforce announcement — STATE remains LIKELY in that case (large/persistent recurring charge, but no confirmed event), only the SCORE reaches this range.
- Score 76–90:  ACTIVE — multi-wave, large-scale, ongoing, or bankruptcy.

SEVERITY TIERS for forward_signals:
- 1: Direct workforce reduction language ("we will reduce headcount by X%")
- 2: Restructuring language ("workforce optimization", "rightsizing", named programme)
- 3: Cost/efficiency focus ("cost discipline", "path to profitability")
- 4: Cautious hiring ("thoughtful about hiring", "pausing headcount growth")

Today's date: ${todayISO}. Use this to assess recency.`;

  const userPrompt = `Analyse the evidence bundle for ${bundle.company}${bundle.ticker ? ` (${bundle.ticker})` : ''}.

═══════════════════════════════════════════════════════════════
HEADCOUNT HISTORY
═══════════════════════════════════════════════════════════════
${headcountBlock}

═══════════════════════════════════════════════════════════════
XBRL FINANCIAL FACTS (priority line items, last 2 years)
═══════════════════════════════════════════════════════════════
${factsCompact}

═══════════════════════════════════════════════════════════════
SEC FILINGS (full text, stripped of HTML)
═══════════════════════════════════════════════════════════════
${filingsBlock}

═══════════════════════════════════════════════════════════════
EARNINGS CALL TRANSCRIPTS (prepared remarks + Q&A where available)
═══════════════════════════════════════════════════════════════
${transcriptsBlock}

═══════════════════════════════════════════════════════════════
TIER A/B/C MEDIA (last 120 days)
═══════════════════════════════════════════════════════════════
${newsBlock}

═══════════════════════════════════════════════════════════════
OUTPUT — return ONLY this JSON object, nothing else.
═══════════════════════════════════════════════════════════════

{
  "state": "CLEAR" | "WATCH" | "LIKELY" | "ACTIVE",
  "score": integer within state band [CLEAR 0-35, WATCH 25-64, LIKELY 45-78, ACTIVE 60-90],
  "confidence": "high" | "medium" | "low",
  "low_confidence_reason": string | null,

  "confirmed_events": [
    {
      "description": "what was announced, in plain English",
      "date": "YYYY-MM-DD" or null,
      "source_ref": "accession number or URL from bundle",
      "source_quote": "direct quote 10-200 chars",
      "roles_affected": integer or null,
      "programme_name": string or null,
      "filing_type": "e.g. 8-K Item 2.05" or null
    }
  ],

  "forward_signals": [
    {
      "signal_type": "activist_pressure" | "sustained_losses" | "ceo_language" | "cost_pressure" | "headcount_drop" | "impairment" | "nt_filing" | "strategic_distress" | "profitability_pivot" | "restructuring_charge" | "hiring_freeze" | "executive_exodus" | "office_closure" | "product_discontinuation" | "debt_covenant_risk" | "other",
      "description": "what the signal is",
      "source_ref": "accession/URL/tier",
      "source_quote": "direct quote 10-200 chars",
      "severity": 1 | 2 | 3 | 4,
      "forward_looking": boolean,
      "escalation_type": "escalation" | "completion" | "neutral",
      "inferred": boolean
    }
  ],

  "programme": {
    "name": "programme name if explicitly named" or null,
    "total_size_usd": number or null,
    "recognised_to_date_usd": number or null,
    "remaining_usd": number or null,
    "timeline": "one_time" | "multi_year" | "unknown",
    "phase": "early" | "mid" | "late" | "complete" | "unknown",
    "severance_component_pct": number 0-100 or null,
    "evidence_quote": direct quote or null,
    "source_filings": ["accession numbers"]
  },

  "headcount": {
    "low": integer or null,
    "mid": integer or null,
    "high": integer or null,
    "basis": "explanation of math",
    "pct_of_workforce": number or null,
    "confidence": "high" | "medium" | "low",
    "inferred": boolean
  },

  "function_risk": {
    "at_risk": [{ "function": "e.g. back-office technology", "confidence": "high|medium|low", "evidence": "quote", "source_ref": "ref" }],
    "protected": [{ "function": "e.g. client-facing brokers", "confidence": "high|medium|low", "evidence": "quote", "source_ref": "ref" }],
    "unstated_note": "if functions not explicitly named, say so" or null
  },

  "bankruptcy": {
    "detected": boolean,
    "chapter": "7" | "11" | "15" | null,
    "filing_date": "YYYY-MM-DD" or null,
    "filing_accession": "accession" or null,
    "description": "plain-language summary" or null,
    "evidence_quote": "direct quote" or null,
    "debtor_in_possession": boolean or null,
    "affected_subsidiaries": ["names"]
  },

  "waves": {
    "waves_confirmed": integer,
    "further_waves_signal": string or null,
    "evidence_quote": direct quote or null,
    "confidence": "high" | "medium" | "low"
  },

  "trajectory": "escalating" | "stable" | "completing" | "unknown",
  "predictive_horizon": "30d" | "60d" | "90d" | "180d+" | null,
  "large_employer_flag": boolean,

  "summary": "3-5 sentence brief written for someone worried about their job at this company. Sentence 1: plain-English verdict using the STATE word (e.g. 'Salesforce is showing signs of an ongoing cost-reduction programme' rather than just restating the score). Sentence 2: the SPECIFIC evidence driving the score — if rule 7 (multi-period restructuring) applied, name the periods and dollar figures (e.g. 'It recorded $586M in restructuring charges in FY2025 and another $80M in Q1 FY2027 — back-to-back periods with no sign of the programme winding down'). Sentence 3: what is and is NOT confirmed — be explicit, e.g. 'No 8-K workforce-reduction notice or specific headcount target has been filed yet, but recurring charges of this size historically carry a severance component.' Sentence 4 (optional): function/role guidance if function_risk has entries, or what to watch for next (next filing date, earnings call). Final sentence: end with 'This reflects confirmed public announcements.' if confirmed_events is non-empty, OR 'This is a predictive signal based on recurring financial filings — not a confirmed layoff announcement.' otherwise. Avoid generic boilerplate like 'no workforce reduction announcement is confirmed' as a STANDALONE sentence with nothing else — always pair any 'not confirmed' statement with the concrete positive evidence that IS present. Max 80 words.",

  "reasoning_chain": "Max 3 sentences: key signals found, why you chose this state, primary uncertainty."
}

Return JSON only. No preamble, no markdown fences, no commentary.`;

  try {
    // v7.2: max_tokens raised from 1_500 → 3_500.
    // At 1_500 the JSON was regularly truncating for companies with real signals
    // (reasoning_chain + multiple forward_signals + source_quotes consumed the
    // entire budget). Truncated JSON → safeParseJSON returns null →
    // emptyIntelligence (CLEAR/0) was silently cached for up to 72 hours.
    const resp = await anthropic.messages.create({
      model:      'claude-sonnet-4-5',
      max_tokens: 3_500,
      system: [
        {
          type: 'text',
          text: systemPrompt,
          cache_control: { type: 'ephemeral' },
        } as any,
      ],
      messages: [{ role: 'user', content: userPrompt }],
    });

    const content = resp.content[0];
    if (content.type !== 'text' || !content.text) {
      empty.low_confidence_reason = 'Non-text response from Sonnet';
      empty.requires_review = true;
      return empty;
    }

    const parsed = safeParseJSON<any>(content.text, null);
    if (!parsed) {
      // v7.2: throw instead of returning CLEAR/0 so the route can skip caching.
      // The old behaviour persisted emptyIntelligence to Supabase and served
      // it for up to 72 hours — masking real signals.
      console.error(
        `[nlp] JSON parse failure for ${bundle.company} (${bundle.ticker}). ` +
        `Response length: ${content.text.length} chars. ` +
        `Possible truncation at max_tokens=${3_500}.`,
      );
      throw new Error('NLP_PARSE_FAILURE');
    }

    const intel = normaliseIntelligence(parsed);
    return runPostValidators(intel, bundle);

  } catch (err: any) {
    // Re-throw NLP_PARSE_FAILURE so route can handle it without caching.
    if (err?.message === 'NLP_PARSE_FAILURE') throw err;

    console.error('[nlp] comprehensiveAnalysis failed:', err?.message || err);
    empty.low_confidence_reason = `Sonnet call failed: ${err?.message || 'unknown'}`;
    empty.requires_review = true;
    return empty;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Empty intelligence scaffold
// ─────────────────────────────────────────────────────────────────────────────

function emptyIntelligence(): ComprehensiveIntelligence {
  return {
    state: 'CLEAR',
    score: 0,
    confidence: 'low',
    low_confidence_reason: null,
    confirmed_events: [],
    forward_signals: [],
    programme: {
      name: null, total_size_usd: null, recognised_to_date_usd: null, remaining_usd: null,
      timeline: 'unknown', phase: 'unknown', severance_component_pct: null,
      evidence_quote: null, source_filings: [],
    },
    headcount: {
      low: null, mid: null, high: null, basis: '', pct_of_workforce: null,
      confidence: 'low', inferred: false,
    },
    function_risk: { at_risk: [], protected: [], unstated_note: null },
    bankruptcy: {
      detected: false, chapter: null, filing_date: null, filing_accession: null,
      description: null, evidence_quote: null, debtor_in_possession: null,
      affected_subsidiaries: [],
    },
    waves: { waves_confirmed: 0, further_waves_signal: null, evidence_quote: null, confidence: 'low' },
    trajectory: 'unknown',
    predictive_horizon: null,
    large_employer_flag: false,
    summary: '',
    reasoning_chain: '',
    requires_review: false,
    validator_notes: [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Normalisation — fills in defaults, coerces types, strips garbage
// ─────────────────────────────────────────────────────────────────────────────

function normaliseIntelligence(raw: any): ComprehensiveIntelligence {
  const validStates: CompanyState[] = ['CLEAR', 'WATCH', 'LIKELY', 'ACTIVE'];
  const state: CompanyState = validStates.includes(raw.state) ? raw.state : 'CLEAR';
  const band = STATE_BANDS[state];
  const rawScore = typeof raw.score === 'number' ? raw.score : band.floor;
  const score = Math.max(band.floor, Math.min(band.ceiling, Math.round(rawScore)));

  return {
    state,
    score,
    confidence: normaliseConfidence(raw.confidence),
    low_confidence_reason: raw.low_confidence_reason || null,
    confirmed_events: Array.isArray(raw.confirmed_events)
      ? raw.confirmed_events.map(normaliseConfirmedEvent).filter(Boolean) as IntelligenceConfirmedEvent[]
      : [],
    forward_signals: Array.isArray(raw.forward_signals)
      ? raw.forward_signals.map(normaliseForwardSignal).filter(Boolean) as IntelligenceForwardSignal[]
      : [],
    programme: normaliseProgramme(raw.programme),
    headcount: normaliseHeadcount(raw.headcount),
    function_risk: normaliseFunctionRisk(raw.function_risk),
    bankruptcy: normaliseBankruptcy(raw.bankruptcy),
    waves: normaliseWaves(raw.waves),
    trajectory: ['escalating','stable','completing','unknown'].includes(raw.trajectory)
      ? raw.trajectory : 'unknown',
    predictive_horizon: normalisePredictiveHorizon(raw.predictive_horizon),
    large_employer_flag: !!raw.large_employer_flag,
    summary: typeof raw.summary === 'string' ? raw.summary.trim() : '',
    reasoning_chain: typeof raw.reasoning_chain === 'string' ? raw.reasoning_chain.trim() : '',
    requires_review: false,
    validator_notes: [],
  };
}

function normaliseConfidence(c: any): ConfidenceTier {
  return c === 'high' || c === 'medium' || c === 'low' ? c : 'low';
}

// v7.2: predictive_horizon — when Sonnet believes a signal is most likely
// to materialise. Defaults to null (unknown) if missing or invalid.
function normalisePredictiveHorizon(h: any): PredictiveHorizon {
  return h === '30d' || h === '60d' || h === '90d' || h === '180d+' ? h : null;
}

function normaliseConfirmedEvent(e: any): IntelligenceConfirmedEvent | null {
  if (!e || typeof e !== 'object') return null;
  if (!e.description || !e.source_ref || !e.source_quote) return null;
  return {
    description:    String(e.description).trim(),
    date:           e.date || null,
    source_ref:     String(e.source_ref).trim(),
    source_quote:   String(e.source_quote).trim().slice(0, 400),
    roles_affected: typeof e.roles_affected === 'number' ? Math.round(e.roles_affected) : null,
    programme_name: e.programme_name || null,
    filing_type:    e.filing_type || null,
  };
}

function normaliseForwardSignal(s: any): IntelligenceForwardSignal | null {
  if (!s || typeof s !== 'object') return null;
  if (!s.description || !s.source_ref || !s.source_quote) return null;
  // v7.2: includes new forward-looking predictive signal types
  const validTypes: ForwardSignalType[] = ['activist_pressure','sustained_losses','ceo_language','cost_pressure',
    'headcount_drop','impairment','nt_filing','strategic_distress','profitability_pivot',
    'restructuring_charge','hiring_freeze','executive_exodus','office_closure',
    'product_discontinuation','debt_covenant_risk','other'];
  return {
    signal_type:     validTypes.includes(s.signal_type) ? s.signal_type : 'other',
    description:     String(s.description).trim(),
    source_ref:      String(s.source_ref).trim(),
    source_quote:    String(s.source_quote).trim().slice(0, 400),
    severity:        [1,2,3,4].includes(s.severity) ? s.severity : 3,
    forward_looking: !!s.forward_looking,
    escalation_type: ['escalation','completion','neutral'].includes(s.escalation_type) ? s.escalation_type : 'neutral',
    inferred:        !!s.inferred,
  };
}

function normaliseProgramme(p: any): ProgrammeIntelligence {
  if (!p || typeof p !== 'object') {
    return { name: null, total_size_usd: null, recognised_to_date_usd: null, remaining_usd: null,
      timeline: 'unknown', phase: 'unknown', severance_component_pct: null, evidence_quote: null, source_filings: [] };
  }
  return {
    name: p.name || null,
    total_size_usd: typeof p.total_size_usd === 'number' ? p.total_size_usd : null,
    recognised_to_date_usd: typeof p.recognised_to_date_usd === 'number' ? p.recognised_to_date_usd : null,
    remaining_usd: typeof p.remaining_usd === 'number' ? p.remaining_usd : null,
    timeline: ['one_time','multi_year','unknown'].includes(p.timeline) ? p.timeline : 'unknown',
    phase: ['early','mid','late','complete','unknown'].includes(p.phase) ? p.phase : 'unknown',
    severance_component_pct: typeof p.severance_component_pct === 'number' ? p.severance_component_pct : null,
    evidence_quote: p.evidence_quote || null,
    source_filings: Array.isArray(p.source_filings) ? p.source_filings : [],
  };
}

function normaliseHeadcount(h: any): HeadcountEstimate {
  if (!h || typeof h !== 'object') {
    return { low: null, mid: null, high: null, basis: '', pct_of_workforce: null, confidence: 'low', inferred: false };
  }
  return {
    low: typeof h.low === 'number' ? Math.round(h.low) : null,
    mid: typeof h.mid === 'number' ? Math.round(h.mid) : null,
    high: typeof h.high === 'number' ? Math.round(h.high) : null,
    basis: h.basis || '',
    pct_of_workforce: typeof h.pct_of_workforce === 'number' ? h.pct_of_workforce : null,
    confidence: normaliseConfidence(h.confidence),
    inferred: !!h.inferred,
  };
}

function normaliseFunctionRisk(fr: any): FunctionRiskMap {
  if (!fr || typeof fr !== 'object') {
    return { at_risk: [], protected: [], unstated_note: null };
  }
  const normItem = (x: any) => (x && x.function) ? {
    function:   String(x.function).trim(),
    confidence: normaliseConfidence(x.confidence),
    evidence:   String(x.evidence || '').slice(0, 300),
    source_ref: String(x.source_ref || '').trim(),
  } : null;
  return {
    at_risk: Array.isArray(fr.at_risk) ? fr.at_risk.map(normItem).filter(Boolean) : [],
    protected: Array.isArray(fr.protected) ? fr.protected.map(normItem).filter(Boolean) : [],
    unstated_note: fr.unstated_note || null,
  };
}

function normaliseBankruptcy(b: any): BankruptcyFiling {
  if (!b || typeof b !== 'object') {
    return { detected: false, chapter: null, filing_date: null, filing_accession: null,
      description: null, evidence_quote: null, debtor_in_possession: null, affected_subsidiaries: [] };
  }
  return {
    detected: !!b.detected,
    chapter: ['7','11','15'].includes(b.chapter) ? b.chapter : null,
    filing_date: b.filing_date || null,
    filing_accession: b.filing_accession || null,
    description: b.description || null,
    evidence_quote: b.evidence_quote || null,
    debtor_in_possession: typeof b.debtor_in_possession === 'boolean' ? b.debtor_in_possession : null,
    affected_subsidiaries: Array.isArray(b.affected_subsidiaries) ? b.affected_subsidiaries : [],
  };
}

function normaliseWaves(w: any): WavesIntelligence {
  if (!w || typeof w !== 'object') {
    return { waves_confirmed: 0, further_waves_signal: null, evidence_quote: null, confidence: 'low' };
  }
  return {
    waves_confirmed: typeof w.waves_confirmed === 'number' ? Math.max(0, Math.round(w.waves_confirmed)) : 0,
    further_waves_signal: w.further_waves_signal || null,
    evidence_quote: w.evidence_quote || null,
    confidence: normaliseConfidence(w.confidence),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// POST-VALIDATORS — strict-mode guardrails
// ─────────────────────────────────────────────────────────────────────────────

function runPostValidators(intel: ComprehensiveIntelligence, bundle: EvidenceBundle): ComprehensiveIntelligence {
  const notes: string[] = [];
  let requiresReview = false;

  const validRefs = new Set<string>();
  for (const f of bundle.filings) {
    validRefs.add(f.accession);
    validRefs.add(f.accession.replace(/-/g, ''));
    validRefs.add(f.url);
  }
  for (const t of bundle.transcripts) {
    validRefs.add(t.url);
    validRefs.add(t.source);
    validRefs.add('motley_fool');
    validRefs.add('transcript');
  }
  for (const n of bundle.news) {
    validRefs.add(n.link);
    validRefs.add(n.source);
    validRefs.add(n.tier);
    validRefs.add(n.tier.toUpperCase());
  }
  validRefs.add('xbrl');
  validRefs.add('companyfacts');

  const isValidRef = (ref: string): boolean => {
    if (!ref) return false;
    const r = ref.toLowerCase();
    for (const v of validRefs) {
      if (!v) continue;
      const vv = v.toLowerCase();
      if (vv.includes(r) || r.includes(vv)) return true;
    }
    return false;
  };

  const beforeConfirmed = intel.confirmed_events.length;
  intel.confirmed_events = intel.confirmed_events.filter(e => {
    if (!isValidRef(e.source_ref)) {
      notes.push(`Stripped confirmed_event with unattributed source_ref: "${e.source_ref.slice(0, 60)}"`);
      requiresReview = true;
      return false;
    }
    return true;
  });
  if (beforeConfirmed !== intel.confirmed_events.length) {
    notes.push(`Removed ${beforeConfirmed - intel.confirmed_events.length} unattributed confirmed events`);
  }

  const beforeSignals = intel.forward_signals.length;
  intel.forward_signals = intel.forward_signals.filter(s => {
    if (!isValidRef(s.source_ref)) {
      notes.push(`Stripped forward_signal "${s.signal_type}" with unattributed source_ref`);
      requiresReview = true;
      return false;
    }
    return true;
  });
  if (beforeSignals !== intel.forward_signals.length) {
    notes.push(`Removed ${beforeSignals - intel.forward_signals.length} unattributed forward signals`);
  }

  const independentSources = countIndependentSources(intel);
  if (intel.confidence === 'high' && independentSources < 3) {
    notes.push(`Downgraded confidence high→medium (${independentSources} sources, need 3)`);
    intel.confidence = 'medium';
    requiresReview = true;
  }
  if (intel.confidence === 'medium' && independentSources < 2) {
    notes.push(`Downgraded confidence medium→low (${independentSources} sources, need 2)`);
    intel.confidence = 'low';
    requiresReview = true;
  }
  if (intel.confidence === 'low' && !intel.low_confidence_reason) {
    intel.low_confidence_reason = independentSources === 0
      ? 'No corroborating sources in evidence bundle'
      : `Only ${independentSources} supporting source${independentSources === 1 ? '' : 's'}`;
  }

  if (intel.state === 'ACTIVE' && intel.confirmed_events.length === 0 && !intel.bankruptcy.detected && !intel.programme.name) {
    notes.push('ACTIVE state without confirmed event, bankruptcy, or named programme — flagged for review');
    requiresReview = true;
  }

  const band = STATE_BANDS[intel.state];
  if (intel.score < band.floor || intel.score > band.ceiling) {
    const corrected = Math.max(band.floor, Math.min(band.ceiling, intel.score));
    notes.push(`Score ${intel.score} outside ${intel.state} band; corrected to ${corrected}`);
    intel.score = corrected;
  }

  if (intel.state === 'ACTIVE' && intel.confirmed_events.length > 0 && !intel.bankruptcy.detected && !intel.programme.name) {
    const today = Date.now();
    const anyRecent = intel.confirmed_events.some(e => {
      if (!e.date) return true;
      const age = (today - Date.parse(e.date)) / 86_400_000;
      return age <= 90;
    });
    const anyEscalation = intel.forward_signals.some(s => s.escalation_type === 'escalation');
    if (!anyRecent && !anyEscalation) {
      // v7.2: actually demote instead of just flagging
      notes.push('Demoted ACTIVE → LIKELY: confirmed events >90 days old, no escalation signals');
      intel.state = 'LIKELY';
      intel.score = Math.min(intel.score, 72); // cap at LIKELY ceiling
      intel.score = Math.max(intel.score, 45); // floor at LIKELY floor
      requiresReview = true;
    }
  }

  intel.validator_notes = notes;
  intel.requires_review = requiresReview;
  return intel;
}

function countIndependentSources(intel: ComprehensiveIntelligence): number {
  const sources = new Set<string>();
  for (const e of intel.confirmed_events) sources.add(e.source_ref.slice(0, 40));
  for (const s of intel.forward_signals) sources.add(s.source_ref.slice(0, 40));
  for (const f of intel.programme.source_filings) sources.add(f.slice(0, 40));
  if (intel.bankruptcy.filing_accession) sources.add(intel.bankruptcy.filing_accession.slice(0, 40));
  return sources.size;
}

// ─────────────────────────────────────────────────────────────────────────────
// LEGACY FALLBACK EXPORTS — preserved for v5/v6.1 path when flag is off
// ─────────────────────────────────────────────────────────────────────────────

export async function prefilterFilingText(rawText: string, companyName: string): Promise<string> {
  if (!process.env.ANTHROPIC_API_KEY || !rawText.trim()) return rawText.slice(0, 3000);
  try {
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: `Extract sections of this SEC filing relating to workforce, restructuring, severance, named programmes, Item 2.05/2.06/5.02/1.03, or management cost-reduction commentary.\n\nCompany: ${companyName}\n\nIf nothing relevant, return exactly: NONE\n\nMax 3000 chars.\n\nFiling:\n${rawText.slice(0, 50000)}`,
      }],
    });
    const content = msg.content[0];
    if (content.type !== 'text' || !content.text) return '';
    const r = content.text.trim();
    return r === 'NONE' ? '' : r;
  } catch (err) {
    console.error('[nlp legacy] prefilter failed:', err);
    return rawText.slice(0, 3000);
  }
}

export async function classifyCompanyState(
  companyName: string,
  filteredFilingText: string,
  recentHeadlines: string[],
): Promise<StateClassification> {
  const def: StateClassification = {
    state: 'CLEAR', confirmed: false, confirmedEvent: null,
    confidence: 'low', reasoning: 'Fallback path — v5 state classification', rawResponse: '',
  };
  if (!process.env.ANTHROPIC_API_KEY) return def;
  try {
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: `Classify ${companyName} into CLEAR|WATCHING|ACTIVE|ACTIVE_MULTI_YEAR|CONTINUATION_RISK based on evidence.\n\nFiling excerpts:\n${filteredFilingText.slice(0, 3000) || '(none)'}\n\nRecent headlines:\n${recentHeadlines.slice(0, 10).join('\n') || '(none)'}\n\nOnly return JSON:\n{"state":"CLEAR|WATCHING|ACTIVE|ACTIVE_MULTI_YEAR|CONTINUATION_RISK","confirmed":true|false,"confirmedEvent":{"description":"","date":"YYYY-MM-DD","source":"","rolesAffected":null,"filingRef":""}|null,"confidence":"high|medium|low","reasoning":""}`,
      }],
    });
    const content = msg.content[0];
    if (content.type !== 'text' || !content.text) return def;
    const parsed = safeParseJSON<any>(content.text, null);
    if (!parsed || !parsed.state) return def;
    return {
      state: parsed.state,
      confirmed: !!parsed.confirmed,
      confirmedEvent: parsed.confirmedEvent || null,
      confidence: parsed.confidence || 'low',
      reasoning: parsed.reasoning || '',
      rawResponse: content.text,
    };
  } catch { return def; }
}

export async function verifyXBRLSignal(
  xbrlKey: string, xbrlValue: number, xbrlPeriod: string,
  filingText: string, companyName: string,
): Promise<XBRLVerification> {
  const def: XBRLVerification = { isWorkforceRelated: false, actualDescription: 'Fallback', evidence: null, confidence: 'low' };
  if (!process.env.ANTHROPIC_API_KEY || !filingText.trim()) return def;
  try {
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: `Is ${fmtUSD(xbrlValue)} (${xbrlKey}, ${xbrlPeriod}) for ${companyName} a workforce restructuring charge or something else? Return JSON {"isWorkforceRelated":bool,"actualDescription":"","evidence":"quote or null","confidence":"high|medium|low"} based ONLY on this filing text:\n${filingText.slice(0, 4000)}`,
      }],
    });
    const content = msg.content[0];
    if (content.type !== 'text' || !content.text) return def;
    return safeParseJSON<XBRLVerification>(content.text, def);
  } catch { return def; }
}

export async function analyzeText(text: string, sourceType: string, company: string): Promise<NLPResult> {
  const def: NLPResult = { signals: [], source_type: sourceType, analyzed_at: new Date().toISOString() };
  if (!text?.trim() || !process.env.ANTHROPIC_API_KEY) return def;
  try {
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      messages: [{
        role: 'user',
        content: `Identify workforce/restructuring signals in this ${sourceType} for ${company}. Return JSON array, each item: {signal_type,severity 1-4,confidence,evidence quote,forward_looking,escalation_type}. Only report signals explicitly in text.\n\n${text.slice(0, 3000)}`,
      }],
    });
    const content = msg.content[0];
    if (content.type !== 'text' || !content.text) return def;
    const parsed = safeParseJSON<any[]>(content.text, []);
    if (!Array.isArray(parsed)) return def;
    return { signals: parsed.filter(s => s.signal_type && s.evidence), source_type: sourceType, analyzed_at: new Date().toISOString() };
  } catch { return def; }
}

export async function generateSummary(
  company: string, signals: any[], score: number, band: string,
  stateResult: StateClassification, quarterHistory: any[], quarterlyStatus: any | null,
  intelligence?: any,
): Promise<{ summary: string; chainOfThought: string }> {
  const fallback = intelligence?.summary
    || (stateResult.confirmedEvent
        ? `${company} has confirmed ${stateResult.confirmedEvent.description} on ${stateResult.confirmedEvent.date}. Risk score ${score}/100 (${band}). This reflects confirmed public announcements.`
        : `No confirmed layoff events detected for ${company} in current filings or Tier A/B media. Risk score ${score}/100 (${band}). This is a predictive signal based on public filings — not a confirmed outcome.`);
  return { summary: fallback, chainOfThought: stateResult.reasoning || '' };
}

export type { CompanyState as V7CompanyState };
