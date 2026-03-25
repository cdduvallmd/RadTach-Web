import type { CptEntry } from '../types/cpt';
import type { GpciValues } from './gpciLookup';
import { adjustedPcRvu } from './gpciLookup';

// ── Resolve RVU for a single entry ───────────────────────────────────────────
// Returns GPCI-adjusted RVU when gpci is provided, raw pcRvu otherwise.
function resolveRvu(entry: CptEntry, gpci?: GpciValues): number {
  return gpci ? adjustedPcRvu(entry, gpci) : entry.pcRvu;
}

// ── Single CPT lookup ──────────────────────────────────────────────────────
// Returns pcRvu (or GPCI-adjusted pcRvu) or null if CPT not found in database.
export function lookupPcRvu(
  entries: Record<string, CptEntry>,
  cpt: string,
  gpci?: GpciValues,
): number | null {
  const entry = entries[cpt];
  if (!entry) return null;
  return resolveRvu(entry, gpci);
}

// ── MPPR combo calculation ─────────────────────────────────────────────────
// CMS Consolidated Appropriations Act 2016, Section 502(a)(2):
// 5% PC reduction on 2nd+ diagnostic imaging procedures (MULT PROC indicator = 4).
// Sort by pcRvu descending — highest at 100%, all subsequent × 0.95.
export function calculateComboRvu(
  entries: Record<string, CptEntry>,
  cpts: string[],
  gpci?: GpciValues,
): {
  total: number;
  breakdown: Array<{ cpt: string; description: string; raw: number; adjusted: number }>;
} {
  const resolved = cpts
    .map(cpt => {
      const entry = entries[cpt];
      return entry
        ? { cpt, description: entry.description, raw: resolveRvu(entry, gpci) }
        : { cpt, description: `Unknown CPT ${cpt}`, raw: 0 };
    })
    .sort((a, b) => b.raw - a.raw); // highest first

  const breakdown = resolved.map((item, idx) => {
    const adjusted = idx === 0 ? item.raw : +(item.raw * 0.95).toFixed(2);
    return { ...item, adjusted };
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
