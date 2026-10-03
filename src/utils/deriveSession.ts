// Everything the screen (and later the session record) needs, derived from
// mode-enum's closed events (Phases 4–5). A pure function: recomputed from the
// event list, so an undone study (converted to Admin in 3c) simply isn't
// counted and nothing has to be subtracted. The engine adds the mode running
// now on top (useTimerMode.getSnapshot).
import type { ModeEvent } from '../hooks/useTimerMode';
import { isPress } from './adminEvents';

export type TimedMode = 'interstitial' | 'admin' | 'comms' | 'break' | 'doubleTap';

export const MODE_OF: Record<string, TimedMode> = {
  INTERSTITIAL: 'interstitial', ADMIN: 'admin', COMMS: 'comms', BREAK: 'break', DOUBLE_TAP: 'doubleTap',
};

const STREAK_MAX = 6;

export interface SessionTotals {
  totals: Record<TimedMode, number>;
  counts: { admin: number; comms: number; break: number; doubleTap: number };
  studies: number;
  totalRVU: number;
  cumulativePar: number;
  cumulativeVariance: number;
  streak: number;          // consecutive at-or-under-par studies, capped at 6
  rvuPerHour: number;      // RVU ÷ hours, as of the last completion or undo (owner, 2026-10-03)
  rollingRVU: number;      // RVU of studies that ended in the trailing 60 minutes
  lastBreakEnd: number;    // session time the last break ended (0 if none)
}

export function deriveSession(events: ModeEvent[], now: number): SessionTotals {
  const totals: Record<TimedMode, number> = { interstitial: 0, admin: 0, comms: 0, break: 0, doubleTap: 0 };
  const counts = { admin: 0, comms: 0, break: 0, doubleTap: 0 };
  let studies = 0, totalRVU = 0, cumulativePar = 0, cumulativeVariance = 0, streak = 0;
  let rollingRVU = 0, lastChange = 0, lastBreakEnd = 0;

  for (const e of events) {
    if (e.type === 'STUDY') {
      studies++;
      totalRVU += e.rvu;
      cumulativePar += e.parTime;
      cumulativeVariance += e.variance;
      streak = e.variance <= 0 ? Math.min(streak + 1, STREAK_MAX) : 0;
      const end = e.endTimeSession ?? e.startTimeSession + e.elapsedTime;
      if (end >= now - 3600) rollingRVU += e.rvu;
      lastChange = Math.max(lastChange, end);
      continue;
    }
    const m = MODE_OF[e.type];
    totals[m] += e.duration;
    if (m !== 'interstitial' && isPress(e)) counts[m]++;
    // A break counts even if Undo later made it Admin: it was still a real
    // break, so it must not bring the break prompt back (Clyde 261003e #3).
    if (e.type === 'BREAK' || (e.type === 'ADMIN' && e.undoneStudy?.originalType === 'BREAK')) {
      lastBreakEnd = Math.max(lastBreakEnd, e.endTimeSession);
    }
    // An undone study changes RVU/hr too, as of its end.
    if (e.type === 'ADMIN' && e.undoneStudy?.originalType === 'STUDY' && !e.undoneStudy.neverResumed) {
      lastChange = Math.max(lastChange, e.endTimeSession);
    }
  }

  const rvuPerHour = lastChange > 0 ? totalRVU / (lastChange / 3600) : 0;
  return { totals, counts, studies, totalRVU, cumulativePar, cumulativeVariance, streak, rvuPerHour, rollingRVU, lastBreakEnd };
}
