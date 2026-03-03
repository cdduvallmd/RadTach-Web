// Orphaned Session Recovery — reconstructs session aggregates from saved events
//
// When the browser crashes mid-session, the Firestore session doc exists (created
// at session start) but has no endTime/stopDateTime. Events flushed every 5 studies
// survive in the events subcollection. This module rebuilds the session data object
// from those events so the orphaned session can be closed out.

import { computeSessionSummary } from './sessionSummary';
import type { SessionSummary } from './sessionSummary';

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

  const studies = typed.filter((e): e is FirestoreStudyEvent => e.type === 'STUDY');
  const interstitials = typed.filter((e): e is FirestoreInterstitialEvent => e.type === 'INTERSTITIAL');
  const admins = typed.filter((e): e is FirestoreTimerEvent => e.type === 'ADMIN');
  const commsEvents = typed.filter((e): e is FirestoreTimerEvent => e.type === 'COMMS');
  const breaks = typed.filter((e): e is FirestoreTimerEvent => e.type === 'BREAK');
  const doubleTaps = typed.filter((e): e is FirestoreTimerEvent => e.type === 'DOUBLE_TAP');

  // Aggregate counts and sums
  const studiesCompleted = studies.length;
  const totalRVU = studies.reduce((sum, s) => sum + (s.rvu || 0), 0);
  const cumulativeParTime = studies.reduce((sum, s) => sum + (s.parTime || 0), 0);
  const swapEvents = studies.filter(s => s.swapped === true).length;

  const interstitialTime = interstitials.reduce((sum, e) => sum + (e.duration || 0), 0);
  const adminTime = admins.reduce((sum, e) => sum + (e.duration || 0), 0);
  const adminEventCount = admins.length;
  const commsTime = commsEvents.reduce((sum, e) => sum + (e.duration || 0), 0);
  const commsEventCount = commsEvents.length;
  const breakTime = breaks.reduce((sum, e) => sum + (e.duration || 0), 0);
  const breakEventCount = breaks.length;
  const doubleTapTime = doubleTaps.reduce((sum, e) => sum + (e.duration || 0), 0);
  const doubleTapEventCount = doubleTaps.length;

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
      // Check startTimeSession + elapsedTime (study events)
      if (evt.type === 'STUDY') {
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
    studiesCompleted,
    deletedStudies: 0, // Deleted studies are removed from events array, unrecoverable
    cumulativeParTime,
    interstitialTime,
    adminTime,
    adminEvents: adminEventCount,
    commsTime,
    commsEvents: commsEventCount,
    breakTime,
    breakEvents: breakEventCount,
    doubleTapTime,
    doubleTapEvents: doubleTapEventCount,
    swapEvents,
    totalRVU,
    notes: { tags: ['No Comment'], description: '(recovered session)' },
    summary,
  };
}
