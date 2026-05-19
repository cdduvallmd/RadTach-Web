// Shared type definitions for RadTach Reports infrastructure
// Used by: periodAggregation, hooks, report tabs, Firestore queries

export type { SessionSummary } from '../utils/sessionSummary';

// ── Core Session Types ────────────────────────────────────────────────────────

export interface SessionNotes {
  tags: string[];
  description: string;
}

export interface StoredSession {
  id: string;                          // Firestore doc ID
  sessionId: string;                   // formatted YYYYMMDD-##-uid
  userAbbrev: string;
  workstationId: string;
  system: string;
  rotation: string;
  halfDay: boolean;
  startDateTime: string;               // ISO 8601
  stopDateTime: string;
  totalSessionTime: number;
  studiesCompleted: number;
  deletedStudies: number;
  cumulativeParTime: number;
  interstitialTime: number;
  adminTime: number;
  adminEvents: number;
  commsTime: number;
  commsEvents: number;
  breakTime: number;
  breakEvents: number;
  doubleTapTime: number;
  doubleTapEvents: number;
  swapEvents?: number;
  totalRVU: number;
  verifiedRVU?: number | null;
  notes?: SessionNotes;
  displayName?: string;
  summary?: import('../utils/sessionSummary').SessionSummary;
}

// ── Date & Role ───────────────────────────────────────────────────────────────

export interface DateRange {
  start: Date;
  end: Date;
}

export type UserRole = 'radiologist' | 'admin' | 'president' | 'hospitalAdmin' | 'it' | 'globalAdmin';
export type EffectiveRole = 'radiologist' | 'admin' | 'president' | 'hospitalAdmin' | 'it';

// ── Statistics ────────────────────────────────────────────────────────────────

export interface DistributionStats {
  mean: number;
  median: number;
  p25: number;
  p50: number;
  p75: number;
  stdDev: number;
  n: number;
}

// ── Group / Composite / Workstation Stats (Tier 3) ────────────────────────────

export interface GroupStats {
  date: string;
  system: string;
  sessionCount: number;
  rvuPerHour: DistributionStats;
  productiveRatio: DistributionStats;
  avgVariance: DistributionStats;
  studiesPerHour: DistributionStats;
  interstitialAvg: DistributionStats;
  tagFrequency: Record<string, number>;
  groupTotals: {
    totalRVU: number;
    totalStudies: number;
    totalSessionHours: number;
    totalAdminHours: number;
    totalCommsHours: number;
    totalBreakHours: number;
  };
  groupTotalsByModality: Record<string, { studies: number; rvu: number }>;
  byModality: Record<string, {
    rvuPerHour: DistributionStats;
    avgVariance: DistributionStats;
    studyCount: DistributionStats;
  }>;
  byRotation: Record<string, {
    rvuPerHour: DistributionStats;
  }>;
}

export interface CompositeStats {
  date: string;
  systemsContributing: string[];
  sessionCount: number;
  rvuPerHour: DistributionStats;
  productiveRatio: DistributionStats;
  avgVariance: DistributionStats;
  studiesPerHour: DistributionStats;
  interstitialAvg: DistributionStats;
  byModality: Record<string, {
    rvuPerHour: DistributionStats;
    avgVariance: DistributionStats;
    studyCount: DistributionStats;
  }>;
}

export interface WorkstationStats {
  date: string;
  system: string;
  workstations: Record<string, {
    bottom5Avg: DistributionStats;
    sameModalityFloor: DistributionStats;
    sessionCount: number;
  }>;
}

// ── Period Summary (Tier 2 aggregation output) ────────────────────────────────

export interface PeriodSummary {
  dateRange: DateRange;
  sessions: StoredSession[];
  totalSessions: number;
  fullDaySessions: number;
  halfDaySessions: number;
  totalStudies: number;
  totalRVU: number;
  avgRVUPerHour: number;
  avgVariance: number;
  avgProductiveRatio: number;
  totalStudyTime: number;
  totalInterstitialTime: number;
  totalAdminTime: number;
  totalCommsTime: number;
  totalBreakTime: number;
  totalDoubleTapTime: number;
  studiesByModality: Record<string, number>;
  rvuByModality: Record<string, number>;
  rvuPerHourByModality: Record<string, number>;
  avgVarianceByModality: Record<string, number>;
  sessionsByRotation: Record<string, number>;
  rvuPerHourByRotation: Record<string, number>;
  avgVarianceByRotation: Record<string, number>;
  sessionsByDayOfWeek: Record<string, number>;
  avgRVUPerHourByDayOfWeek: Record<string, number>;
  tagFrequency: Record<string, number>;
  tagCorrelatedMetrics: Record<string, {
    sessionCount: number;
    avgRVUPerHour: number;
    avgVariance: number;
  }>;
  avgBreaksPerSession: number;
  avgInterstitialPerStudy: number;
  complicationCostAggregated: Record<string, {
    avgActualTimeAdded: number;
    parTimeAllotment: number;
    totalOccurrences: number;
  }>;
  bestSession: {
    date: string;
    rvuPerHour: number;
    studies: number;
    productiveRatio: number;
  } | null;
  totalVerifiedRVU: number;
  sessionsWithVerifiedRVU: number;
  sessionDataPoints: Array<{
    date: string;
    rvuPerHour: number;
    variance: number;
    productiveRatio: number;
    studies: number;
    totalRVU: number;
    interstitialAvg: number;
    rvuPerStudy: number;
    studiesPerHour: number;
  }>;
  // Performance Insights
  hourlyProfile: Record<string, { avgStudies: number; avgRvu: number; sessionCount: number }>;
  avgRvuPerStudy: number;
  avgStudiesPerHour: number;
  fastestCpts: Array<{ cpt: string; modality: string; avgVariance: number; totalCount: number }>;
  slowestCpts: Array<{ cpt: string; modality: string; avgVariance: number; totalCount: number }>;
  avgWarmupCost: number | null;
  avgBreakROI: { avgBefore: number | null; avgAfter: number | null; totalBreaks: number };
  avgTransitionPenalty: { same: number | null; different: number | null };
  avgInterstitialTime: number;
}
