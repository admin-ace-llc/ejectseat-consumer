# EjectSeat Consumer — v6.1 (integrated)

This is the **clean integrated build** layering v6.1 intelligence features onto the deployed v5 codebase. Drop-in replacement for `ejectseat-consumer-cfad` on Vercel.

## What's kept from deployed v5

Everything that currently works in production is preserved **verbatim**:

- **Auth**: `/api/auth` — Supabase magic-link (`signInWithOtp`)
- **Analytics**: `/api/beacon`, `analytics_events` table
- **Capture**: `/api/beta`, `beta_signups` table, inline HIGH/MEDIUM email capture
- **Resolve**: `/api/resolve` — NAME_MAP + EDGAR ticker JSON, <500ms
- **LandingZone**: `/api/landingzone` — Adzuna integration, full role/location filters, risk cross-reference
- **UI**: sign-in modal, loading progress bar, recents chips, inline how-it-works page, 4-quarter sparkline, email capture post-result
- **Scoring pipeline**: Haiku prefilter → Sonnet state classification → Haiku XBRL verification → Haiku text analysis → Haiku summary
- **Signal modules**: SEC (XBRL cross-validation, NT detection, headcount drop, sustained losses, goodwill impairment, 8-K NLP), earnings, news (tiered sources, state-aware scoring), quarterly-calendar
- **Schema**: all 12 tables (profiles, score_usage, companies, watchlist, score_history, predictions, hiring_velocity_snapshots, quarterly_signal_status, role_taxonomy, analytics_events, beta_signups, alert_subscriptions)
- **Supabase auth flow**, RLS policies, triggers, indexes

## What v6.1 adds

Layered **alongside** the v5 pipeline, not replacing it:

### 1. Comprehensive intelligence extraction (single Sonnet call, 12K tokens)
New function `comprehensiveFilingAnalysis` in `lib/signals/nlp-analyzer.ts`. Reads **full** filing text + full company-facts XBRL + headcount history. Runs in parallel with the existing state-classification call. Returns:

- **Programme intelligence** — named transformation programmes ("Thrive", "Fit for Growth"), total disclosed size, recognised-to-date, phase (early/mid/late/complete), severance component %
- **Headcount estimate** — severance dollars ÷ avg severance per head, with low/mid/high range and confidence tier
- **Function-level risk** — explicit at-risk vs protected functions, each with confidence tier and evidence quote
- **Bankruptcy detection** — Chapter 7/11/15 filings, debtor-in-possession status, affected subsidiaries
- **Large employer flag** — ≥50K employees

### 2. Smarter filing truncation
`lib/signals/sec.ts` adds `sliceAroundSections` — for long 10-Ks and 20-Fs, targets MD&A + Notes to Consolidated Financial Statements + restructuring/programme anchors instead of chopping the first 60K chars. Also strips HTML before passing to LLM.

### 3. FPI coverage (20-F / 6-K)
- `lib/signals/sec.ts` — accepts `20-F`, `6-K`, and their `/A` amendments; XBRL scan includes `ifrs-full` taxonomy alongside `us-gaap`
- `lib/signals/earnings.ts` — 6-K accepted alongside 8-K
- `lib/signals/quarterly-calendar.ts` — 20-F in relevant forms

### 4. `ACTIVE_MULTI_YEAR` state
New score band `60-90`. Promoted when `intelligence.programme.name` is present, `timeline === 'multi_year'`, and phase is `mid` or `late`. Captures the MMC/Thrive case that previously showed as WATCHING.

### 5. Bankruptcy override
`lib/scoring/engine.ts#getBankruptcyOverride` forces state to `ACTIVE` with chapter-specific floor when bankruptcy detected. Ch 7 = 85, Ch 11 = 75, Ch 15 = 65. Score capped at 95.

### 6. Phase multiplier
`computeScore` now takes a `phase` argument: early `1.10×`, mid `1.15×`, late `0.85×`, complete `0.50×`. A programme in its late/wind-down phase scores lower than one in early mid-cycle.

### 7. Smarter ticker resolution
`lib/signals/company-validator.ts` + `app/api/resolve/route.ts` now prefer matches in this order: exact ticker → exact name → starts-with (shortest first) → contains (shortest first). Fixes cases like "Apple" matching "Pineapple Holdings" before AAPL. Added explicit MMC mapping.

### 8. Distinct bankruptcy UI
Bankruptcy detection surfaces as a **slate `#1f2933` card with a ⚖ glyph**, distinct from the light coral programme card. Court-supervised process is not the same thing as a voluntary transformation programme and the UI reflects that.

## File structure

```
ejectseat-consumer-v6.1-integrated/
├── .env.local.example       # Env var template
├── .gitignore
├── README.md                # This file
├── next.config.js
├── package.json
├── tsconfig.json
├── vercel.json              # Score maxDuration bumped 30 → 60s
├── app/
│   └── api/
│       ├── auth/route.ts         # v5 verbatim (magic link)
│       ├── beacon/route.ts       # v5 verbatim (page analytics)
│       ├── beta/route.ts         # v5 verbatim (email capture)
│       ├── landingzone/route.ts  # v5 verbatim (Adzuna LZ)
│       ├── resolve/route.ts      # v5 + v6.1 smarter fuzzy + MMC
│       └── score/route.ts        # INTEGRATED orchestrator
├── lib/
│   ├── scoring/
│   │   └── engine.ts             # + ACTIVE_MULTI_YEAR, phase, bankruptcy override
│   └── signals/
│       ├── company-validator.ts  # + smarter fuzzy + MMC
│       ├── earnings.ts           # + 6-K
│       ├── landingzone.ts        # v5 verbatim (Adzuna)
│       ├── news.ts               # + ACTIVE_MULTI_YEAR weighting, expanded keywords
│       ├── nlp-analyzer.ts       # + comprehensiveFilingAnalysis (Sonnet, 12K)
│       ├── quarterly-calendar.ts # + 20-F
│       └── sec.ts                # + 20-F/6-K, IFRS, sliceAroundSections, fetchFullFilingsForAnalysis
├── public/
│   └── index.html                # v5 UI + programme/headcount/function-risk/bankruptcy cards
├── supabase/
│   └── schema.sql                # v5 schema + v6.1 migration block
└── types/
    └── index.ts                  # v5 types + ProgrammeIntelligence, HeadcountEstimate, FunctionRiskMap, BankruptcyFiling, ComprehensiveIntelligence
```

## Migration path (existing deployment)

1. **Back up** your production Supabase (Dashboard → Database → Backups → Download).
2. Run `supabase/schema.sql` in the Supabase SQL editor. The migration block at the bottom is **idempotent** — uses `ADD COLUMN IF NOT EXISTS`, dynamically drops and re-adds CHECK constraints so the `ACTIVE_MULTI_YEAR` state is accepted. Safe to run on the existing database.
3. Replace the deployed code with this zip contents. Keep your existing `.env.local` / Vercel environment variables — no new env vars required.
4. `npm install && npm run build` locally to catch any type errors before deploying.
5. Deploy to Vercel. The `vercel.json` bumps `/api/score` max duration from 30 → 60s to accommodate the extra Sonnet call.

## Test cases (post-deploy)

| Search | Expected |
|---|---|
| `Marsh McLennan` or `MMC` | `ACTIVE_MULTI_YEAR`, score ~70-78. Programme card shows "Thrive" with $149M/$500M progress bar (exact figures depend on latest 10-Q). Headcount ~3-4K estimate. Function risk extracted. |
| `Snap` | `ACTIVE`, confirmed 8-K Item 2.05 cited, no programme card. |
| `Amazon` | Rivian writedown rejected as investment loss by Haiku per-XBRL verification (v5 behaviour preserved). |
| `Stripe` | `ineligible_reason` about private company, news-only scoring. |
| A recent Ch 11 filer (e.g. Spirit Airlines / Yellow / BBBY) | Slate bankruptcy card **replaces** programme card, score ≥75. "Court filing" tag shown. |
| `Apple` | Resolves to AAPL — not "Pineapple Holdings" — via starts-with-shortest tier. |

## Cost implications

| | Tokens/score | Approx cost (USD) |
|---|---|---|
| v5 pipeline | ~20K in + 3K out | ~$0.08 |
| + v6.1 comprehensive call | +80K in + 6K out | +$0.30 |
| **Total per cold score** | ~100K in + 9K out | **~$0.40** |

Cache TTL (6h registered / 24h anonymous) keeps the hot-path free, so realised cost depends on traffic mix. Comprehensive intelligence is cached on the `companies` row — cache hits cost nothing extra.

## Known limits

- Comprehensive call uses `claude-sonnet-4-5`, `max_tokens: 12000`. In the extremely rare case Sonnet's reasoning runs over, the parser recovers gracefully and returns empty intelligence (the v5 scoring still produces a valid score).
- Segment-aware conglomerate analysis (Berkshire Hathaway, Honeywell etc.) is **not** implemented — comprehensive call treats the company as a single entity.
- WARN Act lookup is **not** implemented. The `large_employer_flag` covers the gap by noting site-specific cuts may occur outside of disclosed programmes.

## Contact

- SEC User-Agent: `enquiries.talkace@gmail.com` (required by EDGAR — do not change)
- Production URL: https://ejectseat-consumer-cfad.vercel.app
