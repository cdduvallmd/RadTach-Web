import type { CptEntry } from '../types/cpt';
import zipLocality from '../../data/zip-locality.json';
import gpciTable from '../../data/gpci-2026.json';

export interface GpciValues {
  work: number;
  pe: number;
  mp: number;
  localityName: string;
}

const zipMap = zipLocality as Record<string, string>;
const gpciMap = gpciTable as Record<string, { name: string; work: number; pe: number; mp: number }>;

// ZIP → 7-digit locality code → GPCI values. Returns null if ZIP not found.
export function lookupGpci(zip: string): GpciValues | null {
  const locality = zipMap[zip];
  if (!locality) return null;

  const row = gpciMap[locality];
  if (!row) return null;

  return {
    work: row.work,
    pe: row.pe,
    mp: row.mp,
    localityName: row.name,
  };
}

// Work RVU × GPCI work factor.
// This is what hospital-employed radiologists earn — PE and MP go to the facility.
// Falls back to raw workRvu (or pcRvu if workRvu missing) when GPCI not available.
export function adjustedWorkRvu(entry: CptEntry, gpci: GpciValues): number {
  if (entry.workRvu != null) {
    return +(entry.workRvu * gpci.work).toFixed(2);
  }
  return entry.pcRvu; // legacy fallback
}

// @deprecated — use adjustedWorkRvu. Kept for any remaining callers.
export const adjustedPcRvu = adjustedWorkRvu;
