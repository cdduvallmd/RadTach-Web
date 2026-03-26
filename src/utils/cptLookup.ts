import type { CptEntry } from '../types/cpt';
import type { GpciValues } from './gpciLookup';
import { adjustedWorkRvu } from './gpciLookup';

// ── Resolve work RVU for a single entry ─────────────────────────────────────
// Returns GPCI-adjusted work RVU when gpci is provided, raw workRvu otherwise.
function resolveRvu(entry: CptEntry, gpci?: GpciValues): number {
  if (gpci) return adjustedWorkRvu(entry, gpci);
  return entry.workRvu ?? entry.pcRvu; // workRvu preferred, pcRvu legacy fallback
}

// ── Single CPT lookup ──────────────────────────────────────────────────────
// Returns work RVU (or GPCI-adjusted) or null if CPT not found in database.
export function lookupWorkRvu(
  entries: Record<string, CptEntry>,
  cpt: string,
  gpci?: GpciValues,
): number | null {
  const entry = entries[cpt];
  if (!entry) return null;
  return resolveRvu(entry, gpci);
}

// @deprecated — use lookupWorkRvu
export const lookupPcRvu = lookupWorkRvu;

// ── Combo calculation ──────────────────────────────────────────────────────
// Work RVU is not subject to MPPR — each procedure's work stands at full value.
// (MPPR only reduces the PE component of the technical component.)
export function calculateComboRvu(
  entries: Record<string, CptEntry>,
  cpts: string[],
  gpci?: GpciValues,
): {
  total: number;
  breakdown: Array<{ cpt: string; description: string; raw: number; adjusted: number }>;
} {
  const breakdown = cpts.map(cpt => {
    const entry = entries[cpt];
    const raw = entry ? resolveRvu(entry, gpci) : 0;
    return {
      cpt,
      description: entry?.description ?? `Unknown CPT ${cpt}`,
      raw,
      adjusted: raw, // No MPPR reduction on work RVU
    };
  });

  const total = +breakdown.reduce((sum, b) => sum + b.adjusted, 0).toFixed(2);

  return { total, breakdown };
}

// ── Bilateral RVU ──────────────────────────────────────────────────────────
// 4 paired codes have native bilateral CPTs; all others use modifier-50 math (× 1.5).
const BILATERAL_PAIRS: Record<string, string> = {
  '77046': '77047',
  '77048': '77049',
  '78457': '78458',
  '93923': '93924',
};

export function getBilateralRvu(
  entries: Record<string, CptEntry>,
  cpt: string,
  gpci?: GpciValues,
): { cpt: string; rvu: number } {
  const pairedCpt = BILATERAL_PAIRS[cpt];

  if (pairedCpt) {
    const pairedEntry = entries[pairedCpt];
    if (pairedEntry) {
      return { cpt: pairedCpt, rvu: resolveRvu(pairedEntry, gpci) };
    }
  }

  // No native bilateral CPT — modifier-50 math
  const entry = entries[cpt];
  const baseRvu = entry ? resolveRvu(entry, gpci) : 0;
  return { cpt, rvu: +(baseRvu * 1.5).toFixed(2) };
}
