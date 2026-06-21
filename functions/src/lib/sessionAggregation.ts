// Calendar-day aggregation of session docs into a brief-friendly structure.
// Ported from /tmp/analyze2.ts which was developed during the initial coaching
// read against the user's actual data.

import type { StoredSession } from './types';
import { dayKeyForIso } from './timezone';

export interface DayAggregate {
  day: string;
  sessions: number;
  studies: number;
  rvu: number;
  sessionTime: number;
  productiveTime: number;  // sessionTime - breakTime
  breakTime: number;
  adminTime: number;
  commsTime: number;
  interstitialTime: number;
  rotations: string[];
  tags: string[];
  firstStart: string;
  lastStop: string;
  autoFinalizedCount: number;
}

export interface CptVariance {
  cpt: string;
  modality?: string;
  avgVariance: number;
  totalInstances: number;
  sessionAppearances: number;
}

/**
 * Build per-day aggregates. Skips _autoFinalized sessions per Clyde HIGH #3
 * — they aren't representative work intervals and would skew per-day totals.
 * Caller can opt to include them by setting `includeAutoFinalized: true`
 * (e.g., the user's own report wants to see them flagged).
 */
export function aggregateByDay(
  sessions: StoredSession[],
  tz: string,
  includeAutoFinalized = false,
): Map<string, DayAggregate> {
  const out = new Map<string, DayAggregate>();
  for (const s of sessions) {
    if (s._autoFinalized && !includeAutoFinalized) continue;
    const key = dayKeyForIso(s.startDateTime, tz);
    let agg = out.get(key);
    if (!agg) {
      agg = {
        day: key,
        sessions: 0,
        studies: 0,
        rvu: 0,
        sessionTime: 0,
        productiveTime: 0,
        breakTime: 0,
        adminTime: 0,
        commsTime: 0,
        interstitialTime: 0,
        rotations: [],
        tags: [],
        firstStart: s.startDateTime,
        lastStop: s.stopDateTime ?? s.startDateTime,
        autoFinalizedCount: 0,
      };
      out.set(key, agg);
    }
    agg.sessions += 1;
    agg.studies += s.studiesCompleted ?? 0;
    agg.rvu += s.totalRVU ?? 0;
    agg.sessionTime += s.totalSessionTime ?? 0;
    agg.breakTime += s.breakTime ?? 0;
    agg.productiveTime += (s.totalSessionTime ?? 0) - (s.breakTime ?? 0);
    agg.adminTime += s.adminTime ?? 0;
    agg.commsTime += s.commsTime ?? 0;
    agg.interstitialTime += s.interstitialTime ?? 0;
    if (s.rotation && !agg.rotations.includes(s.rotation)) agg.rotations.push(s.rotation);
    for (const t of s.notes?.tags ?? []) {
      if (!agg.tags.includes(t)) agg.tags.push(t);
    }
    if (s.startDateTime < agg.firstStart) agg.firstStart = s.startDateTime;
    const stop = s.stopDateTime ?? s.startDateTime;
    if (stop > agg.lastStop) agg.lastStop = stop;
    if (s._autoFinalized) agg.autoFinalizedCount += 1;
  }
  return out;
}

interface CptSummaryRow {
  cpt?: string;
  modality?: string;
  avgVariance?: number;
  count?: number;
  totalCount?: number;
}

/**
 * Aggregate per-CPT variance across the given session summaries.
 * Each session's `summary` may carry `fastestCpts` and `slowestCpts` arrays
 * (per `computeSessionSummary`); we collect both into a per-CPT distribution.
 */
export function cptVarianceByModality(
  sessions: StoredSession[],
  modality: string,
  minAppearances = 2,
): CptVariance[] {
  const buckets: Record<string, { variances: number[]; count: number }> = {};
  for (const s of sessions) {
    if (s._autoFinalized) continue;
    const summary = s.summary as { fastestCpts?: CptSummaryRow[]; slowestCpts?: CptSummaryRow[] } | undefined;
    const fc = summary?.fastestCpts ?? [];
    const sc = summary?.slowestCpts ?? [];
    for (const item of [...fc, ...sc]) {
      if (item.modality !== modality || !item.cpt) continue;
      const b = (buckets[item.cpt] ??= { variances: [], count: 0 });
      if (typeof item.avgVariance === 'number') b.variances.push(item.avgVariance);
      b.count += item.totalCount ?? item.count ?? 1;
    }
  }
  const ranked: CptVariance[] = [];
  for (const [cpt, b] of Object.entries(buckets)) {
    if (b.variances.length < minAppearances) continue;
    const avg = b.variances.reduce((s, v) => s + v, 0) / b.variances.length;
    ranked.push({
      cpt,
      modality,
      avgVariance: Math.round(avg * 10) / 10,
      totalInstances: b.count,
      sessionAppearances: b.variances.length,
    });
  }
  ranked.sort((a, b) => b.avgVariance - a.avgVariance);
  return ranked;
}
