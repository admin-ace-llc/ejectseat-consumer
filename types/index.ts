// types/index.ts — EjectSeat Consumer v7
// Single source of truth for all shared types.
// v7: comprehensive intelligence object replaces multi-signal accumulation.
//     Old Signal[] preserved as `legacySignals` for UI backward compatibility
//     and for the audit strip showing what was in the evidence bundle.

// ─────────────────────────────────────────────────────────────────────────────
// BANDS / TIERS
// ─────────────────────────────────────────────────────────────────────────────

export type RiskBand = 'HIGH' | 'MEDIUM' | 'LOW';
export type Confidence = 'high' | 'medium' | 'low' | 'signal_awaited';
export type UserTier = 'free' | 'registered';
export type SourceTier = 'sec' | 'tier_a' | 'tier_b' | 'tier_c' | 'transcript' | 'excluded';
export type TemporalTag = 'Predictive' | 'Upcoming' | 'Context';
export type FilingStatus = 'awaited' | 'filed' | 'overdue';
export type ConfidenceTier = 'high' | 'medium' | 'low';
export type ChargeType =
  | 'first_appearance'
  | 'continuation_with_liability'
  | 'continuation_expensed'
  | 'historical';

// ─────────────────────────────────────────────────────────────────────────────
// STATE MACHINE (4 states — decided with user)
// ─────────────────────────────────────────────────────────────────────────────

export type CompanyState =
  | 'CLEAR'              // no material signals
  | 'WATCH'              // forward indicators, no confirmed event
  | 'LIKELY'             // multiple corroborating signals, strong forward probability
  | 'ACTIVE';            // confirmed layoffs in motion OR mid-cycle programme

// v6.1 compatibility aliases (used by DB rows written before v7 deploy)
export type LegacyCompanyState =
  | 'CLEAR' | 'WATCHING' | 'ACTIVE' | 'ACTIVE_MULTI_YEAR' | 'CONTINUATION_RISK';

export function normaliseLegacyState(s: LegacyCompanyState | CompanyState | string | null | undefined): CompanyState {
  if (!s) return 'CLEAR';
  if (s === 'WATCHING') return 'WATCH';
  if (s === 'ACTIVE_MULTI_YEAR') return 'ACTIVE';
  if (s === 'CONTINUATION_RISK') return 'LIKELY';
  if (s === 'CLEAR' || s === 'WATCH' || s === 'LIKELY' || s === 'ACTIVE') return s;
  return 'CLEAR';
}

// ─────────────────────────────────────────────────────────────────────────────
// EVIDENCE BUNDLE — what we hand to Sonnet
// ─────────────────────────────────────────────────────────────────────────────

export interface FilingEvidence {
  accession:   string;
  form:        string;   // 8-K, 10-K, 10-Q, 20-F, 6-K, NT 10-K, etc.
  filingDate:  string;   // YYYY-MM-DD
  url:         string;
  text:        string;   // stripped, truncated filing body
}

export interface TranscriptEvidence {
  source:       'motley_fool' | 'other';
  ticker:       string;
  quarterLabel: string;         // e.g. "Q3 FY2025"
  publishedAt:  string | null;  // ISO date if known
  url:          string;
  preparedRemarks: string;
  qAndA:           string;
}

export interface NewsEvidence {
  title:       string;
  link:        string;
  pubDate:     string;           // YYYY-MM-DD
  source:      string;           // e.g. "Reuters"
  tier:        'tier_a' | 'tier_b' | 'tier_c';
  description: string;
}

export interface HeadcountRecord {
  fiscalYear: number;
  employees:  number;
}

export interface EvidenceBundle {
  company:          string;
  ticker:           string | null;
  cik:              string | null;
  companyFacts:     any | null;      // raw EDGAR companyfacts JSON
  filings:          FilingEvidence[];
  transcripts:      TranscriptEvidence[];
  news:             NewsEvidence[];
  headcountHistory: HeadcountRecord[];
  generatedAt:      string;
}

// ─────────────────────────────────────────────────────────────────────────────
// INTELLIGENCE OUTPUT — what Sonnet returns (strict JSON schema)
// ─────────────────────────────────────────────────────────────────────────────

export interface IntelligenceConfirmedEvent {
  description:     string;
  date:            string | null;
  source_ref:      string;         // accession or URL from bundle — must match
  source_quote:    string;         // direct quote from the evidence
  roles_affected:  number | null;
  programme_name:  string | null;
  filing_type:     string | null;  // "8-K Item 2.05" etc.
}

export interface IntelligenceForwardSignal {
  signal_type:  'activist_pressure' | 'sustained_losses' | 'ceo_language'
             | 'cost_pressure' | 'headcount_drop' | 'impairment'
             | 'nt_filing' | 'strategic_distress' | 'profitability_pivot'
             | 'restructuring_charge' | 'other';
  description:  string;
  source_ref:   string;            // accession / URL / tier name
  source_quote: string;
  severity:     1 | 2 | 3 | 4;     // 1 = most severe
  forward_looking: boolean;
  escalation_type: 'escalation' | 'completion' | 'neutral';
  inferred:     boolean;           // true = inference beyond explicit statement
}

export type ProgrammePhase = 'early' | 'mid' | 'late' | 'complete' | 'unknown';

export interface ProgrammeIntelligence {
  name:                    string | null;
  total_size_usd:          number | null;
  recognised_to_date_usd:  number | null;
  remaining_usd:           number | null;
  timeline:                'one_time' | 'multi_year' | 'unknown';
  phase:                   ProgrammePhase;
  severance_component_pct: number | null;
  evidence_quote:          string | null;
  source_filings:          string[];   // accession numbers
}

export interface HeadcountEstimate {
  low:              number | null;
  mid:              number | null;
  high:             number | null;
  basis:            string;
  pct_of_workforce: number | null;
  confidence:       ConfidenceTier;
  inferred:         boolean;
}

export interface FunctionRisk {
  function:   string;
  confidence: ConfidenceTier;
  evidence:   string;
  source_ref: string;
}

export interface FunctionRiskMap {
  at_risk:       FunctionRisk[];
  protected:     FunctionRisk[];
  unstated_note: string | null;
}

export interface BankruptcyFiling {
  detected:              boolean;
  chapter:               '7' | '11' | '15' | null;
  filing_date:           string | null;
  filing_accession:      string | null;
  description:           string | null;
  evidence_quote:        string | null;
  debtor_in_possession:  boolean | null;
  affected_subsidiaries: string[];
}

export type TrajectoryDirection = 'escalating' | 'stable' | 'completing' | 'unknown';

export interface WavesIntelligence {
  waves_confirmed:       number;              // 0, 1, 2, 3...
  further_waves_signal:  string | null;       // CEO language / filings pointing to more
  evidence_quote:        string | null;
  confidence:            ConfidenceTier;
}

export interface ComprehensiveIntelligence {
  state:              CompanyState;
  score:              number;                   // within state band
  confidence:         ConfidenceTier;
  low_confidence_reason: string | null;
  confirmed_events:   IntelligenceConfirmedEvent[];
  forward_signals:    IntelligenceForwardSignal[];
  programme:          ProgrammeIntelligence;
  headcount:          HeadcountEstimate;
  function_risk:      FunctionRiskMap;
  bankruptcy:         BankruptcyFiling;
  waves:              WavesIntelligence;
  trajectory:         TrajectoryDirection;
  large_employer_flag: boolean;
  summary:            string;                   // 3-4 sentence brief, ≤ 50 words
  reasoning_chain:    string;                   // Sonnet's chain of thought
  requires_review:    boolean;                  // set by validator on disagreement
  validator_notes:    string[];                 // what post-validation caught
}

// ─────────────────────────────────────────────────────────────────────────────
// LEGACY — preserved for UI audit strip + pipeline_comparison writes
// ─────────────────────────────────────────────────────────────────────────────

export interface Signal {
  type:             string;
  source:           string;
  sourceTier:       SourceTier;
  rawPoints:        number;
  weightedPoints:   number;
  temporalTag:      TemporalTag;
  alertMessage:     string;
  filingDate?:      string;
  chargeType?:      ChargeType;
  edgarFilingUrl?:  string;
  verified?:        boolean;
  verifyNote?:      string;
  escalationType?:  'escalation' | 'completion' | 'neutral';
}

export interface ConfirmedEvent {
  description:     string;
  date:            string;
  source:          string;
  rolesAffected:   number | null;
  filingRef:       string | null;
  type?:           'warn_act' | 'official_announcement';
  weightedPoints?: 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// ELIGIBILITY / STATUS
// ─────────────────────────────────────────────────────────────────────────────

export interface CompanyEligibility {
  isUSListed:           boolean;
  isPublicCompany:      boolean;
  secFilingFound:       boolean;
  cik?:                 string;
  legalName?:           string;
  ticker?:              string;
  ineligibilityReason?: string;
}

export interface QuarterlyStatus {
  filingStatus:          FilingStatus;
  expectedFilingDate?:   string;
  signalAwaitedMessage?: string;
  fiscalYearEnd?:        string;
  currentQuarterLabel?:  string;
  lastFiledDate?:        string;
  lastFiledForm?:        string;
  daysUntilDue?:         number;
}

export interface ScoreDisclaimer {
  productScope:       string;
  signalNature:       string;
  dataSource:         string;
  userGuidance?:      string;
  lastUpdated:        string;
  companyEligibility: CompanyEligibility;
}

// ─────────────────────────────────────────────────────────────────────────────
// RISK SCORE — final shape returned by /api/score (response contract)
// Preserves v6.1 top-level keys so the frontend keeps rendering during deploy.
// v7 adds `intelligence` object; the UI can feature-detect and light up new
// cards without breaking on missing fields.
// ─────────────────────────────────────────────────────────────────────────────

export interface RiskScore {
  // Core (v5 onwards, preserved)
  score:           number;
  band:            RiskBand;
  confidence?:     Confidence;        // optional: cache hits / early-return paths don't compute
  companyState?:   CompanyState;
  stateFloor?:     number;
  stateCeiling?:   number;
  signals:         Signal[];          // audit-strip signals from the bundle
  confirmedEvents: ConfirmedEvent[];  // legacy surface — mirrored from intelligence
  confirmedEvent?: ConfirmedEvent | null;
  disclaimer:      ScoreDisclaimer;
  quarterlyStatus?: QuarterlyStatus;
  claudeSummary?:   string;
  scoreHistory?:    any[];

  // v6.1 surfaced shapes (preserved for UI continuity)
  programme?:          ProgrammeIntelligence | null;
  headcount?:          HeadcountEstimate | null;
  function_risk?:      FunctionRiskMap | null;
  bankruptcy?:         BankruptcyFiling | null;
  large_employer_flag?: boolean;

  // v7 NEW — full intelligence object
  intelligence?: ComprehensiveIntelligence | null;

  // v7 meta
  pipelineVersion: 'v5' | 'v6.1' | 'v7';
  requiresReview?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// LANDINGZONE
// ─────────────────────────────────────────────────────────────────────────────

export interface LandingZoneCompany {
  companyName:   string;
  ticker?:       string;
  hiringVelocity: number;
  hiringTrend:   'surge' | 'stable' | 'declining';
  roleMatches?:  RoleMatch[];
  matchScore?:   number;
  matchTier?:    'excellent' | 'good' | 'fair';
  matchReason?:  string;
  geoSignal:     GeoSignal;
  openRoles:     number;
}

export interface RoleMatch {
  roleType:  string;
  tier:      string;
  openCount: number;
}

export interface GeoSignal {
  matchState: 'match' | 'potential' | 'mismatch';
  remote:     boolean;
  locations:  string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// API REQUESTS
// ─────────────────────────────────────────────────────────────────────────────

export interface ScoreApiRequest {
  companyName: string;
  ticker?:     string;
}

export interface LandingZoneRequest {
  country?:      string;
  remote?:       boolean;
  roleFunction?: string;
  roleTier?:     string;
}
