/**
 * useTimerMode — Shadow mode-enum timer system.
 *
 * Runs in parallel with the production boolean-flag timers.
 * Records its own event stream to shadow_events subcollection.
 * After validation, this will replace the boolean system entirely.
 */
import { useRef, useCallback } from 'react';

// ── Types ────────────────────────────────────────────────────────────────────

export type TimerMode = 'idle' | 'study' | 'interstitial' | 'admin' | 'comms' | 'break' | 'doubleTap';

export type TimerSignal =
  | { type: 'study_start'; modality: string; complications: string[]; parTime: number; studyNumber: number; rvu: number; cpts?: string[]; rvuSource?: string; rvuDerivedMode?: boolean; targetRvuPerHour?: number }
  | { type: 'study_complete' }
  | { type: 'admin_toggle' }
  | { type: 'comms_toggle' }
  | { type: 'break_toggle' }
  | { type: 'doubletap_toggle'; modality?: string }
  | { type: 'draft_enter' }
  | { type: 'draft_exit' }
  | { type: 'swap_detected'; interstitialDuration: number; correctedStart: number; correctedSystem: string };

// Shadow events use the same shape as production events
export interface ShadowStudyEvent {
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
  swapped?: boolean;
  rvuSource?: string;
  cpts?: string[];
  rvuDerivedMode?: boolean;
  targetRvuPerHour?: number;
}

export interface ShadowInterstitialEvent {
  type: 'INTERSTITIAL';
  startTimeSession: number;
  startTimeSystem: string;
  endTimeSession: number;
  endTimeSystem: string;
  duration: number;
}

export interface ShadowTimerEvent {
  type: 'ADMIN' | 'COMMS' | 'BREAK' | 'DOUBLE_TAP';
  startTimeSession: number;
  startTimeSystem: string;
  endTimeSession: number;
  endTimeSystem: string;
  duration: number;
  associatedModality?: string | null;
}

export type ShadowEvent = ShadowStudyEvent | ShadowInterstitialEvent | ShadowTimerEvent;

interface StudyContext {
  modality: string;
  complications: string[];
  parTime: number;
  studyNumber: number;
  rvu: number;
  cpts?: string[];
  rvuSource?: string;
  rvuDerivedMode?: boolean;
  targetRvuPerHour?: number;
  drafted: boolean;
  pauseTime: number;
  accumulatedTime: number; // study time accumulated before ABC interruptions
  originalStart: number;   // session time when study first started (for startTimeSession)
  originalStartSystem: string;
}

// ── Hook ─────────────────────────────────────────────────────────────────────

function getCurrentISO(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export interface UseTimerModeReturn {
  signal: (action: TimerSignal, sessionTime: number) => void;
  startSession: () => void;
  endSession: (sessionTime: number) => ShadowEvent[];
  reset: () => void;
  getEvents: () => ShadowEvent[];
  getMode: () => TimerMode;
}

export function useTimerMode(): UseTimerModeReturn {
  // All state in refs to avoid re-renders (this is a silent observer)
  const mode = useRef<TimerMode>('idle');
  const modeEnteredAt = useRef<number>(0);
  const modeEnteredSystem = useRef<string>('');
  const events = useRef<ShadowEvent[]>([]);
  const studyContext = useRef<StudyContext | null>(null);
  const priorModeBeforeABC = useRef<TimerMode>('interstitial');
  const wasInStudy = useRef<boolean>(false); // was in study when ABC started
  const lastStudyModality = useRef<string | null>(null);
  // Saved interstitial start time — when ABC interrupts an interstitial, we don't close it.
  // Instead we save the start time and restore it when ABC ends, producing one spanning event.
  const savedInterstitialStart = useRef<{ at: number; system: string } | null>(null);

  // ── Helpers ──────────────────────────────────────────────────────────────

  const closeCurrentMode = useCallback((sessionTime: number): void => {
    const duration = sessionTime - modeEnteredAt.current;
    const startSession = modeEnteredAt.current;
    const startSystem = modeEnteredSystem.current;
    const endSystem = getCurrentISO();
    const currentMode = mode.current;

    if (currentMode === 'interstitial' && duration > 0) {
      events.current.push({
        type: 'INTERSTITIAL',
        startTimeSession: startSession,
        startTimeSystem: startSystem,
        endTimeSession: sessionTime,
        endTimeSystem: endSystem,
        duration,
      });
    } else if (currentMode === 'admin' && duration > 0) {
      events.current.push({
        type: 'ADMIN',
        startTimeSession: startSession,
        startTimeSystem: startSystem,
        endTimeSession: sessionTime,
        endTimeSystem: endSystem,
        duration,
      });
    } else if (currentMode === 'comms' && duration > 0) {
      events.current.push({
        type: 'COMMS',
        startTimeSession: startSession,
        startTimeSystem: startSystem,
        endTimeSession: sessionTime,
        endTimeSystem: endSystem,
        duration,
      });
    } else if (currentMode === 'break' && duration > 0) {
      events.current.push({
        type: 'BREAK',
        startTimeSession: startSession,
        startTimeSystem: startSystem,
        endTimeSession: sessionTime,
        endTimeSystem: endSystem,
        duration,
      });
    } else if (currentMode === 'doubleTap' && duration > 0) {
      events.current.push({
        type: 'DOUBLE_TAP',
        startTimeSession: startSession,
        startTimeSystem: startSystem,
        endTimeSession: sessionTime,
        endTimeSystem: endSystem,
        duration,
        associatedModality: lastStudyModality.current,
      });
    }
    // Study mode is closed by study_complete signal, not here
  }, []);

  const enterMode = useCallback((newMode: TimerMode, sessionTime: number): void => {
    mode.current = newMode;
    modeEnteredAt.current = sessionTime;
    modeEnteredSystem.current = getCurrentISO();
  }, []);

  // ── Signal Handler ───────────────────────────────────────────────────────

  const signal = useCallback((action: TimerSignal, sessionTime: number): void => {
    const currentMode = mode.current;

    switch (action.type) {
      case 'study_start': {
        if (currentMode === 'idle') break; // Session not started
        // Study start closes everything — discard any saved interstitial
        savedInterstitialStart.current = null;
        // Close whatever mode we're in (interstitial, admin, comms)
        closeCurrentMode(sessionTime);
        // Save study context (or resume from existing context after draft restore)
        if (!studyContext.current || studyContext.current.modality !== action.modality) {
          studyContext.current = {
            modality: action.modality,
            complications: action.complications,
            parTime: action.parTime,
            studyNumber: action.studyNumber,
            rvu: action.rvu,
            cpts: action.cpts,
            rvuSource: action.rvuSource,
            rvuDerivedMode: action.rvuDerivedMode,
            targetRvuPerHour: action.targetRvuPerHour,
            drafted: false,
            pauseTime: 0,
            accumulatedTime: 0,
            originalStart: sessionTime,
            originalStartSystem: getCurrentISO(),
          };
        }
        enterMode('study', sessionTime);
        break;
      }

      case 'study_complete': {
        if (currentMode !== 'study') break;
        const ctx = studyContext.current;
        if (!ctx) break;

        // Total elapsed = accumulated time from before ABC interruptions + current segment
        const currentSegment = sessionTime - modeEnteredAt.current;
        const elapsedTime = ctx.accumulatedTime + currentSegment;
        const variance = elapsedTime - ctx.parTime;

        const studyEvent: ShadowStudyEvent = {
          type: 'STUDY',
          studyNumber: ctx.studyNumber,
          startTimeSession: ctx.originalStart,
          startTimeSystem: ctx.originalStartSystem,
          modality: ctx.modality,
          complications: ctx.complications,
          parTime: ctx.parTime,
          elapsedTime,
          variance,
          rvu: ctx.rvu,
          pauseTime: ctx.pauseTime,
          pauseUsed: ctx.pauseTime > 0,
          drafted: ctx.drafted,
          ...(ctx.cpts ? { rvuSource: ctx.rvuSource, cpts: ctx.cpts } : {}),
          ...(ctx.rvuDerivedMode ? { rvuDerivedMode: true, targetRvuPerHour: ctx.targetRvuPerHour } : {}),
        };
        events.current.push(studyEvent);

        lastStudyModality.current = ctx.modality;
        studyContext.current = null;
        enterMode('interstitial', sessionTime);
        break;
      }

      case 'swap_detected': {
        // Retroactively fix the last study and interstitial events
        const evts = events.current;
        // Find last interstitial
        let lastInterIdx = -1;
        for (let i = evts.length - 1; i >= 0; i--) {
          if (evts[i].type === 'INTERSTITIAL') { lastInterIdx = i; break; }
        }
        if (lastInterIdx >= 0) {
          const inter = evts[lastInterIdx] as ShadowInterstitialEvent;
          // Shorten interstitial to 10s
          evts[lastInterIdx] = {
            ...inter,
            duration: 10,
            endTimeSession: inter.startTimeSession + 10,
          };
        }
        // Find last study event and fix it
        let lastStudyIdx = -1;
        for (let i = evts.length - 1; i >= 0; i--) {
          if (evts[i].type === 'STUDY') { lastStudyIdx = i; break; }
        }
        if (lastStudyIdx >= 0) {
          const study = evts[lastStudyIdx] as ShadowStudyEvent;
          evts[lastStudyIdx] = {
            ...study,
            startTimeSession: action.correctedStart,
            startTimeSystem: action.correctedSystem,
            elapsedTime: action.interstitialDuration,
            variance: action.interstitialDuration - study.parTime,
            swapped: true,
          };
        }
        break;
      }

      case 'admin_toggle': {
        if (currentMode === 'admin') {
          // Turning off admin — emit ADMIN event
          closeCurrentMode(sessionTime);
          if (wasInStudy.current) {
            enterMode('study', sessionTime);
          } else {
            // Restore interstitial with original start time (spans the admin interruption)
            if (savedInterstitialStart.current) {
              mode.current = 'interstitial';
              modeEnteredAt.current = savedInterstitialStart.current.at;
              modeEnteredSystem.current = savedInterstitialStart.current.system;
              savedInterstitialStart.current = null;
            } else {
              enterMode('interstitial', sessionTime);
            }
          }
          wasInStudy.current = false;
        } else {
          // Turning on admin
          priorModeBeforeABC.current = currentMode;
          wasInStudy.current = currentMode === 'study';
          if (currentMode === 'interstitial') {
            savedInterstitialStart.current = { at: modeEnteredAt.current, system: modeEnteredSystem.current };
          }
          if (currentMode === 'study' && studyContext.current) {
            // Accumulate study time before this interruption
            studyContext.current.accumulatedTime += sessionTime - modeEnteredAt.current;
          }
          enterMode('admin', sessionTime);
        }
        break;
      }

      case 'comms_toggle': {
        if (currentMode === 'comms') {
          closeCurrentMode(sessionTime);
          if (wasInStudy.current) {
            enterMode('study', sessionTime);
          } else {
            if (savedInterstitialStart.current) {
              mode.current = 'interstitial';
              modeEnteredAt.current = savedInterstitialStart.current.at;
              modeEnteredSystem.current = savedInterstitialStart.current.system;
              savedInterstitialStart.current = null;
            } else {
              enterMode('interstitial', sessionTime);
            }
          }
          wasInStudy.current = false;
        } else {
          priorModeBeforeABC.current = currentMode;
          wasInStudy.current = currentMode === 'study';
          if (currentMode === 'interstitial') {
            savedInterstitialStart.current = { at: modeEnteredAt.current, system: modeEnteredSystem.current };
          }
          if (currentMode === 'study' && studyContext.current) {
            studyContext.current.accumulatedTime += sessionTime - modeEnteredAt.current;
          }
          enterMode('comms', sessionTime);
        }
        break;
      }

      case 'break_toggle': {
        if (currentMode === 'break') {
          closeCurrentMode(sessionTime);
          enterMode('interstitial', sessionTime);
          wasInStudy.current = false;
        } else {
          priorModeBeforeABC.current = currentMode;
          wasInStudy.current = currentMode === 'study';
          // Break closes everything — discard any saved interstitial
          savedInterstitialStart.current = null;
          closeCurrentMode(sessionTime);
          enterMode('break', sessionTime);
        }
        break;
      }

      case 'doubletap_toggle': {
        if (currentMode === 'doubleTap') {
          closeCurrentMode(sessionTime);
          enterMode('interstitial', sessionTime);
        } else if (currentMode === 'interstitial') {
          closeCurrentMode(sessionTime);
          if (action.modality) lastStudyModality.current = action.modality;
          enterMode('doubleTap', sessionTime);
        }
        break;
      }

      case 'draft_enter': {
        if (currentMode === 'study' && studyContext.current) {
          studyContext.current.drafted = true;
          // Don't emit study event — it's suspended, will resume later
          enterMode('interstitial', sessionTime);
        }
        break;
      }

      case 'draft_exit': {
        // Study context was preserved; mode stays interstitial until study_start
        if (studyContext.current) {
          studyContext.current.drafted = true;
        }
        break;
      }
    }
  }, [closeCurrentMode, enterMode]);

  // ── Lifecycle ────────────────────────────────────────────────────────────

  const startSession = useCallback((): void => {
    mode.current = 'interstitial';
    modeEnteredAt.current = 0;
    modeEnteredSystem.current = getCurrentISO();
    events.current = [];
    studyContext.current = null;
    wasInStudy.current = false;
    lastStudyModality.current = null;
    savedInterstitialStart.current = null;
  }, []);

  const endSession = useCallback((sessionTime: number): ShadowEvent[] => {
    // Close whatever mode is active
    if (mode.current === 'study' && studyContext.current) {
      // Force-complete the study
      const ctx = studyContext.current;
      const elapsedTime = sessionTime - modeEnteredAt.current;
      events.current.push({
        type: 'STUDY',
        studyNumber: ctx.studyNumber,
        startTimeSession: modeEnteredAt.current,
        startTimeSystem: modeEnteredSystem.current,
        modality: ctx.modality,
        complications: ctx.complications,
        parTime: ctx.parTime,
        elapsedTime,
        variance: elapsedTime - ctx.parTime,
        rvu: ctx.rvu,
        pauseTime: ctx.pauseTime,
        pauseUsed: ctx.pauseTime > 0,
        drafted: ctx.drafted,
        ...(ctx.cpts ? { rvuSource: ctx.rvuSource, cpts: ctx.cpts } : {}),
        ...(ctx.rvuDerivedMode ? { rvuDerivedMode: true, targetRvuPerHour: ctx.targetRvuPerHour } : {}),
      });
    } else {
      closeCurrentMode(sessionTime);
    }
    mode.current = 'idle';
    return [...events.current];
  }, [closeCurrentMode]);

  const reset = useCallback((): void => {
    mode.current = 'idle';
    modeEnteredAt.current = 0;
    modeEnteredSystem.current = '';
    events.current = [];
    studyContext.current = null;
    wasInStudy.current = false;
    lastStudyModality.current = null;
    savedInterstitialStart.current = null;
  }, []);

  const getEvents = useCallback((): ShadowEvent[] => [...events.current], []);
  const getMode = useCallback((): TimerMode => mode.current, []);

  return { signal, startSession, endSession, reset, getEvents, getMode };
}
