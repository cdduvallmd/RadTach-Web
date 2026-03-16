import type { CptEntry } from '../../types/cpt';

export interface SearchResult {
  cpt: string;
  entry: CptEntry;
  score: number;
}

export function searchCpts(
  query: string,
  entries: Record<string, CptEntry>,
  limit = 10,
): SearchResult[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];

  const results: SearchResult[] = [];

  for (const [cpt, entry] of Object.entries(entries)) {
    let score = 0;

    for (const token of tokens) {
      // CPT code exact match
      if (token === cpt) {
        score += 10;
        continue;
      }

      // Modality match (case-insensitive)
      if (token === entry.modality.toLowerCase()) {
        score += 3;
        continue;
      }

      // Body part match (case-insensitive)
      if (entry.bodyPart.toLowerCase().includes(token)) {
        score += 2;
        continue;
      }

      // Description word match
      if (entry.description.toLowerCase().includes(token)) {
        score += 1;
      }
    }

    if (score > 0) {
      results.push({ cpt, entry, score });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}
