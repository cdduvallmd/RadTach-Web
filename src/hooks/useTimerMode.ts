/**
 * useTimerMode — Shadow mode-enum timer system.
 *
 * Runs in parallel with the production boolean-flag timers.
 * Records its own event stream to shadow_events subcollection.
 * After validation, this will replace the boolean system entirely.
 *
 * Clyde fixes applied (2026-05-18):
 * - F1: Removed savedInterstitialStart spanning — ABC during interstitial
 *   abandons pre-ABC fragment (now superseded by absorption rule below)
 * - F5: Removed dead wasInStudy in break path
 * - F6: endSession includes accumulatedTime for interrupted studies
 *
 * Absorption rule (2026-05-25):
 * - When ANY mode (ADMIN/COMMS/BREAK/DOUBLE_TAP) toggles ON during interstitial,
 *   the new mode's start time is back-dated to the interstitial's start time.
 *   The pre-toggle interstitial fragment is absorbed into the new mode event;
 *   no separate INTERSTITIAL event is emitted. Rationale: pressing any of
 *   these buttons is a deliberate transition out of "should be reading" mode,
 *   so the time leading up to that decision belongs to that mode.
 *
 * Drafted-study context preservation (2026-06-06):
 * - When the rad drafts a study, then Sidecar opens a different-modality
 *   study, the prior draft_enter handler used to leave the drafted study's
 *   context in studyContext where the next study_start would clobber it
 *   (creating a fresh context for the new modality). That caused shadow to
 *   record only the post-resume portion of the drafted study when it was
 *   eventually completed, while production retained the full elapsed time
 *   via its separate draftStudy state. Diagnosed 2026-06-06 from a
 *   ~1200s STUDY-duration divergence on a draft-heavy day.
 * - Fix: draft_enter MOVES studyContext to draftedStudyContext; draft_exit
 *   sets pendingDraftRestore = true; study_start restores from
 *   draftedStudyContext only when the user explicitly intends to resume
 *   (pendingDraftRestore set) AND modality matches. Otherwise a fresh
 *   context is created and the drafted slot is preserved for later resume.
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
  | { type: 'swap_detected'; correctedElapsedTime: number; correctedStart: number; correctedSystem: string };

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
  accumulatedTime: number;
  originalStart: number;
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
  const mode = useRef<TimerMode>('idle');
  const modeEnteredAt = useRef<number>(0);
  const modeEnteredSystem = useRef<string>('');
  const events = useRef<ShadowEvent[]>([]);
  const studyContext = useRef<StudyContext | null>(null);
  const wasInStudy = useRef<boolean>(false);
  const lastStudyModality = useRef<string | null>(null);
  // Holds the drafted study's context across other studies until it gets
  // resumed (or the session ends, in which case it's discarded — production
  // does the same since a never-resumed draft never gets emitted as STUDY).
  const draftedStudyContext = useRef<StudyContext | null>(null);
  // True after draft_exit fires; cleared by the next study_start. Tells
  // study_start that the user intends to resume the drafted study so we can
  // distinguish "Resume Draft → click Par Time" from "Sidecar fires a new
  // study that happens to be the same modality as the draft."
  const pendingDraftRestore = useRef<boolean>(false);

  // ── Helpers ──────────────────────────────────────────────────────────────

  const closeCurrentMode = useCallback((sessionTime: number): void => {
    const duration = sessionTime - modeEnteredAt.current;
    const startSession = modeEnteredAt.current;
    const startSystem = modeEnteredSystem.current;
    const endSystem = getCurrentISO();
    const currentMode = mode.current;

    if (currentMode === 'interstitial' && duration > 0) {
      events.current.push({ type: 'INTERSTITIAL', startTimeSession: startSession, startTimeSystem: startSystem, endTimeSession: sessionTime, endTimeSystem: endSystem, duration });
    } else if (currentMode === 'admin' && duration > 0) {
      events.current.push({ type: 'ADMIN', startTimeSession: startSession, startTimeSystem: startSystem, endTimeSession: sessionTime, endTimeSystem: endSystem, duration });
    } else if (currentMode === 'comms' && duration > 0) {
      events.current.push({ type: 'COMMS', startTimeSession: startSession, startTimeSystem: startSystem, endTimeSession: sessionTime, endTimeSystem: endSystem, duration });
    } else if (currentMode === 'break' && duration > 0) {
      events.current.push({ type: 'BREAK', startTimeSession: startSession, startTimeSystem: startSystem, endTimeSession: sessionTime, endTimeSystem: endSystem, duration });
    } else if (currentMode === 'doubleTap' && duration > 0) {
      events.current.push({ type: 'DOUBLE_TAP', startTimeSession: startSession, startTimeSystem: startSystem, endTimeSession: sessionTime, endTimeSystem: endSystem, duration, associatedModality: lastStudyModality.current });
    }
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
        if (currentMode === 'idle') break;
        // Close whatever mode we're in (interstitial, admin, comms)
        closeCurrentMode(sessionTime);

        // Drafted-study resume: only when the rad explicitly clicked Resume
        // Draft (pendingDraftRestore) AND the new modality matches the
        // drafted study. Restores the original studyContext including its
        // pre-draft accumulatedTime — so when the resumed study eventually
        // completes, the recorded elapsedTime spans pre-draft + post-resume.
        const wantsResume = pendingDraftRestore.current;
        pendingDraftRestore.current = false;
        if (
          wantsResume &&
          draftedStudyContext.current &&
          draftedStudyContext.current.modality === action.modality
        ) {
          studyContext.current = draftedStudyContext.current;
          draftedStudyContext.current = null;
        } else if (!studyContext.current || studyContext.current.modality !== action.modality) {
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

        const currentSegment = sessionTime - modeEnteredAt.current;
        const elapsedTime = ctx.accumulatedTime + currentSegment;
        const variance = elapsedTime - ctx.parTime;

        events.current.push({
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
        });

        lastStudyModality.current = ctx.modality;
        studyContext.current = null;
        enterMode('interstitial', sessionTime);
        break;
      }

      case 'swap_detected': {
        const evts = events.current;
        let lastInterIdx = -1;
        for (let i = evts.length - 1; i >= 0; i--) {
          if (evts[i].type === 'INTERSTITIAL') { lastInterIdx = i; break; }
        }
        if (lastInterIdx >= 0) {
          const inter = evts[lastInterIdx] as ShadowInterstitialEvent;
          evts[lastInterIdx] = { ...inter, duration: 10, endTimeSession: inter.startTimeSession + 10 };
        }
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
            elapsedTime: action.correctedElapsedTime,
            variance: action.correctedElapsedTime - study.parTime,
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
            // Start fresh interstitial post-admin
            enterMode('interstitial', sessionTime);
          }
          wasInStudy.current = false;
        } else {
          wasInStudy.current = currentMode === 'study';
          if (currentMode === 'interstitial') {
            // Absorb pre-toggle interstitial — keep modeEnteredAt at the interstitial's start
            mode.current = 'admin';
          } else {
            if (currentMode === 'study' && studyContext.current) {
              studyContext.current.accumulatedTime += sessionTime - modeEnteredAt.current;
            }
            enterMode('admin', sessionTime);
          }
        }
        break;
      }

      case 'comms_toggle': {
        if (currentMode === 'comms') {
          closeCurrentMode(sessionTime);
          if (wasInStudy.current) {
            enterMode('study', sessionTime);
          } else {
            enterMode('interstitial', sessionTime);
          }
          wasInStudy.current = false;
        } else {
          wasInStudy.current = currentMode === 'study';
          if (currentMode === 'interstitial') {
            mode.current = 'comms';
          } else {
            if (currentMode === 'study' && studyContext.current) {
              studyContext.current.accumulatedTime += sessionTime - modeEnteredAt.current;
            }
            enterMode('comms', sessionTime);
          }
        }
        break;
      }

      case 'break_toggle': {
        if (currentMode === 'break') {
          closeCurrentMode(sessionTime);
          // Mirror Admin/Comms: if the user was mid-study when Break started,
          // resume study mode directly without an interstitial transition.
          if (wasInStudy.current) {
            enterMode('study', sessionTime);
          } else {
            enterMode('interstitial', sessionTime);
          }
          wasInStudy.current = false;
        } else {
          wasInStudy.current = currentMode === 'study';
          if (currentMode === 'interstitial') {
            mode.current = 'break';
          } else {
            if (currentMode === 'study' && studyContext.current) {
              studyContext.current.accumulatedTime += sessionTime - modeEnteredAt.current;
            }
            closeCurrentMode(sessionTime);
            enterMode('break', sessionTime);
          }
        }
        break;
      }

      case 'doubletap_toggle': {
        if (currentMode === 'doubleTap') {
          closeCurrentMode(sessionTime);
          enterMode('interstitial', sessionTime);
        } else if (currentMode === 'interstitial') {
          // Absorb pre-toggle interstitial into DOUBLE_TAP
          mode.current = 'doubleTap';
          if (action.modality) lastStudyModality.current = action.modality;
        }
        break;
      }

      case 'draft_enter': {
        if (currentMode === 'study' && studyContext.current) {
          studyContext.current.drafted = true;
          // Accumulate pre-draft study time so it's preserved when the draft
          // is resumed and eventually completed.
          studyContext.current.accumulatedTime += sessionTime - modeEnteredAt.current;
          // Move the drafted context to its own slot so subsequent studies
          // (including different-modality Sidecar studies) can't clobber it.
          draftedStudyContext.current = studyContext.current;
          studyContext.current = null;
          enterMode('interstitial', sessionTime);
        }
        break;
      }

      case 'draft_exit': {
        // Mark intent to resume — consumed by the next study_start. If the
        // rad changes their mind and starts a different modality first,
        // study_start will clear this flag but leave draftedStudyContext
        // intact for the actual resume later.
        pendingDraftRestore.current = true;
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
    draftedStudyContext.current = null;
    pendingDraftRestore.current = false;
  }, []);

  const endSession = useCallback((sessionTime: number): ShadowEvent[] => {
    if (mode.current === 'study' && studyContext.current) {
      // F6: Include accumulatedTime for interrupted studies
      const ctx = studyContext.current;
      const currentSegment = sessionTime - modeEnteredAt.current;
      const elapsedTime = ctx.accumulatedTime + currentSegment;
      events.current.push({
        type: 'STUDY',
        studyNumber: ctx.studyNumber,
        startTimeSession: ctx.originalStart,
        startTimeSystem: ctx.originalStartSystem,
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
    draftedStudyContext.current = null;
    pendingDraftRestore.current = false;
  }, []);

  const getEvents = useCallback((): ShadowEvent[] => [...events.current], []);
  const getMode = useCallback((): TimerMode => mode.current, []);

  return { signal, startSession, endSession, reset, getEvents, getMode };
}
