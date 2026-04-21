// app/api/score/route.ts — EjectSeat Consumer v6.1 INTEGRATED
//
// v5 deployed pipeline preserved in full:
//   auth → cache check → validateCompany → state classification →
//   SEC + earnings + media + quarterly in parallel → cross-signal corroboration →
//   computeScore → generateSummary → persist → respond
//
// v6.1 additions:
//   + comprehensiveFilingAnalysis runs in parallel (one extra Sonnet call)
//   + bankruptcy detection forces state=ACTIVE with floor (Ch 7/11/15)
//   + programme phase applies multiplier to final score
//   + programme / headcount / function_risk / bankruptcy returned in risk{} object
//   + new fields persisted to score_history + companies (via migration)

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { validateCompany } from '@/lib/signals/company-validator';
import {
  computeScore, getBand, getConfidence, getStateBounds,
  crossSignalCorroboration, getBankruptcyOverride,
} from '@/lib/scoring/engine';
import {
  classifyCompanyState,
  prefilterFilingText,
  generateSummary,
  comprehensiveFilingAnalysis,
  type StateClassification,
  type CompanyState,
} from '@/lib/signals/nlp-analyzer';
import { fetchFullFilingsForAnalysis } from '@/lib/signals/sec';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

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
  eligibility: any,
  companyName: string,
  ticker:      string | undefined,
  score:       number,
  band:        string,
  state:       string,
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

// Fetch recent 8-K text for state classification (same as v5 — kept for Haiku pipeline)
async function getRecentFilingText(cik: string): Promise<string> {
  try {
    const paddedCik = cik.replace(/^0+/,'').padStart(10,'0');
    const sub = await fetch(`https://data.sec.gov/submissions/CIK${paddedCik}.json`, {
      headers: { 'User-Agent': 'EjectSeat/1.0 (enquiries.talkace@gmail.com)' }
    });
    if (!sub.ok) return '';
    const data  = await sub.json();
    const recent = data.filings?.recent;
    if (!recent) return '';

    const forms = recent.form            || [];
    const dates = recent.filingDate      || [];
    const accs  = recent.accessionNumber || [];
    const docs  = recent.primaryDocument || [];

    // v6.1: include 6-K for FPIs
    const eightKs = forms
      .map((f: string, i: number) => ({ form: f, date: dates[i], acc: accs[i], doc: docs[i] }))
      .filter((f: any) => (f.form === '8-K' || f.form === '6-K') && f.acc && f.doc)
      .slice(0, 3);

    let combinedText = '';
    const cikNum = parseInt(cik.replace(/^0+/,''), 10);

    for (const filing of eightKs) {
      const accClean = filing.acc.replace(/-/g,'');
      const url      = `https://data.sec.gov/Archives/edgar/data/${cikNum}/${accClean}/${filing.doc}`;
      try {
        const res = await fetch(url, { headers: { 'User-Agent': 'EjectSeat/1.0 (enquiries.talkace@gmail.com)' }});
        if (res.ok) {
          const text = (await res.text()).slice(0, 20000);
          combinedText += `\n\n--- ${filing.form} filed ${filing.date} ---\n${text}`;
        }
      } catch { continue; }
    }

    return combinedText;
  } catch { return ''; }
}

export async function POST(req: NextRequest) {
  try {
    const { companyName, ticker } = await req.json();
    if (!companyName?.trim()) {
      return NextResponse.json({ error: 'companyName required' }, { status: 400 });
    }

    // ── Auth ────────────────────────────────────────────────────────────
    let userId: string | null = null;
    let isRegistered = false;
    const authHeader = req.headers.get('Authorization');
    if (authHeader?.startsWith('Bearer ')) {
      const { data: { user } } = await supabase.auth.getUser(authHeader.replace('Bearer ',''));
      if (user) { userId = user.id; isRegistered = true; }
    }

    // ── Cache check ──────────────────────────────────────────────────────
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
          score:         cachedCo.cached_score,
          band:          cachedCo.cached_band,
          companyState:  cachedCo.cached_state || 'CLEAR',
          fromCache:     true,
          signals:       [],
          confirmedEvents: [],
          scoreHistory,
          programme:     cachedCo.cached_programme || null,
          headcount:     cachedCo.cached_headcount || null,
          function_risk: cachedCo.cached_function_risk || null,
          bankruptcy:    cachedCo.cached_bankruptcy || null,
          large_employer_flag: cachedCo.cached_large_employer_flag || false,
          disclaimer: {
            signalNature: 'Predictive signal — not confirmed outcome.',
            companyEligibility: {
              isUSListed:      cachedCo.is_us_listed,
              isPublicCompany: cachedCo.is_public,
            },
          },
        },
        company: { name: cachedCo.legal_name || companyName, ticker: cachedCo.ticker, cik: cachedCo.cik },
      });
    }

    // ── Company validation ───────────────────────────────────────────────
    const eligibility = await validateCompany(companyName, ticker);

    // Early return for indexes
    if (eligibility.ineligibilityReason?.includes('market index')) {
      return NextResponse.json({
        risk: {
          score: 0, band: 'LOW', companyState: 'CLEAR',
          signals: [], confirmedEvents: [], scoreHistory: [],
          claudeSummary: eligibility.ineligibilityReason,
          disclaimer: { signalNature: eligibility.ineligibilityReason, companyEligibility: eligibility },
        },
        company: { name: companyName, ticker },
        signalsGated: false,
      });
    }

    // ── Step 1: Get filing text + headlines + full-filings bundle in parallel
    const [filingRawText, mediaModule, filingsBundle] = await Promise.all([
      eligibility.secFilingFound && eligibility.cik
        ? getRecentFilingText(eligibility.cik)
        : Promise.resolve(''),
      import('@/lib/signals/news').then(m => m),
      eligibility.secFilingFound && eligibility.cik
        ? fetchFullFilingsForAnalysis(eligibility.cik)
        : Promise.resolve(null),
    ]);

    const filteredFilingText = filingRawText
      ? await prefilterFilingText(filingRawText, companyName)
      : '';

    const recentHeadlines = await mediaModule.fetchRecentHeadlines(companyName);

    // ── Step 2: Run state classification AND comprehensive analysis in parallel
    const [stateResult, intelligence] = await Promise.all([
      classifyCompanyState(companyName, filteredFilingText, recentHeadlines),
      filingsBundle
        ? comprehensiveFilingAnalysis(filingsBundle, companyName)
        : Promise.resolve(null),
    ]);

    // ── Step 3: Bankruptcy override — forces ACTIVE state ───────────────
    let effectiveState: CompanyState = stateResult.state;
    let bankruptcyOverrideReason: string | null = null;
    if (intelligence?.bankruptcy?.detected) {
      const bk = getBankruptcyOverride(intelligence.bankruptcy);
      if (bk) {
        effectiveState = bk.state;
        bankruptcyOverrideReason = bk.reason;
      }
    }

    // ── Step 4: ACTIVE_MULTI_YEAR promotion for named multi-year programme
    if (!intelligence?.bankruptcy?.detected
        && intelligence?.programme?.name
        && intelligence.programme.timeline === 'multi_year'
        && (intelligence.programme.phase === 'mid' || intelligence.programme.phase === 'late')
        && effectiveState === 'ACTIVE') {
      effectiveState = 'ACTIVE_MULTI_YEAR';
    }

    const { floor, ceiling } = getStateBounds(effectiveState);

    // ── Step 5: Run signal pipeline (v5 preserved in full) ──────────────
    const [secSignals, earningsSignals, mediaSignals, quarterlyStatus] = await Promise.all([
      eligibility.secFilingFound
        ? import('@/lib/signals/sec').then(m => m.collectSECSignals(eligibility.cik!, companyName, isRegistered))
        : Promise.resolve([]),
      eligibility.secFilingFound
        ? import('@/lib/signals/earnings').then(m => m.analyzeEarnings(companyName, eligibility.cik!))
        : Promise.resolve([]),
      mediaModule.collectMediaSignals(companyName, effectiveState),
      eligibility.secFilingFound
        ? import('@/lib/signals/quarterly-calendar').then(m => m.getQuarterlySignalStatus(eligibility.cik!))
        : Promise.resolve(null),
    ]);

    const allSignals    = [...secSignals, ...earningsSignals, ...mediaSignals];
    const signalAwaited = quarterlyStatus?.filingStatus === 'awaited'
                       || quarterlyStatus?.filingStatus === 'overdue';

    // ── Step 6: Cross-signal corroboration + phase-aware score ──────────
    const hasVerifiedXBRL = secSignals.some((s: any) => s.verified && s.type.startsWith('restructuring'));
    const hasConfirmed8K  = secSignals.some((s: any) => s.type.startsWith('8k_nlp'));
    const tierABCount     = mediaSignals.filter((s: any) =>
      s.sourceTier === 'tier_a' || s.sourceTier === 'tier_b'
    ).length;

    const corroboration = crossSignalCorroboration(hasVerifiedXBRL, hasConfirmed8K, tierABCount);
    const rawTotal      = allSignals.reduce((sum: number, s: any) => sum + (s.weightedPoints || 0), 0);

    // v6.1: computeScore now accepts phase + bankruptcy
    const score = computeScore(
      rawTotal,
      effectiveState,
      signalAwaited,
      corroboration,
      intelligence?.programme?.phase,
      intelligence?.bankruptcy,
    );
    const band       = getBand(score);
    const confidence = getConfidence(
      eligibility.isUSListed && eligibility.secFilingFound,
      signalAwaited,
      score,
    );

    // ── Step 7: Generate summary (v6.1: passes intelligence) ────────────
    const companyId    = await upsertCompany(eligibility, companyName, ticker, score, band, effectiveState);
    const scoreHistory = companyId ? await getScoreHistory(companyId) : [];

    const { summary: claudeSummary, chainOfThought } = await generateSummary(
      companyName,
      allSignals,
      score,
      band,
      { ...stateResult, state: effectiveState },
      scoreHistory,
      quarterlyStatus || null,
      intelligence,
    );

    // ── Step 8: Persist score_history with v6.1 fields ──────────────────
    if (companyId) {
      const topSignal = allSignals.length > 0
        ? [...allSignals].sort((a: any, b: any) => b.weightedPoints - a.weightedPoints)[0]
        : null;
      const keySignal = topSignal
        ? (topSignal as any).alertMessage?.slice(0,80) || topSignal.type
        : null;

      await supabase.from('score_history').insert({
        company_id:       companyId,
        score,
        band,
        company_state:    effectiveState,
        quarter_label:    quarterlyStatus?.currentQuarterLabel || null,
        key_signal:       keySignal,
        signals:          allSignals.slice(0, 5),
        disclaimer:       { signalNature: 'Predictive', signalAwaited },
        quarterly_status: quarterlyStatus || null,
        chain_of_thought: chainOfThought,
        // v6.1 additions
        programme_name:          intelligence?.programme.name || null,
        programme_total_size:    intelligence?.programme.total_size_usd || null,
        programme_recognised:    intelligence?.programme.recognised_to_date_usd || null,
        headcount_estimate_low:  intelligence?.headcount.low || null,
        headcount_estimate_mid:  intelligence?.headcount.mid || null,
        headcount_estimate_high: intelligence?.headcount.high || null,
        at_risk_functions:       intelligence?.function_risk.at_risk.map(f => f.function) || null,
        protected_functions:     intelligence?.function_risk.protected.map(f => f.function) || null,
        bankruptcy_detected:     intelligence?.bankruptcy.detected || false,
        bankruptcy_chapter:      intelligence?.bankruptcy.chapter || null,
        bankruptcy_filing_date:  intelligence?.bankruptcy.filing_date || null,
        large_employer_flag:     intelligence?.large_employer_flag || false,
        scored_at:        new Date().toISOString(),
      });

      // Also cache intelligence on companies row for cache hits
      await supabase.from('companies').update({
        cached_programme:           intelligence?.programme || null,
        cached_headcount:           intelligence?.headcount || null,
        cached_function_risk:       intelligence?.function_risk || null,
        cached_bankruptcy:          intelligence?.bankruptcy || null,
        cached_large_employer_flag: intelligence?.large_employer_flag || false,
      }).eq('id', companyId);
    }

    // ── Prediction tracking + analytics ─────────────────────────────────
    if (score >= 70 && eligibility.secFilingFound) {
      await supabase.from('predictions').insert({
        company_name: companyName, ticker,
        score_at_prediction: score,
      }).then(() => {});
    }

    await logUsage(userId, req, companyName);
    await supabase.from('analytics_events').insert({
      user_id: userId, session_id: req.cookies.get('es_session')?.value,
      event_type: 'company_searched',
      payload: {
        companyName, score, band,
        state: effectiveState,
        isRegistered,
        programmeName: intelligence?.programme.name || null,
        bankruptcyDetected: intelligence?.bankruptcy.detected || false,
      },
    });

    const returnSignals = allSignals;

    const disclaimer = {
      productScope:  eligibility.isPublicCompany
        ? 'US-listed public companies + FPIs (20-F/6-K). SEC EDGAR + Sonnet/Haiku NLP + Tier A/B media.'
        : eligibility.ineligibilityReason,
      signalNature:  effectiveState === 'ACTIVE' || effectiveState === 'ACTIVE_MULTI_YEAR' || effectiveState === 'CONTINUATION_RISK'
        ? 'Based on confirmed public announcements alongside predictive signals.'
        : 'Predictive signals — not confirmed outcomes. Does not guarantee layoffs will or will not occur.',
      dataSource:    'SEC EDGAR + Claude Sonnet/Haiku NLP + Tier A/B media. Reddit, Blind, social media explicitly excluded.',
      lastUpdated:   new Date().toISOString(),
      companyEligibility: eligibility,
    };

    return NextResponse.json({
      risk: {
        score, band, confidence,
        companyState:    effectiveState,
        stateConfidence: stateResult.confidence,
        confirmedEvent:  stateResult.confirmedEvent,
        stateFloor:      floor,
        stateCeiling:    ceiling,
        stateOverrideReason: bankruptcyOverrideReason,
        signals:         returnSignals,
        confirmedEvents: stateResult.confirmedEvent ? [stateResult.confirmedEvent] : [],
        disclaimer,
        quarterlyStatus: quarterlyStatus || undefined,
        claudeSummary,
        scoreHistory,
        // v6.1 additions
        programme:     intelligence?.programme || null,
        headcount:     intelligence?.headcount || null,
        function_risk: intelligence?.function_risk || null,
        bankruptcy:    intelligence?.bankruptcy || null,
        large_employer_flag: intelligence?.large_employer_flag || false,
      },
      company: {
        name:   eligibility.legalName || companyName,
        ticker,
        cik:    eligibility.cik,
      },
      signalsGated: false,
    });

  } catch (err) {
    console.error('[score/route]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

async function logUsage(userId: string | null, req: NextRequest, companyName: string) {
  await supabase.from('score_usage').insert({
    user_id: userId,
    session_id: req.cookies.get('es_session')?.value,
    company_name: companyName,
  });
}
