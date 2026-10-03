/**
 * useTimerMode — the mode-enum timer engine: exactly one mode at a time
 * (idle / study / interstitial / admin / comms / break / doubleTap).
 *
 * Canonical engine for every session (2026-10-01). Its event list is what
 * reaches Firestore `events`: every add or edit is reported through the change
 * callback to useEventSync. The legacy boolean-flag timers still run alongside
 * only to drive the display and session totals until those move here
 * (mode-enum plan Phases 4–6).
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
 * - Fix: draft_enter MOVES studyContext to draftedStudyContext, where it
 *   waits until a study_start carries its studyId (Resume Draft).
 *
 * Study identity (2026-10-01, plan step 3c): study_start matches contexts by
 * studyId, never by modality. The same id resumes the open or drafted study;
 * any other id starts a new one, so a study mode-enum failed to close can't
 * leak its id, start or RVU into the next study.
 */
import { useRef, useCallback, useEffect } from 'react';
import { isPress } from '../utils/adminEvents';

// ── Types ────────────────────────────────────────────────────────────────────

export type TimerMode = 'idle' | 'study' | 'interstitial' | 'admin' | 'comms' | 'break' | 'doubleTap';

export type TimerSignal =
  | { type: 'study_start'; studyId: string; modality: string; complications: string[]; parTime: number; studyNumber: number; rvu: number; cpts?: string[]; rvuSource?: string; rvuDerivedMode?: boolean; targetRvuPerHour?: number }
  | { type: 'study_complete'; rvu: number; parTime: number; complications: string[]; cpts?: string[]; rvuSource?: string }
  | { type: 'admin_toggle' }
  | { type: 'comms_toggle' }
  | { type: 'break_toggle' }
  | { type: 'doubletap_toggle'; modality?: string }
  | { type: 'draft_enter' }
  | { type: 'swap_detected'; studyId: string }
  | { type: 'undo_study'; studyId: string };

// Same shape as the legacy engine's events
export interface ModeStudyEvent {
  type: 'STUDY';
  studyId?: string; // random, set at study start; absent on events before step 3c
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
  draftGaps?: DraftGap[];  // drafted studies only: when it was on hold
  swapped?: boolean;
  rvuSource?: string;
  cpts?: string[];
  rvuDerivedMode?: boolean;
  targetRvuPerHour?: number;
  // When the study ended (after any interruptions). Absent before step 3c.
  endTimeSession?: number;
  endTimeSystem?: string;
}

// Marks an ADMIN event that replaced an undone study, or an event taken while
// that study was open. Its time is Admin time, but it is not an Admin button
// press, an interruption, or a meeting candidate (see utils/adminEvents.ts).
export interface UndoneStudy {
  studyId: string;
  originalType?: string; // for events taken during the study (e.g. 'COMMS')
  studyNumber?: number;
  modality?: string;
  complications?: string[];
  rvu?: number;
  cpts?: string[];
  rvuSource?: string;
  parTime?: number;
  elapsedTime?: number;
  swapped?: boolean;
  drafted?: boolean;
  // Set when the study was drafted and never resumed before Stop (not an
  // Undo): its reading time is Admin, but it is not a deleted study.
  neverResumed?: boolean;
}

export interface ModeInterstitialEvent {
  type: 'INTERSTITIAL';
  startTimeSession: number;
  startTimeSystem: string;
  endTimeSession: number;
  endTimeSystem: string;
  duration: number;
}

export interface ModeTimerEvent {
  type: 'ADMIN' | 'COMMS' | 'BREAK' | 'DOUBLE_TAP';
  startTimeSession: number;
  startTimeSystem: string;
  endTimeSession: number;
  endTimeSystem: string;
  duration: number;
  associatedModality?: string | null;
  undoneStudy?: UndoneStudy;
  // The rest of an interruption that a study's end split in two: the same
  // press, so not counted again (Phase 4 counts).
  continued?: boolean;
}

export type ModeEvent = ModeStudyEvent | ModeInterstitialEvent | ModeTimerEvent;

interface StudyContext {
  studyId: string;
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
  draftGaps?: DraftGap[];
  pauseTime: number;
  accumulatedTime: number;
  originalStart: number;
  originalStartSystem: string;
}

// ── Hook ─────────────────────────────────────────────────────────────────────

// Local wall-clock time, no zone suffix (the format every event uses).
function getCurrentISO(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// When a drafted study was on hold: from the Draft press to its resume (3e).
// Lets the filmstrip draw the study's pieces around the studies read between.
export interface DraftGap { start: number; end: number }

// An event added or replaced at `index` in the event list. Reported after each
// signal / endSession so the caller can mirror the list (crash log, uploads).

export interface EventChange {
  index: number;
  event: ModeEvent;
}

// What the screen shows, read from mode-enum (Phase 4). Totals include the
// mode running now; an interstitial absorbed by a new mode moves with it.
// Counts are recorded events (one per press: no undone-study Admin, no
// continuation of a split interruption), plus the one running now.
export interface ModeSnapshot {
  mode: TimerMode;
  studyElapsed: number;
  totals: { interstitial: number; admin: number; comms: number; break: number; doubleTap: number };
  counts: { admin: number; comms: number; break: number; doubleTap: number };
}

const EVENT_TYPE = {
  interstitial: 'INTERSTITIAL', admin: 'ADMIN', comms: 'COMMS', break: 'BREAK', doubleTap: 'DOUBLE_TAP',
} as const;
type TimedMode = keyof typeof EVENT_TYPE;
const MODE_OF: Record<string, TimedMode> = {
  INTERSTITIAL: 'interstitial', ADMIN: 'admin', COMMS: 'comms', BREAK: 'break', DOUBLE_TAP: 'doubleTap',
};

export interface UseTimerModeReturn {
  signal: (action: TimerSignal, sessionTime: number) => void;
  startSession: () => void;
  endSession: (sessionTime: number) => ModeEvent[];
  reset: () => void;
  getEvents: () => ModeEvent[];
  getMode: () => TimerMode;
  getSnapshot: (now: number) => ModeSnapshot;
}

export function useTimerMode(onEventsChanged?: (changes: EventChange[]) => void): UseTimerModeReturn {
  const mode = useRef<TimerMode>('idle');
  const modeEnteredAt = useRef<number>(0);
  const modeEnteredSystem = useRef<string>('');
  const events = useRef<ModeEvent[]>([]);
  const studyContext = useRef<StudyContext | null>(null);
  const wasInStudy = useRef<boolean>(false);
  // True while the running interruption continues one split at a study's end.
  const continuing = useRef<boolean>(false);
  const lastStudyModality = useRef<string | null>(null);
  // Holds the drafted study's context across other studies until it gets
  // resumed (or the session ends, in which case it's discarded — production
  // does the same since a never-resumed draft never gets emitted as STUDY).
  const draftedStudyContext = useRef<StudyContext | null>(null);

  // Change reporting (mode-enum plan step 3b): every add or in-place edit of
  // the event list is recorded by index and reported once per signal, so the
  // caller's crash log and upload tracker follow this list exactly.
  const changed = useRef<Set<number>>(new Set());
  const onEventsChangedRef = useRef(onEventsChanged);
  useEffect(() => {
    onEventsChangedRef.current = onEventsChanged;
  }, [onEventsChanged]);

  // ── Helpers ──────────────────────────────────────────────────────────────

  const pushEvent = (event: ModeEvent): void => {
    events.current.push(event);
    changed.current.add(events.current.length - 1);
  };

  const replaceEvent = (index: number, event: ModeEvent): void => {
    events.current[index] = event;
    changed.current.add(index);
  };

  const emitChanges = (): void => {
    if (changed.current.size === 0) return;
    const list = [...changed.current]
      .sort((a, b) => a - b)
      .map(index => ({ index, event: events.current[index] }));
    changed.current.clear();
    onEventsChangedRef.current?.(list);
  };

  // Reading time = time banked before interruptions, plus the current
  // segment if the study is the active mode.
  const pushStudy = useCallback((ctx: StudyContext, sessionTime: number): void => {
    const current = mode.current === 'study' ? sessionTime - modeEnteredAt.current : 0;
    const elapsedTime = ctx.accumulatedTime + current;
    pushEvent({
      type: 'STUDY',
      studyId: ctx.studyId,
      studyNumber: ctx.studyNumber,
      startTimeSession: ctx.originalStart,
      startTimeSystem: ctx.originalStartSystem,
      endTimeSession: sessionTime,
      endTimeSystem: getCurrentISO(),
      modality: ctx.modality,
      complications: ctx.complications,
      parTime: ctx.parTime,
      elapsedTime,
      variance: elapsedTime - ctx.parTime,
      rvu: ctx.rvu,
      pauseTime: ctx.pauseTime,
      pauseUsed: ctx.pauseTime > 0,
      drafted: ctx.drafted,
      ...(ctx.draftGaps ? { draftGaps: ctx.draftGaps } : {}),
      ...(ctx.cpts ? { rvuSource: ctx.rvuSource, cpts: ctx.cpts } : {}),
      ...(ctx.rvuDerivedMode ? { rvuDerivedMode: true, targetRvuPerHour: ctx.targetRvuPerHour } : {}),
    });
  }, []);

  // Undo (plan step 3c): the undone study becomes Admin from its start to its
  // end, and so does every interruption taken while it was open. Each event is
  // replaced at its own index, so the event sync uploads the edits as usual.
  const undoStudy = useCallback((studyId: string): void => {
    const evts = events.current;
    const index = evts.findIndex(e => e.type === 'STUDY' && e.studyId === studyId);
    if (index < 0) {
      console.warn('[mode-enum] undo_study: no STUDY with id', studyId);
      return;
    }
    // Every STUDY with a studyId was built by pushStudy, so it has end times.
    const study = evts[index] as ModeStudyEvent & { endTimeSession: number; endTimeSystem: string };
    replaceEvent(index, {
      type: 'ADMIN',
      startTimeSession: study.startTimeSession,
      startTimeSystem: study.startTimeSystem,
      endTimeSession: study.endTimeSession,
      endTimeSystem: study.endTimeSystem,
      duration: study.elapsedTime,
      undoneStudy: {
        studyId,
        originalType: 'STUDY',
        studyNumber: study.studyNumber,
        modality: study.modality,
        complications: study.complications,
        rvu: study.rvu,
        cpts: study.cpts,
        rvuSource: study.rvuSource,
        parTime: study.parTime,
        elapsedTime: study.elapsedTime,
        swapped: study.swapped ?? false,
        drafted: study.drafted,
      },
    });
    // A drafted study's span holds other studies' work, so only the study
    // itself is converted (accepted, plan 3c).
    if (study.drafted) return;
    // Interruptions taken while the study was open sit just before it in the
    // list. Walk back until another study or anything older than this one,
    // so the conversion can never reach into an earlier study.
    for (
      let i = index - 1;
      i >= 0 && evts[i].type !== 'STUDY' && evts[i].startTimeSession >= study.startTimeSession;
      i--
    ) {
      const e = evts[i] as ModeInterstitialEvent | ModeTimerEvent;
      replaceEvent(i, {
        type: 'ADMIN',
        startTimeSession: e.startTimeSession,
        startTimeSystem: e.startTimeSystem,
        endTimeSession: e.endTimeSession,
        endTimeSystem: e.endTimeSystem,
        duration: e.duration,
        undoneStudy: { studyId, originalType: e.type },
      });
    }
  }, []);

  const closeCurrentMode = useCallback((sessionTime: number): void => {
    const duration = sessionTime - modeEnteredAt.current;
    if (!(mode.current in EVENT_TYPE) || duration <= 0) return;
    const type = EVENT_TYPE[mode.current as TimedMode];
    const base = {
      startTimeSession: modeEnteredAt.current,
      startTimeSystem: modeEnteredSystem.current,
      endTimeSession: sessionTime,
      endTimeSystem: getCurrentISO(),
      duration,
    };
    if (type === 'INTERSTITIAL') {
      pushEvent({ type, ...base });
    } else {
      pushEvent({
        type,
        ...base,
        ...(type === 'DOUBLE_TAP' ? { associatedModality: lastStudyModality.current } : {}),
        ...(continuing.current ? { continued: true } : {}),
      });
    }
  }, []);

  const enterMode = useCallback((newMode: TimerMode, sessionTime: number): void => {
    mode.current = newMode;
    continuing.current = false;
    modeEnteredAt.current = sessionTime;
    modeEnteredSystem.current = getCurrentISO();
  }, []);

  // Admin, Comms and Break share one rule: pressing the running one ends it
  // and returns to the study it interrupted (or to interstitial); pressing
  // another ends whatever is running first, so no time is dropped.
  // Interstitial time just before the press is absorbed into the new mode.
  const toggleInterruption = useCallback((target: 'admin' | 'comms' | 'break', sessionTime: number): void => {
    const current = mode.current;
    if (current === 'idle') return;
    if (current === target) {
      closeCurrentMode(sessionTime);
      enterMode(wasInStudy.current && studyContext.current ? 'study' : 'interstitial', sessionTime);
      wasInStudy.current = false;
    } else if (current === 'interstitial') {
      mode.current = target; // keep modeEnteredAt at the interstitial's start
    } else if (current === 'study') {
      if (studyContext.current) {
        studyContext.current.accumulatedTime += sessionTime - modeEnteredAt.current;
      }
      wasInStudy.current = true;
      enterMode(target, sessionTime);
    } else {
      // Another interruption (or double tap) is running: end it first. A
      // study it interrupted stays open (wasInStudy unchanged).
      closeCurrentMode(sessionTime);
      enterMode(target, sessionTime);
    }
  }, [closeCurrentMode, enterMode]);

  // ── Signal Handler ───────────────────────────────────────────────────────

  const signal = useCallback((action: TimerSignal, sessionTime: number): void => {
    const currentMode = mode.current;

    switch (action.type) {
      case 'study_start': {
        if (currentMode === 'idle') break;
        // Already reading this study: nothing to do (restarting would drop
        // the current segment).
        if (currentMode === 'study' && studyContext.current?.studyId === action.studyId) break;
        // Close whatever mode we're in (interstitial, admin, comms, break).
        // The study is now the active mode, so no interruption is pending.
        closeCurrentMode(sessionTime);
        wasInStudy.current = false;

        if (draftedStudyContext.current?.studyId === action.studyId) {
          // Resume Draft: keeps the pre-draft time, so the completed study's
          // elapsedTime spans pre-draft + post-resume.
          studyContext.current = draftedStudyContext.current;
          draftedStudyContext.current = null;
          const gaps = studyContext.current.draftGaps;
          if (gaps?.length) gaps[gaps.length - 1].end = sessionTime;
        } else if (studyContext.current?.studyId !== action.studyId) {
          studyContext.current = {
            studyId: action.studyId,
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
        if (!studyContext.current) break;
        // Record the final details, which may have changed since the start.
        const ctx: StudyContext = {
          ...studyContext.current,
          rvu: action.rvu,
          parTime: action.parTime,
          complications: action.complications,
          cpts: action.cpts,
          rvuSource: action.rvuSource,
        };
        if (currentMode === 'study') {
          pushStudy(ctx, sessionTime);
          enterMode('interstitial', sessionTime);
        } else if (wasInStudy.current && (currentMode === 'admin' || currentMode === 'comms' || currentMode === 'break')) {
          // Ended while an interruption taken during the study is still on.
          // Split the interruption at the study's end: the part inside the
          // study stays in its span (Undo converts it), the rest carries on.
          const firstHalfRecorded = sessionTime > modeEnteredAt.current;
          closeCurrentMode(sessionTime);
          pushStudy(ctx, sessionTime);
          wasInStudy.current = false;
          enterMode(currentMode, sessionTime);
          // The press is counted on the first half; if that was 0 s (nothing
          // recorded), the rest is the press (Clyde 261003d #7).
          continuing.current = firstHalfRecorded;
        } else {
          break;
        }
        lastStudyModality.current = ctx.modality;
        studyContext.current = null;
        break;
      }

      case 'swap_detected': {
        // The swapped study, by id, and the interstitial between it and the
        // previous study. No such gap (the study started straight from
        // Comms/Admin/Break) means there is nothing to reclaim.
        const evts = events.current;
        const studyIdx = evts.findIndex(e => e.type === 'STUDY' && e.studyId === action.studyId);
        let interIdx = -1;
        for (let i = studyIdx - 1; i >= 0 && evts[i].type !== 'STUDY' && !('undoneStudy' in evts[i]); i--) {
          if (evts[i].type === 'INTERSTITIAL') { interIdx = i; break; }
        }
        // A resumed drafted study started long before this gap; skip it.
        const drafted = studyIdx >= 0 && (evts[studyIdx] as ModeStudyEvent).drafted;
        if (studyIdx >= 0 && interIdx >= 0 && !drafted) {
          // The study really began 10 s after the previous one ended; the rest
          // of the gap was reading time. Computed from this engine's own events
          // (and never more than the gap itself), so the seconds still add up.
          const inter = evts[interIdx] as ModeInterstitialEvent;
          const keep = Math.min(10, inter.duration);
          // Local time, like every other stamp (toISOString would be UTC).
          const splitSystem = getCurrentISO(new Date(new Date(inter.startTimeSystem).getTime() + keep * 1000));
          replaceEvent(interIdx, { ...inter, duration: keep, endTimeSession: inter.startTimeSession + keep, endTimeSystem: splitSystem });
          const study = evts[studyIdx] as ModeStudyEvent;
          const elapsedTime = study.elapsedTime + inter.duration - keep;
          replaceEvent(studyIdx, {
            ...study,
            startTimeSession: inter.startTimeSession + keep,
            startTimeSystem: splitSystem,
            elapsedTime,
            variance: elapsedTime - study.parTime,
            swapped: true,
          });
        }
        break;
      }

      case 'admin_toggle':
        toggleInterruption('admin', sessionTime);
        break;

      case 'comms_toggle':
        toggleInterruption('comms', sessionTime);
        break;

      case 'break_toggle':
        toggleInterruption('break', sessionTime);
        break;

      case 'doubletap_toggle': {
        // Never during a study (App blocks it then).
        if (currentMode === 'doubleTap') {
          closeCurrentMode(sessionTime);
          enterMode('interstitial', sessionTime);
        } else if (currentMode === 'interstitial') {
          // Absorb pre-toggle interstitial into DOUBLE_TAP
          mode.current = 'doubleTap';
          if (action.modality) lastStudyModality.current = action.modality;
        } else if (!wasInStudy.current && (currentMode === 'admin' || currentMode === 'comms' || currentMode === 'break')) {
          // A new mode ends the running one.
          closeCurrentMode(sessionTime);
          enterMode('doubleTap', sessionTime);
          wasInStudy.current = false;
          if (action.modality) lastStudyModality.current = action.modality;
        }
        break;
      }

      case 'draft_enter': {
        const ctx = studyContext.current;
        if (!ctx) break;
        if (currentMode === 'study') {
          // Accumulate pre-draft study time so it's preserved when the draft
          // is resumed and eventually completed.
          ctx.accumulatedTime += sessionTime - modeEnteredAt.current;
          enterMode('interstitial', sessionTime);
        } else if (!(wasInStudy.current && (currentMode === 'admin' || currentMode === 'comms' || currentMode === 'break'))) {
          break;
        }
        // Drafted during an interruption: the interruption carries on, and
        // ends in interstitial since the study is no longer open.
        ctx.drafted = true;
        ctx.draftGaps = [...(ctx.draftGaps ?? []), { start: sessionTime, end: sessionTime }];
        // Move the drafted context to its own slot so subsequent studies
        // (including different-modality Sidecar studies) can't clobber it.
        draftedStudyContext.current = ctx;
        studyContext.current = null;
        wasInStudy.current = false;
        break;
      }

      case 'undo_study': {
        undoStudy(action.studyId);
        break;
      }

    }
    emitChanges();
  }, [closeCurrentMode, enterMode, pushStudy, undoStudy, toggleInterruption]);

  // ── Lifecycle ────────────────────────────────────────────────────────────

  const startSession = useCallback((): void => {
    mode.current = 'interstitial';
    modeEnteredAt.current = 0;
    modeEnteredSystem.current = getCurrentISO();
    events.current = [];
    changed.current.clear();
    studyContext.current = null;
    wasInStudy.current = false;
    continuing.current = false;
    lastStudyModality.current = null;
    draftedStudyContext.current = null;
  }, []);

  const endSession = useCallback((sessionTime: number): ModeEvent[] => {
    // A study still open (or interrupted) at Stop is recorded after the
    // interruption that was running, as at study_complete.
    const ctx = studyContext.current;
    const studyOpen = ctx && (mode.current === 'study' || wasInStudy.current);
    closeCurrentMode(sessionTime);
    if (studyOpen) pushStudy(ctx, sessionTime);
    // A draft never resumed was never completed: like an undone study, its
    // reading time is Admin, with no study and no RVU (owner, 2026-10-03).
    // It ends where it was last drafted.
    const draft = draftedStudyContext.current;
    if (draft && draft.accumulatedTime > 0) {
      const end = draft.draftGaps?.at(-1)?.start ?? draft.originalStart + draft.accumulatedTime;
      pushEvent({
        type: 'ADMIN',
        startTimeSession: draft.originalStart,
        startTimeSystem: draft.originalStartSystem,
        endTimeSession: end,
        endTimeSystem: getCurrentISO(new Date(new Date(draft.originalStartSystem).getTime() + (end - draft.originalStart) * 1000)),
        duration: draft.accumulatedTime,
        undoneStudy: {
          studyId: draft.studyId,
          originalType: 'STUDY',
          studyNumber: draft.studyNumber,
          modality: draft.modality,
          complications: draft.complications,
          rvu: draft.rvu,
          cpts: draft.cpts,
          rvuSource: draft.rvuSource,
          parTime: draft.parTime,
          elapsedTime: draft.accumulatedTime,
          swapped: false,
          drafted: true,
          neverResumed: true,
        },
      });
    }
    draftedStudyContext.current = null;
    // Nothing is open any more, so a repeated endSession adds nothing.
    studyContext.current = null;
    wasInStudy.current = false;
    mode.current = 'idle';
    emitChanges();
    return [...events.current];
  }, [closeCurrentMode, pushStudy]);

  const reset = useCallback((): void => {
    mode.current = 'idle';
    modeEnteredAt.current = 0;
    modeEnteredSystem.current = '';
    events.current = [];
    changed.current.clear();
    studyContext.current = null;
    wasInStudy.current = false;
    continuing.current = false;
    lastStudyModality.current = null;
    draftedStudyContext.current = null;
  }, []);

  const getEvents = useCallback((): ModeEvent[] => [...events.current], []);
  const getMode = useCallback((): TimerMode => mode.current, []);

  const getSnapshot = useCallback((now: number): ModeSnapshot => {
    const totals = { interstitial: 0, admin: 0, comms: 0, break: 0, doubleTap: 0 };
    const counts = { admin: 0, comms: 0, break: 0, doubleTap: 0 };
    for (const e of events.current) {
      if (e.type === 'STUDY') continue;
      const m = MODE_OF[e.type];
      totals[m] += e.duration;
      if (m !== 'interstitial' && isPress(e)) counts[m]++;
    }
    const current = mode.current;
    const running = Math.max(0, now - modeEnteredAt.current);
    if (current in EVENT_TYPE) {
      const m = current as TimedMode;
      totals[m] += running;
      if (m !== 'interstitial' && running > 0 && !continuing.current) counts[m]++;
    }
    const ctx = studyContext.current;
    const studyElapsed = ctx ? ctx.accumulatedTime + (current === 'study' ? running : 0) : 0;
    return { mode: current, studyElapsed, totals, counts };
  }, []);

  return { signal, startSession, endSession, reset, getEvents, getMode, getSnapshot };
}
