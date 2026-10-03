/**
 * useSessionClock — the one session clock, shared by both timer engines.
 *
 * Owned by neither the legacy boolean-flag timers nor mode-enum
 * (useTimerMode). Every engine and handler reads `sessionTime` from here, so
 * turning the legacy timers off (mode-enum plan Phase 7) cannot stop the clock.
 *
 * Wall clock (mode-enum plan step 3d, 2026-10-02):
 * - Session time = wall-clock seconds since Start, minus time spent paused.
 *   It is recomputed every tick, so a covered or minimized window (Chrome
 *   slows its timers to about once a minute) never falls behind.
 * - Paused from the Stop click through the Stop dialog and the Admin Block
 *   Classifier (owner: Stop is the end of work; waiting for the Epic total is
 *   not counted). If a pause ever ends with the session still going, the
 *   paused span is skipped.
 * - Never goes backward: if the system clock steps back, session time holds
 *   until the wall clock catches up.
 * - Handlers call getSessionTime() for the true time at the moment of a press
 *   or Sidecar command, not the last rendered value.
 * - Diagnostic only: ticks more than 5 minutes apart, or a system clock that
 *   steps back, are logged as clock gaps (session doc `_clockGaps`; negative
 *   seconds = backward step). The time stays in the current mode.
 */
import { useState, useRef, useEffect, useCallback } from 'react';

const GAP_LOG_SEC = 5 * 60;

export interface ClockGap {
  at: number;      // session time when the gap ended
  seconds: number; // wall-clock seconds between the two ticks (< 0: clock stepped back)
}

export interface SessionClock {
  sessionTime: number;
  isRunning: boolean;
  /** True session time now, readable from any handler. */
  getSessionTime: () => number;
  /** Clock gaps seen this session (diagnostic). */
  getClockGaps: () => ClockGap[];
  /** Session start: anchor wall clock and start ticking. */
  start: () => void;
  /** Session end: stop ticking. */
  stop: () => void;
  /** Start ticking if not already (first study). */
  ensureRunning: () => void;
  /** Zero the displayed time and the never-backward floor (start() re-anchors). */
  zero: () => void;
  /** Clear the wall-clock anchor (session reset). */
  clearAnchor: () => void;
  /**
   * Formerly the break-end drift correction. The clock no longer drifts, so
   * this just returns the current time. Kept until Phase 8.
   */
  resyncAtBreakEnd: () => number;
}

export function useSessionClock(paused: boolean): SessionClock {
  const [sessionTime, setSessionTime] = useState(0);
  const [isRunning, setIsRunning] = useState(false);
  const startMsRef = useRef(0);         // wall-clock ms at session start
  const pausedMsRef = useRef(0);        // total ms spent paused
  const pauseStartRef = useRef<number | null>(null);
  const latestRef = useRef(0);          // highest session time handed out
  const lastTickMsRef = useRef(0);
  const gapsRef = useRef<ClockGap[]>([]);

  const getSessionTime = useCallback((): number => {
    if (startMsRef.current === 0) return latestRef.current;
    const now = pauseStartRef.current ?? Date.now();
    const elapsed = Math.round((now - startMsRef.current - pausedMsRef.current) / 1000);
    latestRef.current = Math.max(latestRef.current, elapsed);
    return latestRef.current;
  }, []);

  // Pause bookkeeping: freeze at the moment the dialog opens; on resume, skip
  // the paused span.
  useEffect(() => {
    if (paused && pauseStartRef.current === null) {
      pauseStartRef.current = Date.now();
    } else if (!paused && pauseStartRef.current !== null) {
      pausedMsRef.current += Date.now() - pauseStartRef.current;
      pauseStartRef.current = null;
    }
  }, [paused]);

  useEffect(() => {
    if (!isRunning || paused) return;
    lastTickMsRef.current = Date.now();
    const tick = () => {
      const nowMs = Date.now();
      const gapSec = Math.round((nowMs - lastTickMsRef.current) / 1000);
      lastTickMsRef.current = nowMs;
      const t = getSessionTime();
      if (gapSec > GAP_LOG_SEC || gapSec < -2) gapsRef.current.push({ at: t, seconds: gapSec });
      setSessionTime(t);
    };
    const id = setInterval(tick, 1000);
    // Catch up the moment the window is uncovered.
    const onVisible = () => { if (document.visibilityState === 'visible') tick(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [isRunning, paused, getSessionTime]);

  const getClockGaps = useCallback(() => [...gapsRef.current], []);

  const start = useCallback(() => {
    startMsRef.current = Date.now();
    pausedMsRef.current = 0;
    pauseStartRef.current = null;
    latestRef.current = 0;
    gapsRef.current = [];
    setIsRunning(true);
  }, []);

  const stop = useCallback(() => setIsRunning(false), []);

  const ensureRunning = useCallback(() => setIsRunning(true), []);

  const zero = useCallback(() => {
    latestRef.current = 0;
    setSessionTime(0);
  }, []);

  const clearAnchor = useCallback(() => {
    startMsRef.current = 0;
  }, []);

  const resyncAtBreakEnd = useCallback((): number => {
    const t = getSessionTime();
    setSessionTime(t);
    return t;
  }, [getSessionTime]);

  return { sessionTime, isRunning, getSessionTime, getClockGaps, start, stop, ensureRunning, zero, clearAnchor, resyncAtBreakEnd };
}
