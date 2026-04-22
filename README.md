# EjectSeat Consumer v7

Layoff-risk predictor for US-listed public companies (and FPIs). Live at **ejectseat.io**.

This package is the **backend rebuild** for v7 — the pipeline that produces the risk score. The `public/index.html` UI rebuild (motion system, LandingZone integration, inline CTAs) lands in the next session.

---

## What changed in v7

| Area | v6.1 | v7 |
|------|------|------|
| Analysis pipeline | 5+ Haiku calls (prefilter → classify → verify → analyze → summarise) | **Single comprehensive Sonnet call** reading full evidence bundle |
| State machine | 5 states (WATCHING, ACTIVE_MULTI_YEAR, CONTINUATION_RISK…) | **4 states** — CLEAR / WATCH / LIKELY / ACTIVE |
| Bankruptcy | Hard override pinned to ACTIVE_MULTI_YEAR | **No hard override** — earned from evidence, same as everything else |
| Earnings calls | Prepared-remarks text only (from 8-K Item 2.02) | **Motley Fool transcript scraper** — captures Q&A where CEOs go off-script |
| 8-K scanning | Item-number filtered (the cause of the Snap bug) | **All 8-K / 6-K / NT** full-text → Sonnet decides what's material |
| Scoring | Raw points × corroboration × phase multiplier | **Sonnet returns state+score**, engine validates and applies signal-awaited penalty |
| Strict mode | Soft — Sonnet could invent sources | **Hard** — post-validator strips unattributed claims, enforces confidence floor, flags for review |
| Number formatting | Mixed raw / shorthand | **Business shorthand everywhere** ($4.7M not $4,700,000) |

---

## Architecture

```
┌──────────────────── /api/score ────────────────────┐
│                                                     │
│  1. validateCompany(name, ticker)   →  CIK + legalName
│                                                     │
│  2. PARALLEL fetch evidence:                        │
│       ├── fetchEvidenceBundle()  (SEC filings+facts)│
│       ├── fetchRecentTranscripts() (Motley Fool Q&A)│
│       ├── fetchRecentNews()        (Tier A/B/C)     │
│       └── fetchLegacyAuditSignals() (UI audit strip)│
│                                                     │
│  3. comprehensiveAnalysis(bundle)  →  Sonnet call   │
│        - strict system prompt                       │
│        - full filing text + transcripts + news      │
│        - returns ComprehensiveIntelligence object   │
│                                                     │
│  4. runPostValidators(intel, bundle)                │
│        - strips unattributed source_refs            │
│        - enforces confidence floor (3/2/1 sources)  │
│        - flags ACTIVE w/o confirmed event as review │
│                                                     │
│  5. validateAndFinaliseScore(intel, signalAwaited)  │
│        - clamps score to state band                 │
│        - applies 0.85× signal_awaited penalty       │
│                                                     │
│  6. Persist + return unified RiskScore response     │
│                                                     │
└─────────────────────────────────────────────────────┘
```

## Feature flag

All of the above runs when `USE_COMPREHENSIVE_V2=true` (the default). Setting the env var to `false` in Vercel flips to the v5 fallback path instantly — no redeploy. That is the rollback mechanism.

## State bands (v7)

| State | Band (score) | Meaning |
|-------|--------------|---------|
| CLEAR  | 0–35  | No material signals |
| WATCH  | 25–64 | Forward indicators, no confirmed event |
| LIKELY | 45–78 | Multiple corroborating signals |
| ACTIVE | 60–90 | Confirmed layoffs within 90 days OR multi-year programme in motion OR bankruptcy |

Ranges overlap on purpose so Sonnet can reflect nuance within each state.

## Key files

```
types/index.ts                        Shared types + state normaliser
lib/format.ts                         Business-number formatting (single source of truth)
lib/signals/sec.ts                    Evidence-bundle fetcher (pure; no interpretation)
lib/signals/transcripts.ts            Motley Fool scraper; graceful fallback to []
lib/signals/news.ts                   Tier A/B/C news bundler
lib/signals/quarterly-calendar.ts     Filing-status detection
lib/signals/company-validator.ts      Name/ticker → CIK
lib/signals/landingzone.ts            Adzuna client
lib/signals/nlp-analyzer.ts           Comprehensive Sonnet call + post-validators
lib/scoring/engine.ts                 Band validator + signal-awaited penalty
app/api/score/route.ts                Orchestrator (v7 + v5 fallback)
supabase/schema.sql                   Idempotent migration
scripts/regression-test.ts            12-case regression matrix
```

## Running the regression test

```bash
TARGET_URL=http://localhost:3000 npm run regression
# or against production:
TARGET_URL=https://ejectseat-consumer-cfad.vercel.app npm run regression
```

The script tests Snap (the original bug), Amazon (must not attribute Rivian), MMC (v6.1 validator failure), private companies, indexes, and control cases. Exits non-zero on failure.

## The Motley Fool scraper

The transcripts scraper is the most fragile component — Motley Fool's HTML changes occasionally. When selectors break, `fetchRecentTranscripts` returns `[]` and the pipeline continues SEC-only. No user-visible error.

To update selectors: grep `MOTLEY_FOOL_SELECTORS` in `lib/signals/transcripts.ts`.

Abstraction layer: adding Seeking Alpha or AlphaSense as a source means adding a second fetcher in that file and aggregating — no caller changes.

## What's pending for next session

- `public/index.html` rebuild with motion system (score gauge animation, programme progress bar, state badge fade-slide, LandingZone cascade)
- Auto-load LandingZone on result reveal using last-used role + locations from localStorage
- Inline "X companies hiring your role" CTA on MEDIUM/HIGH scores
- Risk-aware LandingZone sort
- Low-confidence pill with tooltip
- Loading states tied to real pipeline milestones
- Motley Fool selector validation against a live ticker
