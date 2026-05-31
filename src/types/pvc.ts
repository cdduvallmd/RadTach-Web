// Practice Value Customization (PVC) types
// Plan: /Users/charlesduvall/.claude/plans/vast-snuggling-kernighan.md
//
// PVC layers compensation accounting on top of the existing session/RVU model:
// shift credits per day, rotation bonus RVU, CPT-level wRVU adjustments,
// meeting RVU, and optional productivity tiers. Feature-flagged per system.

export interface RotationOverlay {
  shiftCount: number;              // 1.0 default; 2.0 for WEEKEND CALL 1/2; 0 for Unassigned
  bonusRvu: number;                // 0 default; e.g., 3.25 for South, 1.75 for Yukon
  bonusHalvesOnHalfDay: boolean;   // default true
  contributesToShiftCount: boolean;// false for Unassigned, true otherwise
  // Flat wRVU credit that REPLACES the session's accrued wRVU when this is the
  // qualifying session of the day. Null = no override (normal accrual).
  // Used for rotations like FLUORO where a rad covering for the PA receives a
  // fixed RVU credit regardless of which studies they read during the shift.
  // Non-qualifying sessions on a flat-RVU rotation contribute 0 wRVU (the rule
  // applies all day, not just to the qualifying session).
  flatRvuOverride?: number | null;
}

export type CptAdjustmentMatchType =
  | 'modality'
  | 'bodyPart'
  | 'cptPrefix'
  | 'cptList'
  | 'description';

export interface CptAdjustment {
  id: string;                          // uuid for editing
  label: string;                       // human-readable, e.g. "Plain films +0.1"
  matchType: CptAdjustmentMatchType;
  matchValue: string | string[];       // single string for modality/bodyPart/cptPrefix/description; array for cptList
  operation: 'add' | 'multiply';
  amount: number;
  appliedToWorkRvuOnly: boolean;       // default true; reserved for future PE/MP support
  disabled?: boolean;                  // soft toggle without delete
  // Restrict this adjustment to studies started on one of these rotations.
  // null/undefined/empty = applies on all rotations. Example: arthrogram 2x
  // multiplier scoped to ["South", "I-35 Arthro"].
  applicableToRotations?: string[] | null;
  // When true, the adjustment only applies if the StudyEvent has
  // personallyPerformed === true. UI for setting that flag is not yet wired;
  // set this true on configs that should remain dormant until it is.
  requiresPersonallyPerformed?: boolean;
}

// Productivity tier row. `multiplier` is the bonus-shifts-per-RVU rate that
// applies to Adjusted wRVU within this tier's slice (from this threshold up to
// the next threshold). In 'marginal' mode each tier contributes only its
// slice; in 'stacked' mode each tier contributes (avg - threshold) * multiplier
// when avg ≥ threshold.
//
// User's group canonical formula (2026-05-27):
//   tier 1: { threshold: 50, multiplier: 0.02 }   // (avg-50)/50 in [50,60]
//   tier 2: { threshold: 60, multiplier: 0.01667 } // (avg-60)/60 above 60 (80% rate)
//   mode: 'marginal'
//   allowNegativeBonus: true
//   computationPeriod: 'monthly'
export interface ProductivityTier {
  thresholdDailyWrvu: number;
  multiplier: number;
}

export type ProductivityTierMode = 'stacked' | 'marginal';
export type ProductivityTierPeriod = 'daily' | 'monthly' | 'quarterly';
export type ShiftLabel = 'shift' | 'workingDay';

export interface PvcConfig {
  enabled: boolean;
  shiftValue: number | null;               // null = no $ estimate
  shiftLabel: ShiftLabel;                  // 'shift' if priced, else 'workingDay'
  fiscalYearStartMonthDay: string | null;  // "MM-DD" or null = calendar quarters
  defaultMeetingRvuRate: number;           // default 7

  rotationConfig: Record<string, RotationOverlay>;

  cptAdjustments: CptAdjustment[];

  productivityTiers: ProductivityTier[];
  productivityTierMode: ProductivityTierMode;
  productivityTierPeriod: ProductivityTierPeriod;  // Adjusted wRVU averaging window
  productivityTiersActive: boolean;        // sub-flag; default false until math is verified
  allowNegativeBonus: boolean;             // default true — months below lowest threshold deduct shifts

  updatedAt?: unknown;                     // Firestore Timestamp
  updatedBy?: string;
}

export interface UserPvcSettings {
  meetingRvuRateOverride: number | null;   // 11 for President, null = use system default
}

// Output of computeShiftCredit at session start
export interface ShiftCredit {
  pvcShiftCredit: number;     // 0, 0.5, 1.0, 2.0, etc.
  pvcBonusRvu: number;        // 0 if no bonus or already claimed
  pvcRotationAtStart: string; // frozen rotation name
  // null = no wRVU override (normal accrual). 0 = zero out wRVU for this
  // session (e.g., a non-qualifying FLUORO session). Positive = flat RVU
  // credit (e.g., 60 on a qualifying FLUORO session).
  pvcWrvuOverride: number | null;
}

// Convenience: what a Phase 1 default config looks like
export const DEFAULT_PVC_CONFIG: PvcConfig = {
  enabled: false,
  shiftValue: null,
  shiftLabel: 'workingDay',
  fiscalYearStartMonthDay: null,
  defaultMeetingRvuRate: 7,
  rotationConfig: {},
  cptAdjustments: [],
  productivityTiers: [],
  productivityTierMode: 'marginal',
  productivityTierPeriod: 'monthly',
  productivityTiersActive: false,
  allowNegativeBonus: true,
};

export const DEFAULT_USER_PVC_SETTINGS: UserPvcSettings = {
  meetingRvuRateOverride: null,
};
