/**
 * useSessionClock — the one session clock, shared by both timer engines.
 *
 * Owned by neither the legacy boolean-flag timers nor mode-enum
 * (useTimerMode). Every engine and handler reads `sessionTime` from here, so
 * turning the legacy timers off (mode-enum plan Phase 7) cannot stop the clock.
 *
 * Behavior is unchanged from the original in-component implementation
 * (mode-enum plan step 3a, 2026-10-01):
 * - +1 per 1-second tick while running and not paused (paused while the Stop
 *   Session dialog is open)
 * - drift correction only at break end: if sessionTime differs from wall-clock
 *   elapsed by more than 2 s, it snaps to wall clock
 *
 * Step 3d replaces the +1 tick with a wall-clock recompute every tick.
 */
import { useState, useRef, useEffect, useCallback } from 'react';

const DRIFT_THRESHOLD_SEC = 2;

export interface SessionClock {
  sessionTime: number;
  isRunning: boolean;
  /** Latest committed sessionTime, readable from any handler (for step 3d). */
  getSessionTime: () => number;
  /** Session start: anchor wall clock and start ticking. */
  start: () => void;
  /** Session end: stop ticking. */
  stop: () => void;
  /** Start ticking if not already (first study). */
  ensureRunning: () => void;
  /** Zero the displayed/recorded session time. */
  zero: () => void;
  /** Clear the wall-clock anchor (session reset). */
  clearAnchor: () => void;
  /**
   * Break-end drift correction. Returns the corrected session time and, if
   * drift exceeds the threshold, snaps the clock to it.
   */
  resyncAtBreakEnd: () => number;
}

export function useSessionClock(paused: boolean): SessionClock {
  const [sessionTime, setSessionTime] = useState(0);
  const [isRunning, setIsRunning] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startMsRef = useRef<number>(0); // Wall-clock ms at session start (for drift correction)
  const latestRef = useRef<number>(0);

  useEffect(() => {
    latestRef.current = sessionTime;
  }, [sessionTime]);

  useEffect(() => {
    if (isRunning && !paused) {
      intervalRef.current = setInterval(() => {
        setSessionTime(prev => prev + 1);
      }, 1000);
    } else {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    }

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [isRunning, paused]);

  const getSessionTime = useCallback(() => latestRef.current, []);

  const start = useCallback(() => {
    startMsRef.current = Date.now();
    setIsRunning(true);
  }, []);

  const stop = useCallback(() => setIsRunning(false), []);

  const ensureRunning = useCallback(() => {
    setIsRunning(true);
  }, []);

  const zero = useCallback(() => setSessionTime(0), []);

  const clearAnchor = useCallback(() => {
    startMsRef.current = 0;
  }, []);

  // Not memoized on purpose: reads `sessionTime` from the same render as the
  // caller, matching the original inline correction exactly.
  const resyncAtBreakEnd = (): number => {
    const wallClockElapsed = Math.round((Date.now() - startMsRef.current) / 1000);
    const drift = wallClockElapsed - sessionTime;
    if (Math.abs(drift) > DRIFT_THRESHOLD_SEC) {
      setSessionTime(wallClockElapsed);
      return wallClockElapsed;
    }
    return sessionTime;
  };

  return { sessionTime, isRunning, getSessionTime, start, stop, ensureRunning, zero, clearAnchor, resyncAtBreakEnd };
}
