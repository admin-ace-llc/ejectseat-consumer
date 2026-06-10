# EjectSeat

**Layoff-risk predictor for US-listed public companies. Enter a ticker. Get a data-backed risk score in seconds.**

[![Live Tool](https://img.shields.io/badge/Live%20Tool-ejectseat.io-blue)](https://ejectseat.io)

---

## What It Does

EjectSeat analyzes publicly available signals — SEC filings, earnings call transcripts, recent news — and returns a **layoff risk score** for any US-listed company.

It tells you whether a company is in a **CLEAR**, **WATCH**, **LIKELY**, or **ACTIVE** layoff state, and shows you exactly what evidence drove the score: revenue trends, headcount language in 10-Ks, restructuring charges, executive tone in Q&A sessions, and confirmed layoff events.

### Why it exists

Every quarter, tens of thousands of employees learn about layoffs from a Slack message or a news alert — not from months of reading between the lines of their company's SEC filings and earnings calls. That information is all public. Most people just don't have the time or tools to process it.

EjectSeat does that processing for you.

---

## Who Uses This

**Employees** at publicly traded companies who want an early-warning signal before making financial decisions — accepting a mortgage, declining a competing offer, or deciding whether to vest.

**Recruiters and talent acquisition teams** who use layoff signals to identify which companies are actively shedding talent and time their outreach accordingly.

**Journalists and analysts** covering the tech industry who need a quick data-backed read on whether a restructuring announcement is the beginning of something larger.

**HR and people ops professionals** who want to benchmark their company's risk signals against peers.

**Job seekers** evaluating whether to accept an offer from a company that seems unstable.

---

## How the Score Works

EjectSeat reads the full SEC evidence bundle for a given company — 10-K/10-Q filings, 8-K events, earnings call Q&A transcripts (including the off-script moments), and recent tier-A/B/C news — and runs a single comprehensive Claude Sonnet analysis that returns a structured risk assessment.

### Risk States

| State | Score Band | Meaning |
|-------|------------|---------|
| CLEAR | 0–35 | No material signals of near-term layoffs |
| WATCH | 25–64 | Forward indicators present (margin pressure, hiring freeze language) but no confirmed event |
| LIKELY | 45–78 | Multiple corroborating signals across filings, calls, and news |
| ACTIVE | 60–90 | Confirmed layoffs within 90 days, or multi-year restructuring programme in motion |

Score bands overlap intentionally — a WATCH company at 62 is very different from a WATCH company at 28, and the score surface reflects that nuance.

### What the pipeline reads

- **SEC 10-K and 10-Q filings** — headcount, restructuring charges, going concern language
- **8-K and 6-K filings** — all events, not just the filtered ones (the full-text approach caught a Snap-style misclassification that item-number filtering missed)
- **Earnings call Q&A transcripts** (Motley Fool) — the prepared remarks are scripted; the Q&A is where executives go off-script
- **Tier A/B/C news** — prioritized by source credibility
- **Historical layoff programmes** — whether an announced programme is still actively running

---

## Architecture (v7)

```
/api/score
  1. validateCompany(name, ticker)      →  CIK + legal name
  2. Parallel evidence fetch:
       ├── SEC filings + EDGAR facts
       ├── Earnings call transcripts (Motley Fool Q&A)
       ├── Recent news (Tier A/B/C)
       └── Legacy audit signals
  3. comprehensiveAnalysis(bundle)      →  Single Sonnet call
  4. runPostValidators(intel, bundle)   →  Strip unattributed claims
  5. validateAndFinaliseScore(intel)    →  Clamp to state band
  6. Persist + return RiskScore
```

Built on Next.js + TypeScript, deployed on Vercel. Supabase for persistence.

---

## Key Files

| File | Purpose |
|------|---------|
| `app/api/score/route.ts` | Main API orchestrator |
| `lib/signals/sec.ts` | SEC evidence bundle fetcher |
| `lib/signals/transcripts.ts` | Motley Fool scraper (graceful fallback) |
| `lib/signals/news.ts` | Tier A/B/C news aggregator |
| `lib/signals/nlp-analyzer.ts` | Comprehensive Sonnet analysis + post-validators |
| `lib/scoring/engine.ts` | Band validator + signal-awaited penalty |
| `types/index.ts` | Shared types + state normaliser |
| `scripts/regression-test.ts` | 12-case regression matrix |

---

## Running the Regression Test

```bash
# Against local
TARGET_URL=http://localhost:3000 npm run regression

# Against production
TARGET_URL=https://ejectseat.io npm run regression
```

Tests include Snap (original bug), Amazon (must not attribute Rivian layoffs), MMC (v6.1 validator failure), private companies, indexes, and control cases.

---

## Feature Flag / Rollback

```
USE_COMPREHENSIVE_V2=true   # default — runs v7 pipeline
USE_COMPREHENSIVE_V2=false  # instant rollback to v5 path, no redeploy
```

---

## Topics

`layoffs` · `layoff-tracker` · `sec-filings` · `earnings-calls` · `risk-score` · `job-security` · `tech-layoffs` · `company-analysis` · `edgar` · `workforce-reduction` · `restructuring` · `ai-analysis` · `employment` · `fintech`

---

## Roadmap

- Score gauge animation + motion system on result reveal
- Auto-load open roles at the company (via LandingZone) when risk is ACTIVE or LIKELY
- Inline "X companies hiring your role" CTA on high-risk results
- Risk-aware job sort (prioritize stable companies)
- Low-confidence pill with source transparency tooltip
- Motley Fool selector health check against live tickers
