// lib/signals/nlp-analyzer.ts — EjectSeat Consumer v7.3
//
// ARCHITECTURE:
//   v5:  5+ Haiku calls (prefilter / classify / verify / analyse / summarise)
//   v7:  ONE comprehensive Sonnet call per company
//   v7.2: Predictive signal types + predictive_horizon field
//   v7.3: COMPREHENSIVE LAYOFF DETECTION — catches all layoff types regardless of
//         whether they trigger a formal SEC filing. Key changes:
//
//   SIGNAL COVERAGE EXPANSION:
//     + performance_managed_layoffs — PIPs at scale, forced ranking, "managing out underperformers"
//     + voluntary_separation_program — VSPs, early-retirement buyouts, "voluntary exit incentives"
//     + quiet_layoffs — role eliminations without announcement, positions not backfilled
//     + rto_attrition_strategy — RTO mandates designed to drive attrition rather than improve attendance
//     + ai_displacement — explicit AI/automation replacing identified role categories
//     + outsourcing_offshoring — job migration to lower-cost geographies
//     + contractor_workforce_cuts — major contractor/vendor reductions preceding employee cuts
//
//   STATE DEFINITION CHANGES:
//     ACTIVE now earned by: 8-K Item 2.05 OR 2+ Tier A media confirming cuts OR CEO
//       explicit announcement on earnings call, all within 90 days. Formal SEC filing
//       is NO LONGER required.
//     LIKELY lowered: single Tier A confirmation + any corroborating signal qualifies.
//     WATCH: any credible single-source indication of cuts qualifies.
//
//   CONTEXT ISOLATION RELAXED:
//     Model may use general industry patterns and known layoff mechanisms as
//     interpretive framework — but MUST NOT assert specific facts about THIS company
//     that are not in the evidence bundle.
//
//   MEDIA ESCALATION RULE (post-validator):
//     If bundle.news contains 2+ Tier A items referencing workforce reduction for
//     this company, minimum state is enforced as ACTIVE.
//     If bundle.news contains 1 Tier A OR 2+ Tier B items, minimum state is WATCH.
//
//   SCORE FLOOR RULE:
//     Any company with ≥1 forward signal cannot score below 8 (prevents 0/CLEAR
//     even when evidence is present).
//     WATCH state minimum floor raised from 25 to 28.
//
//   PROMPT:
//     max_tokens raised 2_000 → 2_500 to accommodate expanded signal taxonomy.
//     System prompt substantially rewritten — new layoff typology, relaxed isolation,
//     lower evidence bar for ACTIVE.

import Anthropic from '@anthropic-ai/sdk';
import type {
  EvidenceBundle, ComprehensiveIntelligence, CompanyState,
  IntelligenceConfirmedEvent, IntelligenceForwardSignal,
  ProgrammeIntelligence, HeadcountEstimate, FunctionRiskMap,
  BankruptcyFiling, WavesIntelligence, ConfidenceTier,
  TrajectoryDirection, ConfirmedEvent, PredictiveHorizon,
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
  WATCH:  { floor: 28, ceiling: 64 },   // v7.3: floor raised 25→28
  LIKELY: { floor: 45, ceiling: 78 },
  ACTIVE: { floor: 60, ceiling: 90 },
};

// v7.3: Full signal type registry — includes all new predictive + behavioural types
const VALID_SIGNAL_TYPES = [
  // Original v7 types
  'activist_pressure', 'sustained_losses', 'ceo_language', 'cost_pressure',
  'headcount_drop', 'impairment', 'nt_filing', 'strategic_distress',
  'profitability_pivot', 'restructuring_charge',
  // v7.2 predictive indicators
  'hiring_freeze', 'executive_exodus', 'office_closure',
  'product_discontinuation', 'debt_covenant_risk',
  // v7.3 comprehensive layoff types — catch cuts that never file 8-K Item 2.05
  'performance_managed_layoffs',   // PIPs at scale, forced ranking, "managing out"
  'voluntary_separation_program',  // VSPs, buyouts, early-retirement programs
  'quiet_layoffs',                 // role eliminations without announcement
  'rto_attrition_strategy',        // RTO mandates as headcount reduction mechanism
  'ai_displacement',               // explicit AI/automation replacing role categories
  'outsourcing_offshoring',        // job migration to lower-cost geographies
  'contractor_workforce_cuts',     // contractor/vendor cuts preceding employee cuts
  'other',
];

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
    // v7.2: lease and debt signals
    'OperatingLeaseLiability',
    'LongTermDebt',
    'DebtInstrumentCarryingAmount',
  ]);

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
        }
      }
    }
  }

  if (lines.length === 0) return '(no relevant XBRL line items in last 2 years)';
  return lines.join('\n').slice(0, 4_000);
}

// ─────────────────────────────────────────────────────────────────────────────
// v7.3 PRIMARY — comprehensiveAnalysis
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

  const transcriptsBlock = bundle.transcripts.length > 0
    ? bundle.transcripts.map(t => compactTranscriptForPrompt(t, 5_000)).join('\n\n')
    : '(no earnings call transcripts available for this ticker)';

  const newsBlock = compactNewsForPrompt(bundle.news);

  const headcountBlock = bundle.headcountHistory.length > 0
    ? bundle.headcountHistory.map(h => `FY${h.fiscalYear}: ${fmtCount(h.employees)} employees`).join('\n')
    : '(no structured headcount disclosure)';

  const todayISO = new Date().toISOString().slice(0, 10);

  // ── SYSTEM PROMPT ──────────────────────────────────────────────────────────
  const systemPrompt = `You are a senior financial intelligence analyst at a layoff-risk prediction company. Your job is to detect workforce reductions of ALL types — not just those that trigger formal SEC filings. You read SEC filings, earnings transcripts, and Tier A/B media and produce structured risk intelligence.

═══════════════════════════════════════
SCOPE: WHAT COUNTS AS A LAYOFF
═══════════════════════════════════════
You must detect ALL of the following — they are all layoffs, regardless of how the company labels them:

1. FORMAL RESTRUCTURING — disclosed in 8-K Item 2.05 or named programme in 10-K/10-Q. Easiest to detect.
2. PERFORMANCE-MANAGED LAYOFFS — companies firing the bottom X% of performers through PIPs or forced ranking ("managing out underperformers", "raising the performance bar", "holding teams to a higher standard"). These NEVER appear in 8-K filings. Detect via: earnings call language, Bloomberg/Reuters/FT reporting, LinkedIn or tech press coverage.
3. VOLUNTARY SEPARATION PROGRAMS (VSPs) — buyouts offered to employees to leave voluntarily. Often framed as "voluntary" but are headcount reduction tools. Detect via any source.
4. QUIET LAYOFFS — individual role eliminations without announcement. No single filing, but patterns emerge in headcount YoY data, media reporting, or executive commentary about "organisational efficiency".
5. RTO-AS-ATTRITION — when return-to-office mandates are deliberately set at levels known to drive voluntary departures among employees who relocated during COVID. Detect via: strong RTO policy + no hiring surge + executive commentary about "right-sizing".
6. AI/AUTOMATION DISPLACEMENT — explicit CEO or product announcements about AI tools replacing categories of workers (customer service, coding, legal review, content, etc.). Detect via earnings calls and tech press.
7. OUTSOURCING / OFFSHORING — moving roles to lower-cost geographies. Detect via earnings commentary on "labour cost optimisation", vendor contract announcements, facility closures in high-cost markets.
8. CONTRACTOR WORKFORCE CUTS — large reductions in contract workers often precede or accompany employee cuts. Detect via media and earnings calls.
9. BENEFIT/COMP REDUCTIONS — while not a layoff, aggressive benefit cuts alongside other signals are a strong predictor.

═══════════════════════════════════════
EVIDENCE RULES
═══════════════════════════════════════

CLAIM BINDING: Every factual claim MUST include:
  - source_ref: accession number from filings, OR URL from news/transcripts, OR tier name (tier_a / tier_b / transcript) — must match something in the bundle
  - source_quote: a direct quote from that source, 10–200 characters
  If you cannot produce both, omit the claim.

INDUSTRY PATTERNS: You MAY use your general knowledge of how different layoff types manifest (e.g. that PIPs-at-scale are typical of large tech companies, that VSPs often precede formal restructuring) as an interpretive framework. However, you MUST NOT assert specific facts about this company (dates, headcount numbers, programme names, CEO statements) unless they appear in the evidence bundle.

NUMBER FORMATTING: Dollar amounts in business shorthand ($4.7M, $1.2B). Headcounts with comma grouping: 1,000 / 34,000.

═══════════════════════════════════════
STATE DEFINITIONS — v7.3 EXPANDED
═══════════════════════════════════════

ACTIVE (score 60–90):
ANY of the following within the last 90 days:
  (a) Formal 8-K Item 2.05 / 6-K workforce reduction filing
  (b) TWO OR MORE Tier A sources (Reuters, Bloomberg, FT, WSJ, NYT) independently confirming headcount cuts
  (c) CEO or CFO EXPLICITLY confirming cuts on an earnings call (e.g. "we are reducing headcount by X%", "we have eliminated X roles")
  (d) A named multi-year transformation programme currently mid-cycle
  (e) Court-filed bankruptcy (any chapter)
  (f) VSP offered or confirmed via credible source
A formal SEC filing is NOT required for ACTIVE. Tier A media confirmation alone is sufficient.

LIKELY (score 45–78):
ANY of the following:
  (a) ONE Tier A source confirming cuts + at least one corroborating signal (financial stress, hiring freeze, exec departure)
  (b) Multiple independent signals (3+) converging toward restructuring without a single confirmation
  (c) Explicit executive language about "right-sizing", "optimising headcount", "leaner organisation" on earnings call
  (d) Confirmed AI displacement affecting identified roles at material scale
  (e) RTO mandate in context of significant headcount growth and financial pressure (strong attrition intent signal)
  (f) Performance management programme disclosed in any source + financial stress present

WATCH (score 28–64):
ANY of the following:
  (a) Any credible source (Tier A, B, or C) reporting cuts or planning for cuts
  (b) Strong forward indicators: hiring freeze + financial stress, OR executive departures + profitability pressure
  (c) Contractor workforce cuts reported without employee confirmation yet
  (d) AI displacement language on earnings call without specific role count confirmed
  (e) Cost-cutting language from CEO or CFO that implies headcount as a lever

CLEAR (score 0–35):
  No material layoff signals across any source type. Company may be growing headcount or in stable plateau. No forward indicators of material restructuring.

═══════════════════════════════════════
90-DAY RECENCY RULE
═══════════════════════════════════════
ACTIVE is appropriate when the event is within 90 days AND/OR there are explicit escalation signals. Events older than 90 days with no fresh signals or escalation should be LIKELY or WATCH. EXCEPTION: named multi-year programmes remain ACTIVE for their declared duration.

═══════════════════════════════════════
SEVERITY TIERS for forward_signals
═══════════════════════════════════════
1 — Direct workforce reduction language: "we will reduce headcount by X%", "we are eliminating X roles", CEO confirms cuts
2 — Restructuring language: "workforce optimisation", "rightsizing", named programme, VSP offered
3 — Cost/efficiency focus: "path to profitability", "operating leverage", "cost discipline", AI replacing roles
4 — Cautious/freeze: hiring freeze, "thoughtful about headcount", "pausing growth"

═══════════════════════════════════════
SIGNAL TYPES — FULL TAXONOMY
═══════════════════════════════════════
Original:
  activist_pressure, sustained_losses, ceo_language, cost_pressure, headcount_drop,
  impairment, nt_filing, strategic_distress, profitability_pivot, restructuring_charge

Predictive (v7.2):
  hiring_freeze — explicit pause on new hires (leading indicator ~60–90 days pre-announcement)
  executive_exodus — clustered CFO/CTO/CRO/CPO/VP departures in a 3-month window
  office_closure — lease terminations, facility consolidations
  product_discontinuation — sunset of product lines / market exits
  debt_covenant_risk — covenant waiver requests, NT filing patterns

Comprehensive (v7.3 — catches all layoff types):
  performance_managed_layoffs — PIPs at scale, forced ranking cuts, "managing out underperformers".
    These are LAYOFFS. Detect from media, earnings call language, employee/LinkedIn reports in Tier B/C.
    Phrase patterns: "raising the performance bar", "managing out", "bottom X% of performers",
    "holding our teams to a higher standard", "increasing performance expectations".

  voluntary_separation_program — VSPs, early-retirement buyouts, "voluntary exit incentives".
    These reduce headcount regardless of "voluntary" framing. Detect from any source.

  quiet_layoffs — role eliminations without formal announcement. Detect from:
    headcount YoY decline in XBRL, Tier B/C media patterns, executive org-change language.

  rto_attrition_strategy — RTO mandates designed to drive attrition.
    Detect when: (a) strong RTO policy announced AND (b) financial pressure or hiring freeze present
    AND (c) no offsetting hiring surge. Severity depends on policy strictness and context.

  ai_displacement — AI tools explicitly replacing identified worker categories.
    Detect from: earnings call commentary on AI replacing roles, product announcements,
    executive statements about "AI doing the work of X employees".
    Phrases: "AI agents replacing", "eliminating the need for", "automating away",
    "AI doing the work previously done by".

  outsourcing_offshoring — job migration to lower-cost geographies.
    Detect from: earnings cost commentary, facility closures in high-cost markets,
    new offshore delivery centre announcements alongside domestic headcount decline.

  contractor_workforce_cuts — material contractor/vendor reductions.
    These often precede employee cuts by 1–2 quarters. Detect from media and earnings calls.

  other — anything not fitting above categories

═══════════════════════════════════════
PREDICTIVE HORIZON
═══════════════════════════════════════
Based on signal combination, estimate WHEN risk most likely materialises as a formal announcement:
  "30d" — Active programme in motion OR imminent announcement signalled
  "60d" — Hiring freeze + financial stress (typical pre-announcement window)
  "90d" — Multiple WATCH signals converging (standard restructuring planning cycle)
  "180d+" — Early-stage indicators only, or stable WATCH with no acceleration
  null — CLEAR state or insufficient data

Today's date: ${todayISO}. Use this to assess recency and compute horizon.

═══════════════════════════════════════
SCORE CALIBRATION GUIDANCE
═══════════════════════════════════════
Avoid score 0 for any company where signals exist. Use this rough guide:
  CLEAR  0–10: absolutely no signals, growing headcount
  CLEAR 11–25: minor cost commentary only, no structural signals
  CLEAR 26–35: some efficiency language but no credible layoff indication
  WATCH  28–40: one soft signal or unconfirmed media report
  WATCH  41–55: multiple soft signals or single credible media report
  WATCH  56–64: strong multi-signal convergence just below LIKELY threshold
  LIKELY 45–60: confirmed-leaning with partial evidence
  LIKELY 61–78: high confidence multiple signals, near-certain short-term
  ACTIVE 60–72: confirmed via media or earnings (no 8-K)
  ACTIVE 73–85: confirmed via 8-K Item 2.05 or named programme mid-cycle
  ACTIVE 86–90: confirmed multi-wave, multi-year programme at scale`;

  // ── USER PROMPT ────────────────────────────────────────────────────────────
  const userPrompt = `Analyse the evidence bundle for ${bundle.company}${bundle.ticker ? ` (${bundle.ticker})` : ''}.

Apply the FULL v7.3 signal taxonomy — detect ALL layoff types, not just formal SEC-filed restructurings. Performance-managed layoffs, VSPs, quiet layoffs, RTO attrition, AI displacement, and offshoring are all in scope.

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
TIER A/B/C MEDIA (last 30–90 days)
═══════════════════════════════════════════════════════════════
${newsBlock}

═══════════════════════════════════════════════════════════════
OUTPUT — return ONLY this JSON object, nothing else.
═══════════════════════════════════════════════════════════════

{
  "state": "CLEAR" | "WATCH" | "LIKELY" | "ACTIVE",
  "score": integer within state band [CLEAR 0-35, WATCH 28-64, LIKELY 45-78, ACTIVE 60-90],
  "confidence": "high" | "medium" | "low",
  "low_confidence_reason": string | null,

  "confirmed_events": [
    {
      "description": "what was confirmed, in plain English — include layoff type (e.g. 'performance-managed', 'VSP', 'formal restructuring')",
      "date": "YYYY-MM-DD" or null,
      "source_ref": "accession number, URL, or tier name (tier_a/tier_b/transcript) from bundle",
      "source_quote": "direct quote 10-200 chars",
      "roles_affected": integer or null,
      "programme_name": string or null,
      "filing_type": "8-K Item 2.05" | "media_confirmed" | "earnings_confirmed" | "vsp" | "performance_managed" | "quiet_layoff" | null
    }
  ],

  "forward_signals": [
    {
      "signal_type": one of the full signal taxonomy above,
      "description": "what the signal is and why it is predictive — be specific about the mechanism (e.g. 'RTO mandate set at 5 days/week in context of 40% remote workforce = designed attrition')",
      "source_ref": "accession/URL/tier from bundle",
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
    "source_filings": ["accession numbers or source refs"]
  },

  "headcount": {
    "low": integer or null,
    "mid": integer or null,
    "high": integer or null,
    "basis": "explanation of math — include source",
    "pct_of_workforce": number or null,
    "confidence": "high" | "medium" | "low",
    "inferred": boolean
  },

  "function_risk": {
    "at_risk": [{ "function": "e.g. customer service (AI displacement risk)", "confidence": "high|medium|low", "evidence": "quote", "source_ref": "ref" }],
    "protected": [{ "function": "e.g. hardware engineers", "confidence": "high|medium|low", "evidence": "quote", "source_ref": "ref" }],
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

  "summary": "3-4 sentences for someone worried about their job. Lead with the plain-English verdict. Name the layoff TYPE (e.g. 'Meta has been managing out underperformers via scaled PIPs' is clearer than 'restructuring'). Distinguish confirmed from predictive. Reference headcount numbers and dates where known. Max 65 words. End with 'This reflects confirmed public reporting.' OR 'This is a predictive signal based on public filings and media — not a confirmed outcome.'",

  "reasoning_chain": "Step-by-step: what you found in each source, how you weighted it, which layoff types you looked for and what you found (or didn't), why you chose this state and score, what would push the state higher or lower"
}

Return JSON only. No preamble, no markdown fences, no commentary.`;

  try {
    const resp = await anthropic.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 2_500,                // v7.3: raised 2_000→2_500 for expanded taxonomy
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
      empty.low_confidence_reason = 'Failed to parse Sonnet JSON output';
      empty.requires_review = true;
      empty.validator_notes.push('JSON parse failure');
      return empty;
    }

    const intel = normaliseIntelligence(parsed);
    return runPostValidators(intel, bundle);

  } catch (err: any) {
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

  const validHorizons: PredictiveHorizon[] = ['30d', '60d', '90d', '180d+', null];
  const predictive_horizon: PredictiveHorizon = validHorizons.includes(raw.predictive_horizon)
    ? raw.predictive_horizon
    : null;

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
    predictive_horizon,
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
  return {
    signal_type:     VALID_SIGNAL_TYPES.includes(s.signal_type) ? s.signal_type : 'other',
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
// POST-VALIDATORS — v7.3 expanded
// ─────────────────────────────────────────────────────────────────────────────

function runPostValidators(intel: ComprehensiveIntelligence, bundle: EvidenceBundle): ComprehensiveIntelligence {
  const notes: string[] = [];
  let requiresReview = false;

  // Build valid ref set — accept tier names as valid refs (news-only evidence)
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
    // v7.3: accept tier aliases so news-only claims aren't stripped
    validRefs.add('tier_a'); validRefs.add('tier_b'); validRefs.add('tier_c');
    validRefs.add('media_confirmed'); validRefs.add('earnings_confirmed');
  }
  validRefs.add('xbrl');
  validRefs.add('companyfacts');
  // v7.3: additional tier aliases
  validRefs.add('tier_a'); validRefs.add('tier_b'); validRefs.add('tier_c');
  validRefs.add('media_confirmed'); validRefs.add('earnings_confirmed');
  validRefs.add('vsp'); validRefs.add('performance_managed'); validRefs.add('quiet_layoff');

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

  // Strip events / signals with completely unattributable refs
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

  // Confidence floor enforcement
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

  // v7.3: MEDIA ESCALATION RULE
  // Count Tier A and Tier B news items in the bundle that mention workforce-related terms
  const workforceTerms = [
    'layoff', 'laid off', 'job cut', 'headcount', 'workforce', 'redundan',
    'retrench', 'downsize', 'restructur', 'severance', 'pip', 'performance',
    'managing out', 'rto', 'return to office', 'ai replac', 'outsourc', 'offshor',
    'voluntary separation', 'vsp', 'buyout', 'early retirement',
  ];
  const isWorkforceNews = (n: any) =>
    workforceTerms.some(t => (n.title || '').toLowerCase().includes(t) || (n.summary || '').toLowerCase().includes(t));

  const tierAWorkforceNews  = bundle.news.filter(n => n.tier === 'tier_a' && isWorkforceNews(n));
  const tierBWorkforceNews  = bundle.news.filter(n => n.tier === 'tier_b' && isWorkforceNews(n));
  const anyWorkforceNews    = tierAWorkforceNews.length + tierBWorkforceNews.length;

  if (tierAWorkforceNews.length >= 2 && intel.state === 'CLEAR') {
    // 2+ Tier A sources confirming workforce reduction → minimum ACTIVE
    notes.push(`Media escalation: ${tierAWorkforceNews.length} Tier A workforce-reduction items — enforcing minimum ACTIVE`);
    intel.state = 'ACTIVE';
    intel.score = Math.max(intel.score, STATE_BANDS.ACTIVE.floor);
    requiresReview = true;
  } else if (tierAWorkforceNews.length >= 2 && intel.state === 'WATCH') {
    notes.push(`Media escalation: ${tierAWorkforceNews.length} Tier A workforce-reduction items — enforcing minimum ACTIVE`);
    intel.state = 'ACTIVE';
    intel.score = Math.max(intel.score, STATE_BANDS.ACTIVE.floor);
    requiresReview = true;
  } else if (
    (tierAWorkforceNews.length >= 1 || tierBWorkforceNews.length >= 2) &&
    (intel.state === 'CLEAR')
  ) {
    // 1 Tier A OR 2 Tier B → minimum WATCH
    notes.push(`Media escalation: ${anyWorkforceNews} workforce-reduction news item(s) — enforcing minimum WATCH`);
    intel.state = 'WATCH';
    intel.score = Math.max(intel.score, STATE_BANDS.WATCH.floor);
    requiresReview = true;
  }

  // v7.3: SCORE FLOOR — any company with forward signals cannot score 0
  if (intel.forward_signals.length > 0 && intel.score < 8) {
    intel.score = 8;
    notes.push('Score floor applied: forward signals present, minimum score 8');
  }

  // ACTIVE without confirmed event — flag but don't downgrade (v7.3: media can earn ACTIVE)
  if (intel.state === 'ACTIVE' && intel.confirmed_events.length === 0 && !intel.bankruptcy.detected && !intel.programme.name) {
    if (tierAWorkforceNews.length < 2) {
      notes.push('ACTIVE state without confirmed event, bankruptcy, programme, or 2+ Tier A media — flagged for review');
      requiresReview = true;
    }
  }

  // Score band enforcement
  const band = STATE_BANDS[intel.state];
  if (intel.score < band.floor || intel.score > band.ceiling) {
    const corrected = Math.max(band.floor, Math.min(band.ceiling, intel.score));
    notes.push(`Score ${intel.score} outside ${intel.state} band [${band.floor}–${band.ceiling}]; corrected to ${corrected}`);
    intel.score = corrected;
  }

  // 90-day recency check for ACTIVE (no programme, no media escalation)
  if (
    intel.state === 'ACTIVE' &&
    intel.confirmed_events.length > 0 &&
    !intel.bankruptcy.detected &&
    !intel.programme.name &&
    tierAWorkforceNews.length < 2
  ) {
    const today = Date.now();
    const anyRecent = intel.confirmed_events.some(e => {
      if (!e.date) return true;
      const age = (today - Date.parse(e.date)) / 86_400_000;
      return age <= 90;
    });
    const anyEscalation = intel.forward_signals.some(s => s.escalation_type === 'escalation');
    if (!anyRecent && !anyEscalation) {
      notes.push('Confirmed events >90d old with no escalation signals and no fresh Tier A media — consider LIKELY/WATCH');
      requiresReview = true;
    }
  }

  // Clear predictive_horizon for CLEAR state
  if (intel.state === 'CLEAR') {
    intel.predictive_horizon = null;
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
      model: 'claude-sonnet-4-6',
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
