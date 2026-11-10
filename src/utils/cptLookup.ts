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

// ── Technical component (facility-cost reports) ───────────────────────────
// Sum of the CPTs' technical-component RVUs: MPFS national (no GPCI), gross
// (no MPPR — the stored CPTs let a report apply it). Stored on each STUDY so it
// keeps the year's CMS value (owner, 2026-11-03). Empty (null) rather than
// guessed (owner, 2026-11-07, Clyde 261103 #1, #2) when any CPT is:
// - missing from the table;
// - listed with a zero technical value (carrier-priced or unverified);
// - flagged bilateral without a bilateral CPT of its own (×1.5 vs ×2 for the
//   technical component is not settled; the flags are stored so it can be
//   filled in later). The 4 paired codes are already the bilateral CPT.
// `bilateralFlags` lines up with `cpts` (the CPTs as stored, after pairing).
export function sumTcRvu(
  entries: Record<string, CptEntry>,
  cpts: string[],
  bilateralFlags?: boolean[],
): number | null {
  let total = 0;
  for (let i = 0; i < cpts.length; i++) {
    const entry = entries[cpts[i]];
    if (!entry || !(entry.tcRvu > 0)) return null;
    if (bilateralFlags?.[i] && !NATIVE_BILATERAL.has(cpts[i])) return null;
    total += entry.tcRvu;
  }
  return +total.toFixed(2);
}

// ── Bilateral RVU ──────────────────────────────────────────────────────────
// 4 paired codes have native bilateral CPTs; all others use modifier-50 math (× 1.5).
const BILATERAL_PAIRS: Record<string, string> = {
  '77046': '77047',
  '77048': '77049',
  '78457': '78458',
  '93923': '93924',
};
// CPTs that are themselves the bilateral code (no ×1.5 / ×2 question).
const NATIVE_BILATERAL = new Set(Object.values(BILATERAL_PAIRS));

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
