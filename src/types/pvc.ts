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
}

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
  productivityTierPeriod: ProductivityTierPeriod;
  productivityTiersActive: boolean;        // Phase 3 sub-flag; default false

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
  productivityTierMode: 'stacked',
  productivityTierPeriod: 'monthly',
  productivityTiersActive: false,
};

export const DEFAULT_USER_PVC_SETTINGS: UserPvcSettings = {
  meetingRvuRateOverride: null,
};
