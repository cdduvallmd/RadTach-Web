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

// (workRvu × work) + (facPeRvu × pe) + (mpRvu × mp)
// Falls back to pcRvu if component RVUs not present.
export function adjustedPcRvu(entry: CptEntry, gpci: GpciValues): number {
  if (entry.workRvu != null && entry.facPeRvu != null && entry.mpRvu != null) {
    return +(
      entry.workRvu * gpci.work +
      entry.facPeRvu * gpci.pe +
      entry.mpRvu * gpci.mp
    ).toFixed(2);
  }
  return entry.pcRvu;
}
