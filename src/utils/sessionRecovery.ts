// Orphaned Session Recovery — reconstructs session aggregates from saved events
//
// When the browser crashes mid-session, the Firestore session doc exists (created
// at session start) but has no endTime/stopDateTime. Events flushed every 5 studies
// survive in the events subcollection. This module rebuilds the session data object
// from those events so the orphaned session can be closed out.

import { computeSessionSummary } from './sessionSummary';
import type { SessionSummary } from './sessionSummary';
import { deriveSession } from './deriveSession';
import type { ModeEvent } from '../hooks/useTimerMode';

// Event shapes as stored in Firestore (looser than the in-app types since
// Firestore docs come back as plain objects)
interface FirestoreStudyEvent {
  type: 'STUDY';
  studyNumber: number;
  startTimeSession: number;
  startTimeSystem: string;
  endTimeSession?: number;
  endTimeSystem?: string;
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
}

interface FirestoreInterstitialEvent {
  type: 'INTERSTITIAL';
  startTimeSession: number;
  startTimeSystem: string;
  endTimeSession: number;
  endTimeSystem: string;
  duration: number;
}

interface FirestoreTimerEvent {
  type: 'ADMIN' | 'COMMS' | 'BREAK' | 'DOUBLE_TAP';
  startTimeSession: number;
  startTimeSystem: string;
  endTimeSession: number;
  endTimeSystem: string;
  duration: number;
  associatedModality?: string | null;
}

type FirestoreEvent = FirestoreStudyEvent | FirestoreInterstitialEvent | FirestoreTimerEvent;

export interface ReconstructedSessionData {
  _recordVersion: string;
  stopDateTime: string;
  totalSessionTime: number;
  studiesCompleted: number;
  deletedStudies: number;
  cumulativeParTime: number;
  interstitialTime: number;
  adminTime: number;
  adminEvents: number;
  commsTime: number;
  commsEvents: number;
  breakTime: number;
  breakEvents: number;
  doubleTapTime: number;
  doubleTapEvents: number;
  swapEvents: number;
  totalRVU: number;
  notes: { tags: string[]; description: string };
  summary: SessionSummary;
}

/**
 * Reconstruct session aggregates from saved events.
 *
 * @param sessionDoc - The Firestore session document (has startDateTime, system, etc.)
 * @param events - All events from the session's events subcollection
 * @returns Complete session data suitable for firestoreService.endSession()
 */
export function reconstructSessionData(
  sessionDoc: Record<string, any>,
  events: Record<string, any>[]
): ReconstructedSessionData {
  const typed = events as FirestoreEvent[];

  // The same totals as a normal session end (Phase 6: deriveSession).
  const d = deriveSession(events as unknown as ModeEvent[], 0);

  // Estimate totalSessionTime from the last event
  let totalSessionTime = 0;
  let stopDateTime = sessionDoc.startDateTime || '';

  if (typed.length > 0) {
    // Find the latest timestamp across all events
    let latestSessionTime = 0;
    let latestSystemTime = '';

    for (const evt of typed) {
      // Check endTimeSession (timer/interstitial events)
      if ('endTimeSession' in evt && typeof evt.endTimeSession === 'number') {
        if (evt.endTimeSession > latestSessionTime) {
          latestSessionTime = evt.endTimeSession;
          latestSystemTime = (evt as any).endTimeSystem || '';
        }
      }
      // Older STUDY events have no end time: estimate it (step 3e)
      if (evt.type === 'STUDY' && evt.endTimeSession === undefined) {
        const studyEnd = evt.startTimeSession + evt.elapsedTime;
        if (studyEnd > latestSessionTime) {
          latestSessionTime = studyEnd;
          latestSystemTime = evt.startTimeSystem || '';
        }
      }
    }

    totalSessionTime = latestSessionTime;
    stopDateTime = latestSystemTime || stopDateTime;
  }

  // Compute summary using the same utility as normal session end
  const summary = computeSessionSummary(typed as any[], totalSessionTime);

  return {
    stopDateTime,
    totalSessionTime,
    studiesCompleted: d.studies,
    deletedStudies: d.undoneStudies,
    cumulativeParTime: d.cumulativePar,
    interstitialTime: d.totals.interstitial,
    adminTime: d.totals.admin,
    adminEvents: d.counts.admin,
    commsTime: d.totals.comms,
    commsEvents: d.counts.comms,
    breakTime: d.totals.break,
    breakEvents: d.counts.break,
    doubleTapTime: d.totals.doubleTap,
    doubleTapEvents: d.counts.doubleTap,
    swapEvents: d.swaps,
    totalRVU: d.totalRVU,
    notes: { tags: ['No Comment'], description: '(recovered session)' },
    // Same totals rule as a normal Phase 6 end (Clyde 261003g #3).
    _recordVersion: 'mode-enum-6',
    summary,
  };
}
