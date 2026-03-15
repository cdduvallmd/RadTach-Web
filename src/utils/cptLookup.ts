import type { CptEntry } from '../types/cpt';

// ── Single CPT lookup ──────────────────────────────────────────────────────
// Returns pcRvu or null if CPT not found in database.
export function lookupPcRvu(entries: Record<string, CptEntry>, cpt: string): number | null {
  const entry = entries[cpt];
  return entry ? entry.pcRvu : null;
}

// ── MPPR combo calculation ─────────────────────────────────────────────────
// CMS Consolidated Appropriations Act 2016, Section 502(a)(2):
// 5% PC reduction on 2nd+ diagnostic imaging procedures (MULT PROC indicator = 4).
// Sort by pcRvu descending — highest at 100%, all subsequent × 0.95.
export function calculateComboRvu(
  entries: Record<string, CptEntry>,
  cpts: string[],
): {
  total: number;
  breakdown: Array<{ cpt: string; description: string; raw: number; adjusted: number }>;
} {
  const resolved = cpts
    .map(cpt => {
      const entry = entries[cpt];
      return entry
        ? { cpt, description: entry.description, raw: entry.pcRvu }
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
): { cpt: string; rvu: number } {
  const pairedCpt = BILATERAL_PAIRS[cpt];

  if (pairedCpt) {
    const pairedEntry = entries[pairedCpt];
    if (pairedEntry) {
      return { cpt: pairedCpt, rvu: pairedEntry.pcRvu };
    }
  }

  // No native bilateral CPT — modifier-50 math
  const entry = entries[cpt];
  const baseRvu = entry ? entry.pcRvu : 0;
  return { cpt, rvu: +(baseRvu * 1.5).toFixed(2) };
}
