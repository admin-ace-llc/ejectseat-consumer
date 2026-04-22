# v7 Deployment Guide

Rollback is a one-flag env change, no redeploy. Read that section first.

---

## 1. Apply the Supabase migration

```bash
# In Supabase SQL editor, or via psql:
psql "$DATABASE_URL" -f supabase/schema.sql
```

The file is **idempotent** — safe to run against a fresh database, a v6.1 database, or a partially-migrated one. All ALTER TABLE statements use `ADD COLUMN IF NOT EXISTS`. No data is destroyed.

What it adds:
- `companies.cached_intelligence` (jsonb) — full intelligence object for cache hits
- `companies.cached_pipeline_version` (text)
- `score_history.waves_confirmed`, `trajectory`, `requires_review`, `pipeline_version`
- `pipeline_comparison` table (unused in v7, reserved for future shadow-run)
- Extended CHECK constraints on `company_state` to accept v7 + v6.1 names

## 2. Set environment variables on Vercel

In Vercel dashboard → Project → Settings → Environment Variables, confirm:

```
ANTHROPIC_API_KEY
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
ADZUNA_APP_ID
ADZUNA_APP_KEY
USE_COMPREHENSIVE_V2   = true
```

`USE_COMPREHENSIVE_V2` is the v7 flag. Default if unset is `true`.

## 3. Deploy

```bash
git add .
git commit -m "v7: comprehensive Sonnet pipeline + 4-state machine + strict-mode guardrails"
git push origin main
```

Vercel auto-deploys on push. `/api/score` has `maxDuration: 60` in `vercel.json` — enough for the Sonnet call.

## 4. Verify

Hit the live URL with 2–3 companies:
- **Snap (SNAP)** — should score ACTIVE or LIKELY with the April 15 2026 layoff event cited.
- **Apple (AAPL)** — should score CLEAR or WATCH.
- **Stripe** (private) — should degrade gracefully with private-company message.

Then run the full regression:

```bash
TARGET_URL=https://ejectseat-consumer-cfad.vercel.app npm run regression
```

Pass threshold: **9 of 12 cases**. The three flexible ones (Oracle, Microsoft, Salesforce) accept a range of states so reality can drift.

---

## Rollback

**If anything is wrong in production, this is the rollback:**

1. Vercel dashboard → Project → Settings → Environment Variables
2. Change `USE_COMPREHENSIVE_V2` from `true` to `false`
3. Redeploy (Vercel does this automatically on env change — ~45 seconds)

The pipeline flips back to v5 fallback path. All v6.1 response fields at the top level of `RiskScore` remain populated; the new `intelligence` object is simply absent. No frontend changes needed. No database revert needed.

If the issue is Sonnet-specific (e.g. prompt change causing bad output on one company type), this takes you out of the danger zone in under 5 minutes.

---

## Known fragilities

### Motley Fool scraper

Selectors in `lib/signals/transcripts.ts` were written against the HTML layout as of April 2026. If Motley Fool changes their page structure, `fetchRecentTranscripts` returns `[]` and the pipeline continues SEC-only. No user-visible error, but the transcript signal is missing.

When selectors break: grep `MOTLEY_FOOL_SELECTORS` in `lib/signals/transcripts.ts` and update. Test with a known-good ticker (e.g. AAPL, MSFT).

### Sonnet prompt drift

If a specific company type starts returning odd verdicts:

1. Flip `USE_COMPREHENSIVE_V2=false` to stabilise
2. Check `score_history.chain_of_thought` for the affected company
3. Adjust the system prompt in `lib/signals/nlp-analyzer.ts` (`comprehensiveAnalysis`)
4. Deploy; flip flag back to `true`

### Cost

Each cold score ≈ ~$0.40 (Sonnet comprehensive call). At 10K scores/month that's ~$4K Anthropic bill. Cache TTL is 6h for registered users, 24h for anonymous — raise these to reduce cost if needed.

---

## Post-deploy monitoring

Query these regularly in Supabase:

```sql
-- How many v7 scores flagged for review?
SELECT count(*) FROM score_history
WHERE pipeline_version = 'v7' AND requires_review = true
AND scored_at > now() - interval '24 hours';

-- State distribution (sanity check)
SELECT company_state, count(*)
FROM score_history
WHERE pipeline_version = 'v7' AND scored_at > now() - interval '24 hours'
GROUP BY company_state;

-- Companies where Sonnet ran out of evidence
SELECT c.name, s.score, s.company_state, s.chain_of_thought
FROM score_history s JOIN companies c ON s.company_id = c.id
WHERE s.pipeline_version = 'v7' AND s.requires_review = true
ORDER BY s.scored_at DESC LIMIT 20;
```

If `requires_review = true` exceeds ~15% of daily scores, Sonnet's guardrails are probably catching a systematic prompt issue — investigate before it becomes a user problem.
