// app/api/score/route.ts — EjectSeat Consumer v7
//
// ORCHESTRATOR with feature flag USE_COMPREHENSIVE_V2.
//
// FLAG ON (default=true in env example):
//   1. Validate company
//   2. Fetch evidence bundle in parallel: SEC filings+facts, transcripts, news
//   3. Single comprehensive Sonnet call → intelligence object
//   4. Validate + finalise score (engine applies bands + signal_awaited penalty)
//   5. Persist to Supabase, log chain-of-thought, return unified response
//
// FLAG OFF:
//   Full v5/v6.1 path runs — state classification + multi-signal + corroboration.
//   Existing behaviour preserved for instant rollback.
//
// RESPONSE SHAPE:
//   Preserved at top level so frontend keeps rendering during flag flips.
//   `intelligence` object added as new field; old clients ignore it; new UI
//   lights up the intelligence cards when present.

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
  CompanyState,
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

// Map intelligence confirmed_events to the legacy ConfirmedEvent[] shape for UI
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

// Build audit-strip signals from intelligence + legacy XBRL
function buildAuditSignals(
  intel: ComprehensiveIntelligence,
  legacyAudit: Signal[],
): Signal[] {
  const out: Signal[] = [];

  // Confirmed events as audit rows
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

  // Forward signals as audit rows
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

  // Programme signal
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

  // Bankruptcy
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

  // Dedup against legacy audit (which surfaces XBRL line items not caught above)
  const haveTypes = new Set(out.map(s => s.type));
  for (const s of legacyAudit) {
    if (!haveTypes.has(s.type) && out.length < 12) out.push(s);
  }

  return out;
}

// Build plain-language summary from intelligence (Sonnet writes it already;
// this is a fallback constructor if Sonnet returned an empty summary)
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

// ─────────────────────────────────────────────────────────────────────────────
// MAIN HANDLER
// ─────────────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const { companyName, ticker } = await req.json();
    if (!companyName?.trim()) {
      return NextResponse.json({ error: 'companyName required' }, { status: 400 });
    }

    // Auth
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
    const cacheTTL = isRegistered ? 6 : 24;

    if (cachedCo && cacheAge < cacheTTL && cachedCo.cached_score !== null) {
      const scoreHistory = await getScoreHistory(cachedCo.id);
      await logUsage(userId, req, companyName);
      return NextResponse.json({
        risk: {
          score:        cachedCo.cached_score,
          band:         cachedCo.cached_band,
          companyState: normaliseLegacyState(cachedCo.cached_state),
          signals:      [],
          confirmedEvents: [],
          scoreHistory,
          programme:    cachedCo.cached_programme || null,
          headcount:    cachedCo.cached_headcount || null,
          function_risk: cachedCo.cached_function_risk || null,
          bankruptcy:   cachedCo.cached_bankruptcy || null,
          large_employer_flag: cachedCo.cached_large_employer_flag || false,
          intelligence: cachedCo.cached_intelligence || null,
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

    // Validate company
    const eligibility = await validateCompany(companyName, ticker);

    // Early return for indexes
    if (eligibility.ineligibilityReason?.includes('market index')) {
      return NextResponse.json({
        risk: {
          score: 0, band: 'LOW' as const, companyState: 'CLEAR' as CompanyState,
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

    // Handle private / unknown companies — news-only path
    if (!eligibility.secFilingFound) {
      return NextResponse.json({
        risk: {
          score: 0, band: 'LOW' as const, companyState: 'CLEAR' as CompanyState,
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

    // ─── v7 PIPELINE (flag on) ─────────────────────────────────────────────
    if (useV2()) {
      return await runV7Pipeline(req, companyName, ticker, eligibility, userId, isRegistered);
    }

    // ─── v5 FALLBACK (flag off) ────────────────────────────────────────────
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
  // Step 1: Fetch everything needed for the bundle in parallel
  const [bundlePart, transcripts, news, legacyAudit, quarterlyStatus] = await Promise.all([
    fetchEvidenceBundle(eligibility.cik!, companyName, 365),
    fetchRecentTranscripts(ticker || null, 2),
    fetchRecentNews(companyName, 30),
    fetchLegacyAuditSignals(eligibility.cik!),
    import('@/lib/signals/quarterly-calendar').then(m => m.getQuarterlySignalStatus(eligibility.cik!))
      .catch(() => null),
  ]);

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

  // Step 2: Comprehensive Sonnet call
  const intel = await comprehensiveAnalysis(bundle);

  // Step 3: Validate + finalise score
  const signalAwaited = quarterlyStatus?.filingStatus === 'awaited' || quarterlyStatus?.filingStatus === 'overdue';
  const finalised = validateAndFinaliseScore(
    intel,
    signalAwaited,
    eligibility.isUSListed && eligibility.secFilingFound,
  );

  // Step 4: Build audit-strip signals for UI
  const auditSignals = buildAuditSignals(intel, legacyAudit);
  const confirmedLegacy = confirmedToLegacy(intel);

  // Step 5: Persist
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
      disclaimer:       { signalNature: 'Predictive', signalAwaited },
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
      pipeline_version:        'v7',
      scored_at:               new Date().toISOString(),
    });

    await supabase.from('companies').update({
      cached_programme:           intel.programme,
      cached_headcount:           intel.headcount,
      cached_function_risk:       intel.function_risk,
      cached_bankruptcy:          intel.bankruptcy,
      cached_large_employer_flag: intel.large_employer_flag,
      cached_intelligence:        intel,
      cached_pipeline_version:    'v7',
    }).eq('id', companyId);
  }

  // Prediction tracking
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
      pipelineVersion: 'v7',
      requiresReview: intel.requires_review,
    },
  });

  const summary = buildFallbackSummary(intel, eligibility.legalName || companyName);

  const response: { risk: RiskScore; company: any; signalsGated: boolean } = {
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
      pipelineVersion: 'v7',
    },
    company: {
      name:   eligibility.legalName || companyName,
      ticker,
      cik:    eligibility.cik,
    },
    signalsGated: false,
  };

  return NextResponse.json(response);
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
  // This is a compact v5 path using our audit-only signal modules. It WILL
  // produce lower fidelity than v7 — the purpose is to stay functional when
  // the flag is off, not to perfectly replicate v5 behaviour.

  const [auditSignals, mediaSignals, headlines, quarterlyStatus] = await Promise.all([
    collectSECSignals(eligibility.cik!, companyName, isRegistered),
    collectMediaSignals(companyName),
    fetchRecentHeadlines(companyName),
    import('@/lib/signals/quarterly-calendar').then(m => m.getQuarterlySignalStatus(eligibility.cik!))
      .catch(() => null),
  ]);

  // Use Sonnet state classification (legacy path)
  const filingText = '';
  const stateResult = await classifyCompanyState(companyName, filingText, headlines);
  const v7State = normaliseLegacyState(stateResult.state);

  const signalAwaited = quarterlyStatus?.filingStatus === 'awaited' || quarterlyStatus?.filingStatus === 'overdue';
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
