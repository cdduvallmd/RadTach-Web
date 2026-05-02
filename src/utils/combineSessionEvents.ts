/**
 * Combines events from multiple sessions into a single unified timeline.
 * Used by DailyReportTab to treat multiple sessions as one continuous workday.
 */
import type { SessionEvent, SessionData, StudyEvent, InterstitialEvent, TimerEvent } from '../components/reports/SessionReportSections';
import type { StoredSession } from '../types/reports';

export interface CombinedResult {
  events: SessionEvent[];
  sessionData: SessionData;
}

/**
 * Combines events from multiple sessions, offsetting times so they form a continuous timeline.
 * Sessions are ordered chronologically. Gaps between sessions are ignored (time is continuous).
 */
export function combineSessionEvents(
  sessions: StoredSession[],
  eventsPerSession: SessionEvent[][]
): CombinedResult {
  const sorted = sessions
    .map((s, i) => ({ session: s, events: eventsPerSession[i] }))
    .sort((a, b) => a.session.startDateTime.localeCompare(b.session.startDateTime));

  const combinedEvents: SessionEvent[] = [];
  let timeOffset = 0;
  let studyNumberOffset = 0;

  for (const { session, events } of sorted) {
    for (const evt of events) {
      if (evt.type === 'STUDY') {
        const study: StudyEvent = {
          ...evt,
          studyNumber: evt.studyNumber + studyNumberOffset,
          startTimeSession: evt.startTimeSession + timeOffset,
        };
        combinedEvents.push(study);
      } else if (evt.type === 'INTERSTITIAL') {
        const inter: InterstitialEvent = {
          ...evt,
          startTimeSession: evt.startTimeSession + timeOffset,
          endTimeSession: evt.endTimeSession + timeOffset,
        };
        combinedEvents.push(inter);
      } else {
        const timer: TimerEvent = {
          ...evt,
          startTimeSession: evt.startTimeSession + timeOffset,
          endTimeSession: evt.endTimeSession + timeOffset,
        };
        combinedEvents.push(timer);
      }
    }

    timeOffset += session.totalSessionTime;
    const sessionStudies = events.filter(e => e.type === 'STUDY');
    studyNumberOffset += sessionStudies.length;
  }

  // Build synthetic SessionData from combined sessions
  const first = sorted[0].session;
  const last = sorted[sorted.length - 1].session;
  const systems = [...new Set(sorted.map(s => s.session.system))];
  const rotations = [...new Set(sorted.map(s => s.session.rotation))];
  const workstations = [...new Set(sorted.map(s => s.session.workstationId))];

  const sessionData: SessionData = {
    sessionId: `combined-${first.sessionId}`,
    userAbbrev: first.userAbbrev,
    workstationId: workstations.length === 1 ? workstations[0] : workstations.join(', '),
    system: systems.length === 1 ? systems[0] : systems.join(', '),
    rotation: rotations.length === 1 ? rotations[0] : rotations.join(', '),
    halfDay: sorted.every(s => s.session.halfDay),
    startDateTime: first.startDateTime,
    stopDateTime: last.stopDateTime,
    totalSessionTime: sorted.reduce((sum, s) => sum + s.session.totalSessionTime, 0),
    studiesCompleted: sorted.reduce((sum, s) => sum + s.session.studiesCompleted, 0),
    deletedStudies: sorted.reduce((sum, s) => sum + s.session.deletedStudies, 0),
    cumulativeParTime: sorted.reduce((sum, s) => sum + s.session.cumulativeParTime, 0),
    interstitialTime: sorted.reduce((sum, s) => sum + s.session.interstitialTime, 0),
    adminTime: sorted.reduce((sum, s) => sum + s.session.adminTime, 0),
    adminEvents: sorted.reduce((sum, s) => sum + s.session.adminEvents, 0),
    commsTime: sorted.reduce((sum, s) => sum + s.session.commsTime, 0),
    commsEvents: sorted.reduce((sum, s) => sum + s.session.commsEvents, 0),
    breakTime: sorted.reduce((sum, s) => sum + s.session.breakTime, 0),
    breakEvents: sorted.reduce((sum, s) => sum + s.session.breakEvents, 0),
    doubleTapTime: sorted.reduce((sum, s) => sum + s.session.doubleTapTime, 0),
    doubleTapEvents: sorted.reduce((sum, s) => sum + s.session.doubleTapEvents, 0),
    swapEvents: sorted.reduce((sum, s) => sum + (s.session.swapEvents ?? 0), 0),
    totalRVU: sorted.reduce((sum, s) => sum + s.session.totalRVU, 0),
    verifiedRVU: sorted.some(s => s.session.verifiedRVU != null)
      ? sorted.reduce((sum, s) => sum + (s.session.verifiedRVU ?? 0), 0)
      : null,
    notes: (() => {
      const allTags = sorted.flatMap(s => s.session.notes?.tags ?? []);
      const allDescs = sorted.map(s => s.session.notes?.description).filter(Boolean);
      if (allTags.length === 0 && allDescs.length === 0) return undefined;
      return { tags: [...new Set(allTags)], description: allDescs.join(' | ') };
    })(),
  };

  return { events: combinedEvents, sessionData };
}
