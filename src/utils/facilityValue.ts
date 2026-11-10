// Facility value of the studies read (owner, 2026-11-09): technical-component
// RVU stored per study (see utils/cptLookup sumTcRvu), converted to dollars at
// the Medicare Physician Fee Schedule conversion factor of the CMS table year
// that produced it. An estimate for perspective: hospital outpatient imaging is
// paid under OPPS, and the figure is before multiple-procedure reduction.
import type { StoredSession } from '../types/reports';

// MPFS conversion factor by year (non-qualifying APM rate). Add each year's
// value at the January CMS update, alongside the CPT table.
export const MPFS_CONVERSION_FACTOR: Record<number, number> = {
  2026: 33.4009, // CMS-1832-F, CY 2026 final rule
};

export interface FacilityValue {
  tcRvu: number;
  tcRvuStudies: number;
  totalStudies: number;
  hours: number;          // session hours of the sessions that carry tcRVU
  dollars: number | null; // null if a session's table year has no conversion factor
  conversionFactor: number | null; // when every session used the same year
}

export function facilityValue(sessions: StoredSession[]): FacilityValue {
  let tcRvu = 0, tcRvuStudies = 0, totalStudies = 0, seconds = 0, dollars: number | null = 0;
  const factors = new Set<number>();
  for (const s of sessions) {
    totalStudies += s.studiesCompleted ?? 0;
    const n = s.tcRvuStudies ?? 0;
    if (n === 0) continue;
    const tc = s.totalTcRVU ?? 0;
    tcRvu += tc;
    tcRvuStudies += n;
    seconds += s.totalSessionTime ?? 0;
    const cf = s.cptTableYear != null ? MPFS_CONVERSION_FACTOR[s.cptTableYear] : undefined;
    if (cf === undefined) dollars = null;
    else { factors.add(cf); if (dollars !== null) dollars += tc * cf; }
  }
  return {
    tcRvu: +tcRvu.toFixed(2),
    tcRvuStudies,
    totalStudies,
    hours: seconds / 3600,
    dollars: dollars === null ? null : +dollars.toFixed(2),
    conversionFactor: factors.size === 1 ? [...factors][0] : null,
  };
}
