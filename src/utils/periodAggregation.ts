// Period Aggregation — computes PeriodSummary from StoredSession[]
// Pure computation, no Firestore dependency. Works exclusively from Tier 2 data.

import {
  startOfWeek, endOfWeek, startOfMonth, endOfMonth,
  startOfQuarter, endOfQuarter, startOfYear, endOfYear,
  startOfDay, endOfDay,
  format, getDay, parseISO, isWithinInterval,
} from 'date-fns';
import type { StoredSession, DateRange, PeriodSummary } from '../types/reports';

// ── Date Range Helpers ────────────────────────────────────────────────────────

export function getDayRange(date: Date): DateRange {
  return { start: startOfDay(date), end: endOfDay(date) };
}

export function getWeekRange(date: Date, weekStartDay: 'sunday' | 'monday' = 'monday'): DateRange {
  const weekStartsOn = weekStartDay === 'monday' ? 1 : 0;
  return {
    start: startOfWeek(date, { weekStartsOn }),
    end: endOfWeek(date, { weekStartsOn }),
  };
}

export function getMonthRange(year: number, month: number): DateRange {
  const d = new Date(year, month - 1, 1);
  return { start: startOfMonth(d), end: endOfMonth(d) };
}

export function getQuarterRange(year: number, quarter: 1 | 2 | 3 | 4): DateRange {
  const month = (quarter - 1) * 3;
  const d = new Date(year, month, 1);
  return { start: startOfQuarter(d), end: endOfQuarter(d) };
}

export function getYearRange(year: number): DateRange {
  const d = new Date(year, 0, 1);
  return { start: startOfYear(d), end: endOfYear(d) };
}

// ── Grouping Helpers ──────────────────────────────────────────────────────────

export function groupSessionsByWeek(
  sessions: StoredSession[],
  weekStartDay: 'sunday' | 'monday' = 'monday'
): Map<string, StoredSession[]> {
  const weekStartsOn = weekStartDay === 'monday' ? 1 : 0;
  const grouped = new Map<string, StoredSession[]>();
  for (const s of sessions) {
    const d = parseISO(s.startDateTime);
    const weekStart = startOfWeek(d, { weekStartsOn });
    const key = format(weekStart, 'yyyy-MM-dd');
    const existing = grouped.get(key) || [];
    existing.push(s);
    grouped.set(key, existing);
  }
  return grouped;
}

export function groupSessionsByMonth(sessions: StoredSession[]): Map<string, StoredSession[]> {
  const grouped = new Map<string, StoredSession[]>();
  for (const s of sessions) {
    const d = parseISO(s.startDateTime);
    const key = format(d, 'yyyy-MM');
    const existing = grouped.get(key) || [];
    existing.push(s);
    grouped.set(key, existing);
  }
  return grouped;
}

// ── Core Aggregation ──────────────────────────────────────────────────────────

export function aggregateSessions(sessions: StoredSession[], dateRange: DateRange): PeriodSummary {
  // Filter sessions to date range
  const filtered = sessions.filter(s => {
    const d = parseISO(s.startDateTime);
    return isWithinInterval(d, { start: dateRange.start, end: dateRange.end });
  });

  const totalSessions = filtered.length;
  const fullDaySessions = filtered.filter(s => !s.halfDay).length;
  const halfDaySessions = filtered.filter(s => s.halfDay).length;
  const totalStudies = filtered.reduce((sum, s) => sum + s.studiesCompleted, 0);
  const totalRVU = filtered.reduce((sum, s) => sum + s.totalRVU, 0);
  const totalVerifiedRVU = filtered.reduce((sum, s) => sum + (s.verifiedRVU ?? 0), 0);
  const sessionsWithVerifiedRVU = filtered.filter(s => s.verifiedRVU != null && s.verifiedRVU > 0).length;

  // Time totals
  const totalSessionTime = filtered.reduce((sum, s) => sum + s.totalSessionTime, 0);
  const totalStudyTime = filtered.reduce((sum, s) => {
    return sum + (s.summary?.timeAllocation.study ?? (s.totalSessionTime - s.interstitialTime - s.adminTime - s.commsTime - s.breakTime - s.doubleTapTime));
  }, 0);
  const totalInterstitialTime = filtered.reduce((sum, s) => sum + s.interstitialTime, 0);
  const totalAdminTime = filtered.reduce((sum, s) => sum + s.adminTime, 0);
  const totalCommsTime = filtered.reduce((sum, s) => sum + s.commsTime, 0);
  const totalBreakTime = filtered.reduce((sum, s) => sum + s.breakTime, 0);
  const totalDoubleTapTime = filtered.reduce((sum, s) => sum + s.doubleTapTime, 0);

  // RVU/hr: total RVU / total session hours (excluding break time)
  const productiveHours = (totalSessionTime - totalBreakTime) / 3600;
  const avgRVUPerHour = productiveHours > 0 ? totalRVU / productiveHours : 0;

  // Per-session metrics for averaging
  const sessionVariances: number[] = [];
  const sessionProductiveRatios: number[] = [];

  for (const s of filtered) {
    // Average variance from summary if available
    if (s.summary?.avgVarianceByModality) {
      const variances = Object.values(s.summary.avgVarianceByModality);
      if (variances.length > 0) {
        sessionVariances.push(variances.reduce((a, b) => a + b, 0) / variances.length);
      }
    } else if (s.cumulativeParTime > 0 && s.studiesCompleted > 0) {
      // Fallback: compute from session-level data
      const totalElapsed = s.totalSessionTime - s.interstitialTime - s.adminTime - s.commsTime - s.breakTime - s.doubleTapTime;
      sessionVariances.push((totalElapsed - s.cumulativeParTime) / s.studiesCompleted);
    }

    if (s.summary?.productiveTimeRatio !== undefined) {
      sessionProductiveRatios.push(s.summary.productiveTimeRatio);
    } else if (s.totalSessionTime > 0) {
      const studyTime = s.totalSessionTime - s.interstitialTime - s.adminTime - s.commsTime - s.breakTime - s.doubleTapTime;
      sessionProductiveRatios.push((studyTime + s.doubleTapTime) / s.totalSessionTime);
    }
  }

  const avgVariance = sessionVariances.length > 0
    ? sessionVariances.reduce((a, b) => a + b, 0) / sessionVariances.length : 0;
  // Productive ratio weighted by session duration: (Σ ratio×duration) / Σ duration
  const avgProductiveRatio = (() => {
    let weightedSum = 0, totalDuration = 0;
    for (const s of sessions) {
      const ratio = s.summary?.productiveTimeRatio ??
        (s.totalSessionTime > 0 ? (s.totalSessionTime - s.interstitialTime - s.adminTime - s.commsTime - s.breakTime) / s.totalSessionTime : 0);
      weightedSum += ratio * s.totalSessionTime;
      totalDuration += s.totalSessionTime;
    }
    return totalDuration > 0 ? weightedSum / totalDuration : 0;
  })();

  // Modality breakdowns
  const studiesByModality: Record<string, number> = {};
  const rvuByModality: Record<string, number> = {};
  const timeByModality: Record<string, number> = {};
  const variancesByModality: Record<string, number[]> = {};

  for (const s of filtered) {
    if (s.summary) {
      for (const [mod, count] of Object.entries(s.summary.studiesByModality)) {
        studiesByModality[mod] = (studiesByModality[mod] || 0) + count;
      }
      for (const [mod, rate] of Object.entries(s.summary.rvuPerHourByModality)) {
        // Accumulate time and RVU per modality for proper rate calculation
        const modStudies = s.summary.studiesByModality[mod] || 0;
        const modTime = modStudies > 0 && rate > 0 ? (s.summary.studiesByModality[mod] || 0) : 0;
        // We need RVU totals per modality — derive from rate * hours
        // This is approximate; we don't have per-modality time at session level
        timeByModality[mod] = (timeByModality[mod] || 0) + modTime;
      }
      for (const [mod, v] of Object.entries(s.summary.avgVarianceByModality)) {
        if (!variancesByModality[mod]) variancesByModality[mod] = [];
        variancesByModality[mod].push(v);
      }
    }
  }

  // Rebuild RVU by modality from session-level summary data
  for (const s of filtered) {
    if (s.summary) {
      // Use rvuPerHourByModality and studiesByModality to estimate RVU per modality
      for (const [mod] of Object.entries(s.summary.rvuPerHourByModality)) {
        const modStudyCount = s.summary.studiesByModality[mod] || 0;
        // Approximate: if we know the total session RVU and study distribution
        if (s.studiesCompleted > 0 && modStudyCount > 0) {
          const proportion = modStudyCount / s.studiesCompleted;
          rvuByModality[mod] = (rvuByModality[mod] || 0) + (s.totalRVU * proportion);
        }
      }
    }
  }

  // RVU/hr by modality: use accumulated totals
  const rvuPerHourByModality: Record<string, number> = {};
  for (const mod of Object.keys(studiesByModality)) {
    // Use the weighted average of per-session RVU/hr rates
    const rates: number[] = [];
    for (const s of filtered) {
      if (s.summary?.rvuPerHourByModality[mod] !== undefined) {
        rates.push(s.summary.rvuPerHourByModality[mod]);
      }
    }
    rvuPerHourByModality[mod] = rates.length > 0
      ? rates.reduce((a, b) => a + b, 0) / rates.length : 0;
  }

  // Avg variance by modality
  const avgVarianceByModality: Record<string, number> = {};
  for (const [mod, variances] of Object.entries(variancesByModality)) {
    avgVarianceByModality[mod] = variances.reduce((a, b) => a + b, 0) / variances.length;
  }

  // Rotation breakdowns
  const sessionsByRotation: Record<string, number> = {};
  const rvuPerHourByRotation: Record<string, number> = {};
  const varianceByRotation: Record<string, number[]> = {};
  const rvuByRotation: Record<string, number> = {};
  const hoursMinusBreakByRotation: Record<string, number> = {};

  for (const s of filtered) {
    const rot = s.rotation || 'Unknown';
    sessionsByRotation[rot] = (sessionsByRotation[rot] || 0) + 1;
    rvuByRotation[rot] = (rvuByRotation[rot] || 0) + s.totalRVU;
    hoursMinusBreakByRotation[rot] = (hoursMinusBreakByRotation[rot] || 0) + (s.totalSessionTime - s.breakTime) / 3600;

    if (s.summary?.avgVarianceByModality) {
      const variances = Object.values(s.summary.avgVarianceByModality);
      if (variances.length > 0) {
        if (!varianceByRotation[rot]) varianceByRotation[rot] = [];
        varianceByRotation[rot].push(variances.reduce((a, b) => a + b, 0) / variances.length);
      }
    }
  }

  for (const rot of Object.keys(sessionsByRotation)) {
    const hours = hoursMinusBreakByRotation[rot] || 0;
    rvuPerHourByRotation[rot] = hours > 0 ? (rvuByRotation[rot] || 0) / hours : 0;
  }

  const avgVarianceByRotation: Record<string, number> = {};
  for (const [rot, variances] of Object.entries(varianceByRotation)) {
    avgVarianceByRotation[rot] = variances.reduce((a, b) => a + b, 0) / variances.length;
  }

  // Day of week
  const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const sessionsByDayOfWeek: Record<string, number> = {};
  const rvuPerHourByDayOfWeek: Record<string, number[]> = {};

  for (const s of filtered) {
    const d = parseISO(s.startDateTime);
    const dayName = DAY_NAMES[getDay(d)];
    sessionsByDayOfWeek[dayName] = (sessionsByDayOfWeek[dayName] || 0) + 1;
    if (!rvuPerHourByDayOfWeek[dayName]) rvuPerHourByDayOfWeek[dayName] = [];
    const hours = (s.totalSessionTime - s.breakTime) / 3600;
    if (hours > 0) {
      rvuPerHourByDayOfWeek[dayName].push(s.totalRVU / hours);
    }
  }

  const avgRVUPerHourByDayOfWeek: Record<string, number> = {};
  for (const [day, rates] of Object.entries(rvuPerHourByDayOfWeek)) {
    avgRVUPerHourByDayOfWeek[day] = rates.length > 0
      ? rates.reduce((a, b) => a + b, 0) / rates.length : 0;
  }

  // Tag frequency + correlated metrics
  const tagFrequency: Record<string, number> = {};
  const tagSessions: Record<string, StoredSession[]> = {};

  for (const s of filtered) {
    if (s.notes?.tags) {
      for (const tag of s.notes.tags) {
        if (tag === 'No Comment') continue;
        tagFrequency[tag] = (tagFrequency[tag] || 0) + 1;
        if (!tagSessions[tag]) tagSessions[tag] = [];
        tagSessions[tag].push(s);
      }
    }
  }

  const tagCorrelatedMetrics: Record<string, { sessionCount: number; avgRVUPerHour: number; avgVariance: number }> = {};
  for (const [tag, sessions] of Object.entries(tagSessions)) {
    const tagTotalRVU = sessions.reduce((sum, s) => sum + s.totalRVU, 0);
    const tagHours = sessions.reduce((sum, s) => sum + (s.totalSessionTime - s.breakTime) / 3600, 0);
    const tagVariances: number[] = [];
    for (const s of sessions) {
      if (s.summary?.avgVarianceByModality) {
        const v = Object.values(s.summary.avgVarianceByModality);
        if (v.length > 0) tagVariances.push(v.reduce((a, b) => a + b, 0) / v.length);
      }
    }
    tagCorrelatedMetrics[tag] = {
      sessionCount: sessions.length,
      avgRVUPerHour: tagHours > 0 ? tagTotalRVU / tagHours : 0,
      avgVariance: tagVariances.length > 0 ? tagVariances.reduce((a, b) => a + b, 0) / tagVariances.length : 0,
    };
  }

  // Break & interstitial averages
  const totalBreakEvents = filtered.reduce((sum, s) => sum + s.breakEvents, 0);
  const avgBreaksPerSession = totalSessions > 0 ? totalBreakEvents / totalSessions : 0;
  const avgInterstitialPerStudy = totalStudies > 0 ? totalInterstitialTime / totalStudies : 0;

  // Complication cost aggregated
  const complicationCostAggregated: Record<string, { totalTimeAdded: number; totalParAllotment: number; totalOccurrences: number }> = {};
  for (const s of filtered) {
    if (s.summary?.complicationCost) {
      for (const [comp, data] of Object.entries(s.summary.complicationCost)) {
        if (!complicationCostAggregated[comp]) {
          complicationCostAggregated[comp] = { totalTimeAdded: 0, totalParAllotment: 0, totalOccurrences: 0 };
        }
        complicationCostAggregated[comp].totalTimeAdded += data.avgActualTimeAdded * data.occurrences;
        complicationCostAggregated[comp].totalParAllotment += data.parTimeAllotment * data.occurrences;
        complicationCostAggregated[comp].totalOccurrences += data.occurrences;
      }
    }
  }

  const complicationCostResult: PeriodSummary['complicationCostAggregated'] = {};
  for (const [comp, data] of Object.entries(complicationCostAggregated)) {
    complicationCostResult[comp] = {
      avgActualTimeAdded: data.totalOccurrences > 0 ? data.totalTimeAdded / data.totalOccurrences : 0,
      parTimeAllotment: data.totalOccurrences > 0 ? data.totalParAllotment / data.totalOccurrences : 0,
      totalOccurrences: data.totalOccurrences,
    };
  }

  // Best session
  let bestSession: PeriodSummary['bestSession'] = null;
  for (const s of filtered) {
    const hours = (s.totalSessionTime - s.breakTime) / 3600;
    if (hours <= 0 || s.studiesCompleted === 0) continue;
    const rvuHr = s.totalRVU / hours;
    const pr = s.summary?.productiveTimeRatio ?? 0;
    if (!bestSession || rvuHr > bestSession.rvuPerHour) {
      bestSession = {
        date: s.startDateTime,
        rvuPerHour: rvuHr,
        studies: s.studiesCompleted,
        productiveRatio: pr,
      };
    }
  }

  // Session data points for trend charts
  const sessionDataPoints = filtered.map(s => {
    const hours = (s.totalSessionTime - s.breakTime) / 3600;
    const rvuHr = hours > 0 ? s.totalRVU / hours : 0;
    const variance = s.summary?.avgVarianceByModality
      ? (() => {
          const v = Object.values(s.summary!.avgVarianceByModality);
          return v.length > 0 ? v.reduce((a, b) => a + b, 0) / v.length : 0;
        })()
      : 0;
    const pr = s.summary?.productiveTimeRatio ?? 0;
    const intAvg = s.studiesCompleted > 0 ? s.interstitialTime / s.studiesCompleted : 0;

    return {
      date: s.startDateTime,
      rvuPerHour: rvuHr,
      variance,
      productiveRatio: pr,
      studies: s.studiesCompleted,
      totalRVU: s.totalRVU,
      interstitialAvg: intAvg,
      rvuPerStudy: s.studiesCompleted > 0 ? s.totalRVU / s.studiesCompleted : 0,
      studiesPerHour: hours > 0 ? s.studiesCompleted / hours : 0,
    };
  });

  // ── Performance Insights aggregation ──────────────────────────────────

  // Hourly profile: aggregate across sessions
  const hourlyProfile: Record<string, { totalStudies: number; totalRvu: number; sessionCount: number }> = {};
  for (const s of filtered) {
    const hp = s.summary?.hourlyProfile;
    if (!hp) continue;
    for (const [hour, data] of Object.entries(hp)) {
      if (!hourlyProfile[hour]) hourlyProfile[hour] = { totalStudies: 0, totalRvu: 0, sessionCount: 0 };
      hourlyProfile[hour].totalStudies += data.studies;
      hourlyProfile[hour].totalRvu += data.rvu;
      hourlyProfile[hour].sessionCount += 1;
    }
  }
  const hourlyProfileAvg: Record<string, { avgStudies: number; avgRvu: number; sessionCount: number }> = {};
  for (const [hour, data] of Object.entries(hourlyProfile)) {
    hourlyProfileAvg[hour] = {
      avgStudies: data.sessionCount > 0 ? data.totalStudies / data.sessionCount : 0,
      avgRvu: data.sessionCount > 0 ? data.totalRvu / data.sessionCount : 0,
      sessionCount: data.sessionCount,
    };
  }

  // Deck quality metrics
  const avgRvuPerStudy = totalStudies > 0 ? totalRVU / totalStudies : 0;
  const periodProductiveHours = (totalStudyTime + totalInterstitialTime + totalAdminTime + totalCommsTime + totalDoubleTapTime) / 3600;
  const avgStudiesPerHour = periodProductiveHours > 0 ? totalStudies / periodProductiveHours : 0;

  // Fastest/slowest CPTs aggregated
  const cptAgg: Record<string, { modality: string; totalVariance: number; count: number }> = {};
  for (const s of filtered) {
    if (!s.summary?.fastestCpts) continue;
    for (const c of [...(s.summary.fastestCpts || []), ...(s.summary.slowestCpts || [])]) {
      if (!cptAgg[c.cpt]) cptAgg[c.cpt] = { modality: c.modality, totalVariance: 0, count: 0 };
      cptAgg[c.cpt].totalVariance += c.avgVariance * c.count;
      cptAgg[c.cpt].count += c.count;
    }
  }
  const cptAggList = Object.entries(cptAgg)
    .filter(([, v]) => v.count >= 2)
    .map(([cpt, v]) => ({ cpt, modality: v.modality, avgVariance: v.totalVariance / v.count, totalCount: v.count }));
  const fastestCpts = [...cptAggList].sort((a, b) => a.avgVariance - b.avgVariance).slice(0, 3);
  const slowestCpts = [...cptAggList].sort((a, b) => b.avgVariance - a.avgVariance).slice(0, 3);

  // First-study warmup averaged
  const warmupCosts = filtered
    .map(s => s.summary?.firstStudyWarmup?.warmupCost)
    .filter((c): c is number => c !== undefined && c !== null);
  const avgWarmupCost = warmupCosts.length > 0
    ? warmupCosts.reduce((a, b) => a + b, 0) / warmupCosts.length
    : null;

  // Break ROI aggregated
  const breakBefore = filtered.map(s => s.summary?.breakROI?.avgVarianceBefore).filter((v): v is number => v !== null && v !== undefined);
  const breakAfter = filtered.map(s => s.summary?.breakROI?.avgVarianceAfter).filter((v): v is number => v !== null && v !== undefined);
  const totalBreaks = filtered.reduce((sum, s) => sum + (s.summary?.breakROI?.breakCount || 0), 0);
  const avgBreakROI = {
    avgBefore: breakBefore.length > 0 ? breakBefore.reduce((a, b) => a + b, 0) / breakBefore.length : null,
    avgAfter: breakAfter.length > 0 ? breakAfter.reduce((a, b) => a + b, 0) / breakAfter.length : null,
    totalBreaks,
  };

  // Modality transition aggregated
  const transSame = filtered.map(s => s.summary?.modalityTransitionPenalty?.avgInterstitialSameModality).filter((v): v is number => v !== null && v !== undefined);
  const transDiff = filtered.map(s => s.summary?.modalityTransitionPenalty?.avgInterstitialDifferentModality).filter((v): v is number => v !== null && v !== undefined);
  const avgTransitionPenalty = {
    same: transSame.length > 0 ? transSame.reduce((a, b) => a + b, 0) / transSame.length : null,
    different: transDiff.length > 0 ? transDiff.reduce((a, b) => a + b, 0) / transDiff.length : null,
  };

  // Average interstitial time
  const avgInterstitialTime = totalStudies > 0 ? totalInterstitialTime / totalStudies : 0;

  return {
    dateRange,
    sessions: filtered,
    totalSessions,
    fullDaySessions,
    halfDaySessions,
    totalStudies,
    totalRVU,
    totalVerifiedRVU,
    sessionsWithVerifiedRVU,
    avgRVUPerHour,
    avgVariance,
    avgProductiveRatio,
    totalStudyTime,
    totalInterstitialTime,
    totalAdminTime,
    totalCommsTime,
    totalBreakTime,
    totalDoubleTapTime,
    studiesByModality,
    rvuByModality,
    rvuPerHourByModality,
    avgVarianceByModality,
    sessionsByRotation,
    rvuPerHourByRotation,
    avgVarianceByRotation,
    sessionsByDayOfWeek,
    avgRVUPerHourByDayOfWeek,
    tagFrequency,
    tagCorrelatedMetrics,
    avgBreaksPerSession,
    avgInterstitialPerStudy,
    complicationCostAggregated: complicationCostResult,
    bestSession,
    sessionDataPoints,
    // Performance Insights
    hourlyProfile: hourlyProfileAvg,
    avgRvuPerStudy,
    avgStudiesPerHour,
    fastestCpts,
    slowestCpts,
    avgWarmupCost,
    avgBreakROI,
    avgTransitionPenalty,
    avgInterstitialTime,
  };
}

// ── Trend Computation ─────────────────────────────────────────────────────────

export interface WeeklyTrendPoint {
  weekLabel: string;
  weekStart: string;
  avgRVUPerHour: number;
  avgVariance: number;
  avgProductiveRatio: number;
  totalStudies: number;
  totalRVU: number;
  sessions: number;
  rvuPerHourByModality: Record<string, number>;
  avgInterstitialTime: number;
  avgRvuPerStudy: number;
  studiesPerHour: number;
}

export function computeWeeklyTrend(
  sessions: StoredSession[],
  weekStartDay: 'sunday' | 'monday' = 'monday'
): WeeklyTrendPoint[] {
  const grouped = groupSessionsByWeek(sessions, weekStartDay);
  const points: WeeklyTrendPoint[] = [];

  const sortedKeys = [...grouped.keys()].sort();
  for (const key of sortedKeys) {
    const weekSessions = grouped.get(key)!;
    const range = getWeekRange(parseISO(key), weekStartDay);
    const summary = aggregateSessions(weekSessions, range);
    points.push({
      weekLabel: format(parseISO(key), 'MMM d'),
      weekStart: key,
      avgRVUPerHour: summary.avgRVUPerHour,
      avgVariance: summary.avgVariance,
      avgProductiveRatio: summary.avgProductiveRatio,
      totalStudies: summary.totalStudies,
      totalRVU: summary.totalRVU,
      sessions: summary.totalSessions,
      rvuPerHourByModality: summary.rvuPerHourByModality,
      avgInterstitialTime: summary.avgInterstitialTime,
      avgRvuPerStudy: summary.avgRvuPerStudy,
      studiesPerHour: summary.avgStudiesPerHour,
    });
  }

  return points;
}

export interface MonthlyTrendPoint {
  monthLabel: string;
  monthKey: string;
  avgRVUPerHour: number;
  avgVariance: number;
  avgProductiveRatio: number;
  totalStudies: number;
  totalRVU: number;
  sessions: number;
  rvuPerHourByModality: Record<string, number>;
  avgInterstitialTime: number;
  avgRvuPerStudy: number;
  studiesPerHour: number;
}

export function computeMonthlyTrend(sessions: StoredSession[]): MonthlyTrendPoint[] {
  const grouped = groupSessionsByMonth(sessions);
  const points: MonthlyTrendPoint[] = [];

  const sortedKeys = [...grouped.keys()].sort();
  for (const key of sortedKeys) {
    const monthSessions = grouped.get(key)!;
    const [year, month] = key.split('-').map(Number);
    const range = getMonthRange(year, month);
    const summary = aggregateSessions(monthSessions, range);
    points.push({
      monthLabel: format(new Date(year, month - 1, 1), 'MMM yyyy'),
      monthKey: key,
      avgRVUPerHour: summary.avgRVUPerHour,
      avgVariance: summary.avgVariance,
      avgProductiveRatio: summary.avgProductiveRatio,
      totalStudies: summary.totalStudies,
      totalRVU: summary.totalRVU,
      sessions: summary.totalSessions,
      rvuPerHourByModality: summary.rvuPerHourByModality,
      avgInterstitialTime: summary.avgInterstitialTime,
      avgRvuPerStudy: summary.avgRvuPerStudy,
      studiesPerHour: summary.avgStudiesPerHour,
    });
  }

  return points;
}

// ── Delta Computation ─────────────────────────────────────────────────────────

export interface PeriodDelta {
  rvuPerHourDelta: number;
  rvuPerHourPctChange: number;
  varianceDelta: number;
  productiveRatioDelta: number;
  studiesDelta: number;
  rvuDelta: number;
  sessionsDelta: number;
}

export function computeDelta(current: PeriodSummary, prior: PeriodSummary): PeriodDelta {
  return {
    rvuPerHourDelta: current.avgRVUPerHour - prior.avgRVUPerHour,
    rvuPerHourPctChange: prior.avgRVUPerHour > 0
      ? ((current.avgRVUPerHour - prior.avgRVUPerHour) / prior.avgRVUPerHour) * 100 : 0,
    varianceDelta: current.avgVariance - prior.avgVariance,
    productiveRatioDelta: current.avgProductiveRatio - prior.avgProductiveRatio,
    studiesDelta: current.totalStudies - prior.totalStudies,
    rvuDelta: current.totalRVU - prior.totalRVU,
    sessionsDelta: current.totalSessions - prior.totalSessions,
  };
}

// ── Personal Bests ────────────────────────────────────────────────────────────

export interface PersonalBests {
  bestSession: { date: string; rvuPerHour: number; studies: number } | null;
  bestWeek: { weekLabel: string; avgRVUPerHour: number; totalRVU: number } | null;
  bestMonth: { monthLabel: string; avgRVUPerHour: number; totalRVU: number } | null;
  longestUnderParStreak: number;
}

export function findPersonalBests(sessions: StoredSession[]): PersonalBests {
  // Best session by RVU/hr
  let bestSession: PersonalBests['bestSession'] = null;
  for (const s of sessions) {
    const hours = (s.totalSessionTime - s.breakTime) / 3600;
    if (hours <= 0 || s.studiesCompleted === 0) continue;
    const rvuHr = s.totalRVU / hours;
    if (!bestSession || rvuHr > bestSession.rvuPerHour) {
      bestSession = { date: s.startDateTime, rvuPerHour: rvuHr, studies: s.studiesCompleted };
    }
  }

  // Best week
  const weeklyTrend = computeWeeklyTrend(sessions);
  let bestWeek: PersonalBests['bestWeek'] = null;
  for (const w of weeklyTrend) {
    if (!bestWeek || w.avgRVUPerHour > bestWeek.avgRVUPerHour) {
      bestWeek = { weekLabel: w.weekLabel, avgRVUPerHour: w.avgRVUPerHour, totalRVU: w.totalRVU };
    }
  }

  // Best month
  const monthlyTrend = computeMonthlyTrend(sessions);
  let bestMonth: PersonalBests['bestMonth'] = null;
  for (const m of monthlyTrend) {
    if (!bestMonth || m.avgRVUPerHour > bestMonth.avgRVUPerHour) {
      bestMonth = { monthLabel: m.monthLabel, avgRVUPerHour: m.avgRVUPerHour, totalRVU: m.totalRVU };
    }
  }

  // Longest under-par streak: consecutive sessions where avg variance <= 0
  let longestUnderParStreak = 0;
  let currentStreak = 0;
  const sorted = [...sessions].sort((a, b) => a.startDateTime.localeCompare(b.startDateTime));
  for (const s of sorted) {
    if (s.summary?.avgVarianceByModality) {
      const v = Object.values(s.summary.avgVarianceByModality);
      const avg = v.length > 0 ? v.reduce((a, b) => a + b, 0) / v.length : 0;
      if (avg <= 0) {
        currentStreak++;
        longestUnderParStreak = Math.max(longestUnderParStreak, currentStreak);
      } else {
        currentStreak = 0;
      }
    }
  }

  return { bestSession, bestWeek, bestMonth, longestUnderParStreak };
}
