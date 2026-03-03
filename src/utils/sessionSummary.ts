// SessionSummary computation — Section 8 of RadTach-Reports-Design.md
// Computed from in-memory sessionEvents at session end, written as a
// summary field on the session document.

interface StudyEvent {
  type: 'STUDY';
  studyNumber: number;
  startTimeSession: number;
  startTimeSystem: string;
  modality: string;
  complications: string[];
  parTime: number;
  elapsedTime: number;
  variance: number;
  rvu: number;
  pauseTime: number;
  pauseUsed: boolean;
  drafted: boolean;
}

interface InterstitialEvent {
  type: 'INTERSTITIAL';
  startTimeSession: number;
  startTimeSystem: string;
  endTimeSession: number;
  endTimeSystem: string;
  duration: number;
}

interface TimerEvent {
  type: 'ADMIN' | 'COMMS' | 'BREAK' | 'DOUBLE_TAP';
  startTimeSession: number;
  startTimeSystem: string;
  endTimeSession: number;
  endTimeSystem: string;
  duration: number;
  associatedModality?: string | null;
}

type SessionEvent = StudyEvent | InterstitialEvent | TimerEvent;

export interface SessionSummary {
  // 6B
  studiesByModality: Record<string, number>;
  // 6C
  rvuPerHourByModality: Record<string, number>;
  // 6D
  avgVarianceByModality: Record<string, number>;
  // 6E
  top5OverPar: Array<{
    studyNumber: number;
    modality: string;
    complications: string[];
    elapsedTime: number;
    parTime: number;
    variance: number;
  }>;
  top5UnderPar: Array<{
    studyNumber: number;
    modality: string;
    complications: string[];
    elapsedTime: number;
    parTime: number;
    variance: number;
  }>;
  // 6F
  timeAllocation: {
    study: number;
    interstitial: number;
    admin: number;
    comms: number;
    break: number;
    doubleTap: number;
  };
  // 7A
  staminaCurve: number[];
  // 7B
  breakROI: {
    avgVarianceBefore: number | null;
    avgVarianceAfter: number | null;
    breakCount: number;
  };
  // 7C
  complicationCost: Record<string, {
    avgActualTimeAdded: number;
    parTimeAllotment: number;
    occurrences: number;
  }>;
  // 7D
  interstitialTrend: number[];
  // 7E
  doubleTapsByModality: Record<string, number>;
  // 7F
  pauseAnalysis: {
    avgVarianceWithPause: number | null;
    avgVarianceWithoutPause: number | null;
    pauseFrequencyByModality: Record<string, number>;
  };
  // 7G
  draftAnalysis: {
    avgVarianceDrafted: number | null;
    avgVarianceNotDrafted: number | null;
    draftRateByModality: Record<string, number>;
  };
  // 7H
  productiveTimeRatio: number;
  // 7I
  peakRVUWindow: {
    startMinute: number;
    endMinute: number;
    rvu: number;
  };
  // 7J
  interruptionRecoveryCost: {
    avgInterstitialAfterInterruption: number | null;
    avgInterstitialNormal: number | null;
  };
  // 7K
  complicationStacking: Record<number, {
    avgVariance: number;
    count: number;
  }>;
  // 7L
  modalityTransitionPenalty: {
    avgInterstitialSameModality: number | null;
    avgInterstitialDifferentModality: number | null;
  };
}

function avg(arr: number[]): number | null {
  if (arr.length === 0) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

export function computeSessionSummary(
  events: SessionEvent[],
  totalSessionTime: number
): SessionSummary {
  const studies = events.filter((e): e is StudyEvent => e.type === 'STUDY');
  const interstitials = events.filter((e): e is InterstitialEvent => e.type === 'INTERSTITIAL');
  const breaks = events.filter((e): e is TimerEvent => e.type === 'BREAK');
  const admins = events.filter((e): e is TimerEvent => e.type === 'ADMIN');
  const comms = events.filter((e): e is TimerEvent => e.type === 'COMMS');
  const doubleTaps = events.filter((e): e is TimerEvent => e.type === 'DOUBLE_TAP');

  // Sort studies by studyNumber for ordered metrics
  const sortedStudies = [...studies].sort((a, b) => a.studyNumber - b.studyNumber);

  // ── 6B: Studies by modality ────────────────────────────────────────────
  const studiesByModality: Record<string, number> = {};
  for (const s of studies) {
    studiesByModality[s.modality] = (studiesByModality[s.modality] || 0) + 1;
  }

  // ── 6C: RVU/hr by modality ────────────────────────────────────────────
  // Sum RVU and reading time per modality, compute rate
  const rvuByModality: Record<string, number> = {};
  const timeByModality: Record<string, number> = {};
  for (const s of studies) {
    rvuByModality[s.modality] = (rvuByModality[s.modality] || 0) + s.rvu;
    timeByModality[s.modality] = (timeByModality[s.modality] || 0) + s.elapsedTime;
  }
  const rvuPerHourByModality: Record<string, number> = {};
  for (const mod of Object.keys(rvuByModality)) {
    const hours = (timeByModality[mod] || 1) / 3600;
    rvuPerHourByModality[mod] = hours > 0 ? rvuByModality[mod] / hours : 0;
  }

  // ── 6D: Average variance by modality ──────────────────────────────────
  const variancesByModality: Record<string, number[]> = {};
  for (const s of studies) {
    if (!variancesByModality[s.modality]) variancesByModality[s.modality] = [];
    variancesByModality[s.modality].push(s.variance);
  }
  const avgVarianceByModality: Record<string, number> = {};
  for (const [mod, variances] of Object.entries(variancesByModality)) {
    avgVarianceByModality[mod] = variances.reduce((a, b) => a + b, 0) / variances.length;
  }

  // ── 6E: Top 5 over/under par ──────────────────────────────────────────
  const studyEntries = studies.map(s => ({
    studyNumber: s.studyNumber,
    modality: s.modality,
    complications: s.complications,
    elapsedTime: s.elapsedTime,
    parTime: s.parTime,
    variance: s.variance,
  }));
  const top5OverPar = [...studyEntries]
    .filter(s => s.variance > 0)
    .sort((a, b) => b.variance - a.variance)
    .slice(0, 5);
  const top5UnderPar = [...studyEntries]
    .filter(s => s.variance <= 0)
    .sort((a, b) => a.variance - b.variance)
    .slice(0, 5);

  // ── 6F: Time allocation ───────────────────────────────────────────────
  const totalStudyTime = studies.reduce((sum, s) => sum + s.elapsedTime, 0);
  const totalInterstitialTime = interstitials.reduce((sum, e) => sum + e.duration, 0);
  const totalAdminTime = admins.reduce((sum, e) => sum + e.duration, 0);
  const totalCommsTime = comms.reduce((sum, e) => sum + e.duration, 0);
  const totalBreakTime = breaks.reduce((sum, e) => sum + e.duration, 0);
  const totalDoubleTapTime = doubleTaps.reduce((sum, e) => sum + e.duration, 0);

  const timeAllocation = {
    study: totalStudyTime,
    interstitial: totalInterstitialTime,
    admin: totalAdminTime,
    comms: totalCommsTime,
    break: totalBreakTime,
    doubleTap: totalDoubleTapTime,
  };

  // ── 7A: Stamina curve ─────────────────────────────────────────────────
  const staminaCurve = sortedStudies.map(s => s.variance);

  // ── 7B: Break ROI ─────────────────────────────────────────────────────
  // For each break, find the nearest studies before and after by session time
  // Use a window of up to 3 studies on each side for stability
  const breakROI = computeBreakROI(sortedStudies, breaks);

  // ── 7C: Complication cost ─────────────────────────────────────────────
  // Compare studies with a complication to those without, same modality
  const complicationCost = computeComplicationCost(studies);

  // ── 7D: Interstitial trend ────────────────────────────────────────────
  // Interstitial duration preceding each study (in study order)
  // Pass all non-study timer events so overlapping break/admin/comms time is subtracted
  const allTimerEvents = [...breaks, ...admins, ...comms, ...doubleTaps];
  const interstitialTrend = computeInterstitialTrend(sortedStudies, interstitials, allTimerEvents);

  // ── 7E: Double tap rate by modality ───────────────────────────────────
  const doubleTapsByModality: Record<string, number> = {};
  for (const dt of doubleTaps) {
    const mod = dt.associatedModality || 'Unknown';
    doubleTapsByModality[mod] = (doubleTapsByModality[mod] || 0) + 1;
  }

  // ── 7F: Pause analysis ────────────────────────────────────────────────
  const withPause = studies.filter(s => s.pauseUsed);
  const withoutPause = studies.filter(s => !s.pauseUsed);
  const pauseFrequencyByModality: Record<string, number> = {};
  for (const s of studies) {
    if (s.pauseUsed) {
      pauseFrequencyByModality[s.modality] = (pauseFrequencyByModality[s.modality] || 0) + 1;
    }
  }
  const pauseAnalysis = {
    avgVarianceWithPause: avg(withPause.map(s => s.variance)),
    avgVarianceWithoutPause: avg(withoutPause.map(s => s.variance)),
    pauseFrequencyByModality,
  };

  // ── 7G: Draft analysis ────────────────────────────────────────────────
  const drafted = studies.filter(s => s.drafted);
  const notDrafted = studies.filter(s => !s.drafted);
  const draftRateByModality: Record<string, number> = {};
  for (const mod of Object.keys(studiesByModality)) {
    const modStudies = studies.filter(s => s.modality === mod);
    const modDrafted = modStudies.filter(s => s.drafted);
    draftRateByModality[mod] = modStudies.length > 0 ? modDrafted.length / modStudies.length : 0;
  }
  const draftAnalysis = {
    avgVarianceDrafted: avg(drafted.map(s => s.variance)),
    avgVarianceNotDrafted: avg(notDrafted.map(s => s.variance)),
    draftRateByModality,
  };

  // ── 7H: Productive time ratio ─────────────────────────────────────────
  const productiveTime = totalStudyTime + totalDoubleTapTime;
  const productiveTimeRatio = totalSessionTime > 0 ? productiveTime / totalSessionTime : 0;

  // ── 7I: Peak RVU window ───────────────────────────────────────────────
  const peakRVUWindow = computePeakRVUWindow(sortedStudies);

  // ── 7J: Interruption recovery cost ────────────────────────────────────
  const interruptionRecoveryCost = computeInterruptionRecoveryCost(
    interstitials, admins, comms
  );

  // ── 7K: Complication stacking ─────────────────────────────────────────
  const stackingBuckets: Record<number, number[]> = {};
  for (const s of studies) {
    const count = Math.min(s.complications.length, 3); // 0, 1, 2, 3+
    if (!stackingBuckets[count]) stackingBuckets[count] = [];
    stackingBuckets[count].push(s.variance);
  }
  const complicationStacking: Record<number, { avgVariance: number; count: number }> = {};
  for (const [count, variances] of Object.entries(stackingBuckets)) {
    complicationStacking[Number(count)] = {
      avgVariance: variances.reduce((a, b) => a + b, 0) / variances.length,
      count: variances.length,
    };
  }

  // ── 7L: Modality transition penalty ───────────────────────────────────
  const modalityTransitionPenalty = computeModalityTransitionPenalty(sortedStudies, interstitials);

  return {
    studiesByModality,
    rvuPerHourByModality,
    avgVarianceByModality,
    top5OverPar,
    top5UnderPar,
    timeAllocation,
    staminaCurve,
    breakROI,
    complicationCost,
    interstitialTrend,
    doubleTapsByModality,
    pauseAnalysis,
    draftAnalysis,
    productiveTimeRatio,
    peakRVUWindow,
    interruptionRecoveryCost,
    complicationStacking,
    modalityTransitionPenalty,
  };
}

// ── Break ROI ──────────────────────────────────────────────────────────────
// Graceful degradation: uses up to 3 studies before/after each break.
// If fewer exist, uses what's available. Returns null if no studies available.
function computeBreakROI(
  studies: StudyEvent[],
  breaks: TimerEvent[]
): SessionSummary['breakROI'] {
  if (breaks.length === 0) {
    return { avgVarianceBefore: null, avgVarianceAfter: null, breakCount: 0 };
  }

  const allBefore: number[] = [];
  const allAfter: number[] = [];

  for (const brk of breaks) {
    const before = studies
      .filter(s => s.startTimeSession < brk.startTimeSession)
      .sort((a, b) => b.startTimeSession - a.startTimeSession)
      .slice(0, 3)
      .map(s => s.variance);
    const after = studies
      .filter(s => s.startTimeSession > brk.endTimeSession)
      .sort((a, b) => a.startTimeSession - b.startTimeSession)
      .slice(0, 3)
      .map(s => s.variance);

    allBefore.push(...before);
    allAfter.push(...after);
  }

  return {
    avgVarianceBefore: avg(allBefore),
    avgVarianceAfter: avg(allAfter),
    breakCount: breaks.length,
  };
}

// ── Complication cost ──────────────────────────────────────────────────────
// For each complication type, compare actual elapsed time vs par allotment
function computeComplicationCost(
  studies: StudyEvent[]
): Record<string, { avgActualTimeAdded: number; parTimeAllotment: number; occurrences: number }> {
  const result: Record<string, { totalTimeAdded: number; parAllotment: number; count: number }> = {};

  // Build baseline: avg elapsed for studies with zero complications, by modality
  const baselineByModality: Record<string, number[]> = {};
  for (const s of studies) {
    if (s.complications.length === 0) {
      if (!baselineByModality[s.modality]) baselineByModality[s.modality] = [];
      baselineByModality[s.modality].push(s.elapsedTime);
    }
  }
  const avgBaselineByModality: Record<string, number> = {};
  for (const [mod, times] of Object.entries(baselineByModality)) {
    avgBaselineByModality[mod] = times.reduce((a, b) => a + b, 0) / times.length;
  }

  // For studies with complications, measure time added over baseline
  for (const s of studies) {
    if (s.complications.length === 0) continue;
    const baseline = avgBaselineByModality[s.modality];
    if (baseline === undefined) continue; // No uncomplicated studies for this modality

    for (const comp of s.complications) {
      if (!result[comp]) result[comp] = { totalTimeAdded: 0, parAllotment: 0, count: 0 };
      // Approximate: distribute excess time equally across complications
      const timeAdded = (s.elapsedTime - baseline) / s.complications.length;
      // Par allotment per complication = (parTime - modality base par) / n complications
      // Since we don't have modality base par directly, use parTime difference
      result[comp].totalTimeAdded += timeAdded;
      result[comp].parAllotment += (s.parTime - (avgBaselineByModality[s.modality] || s.parTime)) / s.complications.length;
      result[comp].count += 1;
    }
  }

  const output: Record<string, { avgActualTimeAdded: number; parTimeAllotment: number; occurrences: number }> = {};
  for (const [comp, data] of Object.entries(result)) {
    output[comp] = {
      avgActualTimeAdded: data.count > 0 ? data.totalTimeAdded / data.count : 0,
      parTimeAllotment: data.count > 0 ? data.parAllotment / data.count : 0,
      occurrences: data.count,
    };
  }
  return output;
}

// ── Interstitial trend ─────────────────────────────────────────────────────
// For each study (in order), find the interstitial that ended just before it started.
// Subtract any overlapping break/admin/comms/double-tap duration from the
// interstitial's reported duration so those timers don't contaminate the trend.
function computeInterstitialTrend(
  studies: StudyEvent[],
  interstitials: InterstitialEvent[],
  timerEvents: TimerEvent[]
): number[] {
  const trend: number[] = [];
  for (const study of studies) {
    // Find interstitial that ended closest before (or at) this study's start
    const preceding = interstitials
      .filter(i => i.endTimeSession <= study.startTimeSession)
      .sort((a, b) => b.endTimeSession - a.endTimeSession);
    if (preceding.length === 0) {
      trend.push(0);
      continue;
    }
    const inter = preceding[0];
    // Subtract overlapping timer event durations from the interstitial
    let overlap = 0;
    for (const te of timerEvents) {
      const overlapStart = Math.max(inter.startTimeSession, te.startTimeSession);
      const overlapEnd = Math.min(inter.endTimeSession, te.endTimeSession);
      if (overlapEnd > overlapStart) {
        overlap += overlapEnd - overlapStart;
      }
    }
    const corrected = inter.duration - overlap;
    trend.push(corrected > 0 ? corrected : 0);
  }
  return trend;
}

// ── Peak RVU window ────────────────────────────────────────────────────────
// Best 60-minute rolling window by RVU output
function computePeakRVUWindow(
  studies: StudyEvent[]
): SessionSummary['peakRVUWindow'] {
  if (studies.length === 0) {
    return { startMinute: 0, endMinute: 0, rvu: 0 };
  }

  let bestRVU = 0;
  let bestStart = 0;

  // Slide window across session time in 1-minute increments
  const maxTime = Math.max(...studies.map(s => s.startTimeSession + s.elapsedTime));
  const windowSize = 3600; // 60 minutes in seconds

  for (let start = 0; start <= maxTime - windowSize; start += 60) {
    const end = start + windowSize;
    const windowRVU = studies
      .filter(s => s.startTimeSession >= start && s.startTimeSession < end)
      .reduce((sum, s) => sum + s.rvu, 0);
    if (windowRVU > bestRVU) {
      bestRVU = windowRVU;
      bestStart = start;
    }
  }

  // If session shorter than 60 min, use the whole session
  if (maxTime < windowSize) {
    bestRVU = studies.reduce((sum, s) => sum + s.rvu, 0);
    bestStart = 0;
  }

  return {
    startMinute: Math.floor(bestStart / 60),
    endMinute: Math.floor((bestStart + windowSize) / 60),
    rvu: bestRVU,
  };
}

// ── Interruption recovery cost ─────────────────────────────────────────────
// Compare interstitial time after admin/comms events vs normal interstitial
function computeInterruptionRecoveryCost(
  interstitials: InterstitialEvent[],
  admins: TimerEvent[],
  commsEvents: TimerEvent[]
): SessionSummary['interruptionRecoveryCost'] {
  const interruptions = [...admins, ...commsEvents];
  if (interruptions.length === 0 || interstitials.length === 0) {
    return { avgInterstitialAfterInterruption: null, avgInterstitialNormal: null };
  }

  const afterInterruption: number[] = [];
  const normal: number[] = [];

  for (const inter of interstitials) {
    // Check if any interruption occurred during or just before this interstitial
    const wasInterrupted = interruptions.some(
      irr => irr.endTimeSession >= inter.startTimeSession - 5 &&
             irr.endTimeSession <= inter.endTimeSession
    );
    if (wasInterrupted) {
      afterInterruption.push(inter.duration);
    } else {
      normal.push(inter.duration);
    }
  }

  return {
    avgInterstitialAfterInterruption: avg(afterInterruption),
    avgInterstitialNormal: avg(normal),
  };
}

// ── Modality transition penalty ────────────────────────────────────────────
// Compare interstitial when staying same modality vs switching
function computeModalityTransitionPenalty(
  studies: StudyEvent[],
  interstitials: InterstitialEvent[]
): SessionSummary['modalityTransitionPenalty'] {
  if (studies.length < 2) {
    return { avgInterstitialSameModality: null, avgInterstitialDifferentModality: null };
  }

  const sameModality: number[] = [];
  const differentModality: number[] = [];

  for (let i = 1; i < studies.length; i++) {
    const prev = studies[i - 1];
    const curr = studies[i];

    // Find interstitial between these two studies
    const between = interstitials.find(
      inter => inter.startTimeSession >= prev.startTimeSession + prev.elapsedTime - 2 &&
               inter.endTimeSession <= curr.startTimeSession + 2
    );
    if (!between) continue;

    if (prev.modality === curr.modality) {
      sameModality.push(between.duration);
    } else {
      differentModality.push(between.duration);
    }
  }

  return {
    avgInterstitialSameModality: avg(sameModality),
    avgInterstitialDifferentModality: avg(differentModality),
  };
}
