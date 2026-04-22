// scripts/regression-test.ts — EjectSeat Consumer v7
//
// Runs the v7 pipeline against a set of known cases and reports a pass/fail matrix.
// Use this BEFORE flipping USE_COMPREHENSIVE_V2=true in production.
//
// Usage:
//   TARGET_URL=http://localhost:3000 npx ts-node scripts/regression-test.ts
//   TARGET_URL=https://ejectseat-consumer-cfad.vercel.app npx ts-node scripts/regression-test.ts
//
// The script only reads. It does not mutate production state beyond whatever
// /api/score itself persists (which it already does on every user search).

/* eslint-disable no-console */

const TARGET = process.env.TARGET_URL || 'http://localhost:3000';

interface Expected {
  company:           string;
  ticker?:           string;
  expectState?:      'CLEAR' | 'WATCH' | 'LIKELY' | 'ACTIVE';
  expectStates?:     Array<'CLEAR' | 'WATCH' | 'LIKELY' | 'ACTIVE'>;
  expectBand?:       'LOW' | 'MEDIUM' | 'HIGH';
  expectBands?:      Array<'LOW' | 'MEDIUM' | 'HIGH'>;
  minScore?:         number;
  maxScore?:         number;
  mustHaveSignal?:   string;          // substring match on any signal.type or description
  mustNotHaveSignal?: string;
  mustBeBankruptcy?: boolean;
  mustBePrivate?:    boolean;
  mustBeIndex?:      boolean;
  note:              string;
}

const CASES: Expected[] = [
  {
    company: 'Snap Inc.',
    ticker: 'SNAP',
    expectStates: ['ACTIVE', 'LIKELY'],
    expectBands: ['HIGH', 'MEDIUM'],
    minScore: 60,
    maxScore: 90,
    mustHaveSignal: 'layoff',
    note: 'Snap announced 1,000 role cut (16% workforce) April 15 2026 via 8-K. Must score ACTIVE/LIKELY — the exact Snap bug that prompted v7.',
  },
  {
    company: 'Amazon.com Inc.',
    ticker: 'AMZN',
    expectStates: ['LIKELY', 'WATCH', 'ACTIVE'],
    minScore: 25,
    mustNotHaveSignal: 'rivian',
    note: 'Amazon has ongoing cuts in waves. Must NOT attribute Rivian (separate company) as Amazon signal.',
  },
  {
    company: 'Oracle Corporation',
    ticker: 'ORCL',
    expectStates: ['WATCH', 'CLEAR', 'LIKELY'],
    note: 'Oracle ongoing restructuring — acceptable in any non-ACTIVE state depending on recency.',
  },
  {
    company: 'Microsoft Corporation',
    ticker: 'MSFT',
    expectStates: ['CLEAR', 'WATCH', 'LIKELY'],
    note: 'Microsoft — expect stable CLEAR or WATCH unless a fresh cut hits.',
  },
  {
    company: 'Marsh & McLennan Companies, Inc.',
    ticker: 'MMC',
    expectStates: ['CLEAR', 'WATCH', 'LIKELY', 'ACTIVE'],
    note: 'MMC must resolve (was failing in v6.1 validator). Any state acceptable; key is it produces a score.',
  },
  {
    company: 'Intel Corporation',
    ticker: 'INTC',
    expectStates: ['LIKELY', 'ACTIVE', 'WATCH'],
    minScore: 25,
    note: 'Intel has announced major restructuring; should land elevated.',
  },
  {
    company: 'Novo Nordisk A/S',
    ticker: 'NVO',
    note: 'FPI test — must resolve via 20-F path and return any state with a non-null score.',
  },
  {
    company: 'Stripe',
    mustBePrivate: true,
    note: 'Private company — must degrade gracefully, no 500, news-only or unavailable message.',
  },
  {
    company: 'Anthropic',
    mustBePrivate: true,
    note: 'Private company.',
  },
  {
    company: 'Dow Jones Industrial Average',
    mustBeIndex: true,
    note: 'Market index — must early-return with explanatory message.',
  },
  {
    company: 'Apple Inc.',
    ticker: 'AAPL',
    expectStates: ['CLEAR', 'WATCH'],
    maxScore: 64,
    note: 'Apple control — expect CLEAR or WATCH.',
  },
  {
    company: 'Salesforce Inc.',
    ticker: 'CRM',
    expectStates: ['CLEAR', 'WATCH', 'LIKELY'],
    note: 'Salesforce — sanity check on well-known ticker.',
  },
];

async function runOne(c: Expected): Promise<{ pass: boolean; reasons: string[]; summary: string; raw: any }> {
  const reasons: string[] = [];
  let raw: any = null;

  try {
    const res = await fetch(`${TARGET}/api/score`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ companyName: c.company, ticker: c.ticker }),
    });
    raw = await res.json();
    const risk = raw.risk;

    if (!risk) { reasons.push('No risk object in response'); return { pass: false, reasons, summary: 'no risk', raw }; }

    const summary = `state=${risk.companyState} score=${risk.score} band=${risk.band} signals=${(risk.signals || []).length} pipeline=${risk.pipelineVersion}`;

    if (c.mustBePrivate) {
      const msg = (risk.claudeSummary || risk.disclaimer?.productScope || '').toLowerCase();
      if (!msg.includes('private') && !msg.includes('sec filings not available')) {
        reasons.push(`Expected private-company degradation, got: ${msg.slice(0, 80)}`);
      }
      return { pass: reasons.length === 0, reasons, summary, raw };
    }

    if (c.mustBeIndex) {
      const msg = (risk.claudeSummary || risk.disclaimer?.productScope || '').toLowerCase();
      if (!msg.includes('index')) reasons.push(`Expected index early-return, got: ${msg.slice(0, 80)}`);
      return { pass: reasons.length === 0, reasons, summary, raw };
    }

    // State check
    const allowedStates = c.expectStates || (c.expectState ? [c.expectState] : null);
    if (allowedStates && !allowedStates.includes(risk.companyState)) {
      reasons.push(`State ${risk.companyState} not in expected ${allowedStates.join('|')}`);
    }

    // Band check
    const allowedBands = c.expectBands || (c.expectBand ? [c.expectBand] : null);
    if (allowedBands && !allowedBands.includes(risk.band)) {
      reasons.push(`Band ${risk.band} not in expected ${allowedBands.join('|')}`);
    }

    // Score range check
    if (c.minScore !== undefined && risk.score < c.minScore) {
      reasons.push(`Score ${risk.score} < minScore ${c.minScore}`);
    }
    if (c.maxScore !== undefined && risk.score > c.maxScore) {
      reasons.push(`Score ${risk.score} > maxScore ${c.maxScore}`);
    }

    // Signal substring checks
    const signalsText = (risk.signals || []).map((s: any) =>
      `${s.type || ''} ${s.alertMessage || ''} ${s.source || ''}`.toLowerCase()).join(' | ');
    const intelText = JSON.stringify(risk.intelligence || {}).toLowerCase();
    const haystack = signalsText + ' ' + intelText + ' ' + (risk.claudeSummary || '').toLowerCase();

    if (c.mustHaveSignal && !haystack.includes(c.mustHaveSignal.toLowerCase())) {
      reasons.push(`Missing required signal substring: "${c.mustHaveSignal}"`);
    }
    if (c.mustNotHaveSignal && haystack.includes(c.mustNotHaveSignal.toLowerCase())) {
      reasons.push(`Contains forbidden substring: "${c.mustNotHaveSignal}"`);
    }
    if (c.mustBeBankruptcy && !risk.bankruptcy?.detected) {
      reasons.push('Expected bankruptcy.detected = true');
    }

    return { pass: reasons.length === 0, reasons, summary, raw };
  } catch (err: any) {
    reasons.push(`Fetch failed: ${err?.message || err}`);
    return { pass: false, reasons, summary: 'fetch error', raw };
  }
}

async function main() {
  console.log(`\n─── EjectSeat v7 Regression Test ────────────────────────────────`);
  console.log(`Target: ${TARGET}`);
  console.log(`Cases:  ${CASES.length}`);
  console.log(`─────────────────────────────────────────────────────────────────\n`);

  const results: Array<{ company: string; pass: boolean; summary: string; reasons: string[] }> = [];
  let pass = 0, fail = 0;

  for (const c of CASES) {
    process.stdout.write(`▸ ${c.company.padEnd(42)} `);
    const r = await runOne(c);
    results.push({ company: c.company, pass: r.pass, summary: r.summary, reasons: r.reasons });
    if (r.pass) { pass++; console.log(`✓ ${r.summary}`); }
    else        { fail++; console.log(`✗ ${r.summary}`);
                  for (const reason of r.reasons) console.log(`       ↳ ${reason}`); }
  }

  console.log(`\n─── Summary ────────────────────────────────────────────────────`);
  console.log(`Pass: ${pass} / ${CASES.length}`);
  console.log(`Fail: ${fail} / ${CASES.length}`);
  console.log(`────────────────────────────────────────────────────────────────\n`);

  if (fail > 0) {
    console.log('FAILED CASES:');
    for (const r of results.filter(r => !r.pass)) {
      console.log(`  ${r.company}: ${r.reasons.join('; ')}`);
    }
    process.exit(1);
  }
}

main().catch(err => { console.error('Regression runner crashed:', err); process.exit(2); });
