// lib/signals/nlp-analyzer.ts — EjectSeat Consumer v6.1
//
// v5 architecture preserved: prefilter (Haiku) → classifyState (Sonnet) →
// verifyXBRL (Haiku, per signal) → analyzeText (Haiku, per article) → summary.
//
// v6.1 ADDS: comprehensiveFilingAnalysis (Sonnet, single call) that extracts
// programme intelligence, headcount estimate, function-level risk, and
// bankruptcy detection from FULL filing text. Runs in parallel with existing
// pipeline. Output feeds the UI; scoring still uses the existing engine.

import Anthropic from '@anthropic-ai/sdk';
import type {
  ConfirmedEvent,
  ProgrammeIntelligence,
  HeadcountEstimate,
  FunctionRiskMap,
  BankruptcyFiling,
  ComprehensiveIntelligence,
} from '@/types';
import type { FullFilingsBundle } from '@/lib/signals/sec';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

// v6.1: ACTIVE_MULTI_YEAR added — mid-cycle of disclosed multi-year programme
export type CompanyState =
  | 'CLEAR'
  | 'WATCHING'
  | 'ACTIVE'
  | 'ACTIVE_MULTI_YEAR'
  | 'CONTINUATION_RISK';

export interface StateClassification {
  state:          CompanyState;
  confirmed:      boolean;
  confirmedEvent: ConfirmedEvent | null;
  confidence:     'high' | 'medium' | 'low';
  reasoning:      string;
  rawResponse:    string;
}

export interface XBRLVerification {
  isWorkforceRelated: boolean;
  actualDescription:  string;
  evidence:           string | null;
  confidence:         'high' | 'medium' | 'low';
}

export interface NLPSignal {
  signal_type:     string;
  severity:        1 | 2 | 3 | 4;
  confidence:      'high' | 'medium' | 'low';
  evidence:        string;
  forward_looking: boolean;
  escalation_type: 'escalation' | 'completion' | 'neutral';
}

export interface NLPResult {
  signals:     NLPSignal[];
  source_type: string;
  analyzed_at: string;
}

export const SEVERITY_TO_POINTS: Record<number, number> = {
  1: 18, 2: 14, 3: 9, 4: 4,
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function safeParseJSON<T>(text: string, fallback: T): T {
  try {
    const noFences = text.replace(/```json|```/g, '');
    const firstBracket = Math.min(
      noFences.indexOf('[') === -1 ? Infinity : noFences.indexOf('['),
      noFences.indexOf('{') === -1 ? Infinity : noFences.indexOf('{'),
    );
    if (firstBracket === Infinity) return fallback;
    const lastBracket = Math.max(noFences.lastIndexOf(']'), noFences.lastIndexOf('}'));
    if (lastBracket === -1) return fallback;
    const cleaned = noFences.slice(firstBracket, lastBracket + 1).trim();
    return JSON.parse(cleaned) as T;
  } catch {
    return fallback;
  }
}

function requireEvidence(sig: any): boolean {
  return Boolean(sig.evidence && sig.evidence.trim().length > 10);
}

// ─────────────────────────────────────────────────────────────────────────────
// v5 PRESERVED — prefilter 8-K text with Haiku
// ─────────────────────────────────────────────────────────────────────────────

export async function prefilterFilingText(
  rawText: string,
  companyName: string
): Promise<string> {
  if (!process.env.ANTHROPIC_API_KEY || !rawText.trim()) return '';

  try {
    const msg = await anthropic.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      messages: [{
        role:    'user',
        content: `Extract ONLY the sections of this SEC filing that relate to:
- Workforce reductions, layoffs, headcount cuts
- Restructuring charges or severance costs
- Named transformation programmes (e.g. "Thrive", "Project Olympus", "Fit for Growth")
- Item 2.05 (costs associated with exit or disposal activities)
- Item 2.06 (material impairments)
- Item 5.02 (departure of directors or officers)
- Item 1.03 (bankruptcy or receivership)
- CEO/management language about cost reduction or workforce changes

Company: ${companyName}

If none of these topics appear, return exactly: NONE

Return only the relevant extracted text, no commentary. Max 3000 characters.

Filing text:
${rawText.slice(0, 50000)}`,
      }],
    });

    const content = msg.content[0];
    if (content.type !== 'text') return '';
    const result = content.text.trim();
    return result === 'NONE' ? '' : result;

  } catch (err) {
    console.error('[nlp] prefilter error:', err);
    return rawText.slice(0, 3000);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// v5 PRESERVED — Classify company state with Sonnet
// v6.1: extended state set to include ACTIVE_MULTI_YEAR
// ─────────────────────────────────────────────────────────────────────────────

export async function classifyCompanyState(
  companyName: string,
  filteredFilingText: string,
  recentHeadlines: string[],
): Promise<StateClassification> {

  const defaultResult: StateClassification = {
    state:          'CLEAR',
    confirmed:      false,
    confirmedEvent: null,
    confidence:     'low',
    reasoning:      'Classification unavailable — defaulting to CLEAR',
    rawResponse:    '',
  };

  if (!process.env.ANTHROPIC_API_KEY) return defaultResult;

  const headlineText = recentHeadlines.length > 0
    ? recentHeadlines.slice(0, 15).join('\n')
    : 'No recent headlines available.';

  const hasFilingText = filteredFilingText.trim().length > 50;

  try {
    const msg = await anthropic.messages.create({
      model:      'claude-sonnet-4-5',
      max_tokens: 1000,
      messages: [{
        role:    'user',
        content: `You are a financial intelligence analyst classifying a company's current layoff risk state.

Company: ${companyName}

AVAILABLE EVIDENCE:
${hasFilingText ? `SEC Filing excerpts:\n${filteredFilingText.slice(0, 3000)}` : 'No relevant filing text found.'}

Recent headlines (last 90 days):
${headlineText}

CLASSIFICATION TASK:
Classify this company into exactly one state:
- CLEAR: No layoff signals. No confirmed announcements. No precursor indicators.
- WATCHING: Precursor signals exist (cost-cutting language, financial stress, activist pressure) but no confirmed layoff announcement.
- ACTIVE: Confirmed layoff announcement within last 180 days. Restructuring is ongoing.
- ACTIVE_MULTI_YEAR: Mid-cycle of a publicly disclosed multi-year transformation programme (e.g. "Thrive", "OneCompany"). Charges still being recognised quarter over quarter.
- CONTINUATION_RISK: Prior confirmed layoff wave completed or underway, with signals suggesting more cuts are coming.

ANTI-HALLUCINATION RULES:
1. Only classify as ACTIVE / ACTIVE_MULTI_YEAR / CONTINUATION_RISK if you can cite a specific confirmed announcement with a date and source from the evidence above.
2. If you are not certain, choose the more conservative state (WATCHING over ACTIVE, CLEAR over WATCHING).
3. Do not invent events, dates, or numbers not present in the evidence.
4. The "reasoning" field is your chain of thought — be explicit about what evidence led to your classification.

Return ONLY this JSON object, no other text:
{
  "state": "CLEAR|WATCHING|ACTIVE|ACTIVE_MULTI_YEAR|CONTINUATION_RISK",
  "confirmed": true|false,
  "confirmedEvent": {
    "description": "exact description of the confirmed event",
    "date": "YYYY-MM-DD",
    "source": "source name",
    "rolesAffected": number or null,
    "filingRef": "e.g. 8-K filed 2026-04-15 or null"
  } or null,
  "confidence": "high|medium|low",
  "reasoning": "Step by step: what evidence exists, what it means, why this state was chosen over alternatives"
}`,
      }],
    });

    const content = msg.content[0];
    if (content.type !== 'text') return defaultResult;

    const parsed = safeParseJSON<any>(content.text, null);
    if (!parsed || !parsed.state) return defaultResult;

    const validStates: CompanyState[] = ['CLEAR','WATCHING','ACTIVE','ACTIVE_MULTI_YEAR','CONTINUATION_RISK'];
    if (!validStates.includes(parsed.state)) return defaultResult;

    const requiresEvent = ['ACTIVE','ACTIVE_MULTI_YEAR','CONTINUATION_RISK'];
    if (requiresEvent.includes(parsed.state) && !parsed.confirmedEvent) {
      parsed.state      = 'WATCHING';
      parsed.confidence = 'low';
      parsed.reasoning  += ' [Downgraded to WATCHING: no confirmed event provided]';
    }

    return {
      state:          parsed.state,
      confirmed:      Boolean(parsed.confirmed),
      confirmedEvent: parsed.confirmedEvent || null,
      confidence:     parsed.confidence || 'low',
      reasoning:      parsed.reasoning || '',
      rawResponse:    content.text,
    };

  } catch (err) {
    console.error('[nlp] classifyCompanyState error:', err);
    return defaultResult;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// v5 PRESERVED — Verify XBRL signal against filing text with Haiku
// ─────────────────────────────────────────────────────────────────────────────

export async function verifyXBRLSignal(
  xbrlKey:     string,
  xbrlValue:   number,
  xbrlPeriod:  string,
  filingText:  string,
  companyName: string,
): Promise<XBRLVerification> {

  const defaultResult: XBRLVerification = {
    isWorkforceRelated: false,
    actualDescription:  'Could not verify',
    evidence:           null,
    confidence:         'low',
  };

  if (!process.env.ANTHROPIC_API_KEY || !filingText.trim()) {
    return defaultResult;
  }

  const amt = xbrlValue >= 1e9
    ? `$${(xbrlValue/1e9).toFixed(1)}B`
    : `$${(xbrlValue/1e6).toFixed(0)}M`;

  try {
    const msg = await anthropic.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 400,
      messages: [{
        role:    'user',
        content: `A SEC filing for ${companyName} reports ${amt} under the XBRL taxonomy key "${xbrlKey}" for the period ${xbrlPeriod}.

Does the filing text below confirm this is a WORKFORCE RESTRUCTURING charge (layoffs, severance, headcount reductions)?
Or is it something else (investment loss, asset impairment, legal settlement, acquisition cost, etc.)?

RULES:
- Only return isWorkforceRelated: true if the filing text explicitly connects this charge to workforce/headcount/severance
- The evidence must be a direct quote from the text below — do not paraphrase
- If uncertain, return isWorkforceRelated: false

Return ONLY this JSON, no other text:
{
  "isWorkforceRelated": true|false,
  "actualDescription": "what this charge actually represents",
  "evidence": "direct quote from filing text, or null if not found",
  "confidence": "high|medium|low"
}

Filing text:
${filingText.slice(0, 4000)}`,
      }],
    });

    const content = msg.content[0];
    if (content.type !== 'text') return defaultResult;

    const parsed = safeParseJSON<XBRLVerification>(content.text, defaultResult);
    return {
      isWorkforceRelated: Boolean(parsed.isWorkforceRelated),
      actualDescription:  parsed.actualDescription || 'Unknown',
      evidence:           parsed.evidence || null,
      confidence:         parsed.confidence || 'low',
    };

  } catch (err) {
    console.error('[nlp] verifyXBRLSignal error:', err);
    return defaultResult;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// v5 PRESERVED — Classify text signals with Haiku (news, earnings)
// ─────────────────────────────────────────────────────────────────────────────

export async function analyzeText(
  text:       string,
  sourceType: string,
  company:    string,
): Promise<NLPResult> {

  const defaultResult: NLPResult = {
    signals:     [],
    source_type: sourceType,
    analyzed_at: new Date().toISOString(),
  };

  if (!text?.trim() || !process.env.ANTHROPIC_API_KEY) return defaultResult;

  try {
    const msg = await anthropic.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 800,
      messages: [{
        role:    'user',
        content: `Analyse this ${sourceType} for ${company}. Identify signals related to workforce reduction, restructuring, or cost-cutting.

ANTI-HALLUCINATION RULES:
- Only report signals explicitly present in the text
- evidence must be a direct quote, minimum 10 characters
- If no clear signal exists, return []
- Do NOT flag denials as positive signals

For each signal return:
{
  "signal_type": "workforce_reduction|restructuring_charge|profitability_pivot|activist_pressure|strategic_distress|cost_cutting|hiring_freeze",
  "severity": 1-4,
  "confidence": "high|medium|low",
  "evidence": "direct quote max 120 chars",
  "forward_looking": true|false,
  "escalation_type": "escalation|completion|neutral"
}

escalation_type rules:
- escalation: signals more cuts are coming, situation worsening
- completion: signals the restructuring is finishing, stabilising  
- neutral: factual reporting with no directional signal

Return JSON array only, no other text:

${text.slice(0, 3000)}`,
      }],
    });

    const content = msg.content[0];
    if (content.type !== 'text') return defaultResult;

    const parsed = safeParseJSON<any[]>(content.text, []);
    if (!Array.isArray(parsed)) return defaultResult;

    const validTypes = new Set([
      'workforce_reduction','restructuring_charge','profitability_pivot',
      'activist_pressure','strategic_distress','cost_cutting','hiring_freeze',
    ]);

    const filtered = parsed.filter(s =>
      validTypes.has(s.signal_type) &&
      s.confidence !== 'low' &&
      s.severity >= 1 && s.severity <= 4 &&
      requireEvidence(s)
    ).map(s => ({
      ...s,
      escalation_type: ['escalation','completion','neutral'].includes(s.escalation_type)
        ? s.escalation_type
        : 'neutral',
    }));

    return { signals: filtered, source_type: sourceType, analyzed_at: new Date().toISOString() };

  } catch (err) {
    console.error('[nlp] analyzeText error:', err);
    return defaultResult;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// v6.1 NEW — Comprehensive intelligence extraction (single Sonnet call)
//
// Reads full filing text + company-facts + headcount history.
// Returns: programme name/size/phase, headcount estimate from severance math,
// function-level at-risk vs protected, bankruptcy detection.
//
// This is the call that fixes the MMC "Thrive" case. The existing v5
// pipeline still runs in parallel for cross-signal corroboration scoring;
// this call adds NEW intelligence dimensions the UI can render.
// ─────────────────────────────────────────────────────────────────────────────

export async function comprehensiveFilingAnalysis(
  bundle: FullFilingsBundle,
  companyName: string
): Promise<ComprehensiveIntelligence> {

  const empty: ComprehensiveIntelligence = {
    programme: {
      name: null, total_size_usd: null, recognised_to_date_usd: null,
      remaining_usd: null, timeline: 'unknown', phase: 'unknown',
      severance_component_pct: null, evidence_quote: null, source_filings: [],
    },
    headcount: {
      low: null, mid: null, high: null,
      basis: '', pct_of_workforce: null, confidence: 'low',
    },
    function_risk: { at_risk: [], protected: [], unstated_note: null },
    bankruptcy: {
      detected: false, chapter: null, filing_date: null, filing_accession: null,
      description: null, evidence_quote: null, debtor_in_possession: null,
      affected_subsidiaries: [],
    },
    large_employer_flag: false,
  };

  if (!process.env.ANTHROPIC_API_KEY) return empty;
  if (!bundle.filings.length && !bundle.companyFacts) return empty;

  const factsCompact = compactCompanyFacts(bundle.companyFacts);
  const filingsBlock = bundle.filings
    .map(f => `── FILING: ${f.form} | Filed ${f.filingDate} | ${f.accession} ──\n${f.text}`)
    .join('\n\n');
  const headcountBlock = bundle.headcountHistory.length
    ? bundle.headcountHistory.map(h => `${h.fiscalYear}: ${h.employees.toLocaleString()} employees`).join('\n')
    : 'No structured headcount disclosure found';

  const systemPrompt = `You are a senior financial analyst specialising in corporate restructuring intelligence. You read SEC filings (10-K, 10-Q, 8-K, 20-F, 6-K) and extract structured intelligence about:
1. Named transformation programmes (e.g. "Thrive", "Project Olympus", "Fit for Growth", "OneCompany")
2. Headcount impact estimates from severance math (severance dollars ÷ avg severance per head)
3. Function-level risk: which roles/functions are explicitly protected vs at-risk in management commentary
4. Bankruptcy filings (Chapter 7/11/15) — distinct from voluntary restructuring

CRITICAL RULES:
- Do NOT rely on keyword matching. Read the financial line items and narrative for meaning.
- If a multi-year transformation programme is named, extract the name and track total disclosed size vs amount recognised.
- For headcount: severance dollars ÷ $75K-$150K avg per head depending on industry mix.
- For function risk: only list functions explicitly named. Use confidence tier "high" for explicit protection/risk language; "medium" for inferred from programme thesis; "low" for weakly supported.
- For bankruptcy: look for 8-K Item 1.03, "Voluntary Petition", "Chapter 11", "debtor-in-possession". Bankruptcy is court-supervised — different employee implications from voluntary restructuring.
- Return ONLY valid JSON. No markdown fences, no preamble.`;

  const userPrompt = `Analyse the following SEC data for ${companyName}.

═══════════════════════════════════════════════════════════════
HEADCOUNT HISTORY
═══════════════════════════════════════════════════════════════
${headcountBlock}

═══════════════════════════════════════════════════════════════
XBRL FACTS (last 8 quarters, all line items)
═══════════════════════════════════════════════════════════════
${factsCompact}

═══════════════════════════════════════════════════════════════
RECENT FILINGS (last 12 months)
═══════════════════════════════════════════════════════════════
${filingsBlock || '(no filings retrieved)'}

═══════════════════════════════════════════════════════════════
RETURN THIS EXACT JSON STRUCTURE:
═══════════════════════════════════════════════════════════════

{
  "programme": {
    "name": string | null,
    "total_size_usd": number | null,
    "recognised_to_date_usd": number | null,
    "remaining_usd": number | null,
    "timeline": "one_time" | "multi_year" | "unknown",
    "phase": "early" | "mid" | "late" | "complete" | "unknown",
    "severance_component_pct": number | null,
    "evidence_quote": "direct quote from filing or null",
    "source_filings": ["accession numbers"]
  },
  "headcount": {
    "low": number | null,
    "mid": number | null,
    "high": number | null,
    "basis": "explanation of math used",
    "pct_of_workforce": number | null,
    "confidence": "high" | "medium" | "low"
  },
  "function_risk": {
    "at_risk": [
      { "function": "back-office technology", "confidence": "high|medium|low", "evidence": "quote" }
    ],
    "protected": [
      { "function": "client-facing brokers", "confidence": "high|medium|low", "evidence": "quote" }
    ],
    "unstated_note": "string or null"
  },
  "bankruptcy": {
    "detected": false,
    "chapter": "7" | "11" | "15" | null,
    "filing_date": "ISO date or null",
    "filing_accession": "accession or null",
    "description": "plain-language summary or null",
    "evidence_quote": "direct quote or null",
    "debtor_in_possession": true | false | null,
    "affected_subsidiaries": []
  },
  "large_employer_flag": true | false
}

LARGE EMPLOYER FLAG: set true if headcount ≥ 50,000.

If no relevant data exists, return all nulls/empty arrays. Do NOT invent data.

Return JSON only.`;

  try {
    const resp = await anthropic.messages.create({
      model:      'claude-sonnet-4-5',
      max_tokens: 12_000,
      system:     systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const content = resp.content[0];
    if (content.type !== 'text') return empty;

    const parsed = safeParseJSON<any>(content.text, null);
    if (!parsed) return empty;

    return normaliseComprehensive(parsed);
  } catch (err: any) {
    console.error('[nlp] comprehensiveFilingAnalysis failed:', err?.message || err);
    return empty;
  }
}

function compactCompanyFacts(facts: any): string {
  if (!facts?.facts) return '(no XBRL facts available)';
  const out: string[] = [];
  const cutoff = Date.now() - 730 * 24 * 60 * 60 * 1000;
  for (const taxonomy of Object.keys(facts.facts)) {
    const items = facts.facts[taxonomy];
    for (const key of Object.keys(items)) {
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
          .slice(-8);
        for (const e of recent) {
          out.push(
            `${taxonomy}:${key} | ${e.fy || ''} ${e.fp || ''} | end=${e.end || ''} | ${unitKey}=${e.val} | ${e.accn || ''} | filed=${e.filed || ''}`
          );
        }
      }
    }
  }
  if (out.length > 8000) out.length = 8000;
  return out.join('\n');
}

function normaliseComprehensive(raw: any): ComprehensiveIntelligence {
  return {
    programme: {
      name: raw.programme?.name || null,
      total_size_usd: raw.programme?.total_size_usd ?? null,
      recognised_to_date_usd: raw.programme?.recognised_to_date_usd ?? null,
      remaining_usd: raw.programme?.remaining_usd ?? null,
      timeline: raw.programme?.timeline || 'unknown',
      phase: raw.programme?.phase || 'unknown',
      severance_component_pct: raw.programme?.severance_component_pct ?? null,
      evidence_quote: raw.programme?.evidence_quote || null,
      source_filings: Array.isArray(raw.programme?.source_filings) ? raw.programme.source_filings : [],
    },
    headcount: {
      low: raw.headcount?.low ?? null,
      mid: raw.headcount?.mid ?? null,
      high: raw.headcount?.high ?? null,
      basis: raw.headcount?.basis || '',
      pct_of_workforce: raw.headcount?.pct_of_workforce ?? null,
      confidence: raw.headcount?.confidence || 'low',
    },
    function_risk: {
      at_risk: Array.isArray(raw.function_risk?.at_risk) ? raw.function_risk.at_risk : [],
      protected: Array.isArray(raw.function_risk?.protected) ? raw.function_risk.protected : [],
      unstated_note: raw.function_risk?.unstated_note || null,
    },
    bankruptcy: {
      detected: !!raw.bankruptcy?.detected,
      chapter: raw.bankruptcy?.chapter === '7' || raw.bankruptcy?.chapter === '11' || raw.bankruptcy?.chapter === '15'
        ? raw.bankruptcy.chapter : null,
      filing_date: raw.bankruptcy?.filing_date || null,
      filing_accession: raw.bankruptcy?.filing_accession || null,
      description: raw.bankruptcy?.description || null,
      evidence_quote: raw.bankruptcy?.evidence_quote || null,
      debtor_in_possession: typeof raw.bankruptcy?.debtor_in_possession === 'boolean'
        ? raw.bankruptcy.debtor_in_possession : null,
      affected_subsidiaries: Array.isArray(raw.bankruptcy?.affected_subsidiaries)
        ? raw.bankruptcy.affected_subsidiaries : [],
    },
    large_employer_flag: !!raw.large_employer_flag,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// v5 PRESERVED — Generate intelligence summary
// v6.1: extended to include programme/headcount/function-risk/bankruptcy in
// the FACTS block so the summary can reference them when relevant
// ─────────────────────────────────────────────────────────────────────────────

export async function generateSummary(
  company:         string,
  signals:         any[],
  score:           number,
  band:            string,
  stateResult:     StateClassification,
  quarterHistory:  any[],
  quarterlyStatus: any | null,
  intelligence?:   ComprehensiveIntelligence | null,
): Promise<{ summary: string; chainOfThought: string }> {

  const defaultSummary = buildFallbackSummary(company, score, band, stateResult, intelligence);

  if (!process.env.ANTHROPIC_API_KEY) {
    return { summary: defaultSummary, chainOfThought: 'API key not available' };
  }

  try {
    const signalList = signals.length > 0
      ? signals.map(s =>
          `  • ${s.type}: "${s.alertMessage || s.evidence || ''}" (filed ${s.filingDate || 'unknown'}, ${s.weightedPoints || 0} pts)`
        ).join('\n')
      : '  • No signals detected';

    const historyText = quarterHistory.length > 1
      ? quarterHistory.map(q =>
          `  ${q.quarter_label || 'Prior quarter'}: score ${q.score}, ${q.band}, key signal: ${q.key_signal || 'none'}`
        ).join('\n')
      : '  No prior quarter history yet';

    const confirmedText = stateResult.confirmedEvent
      ? `YES — ${stateResult.confirmedEvent.description} (${stateResult.confirmedEvent.date}, source: ${stateResult.confirmedEvent.source}${stateResult.confirmedEvent.rolesAffected ? ', ' + stateResult.confirmedEvent.rolesAffected.toLocaleString() + ' roles' : ''})`
      : 'NO confirmed announcement detected';

    const intelBlock = intelligence ? `
- Programme: ${intelligence.programme.name ? `"${intelligence.programme.name}" — ${intelligence.programme.timeline}, phase ${intelligence.programme.phase}, $${(intelligence.programme.recognised_to_date_usd||0)/1e6}M recognised of $${(intelligence.programme.total_size_usd||0)/1e6}M total` : 'No named programme detected'}
- Headcount estimate: ${intelligence.headcount.mid ? `~${intelligence.headcount.mid.toLocaleString()} roles (${intelligence.headcount.confidence} confidence) — basis: ${intelligence.headcount.basis}` : 'No headcount estimate'}
- Function risk: ${intelligence.function_risk.at_risk.length ? 'AT RISK: ' + intelligence.function_risk.at_risk.map(f => f.function).join(', ') : 'No functions flagged at risk'}${intelligence.function_risk.protected.length ? '. PROTECTED: ' + intelligence.function_risk.protected.map(f => f.function).join(', ') : ''}
- Bankruptcy: ${intelligence.bankruptcy.detected ? `Chapter ${intelligence.bankruptcy.chapter} detected${intelligence.bankruptcy.filing_date ? ' (' + intelligence.bankruptcy.filing_date + ')' : ''}` : 'No bankruptcy filing detected'}
- Large employer flag (50K+ employees): ${intelligence.large_employer_flag ? 'YES' : 'NO'}` : '';

    const msg = await anthropic.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 500,
      messages: [{
        role:    'user',
        content: `Write a risk intelligence brief for a tech worker checking ${company}'s layoff risk.

FACTS — only reference what is listed here, do not invent anything:
- Company state: ${stateResult.state} (confidence: ${stateResult.confidence})
- Confirmed layoff event: ${confirmedText}
- EjectSeat risk score: ${score}/100 (${band})
- Filing status: ${quarterlyStatus ? (quarterlyStatus.filingStatus === 'awaited' ? 'QUARTERLY FILING PENDING — ' + (quarterlyStatus.currentQuarterLabel || '') + ' not yet filed. Score reflects prior quarter data.' : quarterlyStatus.filingStatus === 'overdue' ? 'FILING OVERDUE — ' + (quarterlyStatus.signalAwaitedMessage || '') : 'Current quarter filed') : 'Filing status unknown'}${intelBlock}
- Signals found:
${signalList}
- Prior quarter scores:
${historyText}

STEP 1 — CHAIN OF THOUGHT (answer these before writing):
1. Is there a confirmed announcement, or a named multi-year programme? If yes, what and when?
2. If bankruptcy detected: lead with chapter type — DO NOT call it a voluntary restructuring programme.
3. What is the most significant signal and why?
4. Is the risk trajectory rising, flat, or falling based on quarter history?
5. Is this predictive or confirmed?

STEP 2 — WRITE THE BRIEF using exactly this structure:
Sentence 1: Current state — what is confirmed vs what is predicted. Name the programme if one exists. Be specific with dates and numbers.
Sentence 2: Key evidence — what signals exist, from which sources. If headcount estimate exists, mention it. If functions are explicitly at risk or protected, mention them.
Sentence 3: Trajectory + filing note — is risk rising/falling. If filing is PENDING/OVERDUE explicitly say so.

RULES:
- If ACTIVE / ACTIVE_MULTI_YEAR / CONTINUATION_RISK: say "has confirmed layoffs" or "is mid-cycle of [programme]" not "signals suggest"
- If WATCHING or CLEAR: say "signals suggest" or "forward-looking indicators"
- If bankruptcy.detected is true: say "filed for Chapter X" — court-supervised process
- Never invent numbers, dates, or sources not in the FACTS section above
- End with: "This reflects confirmed public announcements." or "This is a predictive signal based on public filings — not a confirmed outcome."
- If large_employer_flag is true and no confirmed event/bankruptcy, append: "Site-specific cuts may occur outside of these signals."
- Max 4 sentences total

Return this JSON only:
{
  "chainOfThought": "your step 1 reasoning",
  "summary": "your brief"
}`,
      }],
    });

    const content = msg.content[0];
    if (content.type !== 'text') {
      return { summary: defaultSummary, chainOfThought: 'Parse error' };
    }

    const parsed = safeParseJSON<any>(content.text, null);
    if (!parsed?.summary) {
      return { summary: defaultSummary, chainOfThought: 'Parse error' };
    }

    return {
      summary:        parsed.summary.trim(),
      chainOfThought: parsed.chainOfThought || '',
    };

  } catch (err) {
    console.error('[nlp] generateSummary error:', err);
    return { summary: defaultSummary, chainOfThought: 'Error' };
  }
}

function buildFallbackSummary(
  company:     string,
  score:       number,
  band:        string,
  stateResult: StateClassification,
  intelligence?: ComprehensiveIntelligence | null,
): string {
  const programmeBit = intelligence?.programme.name
    ? ` Active programme: "${intelligence.programme.name}".`
    : '';
  const hcBit = intelligence?.headcount.mid
    ? ` Estimated impact ~${intelligence.headcount.mid.toLocaleString()} roles.`
    : '';

  if (intelligence?.bankruptcy.detected) {
    return `${company} has filed for Chapter ${intelligence.bankruptcy.chapter} — court-supervised process.${hcBit} Risk score is ${score}/100 (${band}). This reflects confirmed public filings.`;
  }
  if ((stateResult.state === 'ACTIVE' || stateResult.state === 'ACTIVE_MULTI_YEAR') && stateResult.confirmedEvent) {
    return `${company} has confirmed layoffs: ${stateResult.confirmedEvent.description} (${stateResult.confirmedEvent.date}).${programmeBit}${hcBit} Risk score is ${score}/100 (${band}). This reflects confirmed public announcements.`;
  }
  if (stateResult.state === 'CONTINUATION_RISK' && stateResult.confirmedEvent) {
    return `${company} completed a confirmed layoff wave (${stateResult.confirmedEvent.description}) with signals suggesting further restructuring is possible.${programmeBit} Risk score is ${score}/100 (${band}). This reflects confirmed announcements and forward-looking indicators.`;
  }
  if (stateResult.state === 'WATCHING') {
    return `${company} shows precursor signals in SEC filings and/or media coverage but no confirmed layoff announcement has been detected.${programmeBit} Risk score is ${score}/100 (${band}). This is a predictive signal based on public filings — not a confirmed outcome.`;
  }
  return `No significant layoff risk signals detected for ${company} in current SEC filings or Tier A/B media. Risk score is ${score}/100 (${band}). This is a predictive signal based on public filings — not a confirmed outcome.`;
}
