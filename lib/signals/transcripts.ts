// lib/signals/transcripts.ts — EjectSeat Consumer v7
//
// Fetches earnings call transcripts (prepared remarks + Q&A) for a given ticker
// from Motley Fool's public transcript pages. The Q&A section is where CEOs go
// off-script — that's where "we need fewer people" type language typically lives.
//
// Behaviour:
//   - One public interface: fetchRecentTranscripts(ticker, limit)
//   - Returns [] on any failure — pipeline continues SEC-only
//   - Never throws. Graceful fallback is the whole point.
//   - Abstraction layer: internal `sources` array is swappable; today Motley Fool,
//     tomorrow Seeking Alpha or AlphaSense without touching callers.
//   - Text is stripped of HTML / nav chrome before return. Max 20K chars per
//     transcript to keep token cost bounded.
//
// KNOWN FRAGILITY (flagged honestly):
//   Motley Fool's HTML layout changes occasionally. Selectors below were written
//   against the layout as of April 2026. If selectors miss, `fetchRecentTranscripts`
//   returns [] and the pipeline logs the failure — no user-visible error.
//   When selectors break, grep for `MOTLEY_FOOL_SELECTORS` below and update.

import type { TranscriptEvidence } from '@/types';

const UA = 'Mozilla/5.0 (compatible; EjectSeat/1.0; +https://ejectseat.io)';

// MOTLEY_FOOL_SELECTORS — update these if scraper returns empty on known-good tickers
const MF_TRANSCRIPT_LINK_PATTERN = /\/earnings\/call-transcripts\/\d{4}\/\d{2}\/\d{2}\/([a-z0-9-]+-q\d-\d{4}-earnings-call-t)\b/gi;
const MF_INDEX_URL = (ticker: string) =>
  `https://www.fool.com/quote/${ticker.toLowerCase()}/#earnings-call-transcripts`;
const MF_TICKER_INDEX_API = (ticker: string) =>
  `https://www.fool.com/data-news-api/quote-page-earnings-transcripts/?ticker=${ticker.toUpperCase()}`;

const MAX_CHARS_PER_TRANSCRIPT = 20_000;
const FETCH_TIMEOUT_MS = 6_000;

// ─────────────────────────────────────────────────────────────────────────────
// Fetch helper with timeout and graceful fallback
// ─────────────────────────────────────────────────────────────────────────────

async function fetchWithTimeout(url: string, timeoutMs: number = FETCH_TIMEOUT_MS): Promise<string | null> {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/json,*/*',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: controller.signal,
    });
    clearTimeout(t);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HTML -> plain text
// ─────────────────────────────────────────────────────────────────────────────

function stripHtml(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Split prepared remarks vs Q&A
// Motley Fool transcripts conventionally use a "Questions and Answers" heading
// (sometimes "Questions & Answers" or "Q&A Session"). We split on whichever
// first appears; if none found, all text is treated as prepared remarks.
// ─────────────────────────────────────────────────────────────────────────────

function splitRemarksAndQA(plainText: string): { preparedRemarks: string; qAndA: string } {
  const patterns = [
    /questions\s+and\s+answers/i,
    /questions\s*&\s*answers/i,
    /q\s*&\s*a\s+session/i,
    /question-and-answer\s+session/i,
  ];
  let splitIdx = -1;
  for (const p of patterns) {
    const m = plainText.match(p);
    if (m && m.index !== undefined) {
      splitIdx = m.index;
      break;
    }
  }
  if (splitIdx === -1) {
    return { preparedRemarks: plainText.slice(0, MAX_CHARS_PER_TRANSCRIPT), qAndA: '' };
  }
  const prepared = plainText.slice(0, splitIdx);
  const qa = plainText.slice(splitIdx);
  return {
    preparedRemarks: prepared.slice(0, MAX_CHARS_PER_TRANSCRIPT / 2),
    qAndA: qa.slice(0, MAX_CHARS_PER_TRANSCRIPT / 2),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Parse Motley Fool ticker index page → list of recent transcript URLs
// Two paths tried in order (first match wins):
//   1. JSON endpoint (sometimes returns structured data)
//   2. HTML quote page (regex-extract transcript links)
// ─────────────────────────────────────────────────────────────────────────────

interface TranscriptStub {
  url:          string;
  quarterLabel: string;
  publishedAt:  string | null;
}

function extractQuarterLabelFromSlug(slug: string): string {
  // slug pattern: "snap-inc-snap-q3-2025-earnings-call-t" → "Q3 2025"
  const m = slug.match(/q(\d)-(\d{4})/i);
  return m ? `Q${m[1]} ${m[2]}` : 'Recent quarter';
}

async function findRecentTranscriptUrls(ticker: string, limit: number): Promise<TranscriptStub[]> {
  const stubs: TranscriptStub[] = [];

  // Path 1: JSON API (if available)
  try {
    const jsonText = await fetchWithTimeout(MF_TICKER_INDEX_API(ticker));
    if (jsonText) {
      try {
        const data = JSON.parse(jsonText);
        const items: any[] = Array.isArray(data?.transcripts) ? data.transcripts
                          : Array.isArray(data?.data) ? data.data
                          : Array.isArray(data) ? data
                          : [];
        for (const it of items.slice(0, limit)) {
          const url = it.url || it.link || it.href;
          if (!url || typeof url !== 'string') continue;
          const fullUrl = url.startsWith('http') ? url : `https://www.fool.com${url}`;
          const slugMatch = fullUrl.match(/call-transcripts\/\d{4}\/\d{2}\/\d{2}\/([a-z0-9-]+)/i);
          const slug = slugMatch ? slugMatch[1] : '';
          stubs.push({
            url: fullUrl,
            quarterLabel: it.quarter || extractQuarterLabelFromSlug(slug),
            publishedAt: it.publishedAt || it.date || null,
          });
        }
        if (stubs.length) return stubs;
      } catch { /* fall through to HTML path */ }
    }
  } catch { /* fall through */ }

  // Path 2: HTML scrape of quote page
  const html = await fetchWithTimeout(MF_INDEX_URL(ticker));
  if (!html) return [];

  const seen = new Set<string>();
  const linkRe = new RegExp(MF_TRANSCRIPT_LINK_PATTERN);
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null && stubs.length < limit) {
    const fullPath = m[0];
    const slug = m[1];
    const fullUrl = `https://www.fool.com${fullPath}`;
    if (seen.has(fullUrl)) continue;
    seen.add(fullUrl);
    // date from URL: /earnings/call-transcripts/YYYY/MM/DD/
    const dateMatch = fullPath.match(/\/(\d{4})\/(\d{2})\/(\d{2})\//);
    const publishedAt = dateMatch ? `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}` : null;
    stubs.push({
      url: fullUrl,
      quarterLabel: extractQuarterLabelFromSlug(slug),
      publishedAt,
    });
  }
  return stubs;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fetch + parse one transcript page
// ─────────────────────────────────────────────────────────────────────────────

async function fetchOneTranscript(stub: TranscriptStub, ticker: string): Promise<TranscriptEvidence | null> {
  const html = await fetchWithTimeout(stub.url);
  if (!html) return null;

  // Narrow to article body if we can find it — otherwise strip whole page
  let bodyHtml = html;
  const articleMatch = html.match(/<article[\s\S]*?<\/article>/i);
  if (articleMatch) bodyHtml = articleMatch[0];
  else {
    const mainMatch = html.match(/<main[\s\S]*?<\/main>/i);
    if (mainMatch) bodyHtml = mainMatch[0];
  }

  const plain = stripHtml(bodyHtml);
  if (plain.length < 500) return null; // too short to be a real transcript

  const { preparedRemarks, qAndA } = splitRemarksAndQA(plain);

  return {
    source: 'motley_fool',
    ticker: ticker.toUpperCase(),
    quarterLabel: stub.quarterLabel,
    publishedAt: stub.publishedAt,
    url: stub.url,
    preparedRemarks,
    qAndA,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC — fetchRecentTranscripts
// ─────────────────────────────────────────────────────────────────────────────

export async function fetchRecentTranscripts(
  ticker: string | null | undefined,
  limit: number = 2,
): Promise<TranscriptEvidence[]> {
  if (!ticker) return [];
  try {
    const stubs = await findRecentTranscriptUrls(ticker, limit);
    if (stubs.length === 0) {
      console.log(`[transcripts] No transcripts found for ${ticker}`);
      return [];
    }
    const results = await Promise.all(stubs.map(s => fetchOneTranscript(s, ticker)));
    const valid = results.filter((r): r is TranscriptEvidence => r !== null);
    if (valid.length === 0) {
      console.log(`[transcripts] ${stubs.length} stubs found but none parsed for ${ticker}`);
    }
    return valid;
  } catch (err: any) {
    console.error(`[transcripts] fetch failed for ${ticker}:`, err?.message || err);
    return [];
  }
}

/**
 * Compact a transcript for LLM context — keeps the Q&A (highest signal density)
 * and trims prepared remarks if total exceeds the budget.
 */
export function compactTranscriptForPrompt(t: TranscriptEvidence, maxChars: number = 8000): string {
  const header = `── TRANSCRIPT: ${t.ticker} ${t.quarterLabel} | ${t.source} | ${t.publishedAt || 'date unknown'} | ${t.url} ──`;
  const qaBudget = Math.floor(maxChars * 0.6);
  const remarksBudget = maxChars - qaBudget - header.length - 40;
  const qa = t.qAndA.length > qaBudget ? t.qAndA.slice(0, qaBudget) + '…[Q&A truncated]' : t.qAndA;
  const remarks = t.preparedRemarks.length > remarksBudget
    ? t.preparedRemarks.slice(0, remarksBudget) + '…[remarks truncated]'
    : t.preparedRemarks;
  return `${header}\n\n[PREPARED REMARKS]\n${remarks}\n\n[Q&A]\n${qa || '(no Q&A section found)'}`;
}
