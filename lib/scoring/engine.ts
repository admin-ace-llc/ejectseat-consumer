// lib/scoring/engine.ts — EjectSeat Consumer v6.1
//
// v5: State-aware scoring with floor/ceiling, cross-signal corroboration
// v6.1: + ACTIVE_MULTI_YEAR state (60-90 band for mid-cycle programmes)
//       + phase multiplier (programmes late in cycle score lower)
//       + bankruptcy override (forces ACTIVE + floor with chapter cited)

import { Signal, RiskBand, Confidence } from '@/types';
import type { CompanyState } from '@/lib/signals/nlp-analyzer';
import type { ProgrammePhase, BankruptcyFiling } from '@/types';

// ─────────────────────────────────────────────────────────────────────────────
// State bounds
// ─────────────────────────────────────────────────────────────────────────────

export function getStateBounds(state: CompanyState): { floor: number; ceiling: number } {
  switch (state) {
    case 'ACTIVE':             return { floor: 65, ceiling: 88 };
    case 'ACTIVE_MULTI_YEAR':  return { floor: 60, ceiling: 90 }; // v6.1
    case 'CONTINUATION_RISK':  return { floor: 50, ceiling: 82 };
    case 'WATCHING':           return { floor: 25, ceiling: 64 };
    case 'CLEAR':
    default:                   return { floor: 0,  ceiling: 35 };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// v6.1 NEW — Phase multiplier
// Early/mid programmes get boosted; late/complete programmes get discounted.
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

// ─────────────────────────────────────────────────────────────────────────────
// v6.1 NEW — Bankruptcy override
// Chapter 7/11/15 filing forces ACTIVE state with floor score.
// Returns {state, floor, reason} or null if not triggered.
// ─────────────────────────────────────────────────────────────────────────────

export function getBankruptcyOverride(
  bankruptcy: BankruptcyFiling | undefined
): { state: CompanyState; floor: number; reason: string } | null {
  if (!bankruptcy?.detected || !bankruptcy.chapter) return null;

  // Chapter 7 = liquidation (highest severity)
  // Chapter 11 = reorganisation under court
  // Chapter 15 = cross-border insolvency coordination
  const floor = bankruptcy.chapter === '7' ? 85
              : bankruptcy.chapter === '11' ? 75
              : 65;

  return {
    state: 'ACTIVE',
    floor,
    reason: `Chapter ${bankruptcy.chapter} filing — court-supervised process${bankruptcy.filing_date ? ' filed ' + bankruptcy.filing_date : ''}`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// State-aware signal weights
// ─────────────────────────────────────────────────────────────────────────────

export function getStateWeight(
  signalSource:    'xbrl' | 'media' | 'earnings' | '8k',
  state:           CompanyState,
  escalationType?: 'escalation' | 'completion' | 'neutral',
): number {
  if (state === 'ACTIVE' || state === 'ACTIVE_MULTI_YEAR') {
    if (signalSource === 'media') {
      if (escalationType === 'escalation') return 1.3;
      if (escalationType === 'completion') return 0.5;
      return 0.8;
    }
    if (signalSource === 'xbrl')    return 0.9;
    if (signalSource === 'earnings') return 1.2;
    if (signalSource === '8k')      return 1.1;
  }

  if (state === 'CONTINUATION_RISK') {
    if (signalSource === 'xbrl')    return 1.4;
    if (signalSource === 'media') {
      if (escalationType === 'escalation') return 1.4;
      if (escalationType === 'completion') return 0.6;
      return 0.9;
    }
    if (signalSource === 'earnings') return 1.3;
    if (signalSource === '8k')      return 1.2;
  }

  if (state === 'WATCHING') {
    if (signalSource === 'xbrl')     return 1.1;
    if (signalSource === 'earnings') return 1.2;
    if (signalSource === 'media')    return 1.0;
    if (signalSource === '8k')       return 1.1;
  }

  if (state === 'CLEAR') {
    if (signalSource === 'xbrl')     return 1.2;
    if (signalSource === 'earnings') return 1.0;
    if (signalSource === 'media')    return 1.0;
    if (signalSource === '8k')       return 1.1;
  }

  return 1.0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cross-signal corroboration
// ─────────────────────────────────────────────────────────────────────────────

export function crossSignalCorroboration(
  hasVerifiedXBRL: boolean,
  hasConfirmed8K:  boolean,
  tierABCount:     number,
): number {
  if (hasVerifiedXBRL && hasConfirmed8K && tierABCount >= 2) return 1.5;
  if (hasVerifiedXBRL && hasConfirmed8K)                     return 1.3;
  if (hasConfirmed8K && tierABCount >= 2)                    return 1.3;
  if (hasVerifiedXBRL && tierABCount >= 2)                   return 1.2;
  if (tierABCount >= 3)                                      return 1.2;
  if (tierABCount >= 2)                                      return 1.1;
  return 1.0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Final score computation — v6.1 accepts phase + bankruptcy override
// ─────────────────────────────────────────────────────────────────────────────

export function computeScore(
  rawTotal:         number,
  state:            CompanyState,
  signalAwaited:    boolean,
  corroboration:    number,
  phase?:           ProgrammePhase,
  bankruptcy?:      BankruptcyFiling,
): number {
  // v6.1: bankruptcy override first — forces floor
  const bk = getBankruptcyOverride(bankruptcy);
  if (bk) {
    const phaseMult = getPhaseMultiplier(phase);
    let adjusted = Math.round((rawTotal * corroboration * phaseMult / 130) * 100);
    if (signalAwaited) adjusted = Math.round(adjusted * 0.85);
    // Never go below bankruptcy floor — cap at 95 to leave headroom
    return Math.min(95, Math.max(bk.floor, adjusted));
  }

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

export function getBand(score: number): RiskBand {
  if (score >= 65) return 'HIGH';
  if (score >= 40) return 'MEDIUM';
  return 'LOW';
}

export function getConfidence(
  fullyEligible:  boolean,
  signalAwaited:  boolean,
  score:          number,
): Confidence {
  if (signalAwaited)     return 'signal_awaited';
  if (!fullyEligible)    return 'low';
  if (score >= 65)       return 'high';
  if (score >= 40)       return 'medium';
  return 'low';
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
// Legacy exports (preserved)
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

export const TOTAL_MAX           = 130;
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
