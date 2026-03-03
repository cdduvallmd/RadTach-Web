// GAR/CR/GAW Computation Engine
// Pure computation — no Firestore dependency. Receives StoredSession[], outputs stats.
// Key rules:
//   - n >= 3 distinct users required at every level
//   - Half-day sessions EXCLUDED from GAR computation
//   - tagFrequency computed from session.notes.tags

import type { StoredSession, DistributionStats, GroupStats, CompositeStats, WorkstationStats } from '../types/reports';

// ── Statistical Helpers ───────────────────────────────────────────────────────

function computeDistribution(values: number[]): DistributionStats | null {
  const n = values.length;
  if (n === 0) return null;

  const sorted = [...values].sort((a, b) => a - b);
  const mean = sorted.reduce((a, b) => a + b, 0) / n;

  const median = n % 2 === 0
    ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2
    : sorted[Math.floor(n / 2)];

  const p25 = percentile(sorted, 25);
  const p50 = median;
  const p75 = percentile(sorted, 75);

  const variance = n > 1
    ? sorted.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (n - 1)
    : 0;
  const stdDev = Math.sqrt(variance);

  return { mean, median, p25, p50, p75, stdDev, n };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const index = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  const fraction = index - lower;
  return sorted[lower] + fraction * (sorted[upper] - sorted[lower]);
}

// ── Per-User Session Metrics ──────────────────────────────────────────────────

interface UserDayMetrics {
  userId: string;
  rvuPerHour: number;
  productiveRatio: number;
  avgVariance: number;
  studiesPerHour: number;
  interstitialAvg: number;
  totalRVU: number;
  totalStudies: number;
  totalSessionTime: number;
  adminTime: number;
  commsTime: number;
  breakTime: number;
  tags: string[];
  workstationId: string;
  rotation: string;
  studiesByModality: Record<string, number>;
  rvuByModality: Record<string, number>;
  rvuPerHourByModality: Record<string, number>;
  avgVarianceByModality: Record<string, number>;
  // For workstation stats: per-study interstitials
  interstitialTrend: number[];
}

function computeUserDayMetrics(sessions: StoredSession[]): UserDayMetrics | null {
  if (sessions.length === 0) return null;

  const totalSessionTime = sessions.reduce((sum, s) => sum + s.totalSessionTime, 0);
  const totalBreakTime = sessions.reduce((sum, s) => sum + s.breakTime, 0);
  const totalStudies = sessions.reduce((sum, s) => sum + s.studiesCompleted, 0);
  const totalRVU = sessions.reduce((sum, s) => sum + s.totalRVU, 0);
  const totalInterstitialTime = sessions.reduce((sum, s) => sum + s.interstitialTime, 0);
  const totalAdminTime = sessions.reduce((sum, s) => sum + s.adminTime, 0);
  const totalCommsTime = sessions.reduce((sum, s) => sum + s.commsTime, 0);
  const totalDoubleTapTime = sessions.reduce((sum, s) => sum + s.doubleTapTime, 0);

  const productiveHours = (totalSessionTime - totalBreakTime) / 3600;
  const rvuPerHour = productiveHours > 0 ? totalRVU / productiveHours : 0;

  // Productive ratio: (study + doubleTap) / total session
  const totalStudyTime = sessions.reduce((sum, s) =>
    sum + (s.summary?.timeAllocation.study ?? (s.totalSessionTime - s.interstitialTime - s.adminTime - s.commsTime - s.breakTime - s.doubleTapTime)), 0);
  const productiveRatio = totalSessionTime > 0 ? (totalStudyTime + totalDoubleTapTime) / totalSessionTime : 0;

  // Average variance across sessions
  const varianceValues: number[] = [];
  for (const s of sessions) {
    if (s.summary?.avgVarianceByModality) {
      const v = Object.values(s.summary.avgVarianceByModality);
      if (v.length > 0) varianceValues.push(v.reduce((a, b) => a + b, 0) / v.length);
    }
  }
  const avgVariance = varianceValues.length > 0
    ? varianceValues.reduce((a, b) => a + b, 0) / varianceValues.length : 0;

  const studiesPerHour = productiveHours > 0 ? totalStudies / productiveHours : 0;
  const interstitialAvg = totalStudies > 0 ? totalInterstitialTime / totalStudies : 0;

  // Tags
  const tags: string[] = [];
  for (const s of sessions) {
    if (s.notes?.tags) {
      for (const t of s.notes.tags) {
        if (t !== 'No Comment') tags.push(t);
      }
    }
  }

  // Modality breakdowns
  const studiesByModality: Record<string, number> = {};
  const rvuByModality: Record<string, number> = {};
  const rvuPerHourByModality: Record<string, number> = {};
  const avgVarianceByModality: Record<string, number> = {};

  for (const s of sessions) {
    if (s.summary) {
      for (const [mod, count] of Object.entries(s.summary.studiesByModality)) {
        studiesByModality[mod] = (studiesByModality[mod] || 0) + count;
      }
      for (const [mod, v] of Object.entries(s.summary.avgVarianceByModality)) {
        if (!avgVarianceByModality[mod]) avgVarianceByModality[mod] = 0;
        // Weighted: will average later
        avgVarianceByModality[mod] += v;
      }
    }
  }

  // Average variance by modality across sessions
  const modalitySessionCounts: Record<string, number> = {};
  for (const s of sessions) {
    if (s.summary?.avgVarianceByModality) {
      for (const mod of Object.keys(s.summary.avgVarianceByModality)) {
        modalitySessionCounts[mod] = (modalitySessionCounts[mod] || 0) + 1;
      }
    }
  }
  for (const mod of Object.keys(avgVarianceByModality)) {
    const count = modalitySessionCounts[mod] || 1;
    avgVarianceByModality[mod] = avgVarianceByModality[mod] / count;
  }

  // RVU by modality (proportional estimate)
  for (const s of sessions) {
    if (s.summary?.studiesByModality && s.studiesCompleted > 0) {
      for (const [mod, count] of Object.entries(s.summary.studiesByModality)) {
        const proportion = count / s.studiesCompleted;
        rvuByModality[mod] = (rvuByModality[mod] || 0) + (s.totalRVU * proportion);
      }
    }
  }

  // RVU/hr by modality (average of per-session rates)
  const modalityRates: Record<string, number[]> = {};
  for (const s of sessions) {
    if (s.summary?.rvuPerHourByModality) {
      for (const [mod, rate] of Object.entries(s.summary.rvuPerHourByModality)) {
        if (!modalityRates[mod]) modalityRates[mod] = [];
        modalityRates[mod].push(rate);
      }
    }
  }
  for (const [mod, rates] of Object.entries(modalityRates)) {
    rvuPerHourByModality[mod] = rates.reduce((a, b) => a + b, 0) / rates.length;
  }

  // Interstitial trend (from summaries)
  const interstitialTrend: number[] = [];
  for (const s of sessions) {
    if (s.summary?.interstitialTrend) {
      interstitialTrend.push(...s.summary.interstitialTrend);
    }
  }

  return {
    userId: sessions[0].userAbbrev,
    rvuPerHour,
    productiveRatio,
    avgVariance,
    studiesPerHour,
    interstitialAvg,
    totalRVU,
    totalStudies,
    totalSessionTime,
    adminTime: totalAdminTime,
    commsTime: totalCommsTime,
    breakTime: totalBreakTime,
    tags,
    workstationId: sessions[0].workstationId,
    rotation: sessions[0].rotation,
    studiesByModality,
    rvuByModality,
    rvuPerHourByModality,
    avgVarianceByModality,
    interstitialTrend,
  };
}

// ── Group Stats (GAR) ─────────────────────────────────────────────────────────

export function computeGroupStats(
  sessions: StoredSession[],
  system: string,
  date: string
): GroupStats | null {
  // Filter: same system, exclude half-day sessions
  const eligible = sessions.filter(s => s.system === system && !s.halfDay);
  if (eligible.length === 0) return null;

  // Group by user
  const byUser = new Map<string, StoredSession[]>();
  for (const s of eligible) {
    const uid = s.userAbbrev;
    const existing = byUser.get(uid) || [];
    existing.push(s);
    byUser.set(uid, existing);
  }

  // n >= 3 distinct users required
  if (byUser.size < 3) return null;

  // Compute per-user metrics
  const userMetrics: UserDayMetrics[] = [];
  for (const [, userSessions] of byUser) {
    const metrics = computeUserDayMetrics(userSessions);
    if (metrics) userMetrics.push(metrics);
  }

  if (userMetrics.length < 3) return null;

  // Overall distributions
  const rvuPerHour = computeDistribution(userMetrics.map(u => u.rvuPerHour));
  const productiveRatio = computeDistribution(userMetrics.map(u => u.productiveRatio));
  const avgVariance = computeDistribution(userMetrics.map(u => u.avgVariance));
  const studiesPerHour = computeDistribution(userMetrics.map(u => u.studiesPerHour));
  const interstitialAvg = computeDistribution(userMetrics.map(u => u.interstitialAvg));

  if (!rvuPerHour || !productiveRatio || !avgVariance || !studiesPerHour || !interstitialAvg) {
    return null;
  }

  // Tag frequency across all users
  const tagFrequency: Record<string, number> = {};
  for (const u of userMetrics) {
    for (const tag of u.tags) {
      tagFrequency[tag] = (tagFrequency[tag] || 0) + 1;
    }
  }

  // Group totals
  const groupTotals = {
    totalRVU: userMetrics.reduce((sum, u) => sum + u.totalRVU, 0),
    totalStudies: userMetrics.reduce((sum, u) => sum + u.totalStudies, 0),
    totalSessionHours: userMetrics.reduce((sum, u) => sum + u.totalSessionTime, 0) / 3600,
    totalAdminHours: userMetrics.reduce((sum, u) => sum + u.adminTime, 0) / 3600,
    totalCommsHours: userMetrics.reduce((sum, u) => sum + u.commsTime, 0) / 3600,
    totalBreakHours: userMetrics.reduce((sum, u) => sum + u.breakTime, 0) / 3600,
  };

  // Group totals by modality
  const groupTotalsByModality: Record<string, { studies: number; rvu: number }> = {};
  for (const u of userMetrics) {
    for (const [mod, count] of Object.entries(u.studiesByModality)) {
      if (!groupTotalsByModality[mod]) groupTotalsByModality[mod] = { studies: 0, rvu: 0 };
      groupTotalsByModality[mod].studies += count;
      groupTotalsByModality[mod].rvu += (u.rvuByModality[mod] || 0);
    }
  }

  // By modality distributions (only include modalities with n >= 3 users)
  const allModalities = new Set<string>();
  for (const u of userMetrics) {
    for (const mod of Object.keys(u.studiesByModality)) {
      allModalities.add(mod);
    }
  }

  const byModality: GroupStats['byModality'] = {};
  for (const mod of allModalities) {
    const usersWithModality = userMetrics.filter(u => (u.studiesByModality[mod] || 0) > 0);
    if (usersWithModality.length < 3) continue;

    const modRvuPerHour = computeDistribution(
      usersWithModality.map(u => u.rvuPerHourByModality[mod] || 0)
    );
    const modAvgVariance = computeDistribution(
      usersWithModality.map(u => u.avgVarianceByModality[mod] || 0)
    );
    const modStudyCount = computeDistribution(
      usersWithModality.map(u => u.studiesByModality[mod] || 0)
    );

    if (modRvuPerHour && modAvgVariance && modStudyCount) {
      byModality[mod] = {
        rvuPerHour: modRvuPerHour,
        avgVariance: modAvgVariance,
        studyCount: modStudyCount,
      };
    }
  }

  // By rotation distributions (only include rotations with n >= 3 users)
  const allRotations = new Set<string>();
  for (const u of userMetrics) {
    if (u.rotation) allRotations.add(u.rotation);
  }

  const byRotation: GroupStats['byRotation'] = {};
  for (const rot of allRotations) {
    const usersOnRotation = userMetrics.filter(u => u.rotation === rot);
    if (usersOnRotation.length < 3) continue;
    const rotRvuPerHour = computeDistribution(usersOnRotation.map(u => u.rvuPerHour));
    if (rotRvuPerHour) {
      byRotation[rot] = { rvuPerHour: rotRvuPerHour };
    }
  }

  return {
    date,
    system,
    sessionCount: eligible.length,
    rvuPerHour,
    productiveRatio,
    avgVariance,
    studiesPerHour,
    interstitialAvg,
    tagFrequency,
    groupTotals,
    groupTotalsByModality,
    byModality,
    byRotation,
  };
}

// ── Composite Stats (CR) ──────────────────────────────────────────────────────

export function computeCompositeStats(
  allGroupStats: GroupStats[],
  date: string
): CompositeStats | null {
  // Need >= 2 systems
  if (allGroupStats.length < 2) return null;

  const systemsContributing = allGroupStats.map(g => g.system);
  const sessionCount = allGroupStats.reduce((sum, g) => sum + g.sessionCount, 0);

  // Merge distributions: weighted by n
  const mergeDistributions = (accessor: (g: GroupStats) => DistributionStats): DistributionStats | null => {
    const all: number[] = [];
    for (const g of allGroupStats) {
      const dist = accessor(g);
      // Approximate: reconstruct values from distribution stats
      // Since we don't have raw values, use mean repeated n times (best approximation)
      for (let i = 0; i < dist.n; i++) {
        all.push(dist.mean);
      }
    }
    return computeDistribution(all);
  };

  const rvuPerHour = mergeDistributions(g => g.rvuPerHour);
  const productiveRatio = mergeDistributions(g => g.productiveRatio);
  const avgVariance = mergeDistributions(g => g.avgVariance);
  const studiesPerHour = mergeDistributions(g => g.studiesPerHour);
  const interstitialAvg = mergeDistributions(g => g.interstitialAvg);

  if (!rvuPerHour || !productiveRatio || !avgVariance || !studiesPerHour || !interstitialAvg) {
    return null;
  }

  // By modality: merge across systems
  const allMods = new Set<string>();
  for (const g of allGroupStats) {
    for (const mod of Object.keys(g.byModality)) {
      allMods.add(mod);
    }
  }

  const byModality: CompositeStats['byModality'] = {};
  for (const mod of allMods) {
    const modGroups = allGroupStats.filter(g => g.byModality[mod]);
    if (modGroups.length < 2) continue;

    const mergeModDist = (accessor: (bm: GroupStats['byModality'][string]) => DistributionStats): DistributionStats | null => {
      const all: number[] = [];
      for (const g of modGroups) {
        const dist = accessor(g.byModality[mod]);
        for (let i = 0; i < dist.n; i++) {
          all.push(dist.mean);
        }
      }
      return computeDistribution(all);
    };

    const modRvuPerHour = mergeModDist(bm => bm.rvuPerHour);
    const modAvgVariance = mergeModDist(bm => bm.avgVariance);
    const modStudyCount = mergeModDist(bm => bm.studyCount);

    if (modRvuPerHour && modAvgVariance && modStudyCount) {
      byModality[mod] = {
        rvuPerHour: modRvuPerHour,
        avgVariance: modAvgVariance,
        studyCount: modStudyCount,
      };
    }
  }

  return {
    date,
    systemsContributing,
    sessionCount,
    rvuPerHour,
    productiveRatio,
    avgVariance,
    studiesPerHour,
    interstitialAvg,
    byModality,
  };
}

// ── Workstation Stats (GAW) ───────────────────────────────────────────────────

export function computeWorkstationStats(
  sessions: StoredSession[],
  system: string,
  date: string
): WorkstationStats | null {
  const eligible = sessions.filter(s => s.system === system && !s.halfDay);
  if (eligible.length === 0) return null;

  // Group by workstation
  const byWorkstation = new Map<string, StoredSession[]>();
  for (const s of eligible) {
    const ws = s.workstationId;
    const existing = byWorkstation.get(ws) || [];
    existing.push(s);
    byWorkstation.set(ws, existing);
  }

  const workstations: WorkstationStats['workstations'] = {};

  for (const [ws, wsSessions] of byWorkstation) {
    if (wsSessions.length === 0) continue;

    // Bottom 5% interstitial average — find the worst interstitials
    const allInterstitials: number[] = [];
    for (const s of wsSessions) {
      if (s.summary?.interstitialTrend) {
        allInterstitials.push(...s.summary.interstitialTrend);
      }
    }

    // Bottom 5 avg: average of worst 5% of interstitials (floor of workstation performance)
    const sortedInter = [...allInterstitials].sort((a, b) => b - a); // descending (worst first)
    const bottom5Count = Math.max(1, Math.ceil(sortedInter.length * 0.05));
    const bottom5Values = sortedInter.slice(0, bottom5Count);
    const bottom5Avg = computeDistribution(bottom5Values);

    // Same modality floor: interstitial between same-modality studies
    // This requires study-level data we might not have at the session level.
    // Use overall interstitial average as proxy.
    const interstitialAvgs = wsSessions.map(s =>
      s.studiesCompleted > 0 ? s.interstitialTime / s.studiesCompleted : 0
    ).filter(v => v > 0);
    const sameModalityFloor = computeDistribution(interstitialAvgs);

    if (bottom5Avg && sameModalityFloor) {
      workstations[ws] = {
        bottom5Avg,
        sameModalityFloor,
        sessionCount: wsSessions.length,
      };
    }
  }

  if (Object.keys(workstations).length === 0) return null;

  return { date, system, workstations };
}
