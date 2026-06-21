-- supabase/schema.sql — EjectSeat Consumer v7
--
-- This file contains the full schema (v6.1 base + v7 additive migration).
-- It is IDEMPOTENT — safe to run against a fresh database, a v6.1 database,
-- or a database that has already been partially migrated.
--
-- Apply order:
--   1. If starting fresh: run this whole file.
--   2. If upgrading from v6.1: run this whole file — all ALTER TABLE statements
--      use ADD COLUMN IF NOT EXISTS. No data is destroyed.
--
-- ROLLBACK:
--   The flag flip (USE_COMPREHENSIVE_V2=false) is sufficient for immediate
--   rollback. These schema additions are additive and do not break v6.1 reads.

-- ─────────────────────────────────────────────────────────────────────────────
-- Extensions
-- ─────────────────────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "citext";

-- ─────────────────────────────────────────────────────────────────────────────
-- companies — base table
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS companies (
  id                  uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  name                citext UNIQUE NOT NULL,
  legal_name          text,
  ticker              text,
  cik                 text,
  is_us_listed        boolean DEFAULT false,
  is_public           boolean DEFAULT false,
  sec_filing_found    boolean DEFAULT false,
  cached_score        integer,
  cached_band         text,
  cached_state        text,
  cached_at           timestamptz,
  last_scored_at      timestamptz,
  created_at          timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS companies_ticker_idx ON companies (ticker);
CREATE INDEX IF NOT EXISTS companies_cik_idx    ON companies (cik);

-- v6.1 additive columns (may already exist on upgrade)
ALTER TABLE companies ADD COLUMN IF NOT EXISTS cached_programme           jsonb;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS cached_headcount           jsonb;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS cached_function_risk       jsonb;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS cached_bankruptcy          jsonb;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS cached_large_employer_flag boolean;

-- v7 additive columns
ALTER TABLE companies ADD COLUMN IF NOT EXISTS cached_intelligence        jsonb;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS cached_pipeline_version    text;

-- ─────────────────────────────────────────────────────────────────────────────
-- score_history — per-score log
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS score_history (
  id                  uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id          uuid REFERENCES companies(id) ON DELETE CASCADE,
  score               integer NOT NULL,
  band                text NOT NULL,
  company_state       text,
  quarter_label       text,
  key_signal          text,
  signals             jsonb,
  disclaimer          jsonb,
  quarterly_status    jsonb,
  chain_of_thought    text,
  scored_at           timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS score_history_company_idx ON score_history (company_id, scored_at DESC);

-- v6.1 additive
ALTER TABLE score_history ADD COLUMN IF NOT EXISTS programme_name              text;
ALTER TABLE score_history ADD COLUMN IF NOT EXISTS programme_total_size        numeric;
ALTER TABLE score_history ADD COLUMN IF NOT EXISTS programme_recognised        numeric;
ALTER TABLE score_history ADD COLUMN IF NOT EXISTS headcount_estimate_low      integer;
ALTER TABLE score_history ADD COLUMN IF NOT EXISTS headcount_estimate_mid      integer;
ALTER TABLE score_history ADD COLUMN IF NOT EXISTS headcount_estimate_high     integer;
ALTER TABLE score_history ADD COLUMN IF NOT EXISTS at_risk_functions           text[];
ALTER TABLE score_history ADD COLUMN IF NOT EXISTS protected_functions         text[];
ALTER TABLE score_history ADD COLUMN IF NOT EXISTS bankruptcy_detected         boolean;
ALTER TABLE score_history ADD COLUMN IF NOT EXISTS bankruptcy_chapter          text;
ALTER TABLE score_history ADD COLUMN IF NOT EXISTS bankruptcy_filing_date      date;
ALTER TABLE score_history ADD COLUMN IF NOT EXISTS large_employer_flag         boolean;

-- v7 additive
ALTER TABLE score_history ADD COLUMN IF NOT EXISTS waves_confirmed   integer;
ALTER TABLE score_history ADD COLUMN IF NOT EXISTS trajectory        text;
ALTER TABLE score_history ADD COLUMN IF NOT EXISTS requires_review   boolean DEFAULT false;
ALTER TABLE score_history ADD COLUMN IF NOT EXISTS pipeline_version  text DEFAULT 'v7';

-- CHECK constraint on company_state: accept v7 names AND v6.1 legacy names
-- Drop old constraint if it exists (name convention), then add permissive one
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'score_history_company_state_check') THEN
    ALTER TABLE score_history DROP CONSTRAINT score_history_company_state_check;
  END IF;
END $$;

ALTER TABLE score_history ADD CONSTRAINT score_history_company_state_check
  CHECK (company_state IS NULL OR company_state IN (
    -- v7 states
    'CLEAR', 'WATCH', 'LIKELY', 'ACTIVE',
    -- v6.1 legacy states (read compatibility)
    'WATCHING', 'ACTIVE_MULTI_YEAR', 'CONTINUATION_RISK'
  ));

-- Same for companies.cached_state
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'companies_cached_state_check') THEN
    ALTER TABLE companies DROP CONSTRAINT companies_cached_state_check;
  END IF;
END $$;

ALTER TABLE companies ADD CONSTRAINT companies_cached_state_check
  CHECK (cached_state IS NULL OR cached_state IN (
    'CLEAR', 'WATCH', 'LIKELY', 'ACTIVE',
    'WATCHING', 'ACTIVE_MULTI_YEAR', 'CONTINUATION_RISK'
  ));

-- ─────────────────────────────────────────────────────────────────────────────
-- score_usage — per-request usage log
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS score_usage (
  id           uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id      uuid,
  session_id   text,
  company_name text NOT NULL,
  created_at   timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS score_usage_user_idx    ON score_usage (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS score_usage_session_idx ON score_usage (session_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- analytics_events
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS analytics_events (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     uuid,
  session_id  text,
  event_type  text NOT NULL,
  payload     jsonb DEFAULT '{}'::jsonb,
  ip_address  text,
  user_agent  text,
  created_at  timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS analytics_events_type_idx ON analytics_events (event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS analytics_events_user_idx ON analytics_events (user_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- beta_signups
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS beta_signups (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  email         citext UNIQUE NOT NULL,
  source        text,
  context       jsonb,
  signed_up_at  timestamptz DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- predictions — for backtesting score >= 70 outcomes
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS predictions (
  id                    uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_name          text NOT NULL,
  ticker                text,
  score_at_prediction   integer,
  created_at            timestamptz DEFAULT now(),
  outcome               text,       -- 'confirmed_layoff' | 'no_event' | 'ambiguous' | NULL
  outcome_confirmed_at  timestamptz,
  outcome_source_url    text
);

CREATE INDEX IF NOT EXISTS predictions_company_idx ON predictions (company_name, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- pipeline_comparison — for future shadow-run comparison (v7 not using yet)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pipeline_comparison (
  id                    uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_name          text NOT NULL,
  ticker                text,
  v5_score              integer,
  v5_band               text,
  v5_state              text,
  v7_score              integer,
  v7_band               text,
  v7_state              text,
  v7_requires_review    boolean,
  created_at            timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pipeline_comparison_created_idx ON pipeline_comparison (created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- active_layoffs_feed — codifying a table that previously existed only via
-- the Supabase dashboard. Populated by app/api/cron/discover-active-layoffs
-- and app/api/admin/backfill-active-layoffs. Read by app/api/active-layoffs.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS active_layoffs_feed (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_name  text UNIQUE NOT NULL,
  ticker        text,
  cik           text,
  score         integer,
  band          text,
  state         text,
  key_signal    text,
  source_type   text,       -- sec_8k | sec_10k | sec_10q | media
  source_ref    text,
  filed_at      date,
  scored_at     timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS active_layoffs_feed_scored_idx ON active_layoffs_feed (scored_at DESC);
CREATE INDEX IF NOT EXISTS active_layoffs_feed_filed_idx  ON active_layoffs_feed (filed_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- company_comments — anonymous, no-login anecdote board per /company/[ticker]
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS company_comments (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  ticker      text NOT NULL,
  body        text NOT NULL,
  ip_hash     text,
  created_at  timestamptz DEFAULT now(),
  hidden      boolean DEFAULT false
);

CREATE INDEX IF NOT EXISTS company_comments_ticker_idx ON company_comments (ticker, created_at DESC);
CREATE INDEX IF NOT EXISTS company_comments_iphash_idx ON company_comments (ip_hash, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- watches — email alerts when a watched ticker's state changes
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS watches (
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  email             citext NOT NULL,
  ticker            text NOT NULL,
  last_known_state  text,
  last_notified_at  timestamptz,
  created_at        timestamptz DEFAULT now(),
  UNIQUE (email, ticker)
);

CREATE INDEX IF NOT EXISTS watches_ticker_idx ON watches (ticker);

-- ─────────────────────────────────────────────────────────────────────────────
-- enterprise_leads — bulk data / report enquiries (layoffs.fyi-style hook)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS enterprise_leads (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        text,
  email       text NOT NULL,
  company     text,
  use_case    text,
  message     text,
  created_at  timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS enterprise_leads_created_idx ON enterprise_leads (created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- ca_warn_notices — California EDD WARN Act report cache (lib/warn/ca.ts).
-- Source of truth is the EDD spreadsheet itself; this table only ever stores
-- rows that were actually parsed from it — never a fabricated/estimated row.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ca_warn_notices (
  id                  uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_name        text NOT NULL,
  county              text,
  notice_date         date,
  effective_date      date,
  received_date       date,
  employees_affected  integer,
  layoff_type         text,
  raw                 jsonb,
  fetched_at          timestamptz DEFAULT now(),
  UNIQUE (company_name, county, notice_date, effective_date)
);

CREATE INDEX IF NOT EXISTS ca_warn_notices_effective_idx ON ca_warn_notices (effective_date DESC);
CREATE INDEX IF NOT EXISTS ca_warn_notices_notice_idx    ON ca_warn_notices (notice_date DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- Row-level security — service role only (frontend uses API routes, not direct DB)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE companies          ENABLE ROW LEVEL SECURITY;
ALTER TABLE score_history      ENABLE ROW LEVEL SECURITY;
ALTER TABLE score_usage        ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics_events   ENABLE ROW LEVEL SECURITY;
ALTER TABLE beta_signups       ENABLE ROW LEVEL SECURITY;
ALTER TABLE predictions        ENABLE ROW LEVEL SECURITY;
ALTER TABLE pipeline_comparison ENABLE ROW LEVEL SECURITY;
ALTER TABLE active_layoffs_feed ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_comments    ENABLE ROW LEVEL SECURITY;
ALTER TABLE watches             ENABLE ROW LEVEL SECURITY;
ALTER TABLE enterprise_leads    ENABLE ROW LEVEL SECURITY;
ALTER TABLE ca_warn_notices     ENABLE ROW LEVEL SECURITY;

-- Service role bypasses RLS by default; no user-facing policies needed.
