// lib/signals/earnings.ts — EjectSeat Consumer v7
//
// ROLE CHANGE vs v5/v6.1:
//   v5 did its own 8-K Item 2.02 fetch and Haiku keyword classification.
//   v7 earnings content flows through two channels:
//     1. transcripts.ts → Motley Fool Q&A (the high-signal source)
//     2. sec.ts filings bundle → 8-K / 6-K earnings press releases (text)
//   Both are passed to the comprehensive Sonnet call. This file is preserved
//   only as a legacy shim for the v5 fallback path.

import type { Signal } from '@/types';
import { collectMediaSignals } from '@/lib/signals/news';

/**
 * v5 compatibility shim. In v7 mode this is not called — the route orchestrator
 * runs the comprehensive Sonnet pipeline instead. When USE_COMPREHENSIVE_V2=false
 * falls back to a no-op (earnings signal is already surfaced via the comprehensive
 * pass in the sec bundle). Returns empty array rather than reimplementing v5.
 */
export async function analyzeEarnings(
  _companyName: string,
  _cik: string,
): Promise<Signal[]> {
  return [];
}
