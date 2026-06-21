// Coaching brief assembler. Pulls a user's sessions from the trailing window,
// strips event-level detail (keeping per-session summaries), aggregates by
// calendar day in the user's timezone, and adds per-CPT variance breakdowns
// for the modalities with the largest drift.
//
// Ported from scripts/coachingBrief.ts (the data pull) plus /tmp/analyze2.ts
// (the calendar-day aggregation). _autoFinalized sessions are excluded by
// default per Clyde HIGH #3.

import { getFirestore } from 'firebase-admin/firestore';
import type { StoredSession } from './types';
import { DEFAULT_TZ } from './timezone';
import { aggregateByDay, cptVarianceByModality } from './sessionAggregation';

export interface CoachingBrief {
  targetUid: string;
  daysWindow: number;
  periodStart: string;  // ISO
  periodEnd: string;    // ISO date 'yyyy-MM-dd'
  timezone: string;
  sessionCount: number;
  autoFinalizedCount: number;
  perDay: ReturnType<typeof aggregateByDay> extends Map<string, infer V> ? V[] : never;
  cptVariance: {
    CT: ReturnType<typeof cptVarianceByModality>;
    XR: ReturnType<typeof cptVarianceByModality>;
    MR: ReturnType<typeof cptVarianceByModality>;
    US: ReturnType<typeof cptVarianceByModality>;
  };
  // Lightly slimmed per-session payload for the prompt.
  sessions: Array<Pick<StoredSession,
    | 'sessionId'
    | 'startDateTime'
    | 'stopDateTime'
    | 'system'
    | 'rotation'
    | 'halfDay'
    | 'totalSessionTime'
    | 'studiesCompleted'
    | 'totalRVU'
    | 'pvcShiftCredit'
    | 'pvcBonusRvu'
    | 'pvcRotationAtStart'
    | 'pvcWrvuOverride'
    | 'pvcMeetingHours'
    | 'breakTime'
    | 'adminTime'
    | 'commsTime'
    | 'interstitialTime'
    | 'notes'
    | 'summary'
    | '_autoFinalized'
  >>;
  pvcConfigSnapshot?: Record<string, unknown>;
}

export async function assembleBrief(
  targetUid: string,
  daysWindow: number,
): Promise<CoachingBrief> {
  const db = getFirestore();

  // Look up user's timezone, fall back to America/Chicago.
  const userDoc = await db.doc(`users/${targetUid}`).get();
  const userData = userDoc.exists ? userDoc.data() ?? {} : {};
  const tz: string = userData.timezone ?? DEFAULT_TZ;
  const userSystem: string | undefined = userData.system;

  const now = Date.now();
  const sinceIso = new Date(now - daysWindow * 86400 * 1000).toISOString();
  const periodEnd = new Date(now).toISOString().slice(0, 10);

  // Fetch sessions ordered by startTime ascending.
  const snap = await db.collection(`users/${targetUid}/sessions`)
    .where('startTime', '>=', new Date(sinceIso))
    .orderBy('startTime', 'asc')
    .get();

  const sessions: StoredSession[] = snap.docs
    .map(d => d.data() as StoredSession);

  const sessionsSlim = sessions.map(s => ({
    sessionId: s.sessionId,
    startDateTime: s.startDateTime,
    stopDateTime: s.stopDateTime,
    system: s.system,
    rotation: s.rotation,
    halfDay: s.halfDay,
    totalSessionTime: s.totalSessionTime,
    studiesCompleted: s.studiesCompleted,
    totalRVU: s.totalRVU,
    pvcShiftCredit: s.pvcShiftCredit,
    pvcBonusRvu: s.pvcBonusRvu,
    pvcRotationAtStart: s.pvcRotationAtStart,
    pvcWrvuOverride: s.pvcWrvuOverride,
    pvcMeetingHours: s.pvcMeetingHours,
    breakTime: s.breakTime,
    adminTime: s.adminTime,
    commsTime: s.commsTime,
    interstitialTime: s.interstitialTime,
    notes: s.notes,
    summary: s.summary,
    _autoFinalized: s._autoFinalized,
  }));

  const byDay = aggregateByDay(sessions, tz, /* includeAutoFinalized */ false);
  const perDay = Array.from(byDay.values()).sort((a, b) => a.day.localeCompare(b.day));

  // Pull PVC config for the user's system (informs feature-availability windows).
  let pvcConfigSnapshot: Record<string, unknown> | undefined;
  if (userSystem) {
    try {
      const sysDoc = await db.doc(`systems/${userSystem}`).get();
      const sysData = sysDoc.exists ? sysDoc.data() ?? {} : {};
      pvcConfigSnapshot = sysData.pvc;
    } catch (err) {
      console.warn('PVC config snapshot read failed:', err);
    }
  }

  const autoFinalizedCount = sessions.reduce((n, s) => n + (s._autoFinalized ? 1 : 0), 0);

  return {
    targetUid,
    daysWindow,
    periodStart: sinceIso,
    periodEnd,
    timezone: tz,
    sessionCount: sessions.length,
    autoFinalizedCount,
    perDay,
    cptVariance: {
      CT: cptVarianceByModality(sessions, 'CT').slice(0, 8),
      XR: cptVarianceByModality(sessions, 'XR').slice(0, 8),
      MR: cptVarianceByModality(sessions, 'MR').slice(0, 5),
      US: cptVarianceByModality(sessions, 'US').slice(0, 5),
    },
    sessions: sessionsSlim,
    pvcConfigSnapshot,
  };
}
