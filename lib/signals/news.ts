// lib/signals/news.ts — EjectSeat Consumer v5
// State-aware media signal scoring
// Google News URL detection fixed (multi-method)
// Exports fetchRecentHeadlines for state classification

import { Signal } from '@/types';
import { crossSignalCorroboration, temporalWeight } from '@/lib/scoring/engine';
import { analyzeText, SEVERITY_TO_POINTS } from '@/lib/signals/nlp-analyzer';
import type { CompanyState } from '@/lib/signals/nlp-analyzer';

const TIER_A_NAMES = ['reuters','bloomberg','financial times','ft.com','wall street journal','wsj','associated press','ap news','marketwatch'];
const TIER_B_NAMES = ['cnbc','the information','techcrunch','axios','fortune','business insider','businessinsider','variety'];
const TIER_C_NAMES = ['the verge','ars technica','wired','venturebeat','semafor','hollywood reporter','zdnet','cnet'];

const TIER_A_URLS  = ['reuters.com','bloomberg.com','ft.com','wsj.com','marketwatch.com','apnews.com'];
const TIER_B_URLS  = ['cnbc.com','theinformation.com','techcrunch.com','axios.com','fortune.com','businessinsider.com','variety.com','theverge.com'];
const TIER_C_URLS  = ['arstechnica.com','wired.com','venturebeat.com','semafor.com','hollywoodreporter.com','zdnet.com','cnet.com'];

function detectSourceTier(item: any): { tier: 'tier_a'|'tier_b'|'tier_c'|'excluded'; domain: string } {
  const url     = (item.link    || '').toLowerCase();
  const source  = (item.source  || '').toLowerCase();
  const title   = (item.title   || '').toLowerCase();
  const desc    = (item.description || '').toLowerCase();
  const combined = `${title} ${desc} ${source}`;

  if (TIER_A_URLS.some(d => url.includes(d)))      return { tier: 'tier_a', domain: TIER_A_URLS.find(d => url.includes(d))! };
  if (TIER_B_URLS.some(d => url.includes(d)))      return { tier: 'tier_b', domain: TIER_B_URLS.find(d => url.includes(d))! };
  if (TIER_C_URLS.some(d => url.includes(d)))      return { tier: 'tier_c', domain: TIER_C_URLS.find(d => url.includes(d))! };
  if (TIER_A_NAMES.some(d => combined.includes(d))) return { tier: 'tier_a', domain: TIER_A_NAMES.find(d => combined.includes(d))! };
  if (TIER_B_NAMES.some(d => combined.includes(d))) return { tier: 'tier_b', domain: TIER_B_NAMES.find(d => combined.includes(d))! };
  if (TIER_C_NAMES.some(d => combined.includes(d))) return { tier: 'tier_c', domain: TIER_C_NAMES.find(d => combined.includes(d))! };
  return { tier: 'excluded', domain: 'unknown' };
}

function getBasePoints(tier: string): number {
  if (tier === 'tier_a') return 12;
  if (tier === 'tier_b') return 9;
  if (tier === 'tier_c') return 6;
  return 0;
}

function getAgeWeight(pubDate: string | undefined): number {
  if (!pubDate) return 0.65;
  const daysOld = (Date.now() - new Date(pubDate).getTime()) / 86_400_000;
  if (daysOld <= 2)  return 1.3;
  if (daysOld <= 7)  return 1.0;
  if (daysOld <= 30) return 0.85;
  if (daysOld <= 90) return 0.65;
  return 0.40;
}

function getStateMediaWeight(
  state:          CompanyState,
  escalationType: 'escalation' | 'completion' | 'neutral',
): number {
  if (state === 'ACTIVE' || state === 'ACTIVE_MULTI_YEAR') {
    if (escalationType === 'escalation') return 1.3;
    if (escalationType === 'completion') return 0.5;
    return 0.8;
  }
  if (state === 'CONTINUATION_RISK') {
    if (escalationType === 'escalation') return 1.4;
    if (escalationType === 'completion') return 0.6;
    return 0.9;
  }
  if (state === 'WATCHING') return 1.0;
  return 1.0;
}

const SIGNAL_KEYWORDS = [
  'layoff','laid off','job cut','workforce reduction','reduction in force',
  'restructur','severance','headcount','retrench','reorgani',
  'activist investor','shareholder pressure','cost cut','cost saving',
  'profitab','annualized saving','path to profit',
  'right-siz','rightsiz','streamlin','downsiz',
  'thrive','project','programme','transformation',
  'bankruptcy','chapter 11','chapter 7','voluntary petition','debtor',
];

function hasSignalKeyword(text: string): boolean {
  const lower = text.toLowerCase();
  return SIGNAL_KEYWORDS.some(kw => lower.includes(kw));
}

const SEARCH_QUERIES = (company: string) => [
  `"${company}" layoffs OR "job cuts" OR "workforce reduction" OR "reduction in force"`,
  `"${company}" restructuring OR severance OR "headcount reduction" OR downsizing`,
  `"${company}" "activist investor" OR "shareholder pressure" OR "cost cutting" OR "cost savings"`,
  `"${company}" "path to profitability" OR "profitable growth" OR "annualized savings" OR reorg OR bankruptcy`,
];

async function fetchNewsRSS(query: string): Promise<any[]> {
  try {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
    const res = await fetch(url, { headers: { 'User-Agent': 'EjectSeat/1.0 (enquiries.talkace@gmail.com)' }});
    if (!res.ok) return [];
    const xml    = await res.text();
    const items: any[] = [];
    const blocks = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
    for (const block of blocks.slice(0, 10)) {
      const title   = block.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)?.[1]    || block.match(/<title>(.*?)<\/title>/)?.[1]    || '';
      const link    = block.match(/<link>(.*?)<\/link>/)?.[1]                       || block.match(/<guid[^>]*>(.*?)<\/guid>/)?.[1] || '';
      const pubDate = block.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] || '';
      const desc    = block.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/)?.[1] || block.match(/<description>(.*?)<\/description>/)?.[1] || '';
      const source  = block.match(/<source[^>]*>(.*?)<\/source>/)?.[1] || '';
      if (title && link) items.push({ title, link, pubDate, description: desc, source });
    }
    return items;
  } catch { return []; }
}

export async function fetchRecentHeadlines(companyName: string): Promise<string[]> {
  try {
    const items = await fetchNewsRSS(`"${companyName}" layoffs OR restructuring OR "job cuts" OR "workforce reduction"`);
    return items.slice(0, 10).map(i => `${i.source ? i.source + ': ' : ''}${i.title}${i.pubDate ? ' (' + new Date(i.pubDate).toDateString() + ')' : ''}`);
  } catch { return []; }
}

export async function collectMediaSignals(
  companyName: string,
  state:       CompanyState = 'CLEAR',
): Promise<Signal[]> {

  const signals: Signal[] = [];
  const seenTitles = new Set<string>();
  let tierABCount  = 0;

  try {
    const queries  = SEARCH_QUERIES(companyName);
    const results  = await Promise.all(queries.map(q => fetchNewsRSS(q)));
    const allItems = results.flat();

    const unique = allItems.filter(item => {
      const key = item.title.slice(0,60).toLowerCase();
      if (seenTitles.has(key)) return false;
      seenTitles.add(key);
      return true;
    });

    const tieredItems = unique
      .map(item => ({ ...item, ...detectSourceTier(item) }))
      .filter(item => item.tier !== 'excluded')
      .slice(0, 12);

    let nlpBudget = 6;

    for (const item of tieredItems) {
      const basePoints = getBasePoints(item.tier);
      if (!basePoints) continue;

      const pubDate   = item.pubDate ? new Date(item.pubDate).toISOString().slice(0,10) : undefined;
      const ageWeight = getAgeWeight(pubDate);
      const combined  = `${item.title}. ${item.description || ''}`;

      if (!hasSignalKeyword(combined)) continue;

      let signalType     = 'media_keyword_signal';
      let severity       = 3;
      let evidence       = item.title.slice(0,120);
      let forwardLook    = true;
      let escalationType: 'escalation'|'completion'|'neutral' = 'neutral';

      if (nlpBudget > 0) {
        nlpBudget--;
        const nlpResult = await analyzeText(combined.slice(0,2000), 'news article', companyName);
        if (nlpResult.signals.length > 0) {
          const top      = nlpResult.signals.sort((a,b) => a.severity - b.severity)[0];
          signalType     = `media_${top.signal_type}`;
          severity       = top.severity;
          evidence       = top.evidence || evidence;
          forwardLook    = top.forward_looking;
          escalationType = (top as any).escalation_type || 'neutral';
        }
      }

      const nlpPoints     = SEVERITY_TO_POINTS[severity] || 9;
      const stateWeight   = getStateMediaWeight(state, escalationType);
      const effectiveBase = item.tier === 'tier_a'
        ? Math.min(nlpPoints, 14)
        : Math.min(nlpPoints, basePoints * 1.2);

      const weightedPoints = Math.round(effectiveBase * ageWeight * stateWeight);
      if (weightedPoints === 0) continue;

      if (item.tier === 'tier_a' || item.tier === 'tier_b') tierABCount++;

      signals.push({
        type:            signalType,
        source:          item.domain || item.source || 'News source',
        sourceTier:      item.tier,
        rawPoints:       Math.round(effectiveBase),
        weightedPoints,
        temporalTag:     forwardLook ? 'Predictive' : 'Context',
        alertMessage:    evidence,
        filingDate:      pubDate,
        escalationType,
      } as any);
    }

    if (tierABCount >= 2) {
      const mult = tierABCount >= 3 ? 1.4 : 1.2;
      for (const s of signals) {
        s.weightedPoints = Math.round(s.weightedPoints * mult);
      }
    }

  } catch (err) {
    console.error('[news] Error:', err);
  }

  return signals;
}
