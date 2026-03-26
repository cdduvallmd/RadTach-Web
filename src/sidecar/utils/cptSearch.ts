import type { CptEntry, ChargemasterEntry } from '../../types/cpt';

export interface SearchResult {
  cpt: string;
  entry: CptEntry;
  score: number;
  aeTitle?: string;
  comboCpts?: string[];
  comboBilateralFlags?: boolean[];
}

export function searchCpts(
  query: string,
  entries: Record<string, CptEntry>,
  limit = 10,
  chargemaster?: ChargemasterEntry[],
): SearchResult[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];

  const results: SearchResult[] = [];

  if (chargemaster && chargemaster.length > 0) {
    // Search chargemaster entries (AE Titles + CPT descriptions)
    // Facility-only entries excluded — radiologists don't interact with them
    const cmCpts = new Set<string>();
    for (const cm of chargemaster) {
      if (!cm.facilityOnly) {
        for (const cpt of cm.cpts) cmCpts.add(cpt);
      }
    }

    for (const cm of chargemaster) {
      if (cm.facilityOnly) continue;
      let score = 0;
      const primaryEntry = entries[cm.cpts[0]];
      if (!primaryEntry) continue;

      const aeTitleLower = cm.aeTitle.toLowerCase();

      for (const token of tokens) {
        // CPT code exact match (any CPT in the entry)
        if (cm.cpts.includes(token)) {
          score += 10;
          continue;
        }

        // AE Title match (institution name — ranked highest)
        if (aeTitleLower.includes(token)) {
          score += 3;
          continue;
        }

        // Modality match
        if (token === cm.modality.toLowerCase()) {
          score += 3;
          continue;
        }

        // Body part match
        if (cm.bodyPart.toLowerCase().includes(token)) {
          score += 2;
          continue;
        }

        // CMS description fallback
        if (primaryEntry.description.toLowerCase().includes(token)) {
          score += 1;
        }
      }

      if (score > 0) {
        results.push({
          cpt: cm.cpts[0],
          entry: primaryEntry,
          score,
          aeTitle: cm.aeTitle,
          ...(cm.cpts.length > 1 ? {
            comboCpts: cm.cpts,
            comboBilateralFlags: cm.bilateralFlags,
          } : {}),
        });
      }
    }

    // Also search CPTs not in the chargemaster (fallback for unlisted codes)
    for (const [cpt, entry] of Object.entries(entries)) {
      if (cmCpts.has(cpt)) continue;
      let score = 0;
      for (const token of tokens) {
        if (token === cpt) { score += 10; continue; }
        if (token === entry.modality.toLowerCase()) { score += 3; continue; }
        if (entry.bodyPart.toLowerCase().includes(token)) { score += 2; continue; }
        if (entry.description.toLowerCase().includes(token)) { score += 1; }
      }
      if (score > 0) {
        results.push({ cpt, entry, score });
      }
    }
  } else {
    // No chargemaster — search full CPT database
    for (const [cpt, entry] of Object.entries(entries)) {
      let score = 0;
      for (const token of tokens) {
        if (token === cpt) { score += 10; continue; }
        if (token === entry.modality.toLowerCase()) { score += 3; continue; }
        if (entry.bodyPart.toLowerCase().includes(token)) { score += 2; continue; }
        if (entry.description.toLowerCase().includes(token)) { score += 1; }
      }
      if (score > 0) {
        results.push({ cpt, entry, score });
      }
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}
