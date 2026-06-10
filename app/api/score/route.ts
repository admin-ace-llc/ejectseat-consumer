// app/api/score/route.ts — EjectSeat Consumer v7.2
//
// v7.2 ACCURACY FIXES:
//
//   1. NLP parse failures are no longer cached.
//      When comprehensiveAnalysis throws NLP_PARSE_FAILURE the route returns
//      a 503 (Service Unavailable) and skips all DB writes. The old behaviour
//      persisted emptyIntelligence (CLEAR/0) as a real score for up to 72h.
//
//   2. Cache response now populates signals from cached_intelligence.
//      The v7.1 cache path hardcoded `signals: []` and `confirmedEvents: []`,
//      meaning users never saw why a cached score was what it was. The cache
//      path now reconstructs signals from the stored intelligence object so
//      the UI evidence bundle is populated identically to a live response.
//
//   3. signalAwaited and signalOverdue separated.
//      The quarterly calendar now returns overdue as a distinct state.
//      Overdue is passed as a separate flag to validateAndFinaliseScore so
//      the engine can skip the 0.85× penalty (overdue = stress indicator,
//      not a confidence reducer). ACTIVE companies skip the penalty entirely.
//
//   4. fetchLegacyAuditSignals receives pre-fetched EDGAR data.
//      Eliminates the duplicate EDGAR companyfacts + submissions round-trip
//      that was happening on every live score request.
//
// CACHE TTLs (unchanged from v7.1):
//   Anonymous: 72h | Registered: 24h

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { validateCompany } from '@/lib/signals/company-validator';
import {
  validateAndFinaliseScore, getStateBounds, getBand, getConfidence,
  crossSignalCorroboration, computeScore,
} from '@/lib/scoring/engine';
import {
  comprehensiveAnalysis,
  classifyCompanyState, prefilterFilingText, generateSummary,
  type StateClassification,
} from '@/lib/signals/nlp-analyzer';
import {
  fetchEvidenceBundle, fetchLegacyAuditSignals, collectSECSignals,
} from '@/lib/signals/sec';
import { fetchRecentNews, fetchRecentHeadlines, collectMediaSignals } from '@/lib/signals/news';
import { fetchRecentTranscripts } from '@/lib/signals/transcripts';
import type {
  EvidenceBundle, ComprehensiveIntelligence, RiskScore, Signal, ConfirmedEvent,
  CompanyState, Confidence,
} from '@/types';
import { normaliseLegacyState } from '@/types';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// ─────────────────────────────────────────────────────────────────────────────
// Feature flag
// ─────────────────────────────────────────────────────────────────────────────

function useV2(): boolean {
  const v = process.env.USE_COMPREHENSIVE_V2;
  return v === undefined ? true : v === 'true' || v === '1';
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function getScoreHistory(companyId: string): Promise<any[]> {
  const { data } = await supabase
    .from('score_history')
    .select('score, band, quarter_label, scored_at, key_signal, company_state')
    .eq('company_id', companyId)
    .order('scored_at', { ascending: false })
    .limit(4);
  return (data || []).reverse();
}

async function upsertCompany(
  eligibility: any, companyName: string, ticker: string | undefined,
  score: number, band: string, state: string,
): Promise<string | null> {
  const { data } = await supabase
    .from('companies')
    .upsert({
      name:             companyName,
      legal_name:       eligibility.legalName,
      ticker:           eligibility.legalName !== 'PRIVATE' ? ticker : null,
      cik:              eligibility.cik,
      is_us_listed:     eligibility.isUSListed,
      is_public:        eligibility.isPublicCompany,
      sec_filing_found: eligibility.secFilingFound,
      cached_score:     score,
      cached_band:      band,
      cached_state:     state,
      cached_at:        new Date().toISOString(),
      last_scored_at:   new Date().toISOString(),
    }, { onConflict: 'name' })
    .select('id')
    .single();
  return data?.id || null;
}

async function logUsage(userId: string | null, req: NextRequest, companyName: string) {
  await supabase.from('score_usage').insert({
    user_id: userId,
    session_id: req.cookies.get('es_session')?.value,
    company_name: companyName,
  });
}

function confirmedToLegacy(intel: ComprehensiveIntelligence): ConfirmedEvent[] {
  return intel.confirmed_events.map(e => ({
    description:   e.description,
    date:          e.date || '',
    source:        e.filing_type || e.source_ref,
    rolesAffected: e.roles_affected,
    filingRef:     e.source_ref,
    type:          'official_announcement',
    weightedPoints: 0,
  }));
}

function buildAuditSignals(
  intel: ComprehensiveIntelligence,
  legacyAudit: Signal[],
): Signal[] {
  const out: Signal[] = [];

  for (const e of intel.confirmed_events) {
    out.push({
      type: 'confirmed_event',
      source: `${e.filing_type || 'Filing'} · ${e.source_ref.slice(0, 40)}`,
      sourceTier: 'sec',
      rawPoints: 0, weightedPoints: 0, temporalTag: 'Context',
      alertMessage: e.description + (e.roles_affected ? ` (${e.roles_affected.toLocaleString()} roles)` : ''),
      filingDate: e.date || undefined,
      verified: true,
    });
  }

  for (const s of intel.forward_signals) {
    const tier: Signal['sourceTier'] =
      s.source_ref.includes('reuters') || s.source_ref.includes('bloomberg') ? 'tier_a'
      : s.source_ref.includes('cnbc') || s.source_ref.includes('techcrunch') ? 'tier_b'
      : s.source_ref.includes('motley') || s.source_ref.includes('transcript') ? 'transcript'
      : 'sec';
    out.push({
      type: s.signal_type,
      source: s.source_ref.slice(0, 50),
      sourceTier: tier,
      rawPoints: 0, weightedPoints: 0, temporalTag: s.forward_looking ? 'Predictive' : 'Context',
      alertMessage: s.description,
      escalationType: s.escalation_type,
    });
  }

  if (intel.programme.name) {
    out.push({
      type: 'programme_detected',
      source: intel.programme.source_filings[0] || 'SEC EDGAR',
      sourceTier: 'sec',
      rawPoints: 0, weightedPoints: 0, temporalTag: 'Context',
      alertMessage: `Transformation programme "${intel.programme.name}" detected`,
      verified: true,
    });
  }

  if (intel.bankruptcy.detected && intel.bankruptcy.chapter) {
    out.push({
      type: 'bankruptcy_filing',
      source: intel.bankruptcy.filing_accession || 'SEC EDGAR',
      sourceTier: 'sec',
      rawPoints: 0, weightedPoints: 0, temporalTag: 'Context',
      alertMessage: `Chapter ${intel.bankruptcy.chapter} filing${intel.bankruptcy.filing_date ? ' · ' + intel.bankruptcy.filing_date : ''}`,
      filingDate: intel.bankruptcy.filing_date || undefined,
      verified: true,
    });
  }

  const haveTypes = new Set(out.map(s => s.type));
  for (const s of legacyAudit) {
    if (!haveTypes.has(s.type) && out.length < 12) out.push(s);
  }

  return out;
}

function buildFallbackSummary(intel: ComprehensiveIntelligence, companyName: string): string {
  if (intel.summary && intel.summary.length > 20) return intel.summary;
  if (intel.bankruptcy.detected && intel.bankruptcy.chapter) {
    return `${companyName} has filed for Chapter ${intel.bankruptcy.chapter} — court-supervised process${intel.bankruptcy.filing_date ? ` on ${intel.bankruptcy.filing_date}` : ''}. This reflects confirmed public announcements.`;
  }
  if (intel.confirmed_events.length > 0) {
    const e = intel.confirmed_events[0];
    return `${companyName} has confirmed ${e.description}${e.date ? ` on ${e.date}` : ''}. This reflects confirmed public announcements.`;
  }
  if (intel.state === 'CLEAR') {
    return `No significant layoff risk signals detected for ${companyName} in current SEC filings or Tier A/B media. This is a predictive signal based on public filings — not a confirmed outcome.`;
  }
  return `${companyName} shows ${intel.forward_signals.length} forward-looking signals in current filings and media. This is a predictive signal based on public filings — not a confirmed outcome.`;
}

// v7.2: build signals array from cached intelligence for cache-path responses.
// The v7.1 cache path hardcoded signals:[] — users never saw why a cached
// score was what it was. This reconstructs the display-ready signals from
// the stored intelligence so the UI evidence bundle renders correctly.
function signalsFromCachedIntelligence(intel: ComprehensiveIntelligence | null): Signal[] {
  if (!intel) return [];
  return buildAuditSignals(intel, []);
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN HANDLER
// ─────────────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const { companyName, ticker } = await req.json();
    if (!companyName?.trim()) {
      return NextResponse.json({ error: 'companyName required' }, { status: 400 });
    }

    let userId: string | null = null;
    let isRegistered = false;
    const authHeader = req.headers.get('Authorization');
    if (authHeader?.startsWith('Bearer ')) {
      const { data: { user } } = await supabase.auth.getUser(authHeader.replace('Bearer ', ''));
      if (user) { userId = user.id; isRegistered = true; }
    }

    // Cache check
    const { data: cachedCo } = await supabase
      .from('companies').select('*').ilike('name', companyName.trim()).single();
    const cacheAge = cachedCo?.cached_at
      ? (Date.now() - new Date(cachedCo.cached_at).getTime()) / 3_600_000 : Infinity;
    const cacheTTL = isRegistered ? 24 : 72;

    if (cachedCo && cacheAge < cacheTTL && cachedCo.cached_score !== null) {
      // v7.2: guard against serving a cached parse failure (requires_review +
      // no forward_signals + score=0 combination indicates bad cache).
      const cachedIntel: ComprehensiveIntelligence | null = cachedCo.cached_intelligence || null;
      const isBadCache = cachedIntel?.requires_review &&
        cachedIntel?.validator_notes?.some((n: string) => n.includes('JSON parse failure'));
      if (isBadCache) {
        // Fall through to live pipeline — don't serve the bad result
        console.warn(`[score/route] Bad cached result detected for ${companyName} — forcing re-analysis`);
      } else {
        const scoreHistory = await getScoreHistory(cachedCo.id);
        await logUsage(userId, req, companyName);

        // v7.2: reconstruct signals from cached intelligence so the UI bundle
        // is populated the same way as a live response.
        const cachedSignals = signalsFromCachedIntelligence(cachedIntel);
        const cachedConfirmed = cachedIntel ? confirmedToLegacy(cachedIntel) : [];

        return NextResponse.json({
          risk: {
            score:        cachedCo.cached_score,
            band:         cachedCo.cached_band,
            confidence:   (cachedIntel?.confidence as Confidence) || 'medium',
            companyState: normaliseLegacyState(cachedCo.cached_state),
            signals:      cachedSignals,       // v7.2: was []
            confirmedEvents: cachedConfirmed,  // v7.2: was []
            scoreHistory,
            programme:    cachedCo.cached_programme || null,
            headcount:    cachedCo.cached_headcount || null,
            function_risk: cachedCo.cached_function_risk || null,
            bankruptcy:   cachedCo.cached_bankruptcy || null,
            large_employer_flag: cachedCo.cached_large_employer_flag || false,
            intelligence: cachedIntel,
            disclaimer: {
              productScope: 'US-listed public companies + FPIs. Cached response.',
              signalNature: 'Predictive signal — not confirmed outcome.',
              dataSource:   'SEC EDGAR + Claude Sonnet + Tier A/B media.',
              lastUpdated:  cachedCo.cached_at,
              companyEligibility: {
                isUSListed: cachedCo.is_us_listed,
                isPublicCompany: cachedCo.is_public,
                secFilingFound: cachedCo.sec_filing_found,
              },
            },
            pipelineVersion: cachedCo.cached_pipeline_version || 'v7',
          } as RiskScore,
          company: { name: cachedCo.legal_name || companyName, ticker: cachedCo.ticker, cik: cachedCo.cik },
          signalsGated: false,
          fromCache: true,
        });
      }
    }

    const eligibility = await validateCompany(companyName, ticker);

    if (eligibility.ineligibilityReason?.includes('market index')) {
      return NextResponse.json({
        risk: {
          score: 0, band: 'LOW' as const, confidence: 'high' as const,
          companyState: 'CLEAR' as CompanyState,
          signals: [], confirmedEvents: [], scoreHistory: [],
          claudeSummary: eligibility.ineligibilityReason,
          disclaimer: {
            productScope: eligibility.ineligibilityReason,
            signalNature: eligibility.ineligibilityReason,
            dataSource: '',
            lastUpdated: new Date().toISOString(),
            companyEligibility: eligibility,
          },
          pipelineVersion: 'v7' as const,
        } as RiskScore,
        company: { name: companyName, ticker },
        signalsGated: false,
      });
    }

    if (!eligibility.secFilingFound) {
      return NextResponse.json({
        risk: {
          score: 0, band: 'LOW' as const, confidence: 'low' as const,
          companyState: 'CLEAR' as CompanyState,
          signals: [], confirmedEvents: [], scoreHistory: [],
          claudeSummary: eligibility.ineligibilityReason || `SEC filings not available for ${companyName}.`,
          disclaimer: {
            productScope: eligibility.ineligibilityReason || 'Private or non-US listed',
            signalNature: 'News-only evaluation — no SEC signals available.',
            dataSource:   'Google News RSS (private company mode).',
            lastUpdated:  new Date().toISOString(),
            companyEligibility: eligibility,
          },
          pipelineVersion: 'v7' as const,
        } as RiskScore,
        company: { name: eligibility.legalName || companyName, ticker },
        signalsGated: false,
      });
    }

    if (useV2()) {
      return await runV7Pipeline(req, companyName, ticker, eligibility, userId, isRegistered);
    }

    return await runV5Pipeline(req, companyName, ticker, eligibility, userId, isRegistered);

  } catch (err: any) {
    console.error('[score/route]', err);
    return NextResponse.json({ error: 'Internal server error', details: err?.message }, { status: 500 });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// V7 PIPELINE
// ─────────────────────────────────────────────────────────────────────────────

async function runV7Pipeline(
  req: NextRequest,
  companyName: string,
  ticker: string | undefined,
  eligibility: any,
  userId: string | null,
  isRegistered: boolean,
) {
  const [bundlePart, transcripts, news, quarterlyStatus] = await Promise.all([
    fetchEvidenceBundle(eligibility.cik!, companyName, 365),
    fetchRecentTranscripts(ticker || null, 2),
    fetchRecentNews(companyName, 30),
    import('@/lib/signals/quarterly-calendar').then(m => m.getQuarterlySignalStatus(eligibility.cik!))
      .catch(() => null),
  ]);

  // v7.2: pass pre-fetched facts + submissions to avoid second EDGAR round-trip
  const legacyAudit = await fetchLegacyAuditSignals(
    eligibility.cik!,
    bundlePart._rawFacts,
    bundlePart._rawSubmissions,
  );

  const bundle: EvidenceBundle = {
    company:          eligibility.legalName || companyName,
    ticker:           ticker || null,
    cik:              eligibility.cik || null,
    companyFacts:     bundlePart.companyFacts,
    filings:          bundlePart.filings,
    transcripts,
    news,
    headcountHistory: bundlePart.headcountHistory,
    generatedAt:      new Date().toISOString(),
  };

  // v7.2: separate awaited vs overdue — overdue is a stress indicator,
  // not a confidence reducer. ACTIVE companies skip the penalty regardless.
  const filingStatus = quarterlyStatus?.filingStatus;
  const signalAwaited = filingStatus === 'awaited';
  const signalOverdue = filingStatus === 'overdue';

  let intel: ComprehensiveIntelligence;
  try {
    intel = await comprehensiveAnalysis(bundle);
  } catch (err: any) {
    if (err?.message === 'NLP_PARSE_FAILURE') {
      // v7.2: do NOT cache a parse failure. Return 503 so the client can retry.
      // The old behaviour persisted CLEAR/0 and cached it for up to 72 hours.
      console.error(`[score/route] NLP_PARSE_FAILURE for ${companyName} — returning 503, skipping cache`);
      return NextResponse.json(
        {
          error: 'Analysis temporarily unavailable — NLP parse error. Please retry.',
          retryable: true,
          company: { name: eligibility.legalName || companyName, ticker, cik: eligibility.cik },
        },
        { status: 503 },
      );
    }
    throw err;
  }

  // v7.2: pass signalOverdue separately; ACTIVE companies skip penalty in engine
  const finalised = validateAndFinaliseScore(
    intel,
    signalAwaited,
    eligibility.isUSListed && eligibility.secFilingFound,
    signalOverdue,
  );

  const auditSignals = buildAuditSignals(intel, legacyAudit);
  const confirmedLegacy = confirmedToLegacy(intel);

  const companyId = await upsertCompany(
    eligibility, companyName, ticker,
    finalised.score, finalised.band, finalised.state,
  );
  const scoreHistory = companyId ? await getScoreHistory(companyId) : [];

  if (companyId) {
    const topSignal = intel.confirmed_events[0]?.description || intel.forward_signals[0]?.description || null;
    await supabase.from('score_history').insert({
      company_id:       companyId,
      score:            finalised.score,
      band:             finalised.band,
      company_state:    finalised.state,
      quarter_label:    quarterlyStatus?.currentQuarterLabel || null,
      key_signal:       topSignal?.slice(0, 80) || null,
      signals:          auditSignals.slice(0, 5),
      disclaimer:       { signalNature: 'Predictive', signalAwaited, signalOverdue },
      quarterly_status: quarterlyStatus || null,
      chain_of_thought: intel.reasoning_chain,
      programme_name:          intel.programme.name,
      programme_total_size:    intel.programme.total_size_usd,
      programme_recognised:    intel.programme.recognised_to_date_usd,
      headcount_estimate_low:  intel.headcount.low,
      headcount_estimate_mid:  intel.headcount.mid,
      headcount_estimate_high: intel.headcount.high,
      at_risk_functions:       intel.function_risk.at_risk.map(f => f.function),
      protected_functions:     intel.function_risk.protected.map(f => f.function),
      bankruptcy_detected:     intel.bankruptcy.detected,
      bankruptcy_chapter:      intel.bankruptcy.chapter,
      bankruptcy_filing_date:  intel.bankruptcy.filing_date,
      large_employer_flag:     intel.large_employer_flag,
      waves_confirmed:         intel.waves.waves_confirmed,
      trajectory:              intel.trajectory,
      requires_review:         intel.requires_review,
      pipeline_version:        'v7.2',
      scored_at:               new Date().toISOString(),
    });

    await supabase.from('companies').update({
      cached_programme:           intel.programme,
      cached_headcount:           intel.headcount,
      cached_function_risk:       intel.function_risk,
      cached_bankruptcy:          intel.bankruptcy,
      cached_large_employer_flag: intel.large_employer_flag,
      cached_intelligence:        intel,
      cached_pipeline_version:    'v7.2',
    }).eq('id', companyId);
  }

  if (finalised.score >= 70 && eligibility.secFilingFound) {
    await supabase.from('predictions').insert({
      company_name: companyName, ticker,
      score_at_prediction: finalised.score,
    }).then(() => {});
  }

  await logUsage(userId, req, companyName);
  await supabase.from('analytics_events').insert({
    user_id: userId,
    session_id: req.cookies.get('es_session')?.value,
    event_type: 'company_searched',
    payload: {
      companyName, score: finalised.score, band: finalised.band,
      state: finalised.state, isRegistered,
      programmeName: intel.programme.name,
      bankruptcyDetected: intel.bankruptcy.detected,
      pipelineVersion: 'v7.2',
      requiresReview: intel.requires_review,
      signalAwaited,
      signalOverdue,
    },
  });

  const summary = buildFallbackSummary(intel, eligibility.legalName || companyName);

  return NextResponse.json({
    risk: {
      score:           finalised.score,
      band:            finalised.band,
      confidence:      finalised.confidence,
      companyState:    finalised.state,
      stateFloor:      finalised.floor,
      stateCeiling:    finalised.ceiling,
      signals:         auditSignals,
      confirmedEvents: confirmedLegacy,
      confirmedEvent:  confirmedLegacy[0] || null,
      claudeSummary:   summary,
      scoreHistory,
      programme:       intel.programme,
      headcount:       intel.headcount,
      function_risk:   intel.function_risk,
      bankruptcy:      intel.bankruptcy,
      large_employer_flag: intel.large_employer_flag,
      intelligence:    intel,
      quarterlyStatus: quarterlyStatus || undefined,
      requiresReview:  intel.requires_review,
      disclaimer: {
        productScope: 'US-listed public companies + FPIs (20-F/6-K). SEC EDGAR + Sonnet comprehensive analysis + Tier A/B media + earnings transcripts.',
        signalNature: intel.confirmed_events.length > 0
          ? 'Based on confirmed public announcements alongside predictive signals.'
          : 'Predictive signals — not confirmed outcomes. Does not guarantee layoffs will or will not occur.',
        dataSource:   'SEC EDGAR + Claude Sonnet + Motley Fool earnings transcripts + Tier A/B media. Reddit, Blind, social media explicitly excluded.',
        lastUpdated:  new Date().toISOString(),
        companyEligibility: eligibility,
      },
      pipelineVersion: 'v7' as const,
    } as RiskScore,
    company: { name: eligibility.legalName || companyName, ticker, cik: eligibility.cik },
    signalsGated: false,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// V5 FALLBACK PIPELINE (flag off) — preserved for instant rollback
// ─────────────────────────────────────────────────────────────────────────────

async function runV5Pipeline(
  req: NextRequest,
  companyName: string,
  ticker: string | undefined,
  eligibility: any,
  userId: string | null,
  isRegistered: boolean,
) {
  const [auditSignals, mediaSignals, headlines, quarterlyStatus] = await Promise.all([
    collectSECSignals(eligibility.cik!, companyName, isRegistered),
    collectMediaSignals(companyName),
    fetchRecentHeadlines(companyName),
    import('@/lib/signals/quarterly-calendar').then(m => m.getQuarterlySignalStatus(eligibility.cik!))
      .catch(() => null),
  ]);

  const filingText = '';
  const stateResult = await classifyCompanyState(companyName, filingText, headlines);
  const v7State = normaliseLegacyState(stateResult.state);

  const signalAwaited = quarterlyStatus?.filingStatus === 'awaited';
  const { floor, ceiling } = getStateBounds(v7State);
  const score = signalAwaited ? Math.round(floor * 0.85) : floor;
  const band = getBand(score);

  const allSignals = [...auditSignals, ...mediaSignals];

  await logUsage(userId, req, companyName);
  await supabase.from('analytics_events').insert({
    user_id: userId,
    session_id: req.cookies.get('es_session')?.value,
    event_type: 'company_searched',
    payload: { companyName, score, band, state: v7State, pipelineVersion: 'v5_fallback' },
  });

  return NextResponse.json({
    risk: {
      score, band,
      confidence: getConfidence(true, signalAwaited, score),
      companyState: v7State,
      stateFloor: floor, stateCeiling: ceiling,
      signals: allSignals,
      confirmedEvents: stateResult.confirmedEvent ? [stateResult.confirmedEvent] : [],
      confirmedEvent: stateResult.confirmedEvent,
      claudeSummary: `${companyName}: ${stateResult.reasoning}`.slice(0, 300),
      quarterlyStatus: quarterlyStatus || undefined,
      disclaimer: {
        productScope: 'US-listed public companies + FPIs (v5 fallback mode).',
        signalNature: 'Predictive signal — not confirmed outcome.',
        dataSource: 'SEC EDGAR + Tier A/B media (v5 fallback).',
        lastUpdated: new Date().toISOString(),
        companyEligibility: eligibility,
      },
      pipelineVersion: 'v5' as const,
    } as RiskScore,
    company: { name: eligibility.legalName || companyName, ticker, cik: eligibility.cik },
    signalsGated: false,
  });
}
