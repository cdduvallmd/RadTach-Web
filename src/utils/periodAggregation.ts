// Period Aggregation — computes PeriodSummary from StoredSession[]
// Pure computation, no Firestore dependency. Works exclusively from Tier 2 data.

import {
  startOfWeek, endOfWeek, startOfMonth, endOfMonth,
  startOfQuarter, endOfQuarter, startOfYear, endOfYear,
  startOfDay, endOfDay,
  format, getDay, parseISO, isWithinInterval,
} from 'date-fns';
import type { StoredSession, DateRange, PeriodSummary } from '../types/reports';
import type { PvcConfig, UserPvcSettings, ProductivityTierPeriod } from '../types/pvc';
import { anyRotationHasBonus, anyRotationHasBonusShiftCredit, computeBonusShiftsPerShift, monthKey, quarterKey, dayKey } from './pvcConfig';

// Flat-rate sessions (e.g. Fluoro with pvcWrvuOverride set at session start)
// contribute a fixed wRVU credit that isn't earned per unit time. They belong
// in absolute totals (wRVU sums, shifts, session time) but pollute rate,
// variance, and productivity-ratio metrics — a 60-wRVU Fluoro session over
// 8 hours reads as 7.5 RVU/hr and skews any per-hour average toward the
// flat rate. Any metric that divides RVU or studies by time (or that ranks
// by RVU/hr) should exclude these.
function isFlatRateSession(s: StoredSession): boolean {
  return s.pvcWrvuOverride != null;
}

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

  // Flat-rate sessions are excluded from every per-hour, per-study,
  // variance, and productivity-ratio metric. See isFlatRateSession above.
  const filteredForRates = filtered.filter(s => !isFlatRateSession(s));

  const totalSessions = filtered.length;
  const fullDaySessions = filtered.filter(s => !s.halfDay).length;
  const halfDaySessions = filtered.filter(s => s.halfDay).length;
  const totalStudies = filtered.reduce((sum, s) => sum + s.studiesCompleted, 0);
  // FLUORO-style flat RVU: when pvcWrvuOverride is set (non-null), it
  // REPLACES the session's accrued wRVU. Mirrors the pattern used in
  // aggregatePvc() below.
  const totalRVU = filtered.reduce((sum, s) => {
    const sessionWrvu = (s.pvcWrvuOverride != null) ? s.pvcWrvuOverride : s.totalRVU;
    return sum + sessionWrvu;
  }, 0);
  const totalVerifiedRVU = filtered.reduce((sum, s) => sum + (s.verifiedRVU ?? 0), 0);
  const sessionsWithVerifiedRVU = filtered.filter(s => s.verifiedRVU != null && s.verifiedRVU > 0).length;

  // Time totals
  const totalStudyTime = filtered.reduce((sum, s) => {
    return sum + (s.summary?.timeAllocation.study ?? (s.totalSessionTime - s.interstitialTime - s.adminTime - s.commsTime - s.breakTime - s.doubleTapTime));
  }, 0);
  const totalInterstitialTime = filtered.reduce((sum, s) => sum + s.interstitialTime, 0);
  const totalAdminTime = filtered.reduce((sum, s) => sum + s.adminTime, 0);
  const totalCommsTime = filtered.reduce((sum, s) => sum + s.commsTime, 0);
  const totalBreakTime = filtered.reduce((sum, s) => sum + s.breakTime, 0);
  const totalDoubleTapTime = filtered.reduce((sum, s) => sum + s.doubleTapTime, 0);

  // RVU/hr: uses non-flat-rate sessions only. Flat-rate wRVU isn't earned per
  // unit time, so including flat-rate sessions in either the numerator or
  // denominator distorts the ratio.
  const ratesRvuSum = filteredForRates.reduce((sum, s) => sum + s.totalRVU, 0);
  const ratesHours = filteredForRates.reduce((sum, s) => sum + (s.totalSessionTime - s.breakTime), 0) / 3600;
  const avgRVUPerHour = ratesHours > 0 ? ratesRvuSum / ratesHours : 0;

  // Per-session metrics for averaging (flat-rate sessions excluded)
  const sessionVariances: number[] = [];
  const sessionProductiveRatios: number[] = [];

  for (const s of filteredForRates) {
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
    for (const s of filteredForRates) {
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
  const studiesByRotation: Record<string, number> = {};
  const hoursMinusBreakByRotation: Record<string, number> = {};

  // Absolute totals include flat-rate sessions (informative — you did work Fluoro)
  for (const s of filtered) {
    const rot = s.rotation || 'Unknown';
    sessionsByRotation[rot] = (sessionsByRotation[rot] || 0) + 1;
    rvuByRotation[rot] = (rvuByRotation[rot] || 0) + s.totalRVU;
    studiesByRotation[rot] = (studiesByRotation[rot] || 0) + s.studiesCompleted;
  }

  // Rate/variance denominators exclude flat-rate sessions.
  const rvuByRotationForRates: Record<string, number> = {};
  const studiesByRotationForRates: Record<string, number> = {};
  for (const s of filteredForRates) {
    const rot = s.rotation || 'Unknown';
    hoursMinusBreakByRotation[rot] = (hoursMinusBreakByRotation[rot] || 0) + (s.totalSessionTime - s.breakTime) / 3600;
    rvuByRotationForRates[rot] = (rvuByRotationForRates[rot] || 0) + s.totalRVU;
    studiesByRotationForRates[rot] = (studiesByRotationForRates[rot] || 0) + s.studiesCompleted;

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
    // Rotations composed entirely of flat-rate sessions get no rate entry;
    // showing "0 RVU/hr" or a flat-rate-inflated number would misinform.
    rvuPerHourByRotation[rot] = hours > 0 ? (rvuByRotationForRates[rot] || 0) / hours : 0;
  }

  const avgVarianceByRotation: Record<string, number> = {};
  for (const [rot, variances] of Object.entries(varianceByRotation)) {
    avgVarianceByRotation[rot] = variances.reduce((a, b) => a + b, 0) / variances.length;
  }

  // Rotation deck quality decomposition — uses non-flat-rate accumulators so
  // Fluoro's 60 flat wRVU doesn't inflate per-study or per-hour ratios.
  const avgRvuPerStudyByRotation: Record<string, number> = {};
  const studiesPerHourByRotation: Record<string, number> = {};
  for (const rot of Object.keys(sessionsByRotation)) {
    const studies = studiesByRotationForRates[rot] || 0;
    const hours = hoursMinusBreakByRotation[rot] || 0;
    avgRvuPerStudyByRotation[rot] = studies > 0 ? (rvuByRotationForRates[rot] || 0) / studies : 0;
    studiesPerHourByRotation[rot] = hours > 0 ? studies / hours : 0;
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
    // Rate accumulation excludes flat-rate — a Fluoro day at 60/8=7.5 RVU/hr
    // isn't a productivity signal for that weekday.
    if (hours > 0 && !isFlatRateSession(s)) {
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

  // Best session — flat-rate sessions can't win an RVU/hr contest by design.
  let bestSession: PeriodSummary['bestSession'] = null;
  for (const s of filteredForRates) {
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

  // Session data points for trend charts — flat-rate sessions omitted so they
  // don't produce off-scale outliers on RVU/hr and variance axes.
  const sessionDataPoints = filteredForRates.map(s => {
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
      rotation: s.rotation || 'Unknown',
      office: s.workstationId || 'Unknown',
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

  // Deck quality metrics — computed from non-flat-rate sessions only. Fluoro's
  // 60 wRVU over 0 studies would produce Infinity RVU/study, and its shift
  // time would dilute studies/hour without contributing studies.
  const ratesStudies = filteredForRates.reduce((sum, s) => sum + s.studiesCompleted, 0);
  const ratesStudyTime = filteredForRates.reduce((sum, s) => {
    return sum + (s.summary?.timeAllocation.study ?? (s.totalSessionTime - s.interstitialTime - s.adminTime - s.commsTime - s.breakTime - s.doubleTapTime));
  }, 0);
  const ratesInterstitial = filteredForRates.reduce((sum, s) => sum + s.interstitialTime, 0);
  const ratesAdmin = filteredForRates.reduce((sum, s) => sum + s.adminTime, 0);
  const ratesComms = filteredForRates.reduce((sum, s) => sum + s.commsTime, 0);
  const ratesDoubleTap = filteredForRates.reduce((sum, s) => sum + s.doubleTapTime, 0);
  const avgRvuPerStudy = ratesStudies > 0 ? ratesRvuSum / ratesStudies : 0;
  const periodProductiveHours = (ratesStudyTime + ratesInterstitial + ratesAdmin + ratesComms + ratesDoubleTap) / 3600;
  const avgStudiesPerHour = periodProductiveHours > 0 ? ratesStudies / periodProductiveHours : 0;

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
    studiesByRotation,
    avgRvuPerStudyByRotation,
    studiesPerHourByRotation,
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
  // Best session by RVU/hr — flat-rate sessions excluded (their per-hour
  // rate is a mechanical division, not a productivity record).
  let bestSession: PersonalBests['bestSession'] = null;
  for (const s of sessions) {
    if (isFlatRateSession(s)) continue;
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

// ── PVC Aggregation ───────────────────────────────────────────────────────────
// Plan: /Users/charlesduvall/.claude/plans/vast-snuggling-kernighan.md
//
// Computes compensation-oriented totals for a period. Adaptive columns let the
// caller (report section) decide which to render based on what the practice has
// configured. Pure function — caller filters sessions to the desired range first.

export interface PvcColumnsToShow {
  shifts: boolean;            // always true when PVC enabled
  wrvu: boolean;              // always true
  bonusRvu: boolean;          // true if any rotation has bonus OR any session earned
  meetingRvu: boolean;        // true if any meetings logged (Phase 2a)
  allInRvuPerShift: boolean;  // true if bonus or meeting columns active
  estimatedDollars: boolean;  // true if shiftValue !== null
  clockHours: boolean;        // always true when PVC enabled (session totalSessionTime)
  // Bonus-shift columns — three cells: RVU / Rotation / Total. Shown together
  // whenever either mechanism is configured. Zeros and negatives display
  // rather than hiding, so a zero rotation-bonus column reads as "no call
  // shifts this month" instead of an ambiguous absence.
  bonusShiftsFromRvu: boolean;      // true if productivityTiersActive AND tiers configured
  bonusShiftsFromRotation: boolean; // true if any rotation has bonusShiftCredit > 0
  bonusShiftsTotal: boolean;        // true if either of the above is true
}

// One row in the period-breakdown table. The unit of "period" is determined by
// pvcConfig.productivityTierPeriod (daily / monthly / quarterly).
export interface PvcPeriodBreakdownRow {
  key: string;              // YYYY-MM (monthly), YYYY-Qn (quarterly), YYYY-MM-DD (daily)
  label: string;            // human-readable, e.g., "May 2026", "2026 Q2", "May 27"
  isComplete: boolean;      // true if the period ended before today (frozen)
  shifts: number;
  totalAdjustedRvu: number; // wRVU + bonus RVU + meeting RVU for this period
  avgAdjustedRvuPerShift: number;
  bonusShiftsFromRvu: number;      // from productivity tier engine (can be negative)
  bonusShiftsFromRotation: number; // sum of session.pvcBonusShiftCredit
  bonusShifts: number;             // bonusShiftsFromRvu + bonusShiftsFromRotation
}

export interface PvcAggregation {
  enabled: boolean;
  shiftLabel: 'shift' | 'workingDay';
  totalShifts: number;
  totalWrvu: number;          // sum of session.totalRVU (already PVC-corrected via chokepoint)
  totalBonusRvu: number;      // sum of session.pvcBonusRvu
  totalMeetingRvu: number;    // sum of session.pvcMeetingHours × user's effective rate (Phase 2a)
  totalClockHours: number;    // sum of session.totalSessionTime / 3600
  allInWrvu: number;          // totalWrvu + totalBonusRvu + totalMeetingRvu
  allInRvuPerShift: number;   // allInWrvu / totalShifts (0 if no shifts)
  wrvuPerShift: number;       // totalWrvu / totalShifts (0 if no shifts)
  estimatedDollars: number;   // (totalShifts + totalBonusShifts) × shiftValue
  totalBonusShiftsFromRvu: number;      // productivity tier bonus (only counts completed periods)
  totalBonusShiftsFromRotation: number; // rotation flat credit (all sessions)
  totalBonusShifts: number;             // sum of the two above
  totalCreditShifts: number;            // totalShifts + totalBonusShifts
  // Verified counterparts: substitute session.verifiedRVU for the in-program
  // wRVU basis when computing productivity tiers. Non-verified sessions
  // contribute 0 to the verified pool but still contribute shifts, so the
  // per-period avg for tier lookup reflects reality (billing gap = lower tier).
  // hasVerifiedData is true if AT LEAST ONE session in the input has a
  // verifiedRVU > 0; UI gates display on this.
  hasVerifiedData: boolean;
  verifiedTotalBonusShiftsFromRvu: number; // productivity tier bonus using verifiedRVU as basis
  verifiedTotalBonusShifts: number;        // verifiedTotalBonusShiftsFromRvu + totalBonusShiftsFromRotation
  verifiedTotalCreditShifts: number;       // totalShifts + verifiedTotalBonusShifts
  verifiedEstimatedDollars: number;        // (totalShifts + verifiedTotalBonusShifts) × shiftValue
  periodBreakdown: PvcPeriodBreakdownRow[];  // per-period rows (sorted by key)
  computationPeriod: ProductivityTierPeriod;
  columnsToShow: PvcColumnsToShow;
}

// Group sessions by computation period key.
function groupSessionsByComputationPeriod(
  sessions: StoredSession[],
  period: ProductivityTierPeriod,
): Map<string, StoredSession[]> {
  const grouped = new Map<string, StoredSession[]>();
  for (const s of sessions) {
    const d = parseISO(s.startDateTime);
    const key = period === 'daily' ? dayKey(d) : period === 'quarterly' ? quarterKey(d) : monthKey(d);
    const existing = grouped.get(key) || [];
    existing.push(s);
    grouped.set(key, existing);
  }
  return grouped;
}

// Render-friendly label for a period key.
function labelForPeriodKey(key: string, period: ProductivityTierPeriod): string {
  if (period === 'daily') {
    const d = parseISO(key);
    return format(d, 'MMM d');
  }
  if (period === 'quarterly') {
    // key looks like "2026-Q2"
    return key.replace('-', ' ');
  }
  // monthly
  const [y, m] = key.split('-');
  const d = new Date(Number(y), Number(m) - 1, 1);
  return format(d, 'MMMM yyyy');
}

// Is the period containing this key fully in the past?
function isPeriodComplete(key: string, period: ProductivityTierPeriod, now: Date = new Date()): boolean {
  if (period === 'daily') {
    const d = parseISO(key);
    return endOfDay(d) < startOfDay(now);
  }
  if (period === 'quarterly') {
    const [yStr, qStr] = key.split('-Q');
    const y = Number(yStr);
    const q = (Number(qStr) - 1) * 3;
    const periodEnd = endOfQuarter(new Date(y, q, 1));
    return periodEnd < startOfDay(now);
  }
  const [yStr, mStr] = key.split('-');
  const periodEnd = endOfMonth(new Date(Number(yStr), Number(mStr) - 1, 1));
  return periodEnd < startOfDay(now);
}

export function aggregatePvc(
  sessions: StoredSession[],
  config: PvcConfig,
  userPvcSettings?: UserPvcSettings,
): PvcAggregation {
  const baseColumns: PvcColumnsToShow = {
    shifts: config.enabled,
    wrvu: config.enabled,
    bonusRvu: false,
    meetingRvu: false,
    allInRvuPerShift: false,
    estimatedDollars: false,
    clockHours: config.enabled,
    bonusShiftsFromRvu: false,
    bonusShiftsFromRotation: false,
    bonusShiftsTotal: false,
  };

  if (!config.enabled) {
    return {
      enabled: false,
      shiftLabel: config.shiftLabel,
      totalShifts: 0,
      totalWrvu: 0,
      totalBonusRvu: 0,
      totalMeetingRvu: 0,
      totalClockHours: 0,
      allInWrvu: 0,
      allInRvuPerShift: 0,
      wrvuPerShift: 0,
      estimatedDollars: 0,
      totalBonusShiftsFromRvu: 0,
      totalBonusShiftsFromRotation: 0,
      totalBonusShifts: 0,
      totalCreditShifts: 0,
      hasVerifiedData: false,
      verifiedTotalBonusShiftsFromRvu: 0,
      verifiedTotalBonusShifts: 0,
      verifiedTotalCreditShifts: 0,
      verifiedEstimatedDollars: 0,
      periodBreakdown: [],
      computationPeriod: config.productivityTierPeriod,
      columnsToShow: baseColumns,
    };
  }

  let totalShifts = 0;
  let totalWrvu = 0;
  let totalBonusRvu = 0;
  let totalMeetingHours = 0;
  let totalClockSeconds = 0;
  let anySessionHasBonus = false;
  let anySessionHasMeeting = false;

  for (const s of sessions) {
    totalShifts += s.pvcShiftCredit ?? 0;
    // FLUORO-style flat RVU: when pvcWrvuOverride is set (non-null), it
    // REPLACES the session's accrued wRVU. Non-qualifying sessions on a
    // flat-RVU rotation have override=0 (zero out their actual studies).
    const sessionWrvu = (s.pvcWrvuOverride != null) ? s.pvcWrvuOverride : (s.totalRVU ?? 0);
    totalWrvu += sessionWrvu;
    totalBonusRvu += s.pvcBonusRvu ?? 0;
    totalMeetingHours += s.pvcMeetingHours ?? 0;
    totalClockSeconds += s.totalSessionTime ?? 0;
    if ((s.pvcBonusRvu ?? 0) > 0) anySessionHasBonus = true;
    if ((s.pvcMeetingHours ?? 0) > 0) anySessionHasMeeting = true;
  }

  // Meeting rate: per-user override beats system default; default 7 if neither set.
  const meetingRate =
    userPvcSettings?.meetingRvuRateOverride ??
    config.defaultMeetingRvuRate ??
    7;
  const totalMeetingRvu = +(totalMeetingHours * meetingRate).toFixed(2);
  const allInWrvu = +(totalWrvu + totalBonusRvu + totalMeetingRvu).toFixed(2);
  const wrvuPerShift = totalShifts > 0 ? +(totalWrvu / totalShifts).toFixed(2) : 0;
  const allInRvuPerShift = totalShifts > 0 ? +(allInWrvu / totalShifts).toFixed(2) : 0;
  const totalClockHours = +(totalClockSeconds / 3600).toFixed(1);

  // Per-period breakdown — used both for display and for productivity bonus
  // calculation. Adjusted wRVU = wRVU + bonus RVU + meeting RVU within the
  // period; bonus shifts come from the configured tier formula applied to the
  // period's avg.
  const groups = groupSessionsByComputationPeriod(sessions, config.productivityTierPeriod);
  const periodBreakdown: PvcPeriodBreakdownRow[] = [];
  // Bonus shifts have two independent sources — track separately so the report
  // can display them side-by-side, then sum for totals and $ estimate.
  let totalBonusShiftsFromRvu = 0;        // productivity tier engine (completed periods only)
  let totalBonusShiftsFromRotation = 0;   // rotation flat credit (all sessions)
  // Verified counterpart mirrors the tier calc with verifiedRVU substituted.
  // Rotation bonus shifts are the same regardless — they're paid on rotation,
  // not on billing.
  let verifiedTotalBonusShiftsFromRvu = 0;
  let hasVerifiedData = false;

  const sortedKeys = [...groups.keys()].sort();
  for (const key of sortedKeys) {
    const periodSessions = groups.get(key)!;
    let pShifts = 0;
    let pWrvu = 0;
    let pVerifiedWrvu = 0;
    let pBonus = 0;
    let pMeetingHours = 0;
    let pRotationBonusShifts = 0;
    for (const s of periodSessions) {
      pShifts += s.pvcShiftCredit ?? 0;
      pWrvu += (s.pvcWrvuOverride != null) ? s.pvcWrvuOverride : (s.totalRVU ?? 0);
      if (s.verifiedRVU != null && s.verifiedRVU > 0) {
        pVerifiedWrvu += s.verifiedRVU;
        hasVerifiedData = true;
      }
      pBonus += s.pvcBonusRvu ?? 0;
      pMeetingHours += s.pvcMeetingHours ?? 0;
      pRotationBonusShifts += s.pvcBonusShiftCredit ?? 0;
    }
    const pMeetingRvu = pMeetingHours * meetingRate;
    const pTotalAdjusted = pWrvu + pBonus + pMeetingRvu;
    const pAvgAdjusted = pShifts > 0 ? pTotalAdjusted / pShifts : 0;
    const pVerifiedTotalAdjusted = pVerifiedWrvu + pBonus + pMeetingRvu;
    const pVerifiedAvgAdjusted = pShifts > 0 ? pVerifiedTotalAdjusted / pShifts : 0;

    let pBonusShiftsFromRvu = 0;
    let pVerifiedBonusShiftsFromRvu = 0;
    if (config.productivityTiersActive && config.productivityTiers.length > 0 && pShifts > 0) {
      const bonusPerShift = computeBonusShiftsPerShift(
        pAvgAdjusted,
        config.productivityTiers,
        config.productivityTierMode,
        config.allowNegativeBonus,
      );
      pBonusShiftsFromRvu = +(bonusPerShift * pShifts).toFixed(2);
      const verifiedBonusPerShift = computeBonusShiftsPerShift(
        pVerifiedAvgAdjusted,
        config.productivityTiers,
        config.productivityTierMode,
        config.allowNegativeBonus,
      );
      pVerifiedBonusShiftsFromRvu = +(verifiedBonusPerShift * pShifts).toFixed(2);
      // Only count completed periods toward the running tier bonus total —
      // in-progress periods are tentative and may change.
      if (isPeriodComplete(key, config.productivityTierPeriod)) {
        totalBonusShiftsFromRvu += pBonusShiftsFromRvu;
        verifiedTotalBonusShiftsFromRvu += pVerifiedBonusShiftsFromRvu;
      }
    }

    // Rotation bonus shifts accrue per session as they happen — no tier gate,
    // no completed-period rule. Count every period.
    const pRotationBonusRounded = +pRotationBonusShifts.toFixed(2);
    totalBonusShiftsFromRotation += pRotationBonusRounded;

    const pBonusShiftsTotal = +(pBonusShiftsFromRvu + pRotationBonusRounded).toFixed(2);
    periodBreakdown.push({
      key,
      label: labelForPeriodKey(key, config.productivityTierPeriod),
      isComplete: isPeriodComplete(key, config.productivityTierPeriod),
      shifts: +pShifts.toFixed(2),
      totalAdjustedRvu: +pTotalAdjusted.toFixed(2),
      avgAdjustedRvuPerShift: +pAvgAdjusted.toFixed(2),
      bonusShiftsFromRvu: pBonusShiftsFromRvu,
      bonusShiftsFromRotation: pRotationBonusRounded,
      bonusShifts: pBonusShiftsTotal,
    });
  }

  totalBonusShiftsFromRvu = +totalBonusShiftsFromRvu.toFixed(2);
  totalBonusShiftsFromRotation = +totalBonusShiftsFromRotation.toFixed(2);
  const totalBonusShifts = +(totalBonusShiftsFromRvu + totalBonusShiftsFromRotation).toFixed(2);
  verifiedTotalBonusShiftsFromRvu = +verifiedTotalBonusShiftsFromRvu.toFixed(2);
  const verifiedTotalBonusShifts = +(verifiedTotalBonusShiftsFromRvu + totalBonusShiftsFromRotation).toFixed(2);
  const totalCreditShifts = +(totalShifts + totalBonusShifts).toFixed(2);
  const verifiedTotalCreditShifts = +(totalShifts + verifiedTotalBonusShifts).toFixed(2);
  const estimatedDollars = config.shiftValue != null
    ? +(totalCreditShifts * config.shiftValue).toFixed(2)
    : 0;
  const verifiedEstimatedDollars = config.shiftValue != null
    ? +(verifiedTotalCreditShifts * config.shiftValue).toFixed(2)
    : 0;

  const showBonus = anyRotationHasBonus(config) || anySessionHasBonus;
  const showMeeting = anySessionHasMeeting;
  const showAllIn = showBonus || showMeeting;
  const showDollars = config.shiftValue != null;
  const showBonusFromRvu = config.productivityTiersActive && config.productivityTiers.length > 0;
  const showBonusFromRotation = anyRotationHasBonusShiftCredit(config);
  const showBonusTotal = showBonusFromRvu || showBonusFromRotation;

  return {
    enabled: true,
    shiftLabel: config.shiftLabel,
    totalShifts: +totalShifts.toFixed(2),
    totalWrvu: +totalWrvu.toFixed(2),
    totalBonusRvu: +totalBonusRvu.toFixed(2),
    totalMeetingRvu,
    totalClockHours,
    allInWrvu,
    allInRvuPerShift,
    wrvuPerShift,
    estimatedDollars,
    totalBonusShiftsFromRvu,
    totalBonusShiftsFromRotation,
    totalBonusShifts,
    totalCreditShifts,
    hasVerifiedData,
    verifiedTotalBonusShiftsFromRvu,
    verifiedTotalBonusShifts,
    verifiedTotalCreditShifts,
    verifiedEstimatedDollars,
    periodBreakdown,
    computationPeriod: config.productivityTierPeriod,
    columnsToShow: {
      shifts: true,
      wrvu: true,
      bonusRvu: showBonus,
      meetingRvu: showMeeting,
      allInRvuPerShift: showAllIn,
      estimatedDollars: showDollars,
      clockHours: true,
      bonusShiftsFromRvu: showBonusFromRvu,
      bonusShiftsFromRotation: showBonusFromRotation,
      bonusShiftsTotal: showBonusTotal,
    },
  };
}

// "So far this {period}" range — start of the requested period through "now".
// Returns null if the period hasn't started yet. Used by adaptive labels in reports.
export function getPeriodToDateRange(
  period: 'month' | 'quarter' | 'year' | 'week',
  reference: Date = new Date(),
): DateRange {
  switch (period) {
    case 'month':
      return { start: startOfMonth(reference), end: reference };
    case 'quarter':
      return { start: startOfQuarter(reference), end: reference };
    case 'year':
      return { start: startOfYear(reference), end: reference };
    case 'week':
      return { start: startOfWeek(reference, { weekStartsOn: 1 }), end: reference };
  }
}

// True when `range.end` is before today — i.e., the period is fully complete.
// Drives "So far this X" vs "X Totals" label choice in reports.
export function isCompletedPeriod(range: DateRange, reference: Date = new Date()): boolean {
  return range.end < startOfDay(reference);
}
