// lib/signals/quarterly-calendar.ts — EjectSeat Consumer v7.2
//
// v7.2 FIX — non-calendar fiscal year bug in computeFiscalPeriod.
//
// BUG (v7.1 and earlier):
//   For companies whose fiscal year end has already passed in the current
//   calendar year (e.g. Salesforce, FYE Jan 31), the code computed quarter
//   boundaries relative to the PAST fiscal year end rather than the NEXT one.
//   Example on June 10, 2026 for Salesforce (FYE Jan 31):
//     Old: fyEndThisYear = Jan 31, 2026 → Q4 ended Jan 31, 2026 → status=overdue
//     New: fyEndThisYear = Jan 31, 2027 → Q2 ends July 31, 2026 → status=awaited
//   The old code also treated the company as being in its annual filing window
//   (Q4/10-K) when it was actually mid-year on a quarterly cycle.
//
// v7.2 FIX — separate overdue vs awaited treatment.
//   An overdue filing is a STRESS INDICATOR (company may be delaying bad news),
//   NOT a confidence-reducing factor. The route handler was applying the same
//   0.85× score penalty to both awaited and overdue. This file now returns a
//   separate `isOverdue` boolean so the route can handle them differently.
//
// v7.2 FIX — QuarterlyStatus now includes isOverdue field.

import type { QuarterlyStatus, FilingStatus } from '@/types';

const USER_AGENT = 'EjectSeat/1.0 (enquiries.talkace@gmail.com)';
const EDGAR_SUBMISSIONS = (cik: string) =>
  `https://data.sec.gov/submissions/CIK${cik.replace(/^0+/, '').padStart(10, '0')}.json`;

// Typical filing lag windows (calendar days after period end)
// Large Accelerated Filer deadlines used as baseline.
const FILING_DUE_DAYS = {
  '10-Q': 40,   // LAF: 40 days
  '10-K': 60,   // LAF: 60 days
  '20-F': 120,
  '6-K':  30,
};

// Overdue threshold — fiscal quarter end + due window + this many days
const OVERDUE_GRACE_DAYS = 10;

// ─────────────────────────────────────────────────────────────────────────────
// Fiscal quarter math
// ─────────────────────────────────────────────────────────────────────────────

interface FiscalPeriod {
  yearEnd: string;         // MM-DD — fiscal year end (e.g. "01-31")
  currentQuarter: number;  // 1..4
  quarterEnd: Date;        // end date of current fiscal quarter
  quarterLabel: string;    // e.g. "Q2 FY2027"
  isAnnual: boolean;       // true if current quarter = Q4
}

function parseYearEnd(fyEnd: string | null | undefined): { month: number; day: number } {
  // EDGAR returns "MMDD" or "12-31" format
  if (!fyEnd) return { month: 12, day: 31 };
  const clean = fyEnd.replace(/-/g, '');
  if (clean.length === 4) {
    return { month: parseInt(clean.slice(0, 2)), day: parseInt(clean.slice(2, 4)) };
  }
  return { month: 12, day: 31 };
}

function computeFiscalPeriod(fyEndStr: string | null | undefined, asOf: Date = new Date()): FiscalPeriod {
  const { month: fyEndMonth, day: fyEndDay } = parseYearEnd(fyEndStr);

  // Standard calendar FY (Dec 31)
  if (fyEndMonth === 12 && fyEndDay === 31) {
    const month = asOf.getMonth() + 1;
    const year = asOf.getFullYear();
    let q: number;
    let qEnd: Date;
    if (month <= 3)      { q = 1; qEnd = new Date(year, 2, 31); }
    else if (month <= 6) { q = 2; qEnd = new Date(year, 5, 30); }
    else if (month <= 9) { q = 3; qEnd = new Date(year, 8, 30); }
    else                 { q = 4; qEnd = new Date(year, 11, 31); }
    return {
      yearEnd: '12-31',
      currentQuarter: q,
      quarterEnd: qEnd,
      quarterLabel: `Q${q} FY${year}`,
      isAnnual: q === 4,
    };
  }

  // Non-calendar FY — compute quarter ends by stepping back from the NEXT
  // upcoming fiscal year end date.
  //
  // v7.2 FIX: The original code used `asOfYear`'s FY end without checking
  // whether that date had already passed. For Salesforce (FYE Jan 31) in
  // June 2026, `fyEndThisYear` was Jan 31 2026 — already 5 months past —
  // so all four Q-ends fell in 2025, placing us permanently in "Q4 overdue."
  // The fix: advance to the next calendar year when the FY end has passed.
  const asOfYear = asOf.getFullYear();
  let fyEndRef = new Date(asOfYear, fyEndMonth - 1, fyEndDay);
  if (fyEndRef <= asOf) {
    // FY end has passed in the current calendar year; use next year's end
    fyEndRef = new Date(asOfYear + 1, fyEndMonth - 1, fyEndDay);
  }

  // Quarter ends relative to next FY end (stepping back 3 months each)
  const q1End = new Date(fyEndRef); q1End.setMonth(q1End.getMonth() - 9);
  const q2End = new Date(fyEndRef); q2End.setMonth(q2End.getMonth() - 6);
  const q3End = new Date(fyEndRef); q3End.setMonth(q3End.getMonth() - 3);
  const q4End = fyEndRef;

  let q: number; let qEnd: Date;
  if (asOf <= q1End)      { q = 1; qEnd = q1End; }
  else if (asOf <= q2End) { q = 2; qEnd = q2End; }
  else if (asOf <= q3End) { q = 3; qEnd = q3End; }
  else                    { q = 4; qEnd = q4End; }

  // FY label: for non-calendar FYs, the fiscal year number follows the
  // calendar year in which it ends.
  const fyLabel = fyEndRef.getFullYear();

  return {
    yearEnd: `${String(fyEndMonth).padStart(2, '0')}-${String(fyEndDay).padStart(2, '0')}`,
    currentQuarter: q,
    quarterEnd: qEnd,
    quarterLabel: `Q${q} FY${fyLabel}`,
    isAnnual: q === 4,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC — getQuarterlySignalStatus
// ─────────────────────────────────────────────────────────────────────────────

export async function getQuarterlySignalStatus(cik: string): Promise<QuarterlyStatus | null> {
  try {
    const res = await fetch(EDGAR_SUBMISSIONS(cik), { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) return null;
    const data = await res.json();

    const fyEnd = data.fiscalYearEnd; // e.g. "1231" or "0130"
    const recent = data.filings?.recent;
    const forms = recent?.form || [];
    const dates = recent?.filingDate || [];
    const periodOfReports = recent?.periodOfReport || [];

    const period = computeFiscalPeriod(fyEnd);

    // Find the most recent quarterly / annual filing
    let lastFiledDate: string | undefined;
    let lastFiledForm: string | undefined;
    let mostRecentPeriodOfReport: string | undefined;

    for (let i = 0; i < forms.length; i++) {
      const form = forms[i];
      if (['10-Q', '10-K', '20-F', '6-K'].includes(form)) {
        lastFiledDate = dates[i];
        lastFiledForm = form;
        mostRecentPeriodOfReport = periodOfReports[i];
        break;
      }
    }

    // Determine expected form for current period
    const expectedForm = period.isAnnual ? '10-K' : '10-Q';
    const dueWindow = FILING_DUE_DAYS[expectedForm as keyof typeof FILING_DUE_DAYS] || 40;
    const expectedDueDate = new Date(period.quarterEnd.getTime() + dueWindow * 86_400_000);
    const overdueDate = new Date(expectedDueDate.getTime() + OVERDUE_GRACE_DAYS * 86_400_000);
    const now = new Date();

    // Has the current period been reported?
    const currentPeriodEndIso = period.quarterEnd.toISOString().slice(0, 10);
    const alreadyReported = mostRecentPeriodOfReport && mostRecentPeriodOfReport >= currentPeriodEndIso;

    let status: FilingStatus;
    let signalAwaitedMessage: string | undefined;
    const daysUntilDue = Math.floor((expectedDueDate.getTime() - now.getTime()) / 86_400_000);

    if (alreadyReported) {
      status = 'filed';
    } else if (now < period.quarterEnd) {
      // Quarter hasn't ended yet — nothing to file
      status = 'filed';
    } else if (now > overdueDate) {
      // v7.2: overdue is a separate stress signal — do NOT conflate with awaited.
      // The route handler should NOT apply the 0.85× score penalty here;
      // overdue filings are a negative indicator (company may be delaying bad news).
      status = 'overdue';
      signalAwaitedMessage = `${period.quarterLabel} ${expectedForm} overdue — last filed ${lastFiledDate || 'unknown'}. Late filing is itself a stress indicator.`;
    } else {
      status = 'awaited';
      signalAwaitedMessage = daysUntilDue > 0
        ? `Awaiting ${period.quarterLabel} ${expectedForm} — due in ~${daysUntilDue} days`
        : `Awaiting ${period.quarterLabel} ${expectedForm} — now within filing window`;
    }

    return {
      filingStatus: status,
      expectedFilingDate: expectedDueDate.toISOString().slice(0, 10),
      signalAwaitedMessage,
      fiscalYearEnd: period.yearEnd,
      currentQuarterLabel: period.quarterLabel,
      lastFiledDate,
      lastFiledForm,
      daysUntilDue: status === 'awaited' ? Math.max(0, daysUntilDue) : undefined,
    };
  } catch (err: any) {
    console.error('[quarterly-calendar] failed:', err?.message || err);
    return null;
  }
}
