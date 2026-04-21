-- ─────────────────────────────────────────────────────────────────────────────
-- EjectSeat CONSUMER — Supabase Schema (v6.1 integrated)
-- Run in Supabase SQL Editor → New Query → Run
-- Safe to re-run: all CREATE statements use IF NOT EXISTS.
-- v6.1 migration block at bottom uses ALTER TABLE IF NOT EXISTS for safety.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── PROFILES ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS profiles (
  id                     UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email                  TEXT,
  tier                   TEXT NOT NULL DEFAULT 'free'
                         CHECK (tier IN ('free', 'registered')),
  stripe_customer_id     TEXT,
  stripe_subscription_id TEXT,
  subscription_status    TEXT,
  subscription_ends_at   TIMESTAMPTZ,
  role_function          TEXT,
  role_tier              TEXT,
  preferred_geo          TEXT,
  remote_preferred       BOOLEAN DEFAULT TRUE,
  created_at             TIMESTAMPTZ DEFAULT NOW(),
  updated_at             TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users read own profile"   ON profiles;
DROP POLICY IF EXISTS "Users update own profile" ON profiles;
CREATE POLICY "Users read own profile"   ON profiles FOR SELECT USING (auth.uid() = id);
CREATE POLICY "Users update own profile" ON profiles FOR UPDATE USING (auth.uid() = id);

-- ── SCORE USAGE ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS score_usage (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id      UUID REFERENCES profiles(id) ON DELETE CASCADE,
  session_id   TEXT,
  company_name TEXT NOT NULL,
  scored_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS score_usage_user_month_idx    ON score_usage(user_id, scored_at DESC);
CREATE INDEX IF NOT EXISTS score_usage_session_month_idx ON score_usage(session_id, scored_at DESC);

-- ── COMPANIES ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS companies (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name             TEXT NOT NULL,
  legal_name       TEXT,
  ticker           TEXT,
  cik              TEXT,
  is_us_listed     BOOLEAN DEFAULT FALSE,
  is_public        BOOLEAN DEFAULT FALSE,
  sec_filing_found BOOLEAN DEFAULT FALSE,
  cached_score     INTEGER,
  cached_band      TEXT,
  cached_state     TEXT,
  cached_at        TIMESTAMPTZ,
  last_scored_at   TIMESTAMPTZ,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS companies_ticker_idx ON companies(ticker) WHERE ticker IS NOT NULL;
CREATE INDEX IF NOT EXISTS companies_name_idx          ON companies(lower(name));

-- ── WATCHLIST ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS watchlist (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID REFERENCES profiles(id) ON DELETE CASCADE,
  company_id UUID REFERENCES companies(id) ON DELETE CASCADE,
  added_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, company_id)
);

ALTER TABLE watchlist ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users manage own watchlist" ON watchlist;
CREATE POLICY "Users manage own watchlist" ON watchlist FOR ALL USING (auth.uid() = user_id);

-- ── SCORE HISTORY ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS score_history (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id       UUID REFERENCES companies(id) ON DELETE CASCADE,
  score            INTEGER NOT NULL,
  band             TEXT NOT NULL CHECK (band IN ('HIGH','MEDIUM','LOW')),
  quarter_label    TEXT,
  key_signal       TEXT,
  company_state    TEXT,
  chain_of_thought TEXT,
  signals          JSONB,
  disclaimer       JSONB,
  quarterly_status JSONB,
  scored_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS score_history_company_idx ON score_history(company_id, scored_at DESC);

-- ── PREDICTIONS ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS predictions (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id          UUID REFERENCES companies(id),
  company_name        TEXT NOT NULL,
  ticker              TEXT,
  score_at_prediction INTEGER NOT NULL,
  predicted_at        TIMESTAMPTZ DEFAULT NOW(),
  outcome             TEXT CHECK (outcome IN ('validated','invalidated','pending'))
                      DEFAULT 'pending',
  outcome_at          TIMESTAMPTZ,
  outcome_source      TEXT,
  days_to_outcome     INTEGER GENERATED ALWAYS AS (
    CASE WHEN outcome_at IS NOT NULL
    THEN EXTRACT(DAY FROM outcome_at - predicted_at)::INTEGER
    ELSE NULL END
  ) STORED
);

CREATE INDEX IF NOT EXISTS predictions_outcome_idx ON predictions(outcome, predicted_at DESC);
CREATE INDEX IF NOT EXISTS predictions_pending_idx ON predictions(score_at_prediction DESC)
  WHERE outcome = 'pending';

-- ── HIRING VELOCITY ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hiring_velocity_snapshots (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id UUID REFERENCES companies(id) ON DELETE CASCADE,
  role_type  TEXT,
  role_level TEXT,
  count      INTEGER NOT NULL,
  geo        TEXT,
  snapped_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS hv_company_date_idx ON hiring_velocity_snapshots(company_id, snapped_at DESC);

-- ── QUARTERLY SIGNAL STATUS ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS quarterly_signal_status (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id           UUID REFERENCES companies(id),
  cik                  TEXT,
  fiscal_year_end      TEXT,
  expected_filing_date TIMESTAMPTZ,
  filing_status        TEXT CHECK (filing_status IN ('awaited','filed','overdue')),
  checked_at           TIMESTAMPTZ DEFAULT NOW()
);

-- ── ROLE TAXONOMY ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS role_taxonomy (
  id       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  function TEXT NOT NULL,
  tier     TEXT NOT NULL CHECK (tier IN ('junior','mid','senior')),
  keywords TEXT[]
);

INSERT INTO role_taxonomy (function, tier, keywords)
SELECT * FROM (VALUES
  ('engineering',  'junior',  ARRAY['engineer','developer','swe','software engineer']),
  ('engineering',  'mid',     ARRAY['senior engineer','staff engineer','tech lead']),
  ('engineering',  'senior',  ARRAY['principal','distinguished','vp engineering','cto']),
  ('trust_safety', 'junior',  ARRAY['trust & safety analyst','content moderator','policy analyst']),
  ('trust_safety', 'mid',     ARRAY['senior trust','trust & safety manager','policy manager']),
  ('trust_safety', 'senior',  ARRAY['head of trust','director trust','vp trust','chief trust']),
  ('product',      'junior',  ARRAY['associate pm','product analyst','apm']),
  ('product',      'mid',     ARRAY['product manager','senior pm','group pm']),
  ('product',      'senior',  ARRAY['director product','vp product','chief product','cpo']),
  ('design',       'junior',  ARRAY['ux designer','ui designer','product designer']),
  ('design',       'mid',     ARRAY['senior designer','lead designer','design lead']),
  ('design',       'senior',  ARRAY['head of design','vp design','chief design']),
  ('data',         'junior',  ARRAY['data analyst','business analyst','analyst']),
  ('data',         'mid',     ARRAY['senior analyst','data scientist','senior data']),
  ('data',         'senior',  ARRAY['head of data','vp data','chief data','cdo']),
  ('sales',        'junior',  ARRAY['account executive','sales rep','bdr','sdr']),
  ('sales',        'mid',     ARRAY['senior ae','account manager','regional sales']),
  ('sales',        'senior',  ARRAY['vp sales','chief revenue','cro','head of sales'])
) AS seed(function, tier, keywords)
WHERE NOT EXISTS (SELECT 1 FROM role_taxonomy LIMIT 1);

-- ── ANALYTICS EVENTS ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS analytics_events (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID REFERENCES profiles(id) ON DELETE SET NULL,
  session_id TEXT,
  event_type TEXT NOT NULL,
  payload    JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS analytics_events_type_idx  ON analytics_events(event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS analytics_events_user_idx  ON analytics_events(user_id, created_at DESC);

-- ── BETA SIGNUPS ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS beta_signups (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email        TEXT NOT NULL UNIQUE,
  use_case     TEXT,
  referrer     TEXT,
  signed_up_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── ALERT SUBSCRIPTIONS ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS alert_subscriptions (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID REFERENCES profiles(id) ON DELETE CASCADE,
  company_id UUID REFERENCES companies(id) ON DELETE CASCADE,
  channel    TEXT NOT NULL DEFAULT 'email' CHECK (channel IN ('email')),
  threshold  INTEGER DEFAULT 5,
  active     BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, company_id)
);

ALTER TABLE alert_subscriptions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users manage own alerts" ON alert_subscriptions;
CREATE POLICY "Users manage own alerts"
  ON alert_subscriptions FOR ALL USING (auth.uid() = user_id);

-- ── TRIGGERS ──────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO profiles (id, email)
  VALUES (NEW.id, NEW.email)
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS profiles_updated_at ON profiles;
CREATE TRIGGER profiles_updated_at
  BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ═════════════════════════════════════════════════════════════════════════════
-- v6.1 MIGRATION BLOCK — safe to run repeatedly
-- Adds programme intelligence, headcount estimate, function-level risk,
-- bankruptcy distinction, large-employer flag, and extends company_state
-- ═════════════════════════════════════════════════════════════════════════════

-- companies: cache the intelligence objects for cache-hit responses
ALTER TABLE companies ADD COLUMN IF NOT EXISTS cached_programme           JSONB;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS cached_headcount           JSONB;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS cached_function_risk       JSONB;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS cached_bankruptcy          JSONB;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS cached_large_employer_flag BOOLEAN DEFAULT FALSE;

-- score_history: persist intelligence fields per-score for audit + trend analysis
ALTER TABLE score_history ADD COLUMN IF NOT EXISTS programme_name          TEXT;
ALTER TABLE score_history ADD COLUMN IF NOT EXISTS programme_total_size    BIGINT;
ALTER TABLE score_history ADD COLUMN IF NOT EXISTS programme_recognised    BIGINT;
ALTER TABLE score_history ADD COLUMN IF NOT EXISTS headcount_estimate_low  INTEGER;
ALTER TABLE score_history ADD COLUMN IF NOT EXISTS headcount_estimate_mid  INTEGER;
ALTER TABLE score_history ADD COLUMN IF NOT EXISTS headcount_estimate_high INTEGER;
ALTER TABLE score_history ADD COLUMN IF NOT EXISTS at_risk_functions       TEXT[];
ALTER TABLE score_history ADD COLUMN IF NOT EXISTS protected_functions     TEXT[];
ALTER TABLE score_history ADD COLUMN IF NOT EXISTS bankruptcy_detected     BOOLEAN DEFAULT FALSE;
ALTER TABLE score_history ADD COLUMN IF NOT EXISTS bankruptcy_chapter      TEXT;
ALTER TABLE score_history ADD COLUMN IF NOT EXISTS bankruptcy_filing_date  DATE;
ALTER TABLE score_history ADD COLUMN IF NOT EXISTS large_employer_flag     BOOLEAN DEFAULT FALSE;

-- Extend company_state CHECK to include ACTIVE_MULTI_YEAR.
-- Drop any existing constraint on the column, then re-add with the new set.
DO $$
DECLARE
  con_name TEXT;
BEGIN
  -- companies.cached_state
  SELECT conname INTO con_name FROM pg_constraint c
    JOIN pg_attribute a ON a.attnum = ANY(c.conkey) AND a.attrelid = c.conrelid
    WHERE c.conrelid = 'companies'::regclass
      AND a.attname = 'cached_state' AND c.contype = 'c'
    LIMIT 1;
  IF con_name IS NOT NULL THEN
    EXECUTE 'ALTER TABLE companies DROP CONSTRAINT ' || quote_ident(con_name);
  END IF;
  ALTER TABLE companies ADD CONSTRAINT companies_cached_state_check
    CHECK (cached_state IS NULL OR cached_state IN
      ('CLEAR','WATCHING','ACTIVE','ACTIVE_MULTI_YEAR','CONTINUATION_RISK'));

  -- score_history.company_state
  SELECT conname INTO con_name FROM pg_constraint c
    JOIN pg_attribute a ON a.attnum = ANY(c.conkey) AND a.attrelid = c.conrelid
    WHERE c.conrelid = 'score_history'::regclass
      AND a.attname = 'company_state' AND c.contype = 'c'
    LIMIT 1;
  IF con_name IS NOT NULL THEN
    EXECUTE 'ALTER TABLE score_history DROP CONSTRAINT ' || quote_ident(con_name);
  END IF;
  ALTER TABLE score_history ADD CONSTRAINT score_history_company_state_check
    CHECK (company_state IS NULL OR company_state IN
      ('CLEAR','WATCHING','ACTIVE','ACTIVE_MULTI_YEAR','CONTINUATION_RISK'));

  -- bankruptcy_chapter check
  BEGIN
    ALTER TABLE score_history ADD CONSTRAINT score_history_bankruptcy_chapter_check
      CHECK (bankruptcy_chapter IS NULL OR bankruptcy_chapter IN ('7','11','15'));
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
END $$;

-- Indexes supporting new query patterns
CREATE INDEX IF NOT EXISTS score_history_programme_idx
  ON score_history(programme_name) WHERE programme_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS score_history_bankruptcy_idx
  ON score_history(bankruptcy_detected, scored_at DESC) WHERE bankruptcy_detected = TRUE;

-- ── TABLE SUMMARY ────────────────────────────────────────────────────────────
-- profiles, score_usage, companies, watchlist, score_history, predictions,
-- hiring_velocity_snapshots, quarterly_signal_status, role_taxonomy,
-- analytics_events, beta_signups, alert_subscriptions
-- Total: 12 tables (v6.1 adds columns, not tables)
