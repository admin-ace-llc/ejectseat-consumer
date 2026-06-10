// lib/scoring/engine.ts — EjectSeat Consumer v7.2
//
// v7.2 ACCURACY FIXES:
//
//   1. signalAwaited penalty does NOT apply to ACTIVE state companies.
//      Confirmed layoffs are confirmed regardless of whether the NEXT filing
//      is pending. The 0.85× penalty was pushing ACTIVE scores to the band
//      floor (60), signalling low confidence about events that are already
//      confirmed. ACTIVE companies now receive no penalty.
//
//   2. Overdue filings treated differently from awaited filings.
//      An overdue filing is a stress indicator, not a confidence reducer.
//      The validateAndFinaliseScore function now accepts separate
//      signalAwaited and signalOverdue flags. ACTIVE companies: neither
//      applies. WATCH/LIKELY companies: awaited gets 0.85×; overdue gets
//      NO penalty (route handles it as an additive signal instead).
//
//   3. validateAndFinaliseScore signature updated to accept CompanyState.
//      The route passes intel.state so the engine can gate the penalty
//      without re-deriving it.
//
// All v5 fallback math preserved unchanged.

import type {
  Signal, RiskBand, Confidence, CompanyState,
  ProgrammePhase, BankruptcyFiling, ComprehensiveIntelligence,
} from '@/types';
import { normaliseLegacyState } from '@/types';

// ─────────────────────────────────────────────────────────────────────────────
// v7 state bands (4 states per user alignment)
// ─────────────────────────────────────────────────────────────────────────────

const V7_BANDS: Record<CompanyState, { floor: number; ceiling: number }> = {
  CLEAR:  { floor: 0,  ceiling: 35 },
  WATCH:  { floor: 25, ceiling: 64 },
  LIKELY: { floor: 45, ceiling: 78 },
  ACTIVE: { floor: 60, ceiling: 90 },
};

// ─────────────────────────────────────────────────────────────────────────────
// v5/v6.1 legacy bands
// ─────────────────────────────────────────────────────────────────────────────

export function getStateBounds(state: string): { floor: number; ceiling: number } {
  switch (state) {
    case 'ACTIVE':             return { floor: 65, ceiling: 88 };
    case 'ACTIVE_MULTI_YEAR':  return { floor: 60, ceiling: 90 };
    case 'CONTINUATION_RISK':  return { floor: 50, ceiling: 82 };
    case 'WATCHING':           return { floor: 25, ceiling: 64 };
    // v7 names
    case 'WATCH':              return { floor: 25, ceiling: 64 };
    case 'LIKELY':             return { floor: 45, ceiling: 78 };
    case 'CLEAR':
    default:                   return { floor: 0,  ceiling: 35 };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// v7 PRIMARY — validateAndFinaliseScore
//
// v7.2: accepts separate signalAwaited and signalOverdue flags.
//        ACTIVE companies skip both penalties.
//        Non-ACTIVE companies: awaited gets 0.85×; overdue gets no penalty.
// ─────────────────────────────────────────────────────────────────────────────

export interface FinalisedScore {
  score:      number;
  band:       RiskBand;
  confidence: Confidence;
  state:      CompanyState;
  floor:      number;
  ceiling:    number;
  notes:      string[];
}

export function validateAndFinaliseScore(
  intel: ComprehensiveIntelligence,
  signalAwaited: boolean,
  fullyEligible: boolean,
  signalOverdue: boolean = false,
): FinalisedScore {
  const notes: string[] = [];
  const band = V7_BANDS[intel.state];

  let score = Math.max(band.floor, Math.min(band.ceiling, intel.score));
  if (score !== intel.score) notes.push(`Score clamped from ${intel.score} to ${score} (${intel.state} band)`);

  // v7.2: ACTIVE companies skip the signal-awaited penalty entirely.
  // Confirmed layoffs are confirmed — the next filing being pending doesn't
  // reduce the confidence of an already-confirmed event.
  if (signalAwaited && intel.state !== 'ACTIVE') {
    const before = score;
    score = Math.round(score * 0.85);
    score = Math.max(band.floor, score);
    notes.push(`Signal-awaited penalty: ${before} → ${score} (0.85× multiplier, floored at ${band.floor})`);
  } else if (signalAwaited && intel.state === 'ACTIVE') {
    notes.push('Signal-awaited penalty skipped: ACTIVE state — confirmed events are not downgraded by pending filings');
  }

  // v7.2: overdue is a stress indicator — no penalty applied.
  // The route adds it as a forward signal for the model to consider.
  if (signalOverdue) {
    notes.push('Overdue filing detected — treated as stress indicator (no score penalty; additive signal)');
  }

  return {
    score,
    band: getBand(score),
    confidence: getConfidence(fullyEligible, signalAwaited, score, intel.confidence, intel.state),
    state: intel.state,
    floor: band.floor,
    ceiling: band.ceiling,
    notes,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Band and confidence mapping
// ─────────────────────────────────────────────────────────────────────────────

export function getBand(score: number): RiskBand {
  if (score >= 65) return 'HIGH';
  if (score >= 40) return 'MEDIUM';
  return 'LOW';
}

export function getConfidence(
  fullyEligible: boolean,
  signalAwaited: boolean,
  score: number,
  intelConfidence?: 'high' | 'medium' | 'low',
  state?: CompanyState,
): Confidence {
  // v7.2: ACTIVE companies don't get signal_awaited confidence — their event
  // is confirmed regardless of next filing status.
  if (signalAwaited && state !== 'ACTIVE') return 'signal_awaited';
  if (!fullyEligible) return 'low';
  if (intelConfidence === 'low') return 'low';
  if (score >= 65 && intelConfidence === 'high')   return 'high';
  if (score >= 40)                                  return 'medium';
  return 'low';
}

// ─────────────────────────────────────────────────────────────────────────────
// v5/v6.1 FALLBACK MATH — preserved in full for flag-off path
// ─────────────────────────────────────────────────────────────────────────────

export function getPhaseMultiplier(phase: ProgrammePhase | undefined): number {
  switch (phase) {
    case 'early':    return 1.10;
    case 'mid':      return 1.15;
    case 'late':     return 0.85;
    case 'complete': return 0.50;
    default:         return 1.00;
  }
}

export function getBankruptcyOverride(_b: BankruptcyFiling | undefined): null {
  return null;
}

export function getStateWeight(
  signalSource: 'xbrl' | 'media' | 'earnings' | '8k',
  state: string,
  escalationType?: 'escalation' | 'completion' | 'neutral',
): number {
  const s = normaliseLegacyState(state);
  if (s === 'ACTIVE') {
    if (signalSource === 'media') {
      if (escalationType === 'escalation') return 1.3;
      if (escalationType === 'completion') return 0.5;
      return 0.8;
    }
    if (signalSource === 'xbrl')    return 0.9;
    if (signalSource === 'earnings') return 1.2;
    if (signalSource === '8k')      return 1.1;
  }
  if (s === 'LIKELY') {
    if (signalSource === 'xbrl')     return 1.4;
    if (signalSource === 'earnings') return 1.3;
    if (signalSource === '8k')       return 1.2;
    if (signalSource === 'media') {
      if (escalationType === 'escalation') return 1.4;
      if (escalationType === 'completion') return 0.6;
      return 0.9;
    }
  }
  if (s === 'WATCH') {
    if (signalSource === 'xbrl')     return 1.1;
    if (signalSource === 'earnings') return 1.2;
    if (signalSource === 'media')    return 1.0;
    if (signalSource === '8k')       return 1.1;
  }
  if (s === 'CLEAR') {
    if (signalSource === 'xbrl')     return 1.2;
    if (signalSource === 'earnings') return 1.0;
    if (signalSource === 'media')    return 1.0;
    if (signalSource === '8k')       return 1.1;
  }
  return 1.0;
}

export function crossSignalCorroboration(
  hasVerifiedXBRL: boolean,
  hasConfirmed8K: boolean,
  tierABCount: number,
): number {
  if (hasVerifiedXBRL && hasConfirmed8K && tierABCount >= 2) return 1.5;
  if (hasVerifiedXBRL && hasConfirmed8K)                     return 1.3;
  if (hasConfirmed8K && tierABCount >= 2)                    return 1.3;
  if (hasVerifiedXBRL && tierABCount >= 2)                   return 1.2;
  if (tierABCount >= 3)                                      return 1.2;
  if (tierABCount >= 2)                                      return 1.1;
  return 1.0;
}

export function computeScore(
  rawTotal: number,
  state: string,
  signalAwaited: boolean,
  corroboration: number,
  phase?: ProgrammePhase,
  _bankruptcy?: BankruptcyFiling,
): number {
  const { floor, ceiling } = getStateBounds(state);
  const phaseMult = getPhaseMultiplier(phase);
  let adjusted = Math.round((rawTotal * corroboration * phaseMult / 130) * 100);
  if (signalAwaited) adjusted = Math.round(adjusted * 0.85);
  return Math.min(ceiling, Math.max(floor, adjusted));
}

export function normaliseScore(rawTotal: number, signalAwaited: boolean): number {
  let score = Math.round((rawTotal / 130) * 100);
  if (signalAwaited) score = Math.round(score * 0.85);
  return Math.min(100, Math.max(0, score));
}

export function temporalWeight(filingDateStr?: string): number {
  if (!filingDateStr) return 1.0;
  const days = (Date.now() - new Date(filingDateStr).getTime()) / 86_400_000;
  if (days <=   2) return 1.3;
  if (days <=  30) return 1.0;
  if (days <=  90) return 0.85;
  if (days <= 180) return 0.65;
  if (days <= 365) return 0.40;
  return 0.20;
}

// ─────────────────────────────────────────────────────────────────────────────
// Legacy constants
// ─────────────────────────────────────────────────────────────────────────────

export const SOURCE_MULTIPLIERS: Record<string, number> = {
  reuters: 1.3, bloomberg: 1.3, 'associated press': 1.2, ap: 1.2,
  'financial times': 1.2, ft: 1.2, 'wall street journal': 1.2, wsj: 1.2,
  marketwatch: 1.1, cnbc: 1.1, 'the information': 1.0, techcrunch: 0.95,
  axios: 0.95, fortune: 0.9, 'business insider': 0.9,
  'the verge': 0.8, 'ars technica': 0.8, wired: 0.78,
  venturebeat: 0.75, semafor: 0.75,
  reddit: 0, blind: 0, hackernews: 0, linkedin: 0, twitter: 0,
};

export const CHARGE_POINTS: Record<string, number> = {
  first_appearance:            22,
  continuation_with_liability: 16,
  continuation_expensed:        7,
  historical:                   4,
};

export const EARNINGS_TIER_POINTS: Record<string, number> = {
  tier_1: 18, tier_2: 14, tier_3: 9, tier_4: 4,
};

export const TOTAL_MAX = 130;
export const SIGNAL_AWAITED_MULT = 0.85;

export function corroborationMultiplier(tierABCount: number): number {
  if (tierABCount >= 3) return 1.4;
  if (tierABCount >= 2) return 1.2;
  return 1.0;
}

export function isTierAorB(source: string): boolean {
  const s = source.toLowerCase();
  return ['reuters','bloomberg','associated press','ap','financial times',
    'ft','wall street journal','wsj','marketwatch','cnbc','the information',
    'techcrunch','axios','fortune','business insider'].some(t => s.includes(t));
}

export function getMultiplier(source: string): number {
  const s = source.toLowerCase();
  for (const [key, mult] of Object.entries(SOURCE_MULTIPLIERS)) {
    if (s.includes(key)) return mult;
  }
  return 0;
}
