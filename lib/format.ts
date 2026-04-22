// lib/format.ts — EjectSeat Consumer v7
// Single source of truth for number formatting.
// Applied in: SEC signal alerts, Sonnet prompt (pre-formatted), UI rendering,
// summary fallbacks, score_history logging, everywhere a number faces a user.

/**
 * Format a USD amount in business shorthand.
 *   12_500_000_000 -> "$12.5B"
 *   847_000_000    -> "$847M"
 *   1_200_000      -> "$1.2M"
 *   847_000        -> "$847K"
 *   500            -> "$500"
 *
 * Null / undefined / NaN -> "—"
 */
export function fmtUSD(val: number | null | undefined): string {
  if (val === null || val === undefined || !Number.isFinite(val)) return '—';
  const abs = Math.abs(val);
  const sign = val < 0 ? '-' : '';
  if (abs >= 1e12) return `${sign}$${(abs / 1e12).toFixed(1)}T`;
  if (abs >= 1e9)  return `${sign}$${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6)  return `${sign}$${(abs / 1e6).toFixed(abs >= 1e8 ? 0 : 1)}M`;
  if (abs >= 1e3)  return `${sign}$${Math.round(abs / 1e3)}K`;
  return `${sign}$${Math.round(abs)}`;
}

/**
 * Format a headcount / role count with locale-appropriate grouping.
 *   3_400  -> "3,400"
 *   1_000  -> "1,000"
 *   47     -> "47"
 */
export function fmtCount(val: number | null | undefined): string {
  if (val === null || val === undefined || !Number.isFinite(val)) return '—';
  return Math.round(val).toLocaleString('en-US');
}

/**
 * Format a headcount range.
 *   (3000, 4500) -> "3,000–4,500"
 *   (null, null) -> "—"
 *   (3000, 3000) -> "~3,000"
 */
export function fmtRange(low: number | null | undefined, high: number | null | undefined): string {
  if ((low == null) && (high == null)) return '—';
  if (low != null && high != null) {
    if (low === high) return `~${fmtCount(low)}`;
    return `${fmtCount(low)}–${fmtCount(high)}`;
  }
  return fmtCount(low ?? high);
}

/**
 * Format a percentage. Accepts either 0-1 (fraction) or 0-100 (percent).
 * Heuristic: if abs value <= 1.5, treat as fraction; else as percent.
 *   0.16  -> "16%"
 *   16    -> "16%"
 *   0.043 -> "4.3%"
 */
export function fmtPct(val: number | null | undefined, decimals = 0): string {
  if (val === null || val === undefined || !Number.isFinite(val)) return '—';
  const asPct = Math.abs(val) <= 1.5 ? val * 100 : val;
  return `${asPct.toFixed(decimals)}%`;
}

/**
 * Format a date nicely. ISO string in, "Apr 15, 2026" out.
 * Returns "—" for null / invalid.
 */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

/**
 * Relative time: "today", "3 days ago", "2 weeks ago", "Jan 2025".
 * Useful for recency chips on signals.
 */
export function fmtRelative(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '—';
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (days < 0) return fmtDate(iso);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 30) {
    const wks = Math.round(days / 7);
    return `${wks} ${wks === 1 ? 'week' : 'weeks'} ago`;
  }
  if (days < 365) {
    const mos = Math.round(days / 30);
    return `${mos} ${mos === 1 ? 'month' : 'months'} ago`;
  }
  return fmtDate(iso);
}

/**
 * Truncate a string to n chars, appending "…" if cut.
 * Safe on null / undefined.
 */
export function truncate(s: string | null | undefined, n: number): string {
  if (!s) return '';
  if (s.length <= n) return s;
  return s.slice(0, n - 1).trimEnd() + '…';
}

/**
 * Format an EDGAR accession number for display.
 *   "0001564408-26-000037" stays as-is (standard EDGAR format).
 *   Bare numbers get grouped: "000156440826000037" -> "0001564408-26-000037"
 */
export function fmtAccession(acc: string | null | undefined): string {
  if (!acc) return '—';
  if (acc.includes('-')) return acc;
  if (acc.length === 18) return `${acc.slice(0, 10)}-${acc.slice(10, 12)}-${acc.slice(12)}`;
  return acc;
}
