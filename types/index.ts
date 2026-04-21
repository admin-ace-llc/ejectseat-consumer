// types/index.ts — EjectSeat Consumer shared types
// v6.1: extended with programme intelligence, headcount estimates,
// function-level risk, and bankruptcy distinction

export type RiskBand = 'HIGH' | 'MEDIUM' | 'LOW';
export type Confidence = 'high' | 'medium' | 'low' | 'signal_awaited';
export type UserTier = 'free' | 'registered';
export type SourceTier = 'sec' | 'tier_a' | 'tier_b' | 'tier_c' | 'excluded';
export type ChargeType =
  | 'first_appearance'
  | 'continuation_with_liability'
  | 'continuation_expensed'
  | 'historical';
export type TemporalTag = 'Predictive' | 'Upcoming' | 'Context';
export type FilingStatus = 'awaited' | 'filed' | 'overdue';
export type ConfidenceTier = 'high' | 'medium' | 'low';

export interface Signal {
  type: string;
  source: string;
  sourceTier: SourceTier;
  rawPoints: number;
  weightedPoints: number;
  temporalTag: TemporalTag;
  alertMessage: string;
  filingDate?: string;
  chargeType?: ChargeType;
  edgarFilingUrl?: string;
  verified?: boolean;
  verifyNote?: string;
  escalationType?: 'escalation' | 'completion' | 'neutral';
}

export interface ConfirmedEvent {
  description:   string;
  date:          string;
  source:        string;
  rolesAffected: number | null;
  filingRef:     string | null;
  type?:         'warn_act' | 'official_announcement';
  weightedPoints?: 0;
}

export interface ScoreDisclaimer {
  productScope: string;
  signalNature: string;
  dataSource: string;
  userGuidance?: string;
  lastUpdated: string;
  companyEligibility: CompanyEligibility;
}

export interface CompanyEligibility {
  isUSListed: boolean;
  isPublicCompany: boolean;
  secFilingFound: boolean;
  cik?: string;
  legalName?: string;
  ineligibilityReason?: string;
}

export interface QuarterlyStatus {
  filingStatus: FilingStatus;
  expectedFilingDate?: string;
  signalAwaitedMessage?: string;
  fiscalYearEnd?: string;
  currentQuarterLabel?: string;
}

export interface ScoreBreakdown {
  sec: number;
  earnings: number;
  media: number;
  corroborationBonus: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// v6.1 — Programme intelligence
// ─────────────────────────────────────────────────────────────────────────────

export type ProgrammePhase = 'early' | 'mid' | 'late' | 'complete' | 'unknown';

export interface ProgrammeIntelligence {
  name: string | null;
  total_size_usd: number | null;
  recognised_to_date_usd: number | null;
  remaining_usd: number | null;
  timeline: 'one_time' | 'multi_year' | 'unknown';
  phase: ProgrammePhase;
  severance_component_pct: number | null;
  evidence_quote: string | null;
  source_filings: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// v6.1 — Headcount estimate from severance math
// ─────────────────────────────────────────────────────────────────────────────

export interface HeadcountEstimate {
  low: number | null;
  mid: number | null;
  high: number | null;
  basis: string;
  pct_of_workforce: number | null;
  confidence: ConfidenceTier;
}

// ─────────────────────────────────────────────────────────────────────────────
// v6.1 — Function-level risk
// ─────────────────────────────────────────────────────────────────────────────

export interface FunctionRisk {
  function: string;
  confidence: ConfidenceTier;
  evidence: string;
}

export interface FunctionRiskMap {
  at_risk: FunctionRisk[];
  protected: FunctionRisk[];
  unstated_note: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// v6.1 — Bankruptcy distinction
// Court-supervised process — different employee implications from voluntary RIF
// ─────────────────────────────────────────────────────────────────────────────

export interface BankruptcyFiling {
  detected: boolean;
  chapter: '7' | '11' | '15' | null;
  filing_date: string | null;
  filing_accession: string | null;
  description: string | null;
  evidence_quote: string | null;
  debtor_in_possession: boolean | null;
  affected_subsidiaries: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// v6.1 — Comprehensive analysis output (single Sonnet call)
// ─────────────────────────────────────────────────────────────────────────────

export interface ComprehensiveIntelligence {
  programme: ProgrammeIntelligence;
  headcount: HeadcountEstimate;
  function_risk: FunctionRiskMap;
  bankruptcy: BankruptcyFiling;
  large_employer_flag: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Risk score — v6.1 extended with programme/headcount/function-risk/bankruptcy
// ─────────────────────────────────────────────────────────────────────────────

export interface RiskScore {
  score: number;
  band: RiskBand;
  confidence: Confidence;
  companyState?: string;
  signals: Signal[];
  confirmedEvents: ConfirmedEvent[];
  breakdown?: ScoreBreakdown;
  disclaimer: ScoreDisclaimer;
  quarterlyStatus?: QuarterlyStatus;
  claudeSummary?: string;
  scoreHistory?: any[];
  // v6.1 additions
  programme?: ProgrammeIntelligence;
  headcount?: HeadcountEstimate;
  function_risk?: FunctionRiskMap;
  bankruptcy?: BankruptcyFiling;
  large_employer_flag?: boolean;
}

export interface LandingZoneCompany {
  companyName: string;
  ticker?: string;
  hiringVelocity: number;
  hiringTrend: 'surge' | 'stable' | 'declining';
  roleMatches?: RoleMatch[];
  matchScore?: number;
  matchTier?: 'excellent' | 'good' | 'fair';
  matchReason?: string;
  geoSignal: GeoSignal;
  openRoles: number;
}

export interface RoleMatch {
  roleType: string;
  tier: string;
  openCount: number;
}

export interface GeoSignal {
  matchState: 'match' | 'potential' | 'mismatch';
  remote: boolean;
  locations: string[];
}

export interface ScoreApiRequest {
  companyName: string;
  ticker?: string;
}

export interface LandingZoneRequest {
  country?: string;
  remote?: boolean;
  roleFunction?: string;
  roleTier?: string;
}
