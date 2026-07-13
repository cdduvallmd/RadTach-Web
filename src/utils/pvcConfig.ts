// Practice Value Customization — pure utility functions
// Plan: /Users/charlesduvall/.claude/plans/vast-snuggling-kernighan.md
//
// No React, no Firestore — all functions are pure. Callers handle I/O.

import type { CptEntry } from '../types/cpt';
import type {
  PvcConfig,
  RotationOverlay,
  CptAdjustment,
  ProductivityTier,
  ProductivityTierMode,
  ShiftCredit,
} from '../types/pvc';

const UNASSIGNED = 'Unassigned';

// Default overlay for a rotation that has no entry in pvc.rotationConfig.
// Unassigned is the only name with a different shape — it does not earn credit.
export function getDefaultRotationOverlay(rotationName: string): RotationOverlay {
  if (rotationName === UNASSIGNED) {
    return {
      shiftCount: 0,
      bonusShiftCredit: 0,
      bonusRvu: 0,
      bonusHalvesOnHalfDay: false,
      contributesToShiftCount: false,
      flatRvuOverride: null,
    };
  }
  return {
    shiftCount: 1.0,
    bonusShiftCredit: 0,
    bonusRvu: 0,
    bonusHalvesOnHalfDay: true,
    contributesToShiftCount: true,
    flatRvuOverride: null,
  };
}

// Look up the effective overlay for a rotation, falling back to defaults if
// the practice has not explicitly configured it.
export function resolveRotationOverlay(
  rotationName: string,
  config: PvcConfig,
): RotationOverlay {
  return config.rotationConfig[rotationName] ?? getDefaultRotationOverlay(rotationName);
}

// Shift-credit rule (locked-in by user):
// - One credit per day, not per rotation.
// - Awarded to the first non-Unassigned rotation of the day.
// - Unassigned never claims the day's bonus slot — a later real rotation still earns.
// - Half-day halves shift credit always; halves bonus only if overlay.bonusHalvesOnHalfDay.
//
// Caller is responsible for filtering `todaysPriorSessions` to the same calendar
// day in the user's timezone.
export function computeShiftCredit(
  rotationName: string,
  halfDay: boolean,
  todaysPriorSessions: Array<{ pvcShiftCredit?: number }>,
  config: PvcConfig,
): ShiftCredit {
  const overlay = resolveRotationOverlay(rotationName, config);
  const hasFlat = typeof overlay.flatRvuOverride === 'number';

  // Unassigned (or any other non-contributing rotation): never claims, never earns.
  if (!overlay.contributesToShiftCount) {
    return {
      pvcShiftCredit: 0,
      pvcBonusShiftCredit: 0,
      pvcBonusRvu: 0,
      pvcRotationAtStart: rotationName,
      pvcWrvuOverride: hasFlat ? 0 : null,
    };
  }

  // Day's bonus slot already claimed by an earlier qualifying session?
  const alreadyClaimed = todaysPriorSessions.some(s => (s.pvcShiftCredit ?? 0) > 0);
  if (alreadyClaimed) {
    // Subsequent sessions on a flat-RVU rotation still get zeroed out wRVU.
    return {
      pvcShiftCredit: 0,
      pvcBonusShiftCredit: 0,
      pvcBonusRvu: 0,
      pvcRotationAtStart: rotationName,
      pvcWrvuOverride: hasFlat ? 0 : null,
    };
  }

  const shiftMultiplier = halfDay ? 0.5 : 1.0;
  const bonusMultiplier = halfDay && overlay.bonusHalvesOnHalfDay ? 0.5 : 1.0;

  return {
    pvcShiftCredit: overlay.shiftCount * shiftMultiplier,
    // Bonus shift credit scales with shiftMultiplier (same as shiftCount),
    // not with bonusHalvesOnHalfDay — that flag governs the RVU bonus only.
    pvcBonusShiftCredit: (overlay.bonusShiftCredit ?? 0) * shiftMultiplier,
    pvcBonusRvu: overlay.bonusRvu * bonusMultiplier,
    pvcRotationAtStart: rotationName,
    // Half-day on a flat-RVU rotation: scale the flat amount proportionally.
    pvcWrvuOverride: hasFlat ? (overlay.flatRvuOverride as number) * shiftMultiplier : null,
  };
}

// Context passed alongside the CPT entry when evaluating adjustments. Optional
// fields gate adjustments that scope to a rotation or to personally-performed
// studies. Callers that don't have the context (e.g., modality-only path) can
// omit it; in that case rotation-filtered or personally-performed adjustments
// are skipped.
export interface AdjustmentMatchContext {
  rotation?: string | null;
  personallyPerformed?: boolean;
}

// Does an adjustment rule match a given CPT entry?
function adjustmentMatches(
  adjustment: CptAdjustment,
  entry: CptEntry | undefined,
  ctx?: AdjustmentMatchContext,
): boolean {
  if (adjustment.disabled) return false;
  if (!entry) {
    // Adjustments matching by modality alone can still apply when caller passes
    // a synthetic entry; if entry is missing entirely, skip.
    return false;
  }

  // Rotation filter — adjustment only fires on listed rotations.
  if (adjustment.applicableToRotations && adjustment.applicableToRotations.length > 0) {
    if (!ctx?.rotation) return false;
    if (!adjustment.applicableToRotations.includes(ctx.rotation)) return false;
  }

  // Personally-performed gate — adjustment only fires when the study event was
  // flagged. UI to set the flag is pending; configurations using this gate stay
  // dormant until then.
  if (adjustment.requiresPersonallyPerformed && !ctx?.personallyPerformed) {
    return false;
  }

  const v = adjustment.matchValue;
  switch (adjustment.matchType) {
    case 'modality':
      return typeof v === 'string' && entry.modality?.toLowerCase() === v.toLowerCase();
    case 'bodyPart':
      return typeof v === 'string' && entry.bodyPart?.toLowerCase() === v.toLowerCase();
    case 'cptPrefix':
      return typeof v === 'string' && entry.cpt.startsWith(v);
    case 'cptList':
      return Array.isArray(v) && v.includes(entry.cpt);
    case 'description':
      return typeof v === 'string' && entry.description?.toLowerCase().includes(v.toLowerCase());
    default:
      return false;
  }
}

// Apply practice-wide adjustments to a single (raw) per-CPT RVU value.
// Adjustments run in two passes within array order: all 'add' ops first, then all 'multiply' ops.
// This makes "+0.1 to plain films then ×2 for arthrograms" deterministic.
export function applyAdjustmentsToCptRvu(
  rawRvu: number,
  cptEntry: CptEntry | undefined,
  adjustments: CptAdjustment[],
  ctx?: AdjustmentMatchContext,
): { adjusted: number; delta: number } {
  let value = rawRvu;
  for (const a of adjustments) {
    if (a.operation === 'add' && adjustmentMatches(a, cptEntry, ctx)) {
      value += a.amount;
    }
  }
  for (const a of adjustments) {
    if (a.operation === 'multiply' && adjustmentMatches(a, cptEntry, ctx)) {
      value *= a.amount;
    }
  }
  const adjusted = +value.toFixed(4);
  return { adjusted, delta: +(adjusted - rawRvu).toFixed(4) };
}

// Apply adjustments to a combo breakdown returned by calculateComboRvu().
// Returns a new breakdown and the total (sum of adjusted values, rounded to 2 dp).
export interface AdjustedComboResult {
  total: number;
  totalRaw: number;
  totalAdjustment: number;
  breakdown: Array<{
    cpt: string;
    description: string;
    raw: number;
    adjusted: number;
    rawBeforePvc: number;
    pvcDelta: number;
  }>;
}

export function applyCptAdjustmentsToBreakdown(
  breakdown: Array<{ cpt: string; description: string; raw: number; adjusted: number }>,
  cptEntries: Record<string, CptEntry>,
  adjustments: CptAdjustment[],
  ctx?: AdjustmentMatchContext,
): AdjustedComboResult {
  const newBreakdown = breakdown.map(b => {
    const entry = cptEntries[b.cpt];
    const { adjusted, delta } = applyAdjustmentsToCptRvu(b.adjusted, entry, adjustments, ctx);
    return {
      cpt: b.cpt,
      description: b.description,
      raw: b.raw,             // preserve original raw (pre-PVC)
      adjusted,               // post-PVC value (what the rad sees as "the RVU")
      rawBeforePvc: b.adjusted,
      pvcDelta: delta,
    };
  });
  const total = +newBreakdown.reduce((s, b) => s + b.adjusted, 0).toFixed(2);
  const totalRaw = +newBreakdown.reduce((s, b) => s + b.rawBeforePvc, 0).toFixed(2);
  return {
    total,
    totalRaw,
    totalAdjustment: +(total - totalRaw).toFixed(4),
    breakdown: newBreakdown,
  };
}

// Apply a modality-only adjustment to a modality-default RVU (no CPT available).
// Used by the non-Sidecar path where calculateRVU returns a modality default.
export function applyModalityOnlyAdjustment(
  rawRvu: number,
  modality: string | null,
  adjustments: CptAdjustment[],
  ctx?: AdjustmentMatchContext,
): { adjusted: number; delta: number } {
  if (!modality) return { adjusted: rawRvu, delta: 0 };
  const rotationAllowed = (a: CptAdjustment): boolean => {
    if (!a.applicableToRotations || a.applicableToRotations.length === 0) return true;
    if (!ctx?.rotation) return false;
    return a.applicableToRotations.includes(ctx.rotation);
  };
  const personallyOk = (a: CptAdjustment): boolean =>
    !a.requiresPersonallyPerformed || !!ctx?.personallyPerformed;
  let value = rawRvu;
  for (const a of adjustments) {
    if (a.disabled) continue;
    if (a.matchType !== 'modality') continue;
    if (typeof a.matchValue !== 'string') continue;
    if (a.matchValue.toLowerCase() !== modality.toLowerCase()) continue;
    if (!rotationAllowed(a) || !personallyOk(a)) continue;
    if (a.operation === 'add') value += a.amount;
  }
  for (const a of adjustments) {
    if (a.disabled) continue;
    if (a.matchType !== 'modality') continue;
    if (typeof a.matchValue !== 'string') continue;
    if (a.matchValue.toLowerCase() !== modality.toLowerCase()) continue;
    if (!rotationAllowed(a) || !personallyOk(a)) continue;
    if (a.operation === 'multiply') value *= a.amount;
  }
  const adjusted = +value.toFixed(4);
  return { adjusted, delta: +(adjusted - rawRvu).toFixed(4) };
}

// Returns true if any rotation overlay configures a non-zero bonus.
// Used by adaptive report columns.
export function anyRotationHasBonus(config: PvcConfig): boolean {
  return Object.values(config.rotationConfig).some(o => o.bonusRvu > 0);
}

// Returns true if any rotation overlay configures a non-zero bonus shift credit.
// Used by adaptive report columns.
export function anyRotationHasBonusShiftCredit(config: PvcConfig): boolean {
  return Object.values(config.rotationConfig).some(o => (o.bonusShiftCredit ?? 0) > 0);
}

// Productivity bonus shifts per shift, computed from a period's Adjusted wRVU
// average. `multiplier` on each tier is interpreted as bonus-shifts-per-RVU
// for that tier's slice.
//
// Marginal mode (recommended): each tier contributes its slice
//   slice = min(avg, nextThreshold) - tier.threshold
// User's group example (tier1@50/0.02, tier2@60/0.01667, avg=66, marginal):
//   tier1 slice = min(66,60) - 50 = 10 → 10 × 0.02 = 0.2
//   tier2 slice = 66 - 60 = 6        → 6 × 0.01667 = 0.1
//   total bonus per shift = 0.3
//
// Stacked mode: each tier contributes (avg - threshold) × multiplier when
// avg ≥ threshold. Kept for compatibility but generally over-credits at the
// upper end since the lower-tier rate keeps applying past its slice.
export function computeBonusShiftsPerShift(
  avgAdjustedRvu: number,
  tiers: ProductivityTier[],
  mode: ProductivityTierMode,
  allowNegativeBonus: boolean,
): number {
  if (tiers.length === 0) return 0;
  const sorted = [...tiers].sort((a, b) => a.thresholdDailyWrvu - b.thresholdDailyWrvu);
  let bonus = 0;
  for (let i = 0; i < sorted.length; i++) {
    const tier = sorted[i];
    const nextThreshold = i + 1 < sorted.length
      ? sorted[i + 1].thresholdDailyWrvu
      : Number.POSITIVE_INFINITY;
    if (mode === 'marginal') {
      const sliceUpper = Math.min(avgAdjustedRvu, nextThreshold);
      const slice = sliceUpper - tier.thresholdDailyWrvu;
      if (slice >= 0) {
        bonus += slice * tier.multiplier;
      } else if (allowNegativeBonus) {
        // Only the lowest tier produces negative slice; higher tiers' slice is
        // already 0 or positive due to the cap above.
        bonus += slice * tier.multiplier;
      }
    } else {
      // stacked
      if (avgAdjustedRvu >= tier.thresholdDailyWrvu) {
        bonus += (avgAdjustedRvu - tier.thresholdDailyWrvu) * tier.multiplier;
      } else if (allowNegativeBonus && i === 0) {
        bonus += (avgAdjustedRvu - tier.thresholdDailyWrvu) * tier.multiplier;
      }
    }
  }
  return +bonus.toFixed(4);
}

// ISO calendar-month key (YYYY-MM) for a Date.
export function monthKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

// Returns the calendar quarter key (YYYY-Qn) for a Date. Quarters are calendar
// by default; fiscal year offset would be handled separately.
export function quarterKey(date: Date): string {
  const year = date.getFullYear();
  const q = Math.floor(date.getMonth() / 3) + 1;
  return `${year}-Q${q}`;
}

// Day key (YYYY-MM-DD).
export function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// Returns ISO date (YYYY-MM-DD) for a given Date in the specified IANA timezone.
// Used to determine the user's "today" boundary for shift-credit attribution.
// Falls back to the local date string if timezone is invalid.
export function isoDateInTimezone(date: Date, timezone?: string): string {
  if (!timezone) {
    return date.toISOString().slice(0, 10);
  }
  try {
    // en-CA gives YYYY-MM-DD format directly
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const year = parts.find(p => p.type === 'year')?.value;
    const month = parts.find(p => p.type === 'month')?.value;
    const day = parts.find(p => p.type === 'day')?.value;
    if (year && month && day) return `${year}-${month}-${day}`;
  } catch {
    // Invalid timezone — fall through
  }
  return date.toISOString().slice(0, 10);
}
