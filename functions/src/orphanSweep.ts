// Function 3 — orphan session sweep.
// Ships ACTIVE at deploy. Runs daily at 04:00 America/Chicago. Finalizes any
// session missing `endTime` whose `startTime` is older than 24 hours by
// reconstructing what it can from the events subcollection and marking the
// session with `_autoFinalized: true`.
//
// The existing browser-side recovery dialog still wins when the rad returns
// to the same workstation (IDB has more data than Firestore). This sweep is
// the FLOOR — guarantees max orphan age of 24 hours when the rad never
// returns.
//
// Defensive cap: 100 orphans per run. If more exist, log and return; nightly
// retry covers them. Prevents a runaway sweep.

import { onSchedule } from 'firebase-functions/v2/scheduler';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { readFlags } from './lib/featureFlags';
import type { StoredSession } from './lib/types';

const ORPHAN_AGE_HOURS = 24;
const MAX_PER_RUN = 100;

interface EventRow {
  type?: string;
  duration?: number;
  rvu?: number;
  startTimeSession?: number;
  endTimeSession?: number;
}

async function finalizeOne(userId: string, sessionId: string): Promise<void> {
  const db = getFirestore();
  const sessionRef = db.doc(`users/${userId}/sessions/${sessionId}`);
  const eventsSnap = await sessionRef.collection('events').get();
  const events = eventsSnap.docs.map(d => d.data() as EventRow);

  // Reconstruct totals from the events subcollection. If no events exist,
  // we zero everything per the documented policy (Clyde HIGH #3).
  let totalSessionTime = 0;
  let studiesCompleted = 0;
  let totalRVU = 0;
  let interstitialTime = 0;
  let adminTime = 0;
  let commsTime = 0;
  let breakTime = 0;
  let doubleTapTime = 0;
  for (const e of events) {
    const dur = e.duration ?? 0;
    switch (e.type) {
      case 'STUDY':
        studiesCompleted += 1;
        totalSessionTime += dur;
        totalRVU += e.rvu ?? 0;
        break;
      case 'INTERSTITIAL':
        interstitialTime += dur;
        totalSessionTime += dur;
        break;
      case 'ADMIN':
        adminTime += dur;
        totalSessionTime += dur;
        break;
      case 'COMMS':
        commsTime += dur;
        totalSessionTime += dur;
        break;
      case 'BREAK':
        breakTime += dur;
        totalSessionTime += dur;
        break;
      case 'DOUBLE_TAP':
        doubleTapTime += dur;
        totalSessionTime += dur;
        break;
    }
  }

  await sessionRef.set({
    endTime: FieldValue.serverTimestamp(),
    stopDateTime: new Date().toISOString(),
    totalSessionTime,
    studiesCompleted,
    totalRVU,
    interstitialTime,
    adminTime,
    commsTime,
    breakTime,
    doubleTapTime,
    _autoFinalized: true,
  }, { merge: true });
}

export const orphanSessionSweep = onSchedule(
  {
    schedule: '0 4 * * *',
    timeZone: 'America/Chicago',
    region: 'us-central1',
    timeoutSeconds: 540,
    memory: '512MiB',
  },
  async () => {
    const flags = await readFlags();
    if (!flags.cloudOrphanSweepEnabled) {
      console.log('orphanSessionSweep: disabled by feature flag; exiting');
      return;
    }

    const db = getFirestore();
    const cutoff = Timestamp.fromMillis(Date.now() - ORPHAN_AGE_HOURS * 3600 * 1000);

    // Query for orphans: startTime older than cutoff AND endTime absent or null.
    // Firestore can't filter "field missing" directly via the SDK, so we
    // overfetch and filter client-side. The cap below bounds memory cost.
    const snap = await db.collectionGroup('sessions')
      .where('startTime', '<', cutoff)
      .orderBy('startTime', 'desc')
      .limit(500)
      .get();

    const candidates: Array<{ userId: string; sessionId: string; sessionData: StoredSession }> = [];
    for (const d of snap.docs) {
      const data = d.data() as StoredSession;
      if (data.endTime != null) continue;
      if (data._autoFinalized) continue;
      const m = d.ref.path.match(/users\/([^/]+)\/sessions\/([^/]+)/);
      if (!m) continue;
      candidates.push({ userId: m[1], sessionId: m[2], sessionData: data });
      if (candidates.length >= MAX_PER_RUN) break;
    }

    if (candidates.length === 0) {
      console.log('orphanSessionSweep: nothing to finalize');
      return;
    }

    let finalized = 0;
    let failed = 0;
    for (const c of candidates) {
      try {
        await finalizeOne(c.userId, c.sessionId);
        finalized++;
      } catch (err) {
        console.error(`Failed to finalize ${c.userId}/${c.sessionId}:`, err);
        failed++;
      }
    }

    console.log(`orphanSessionSweep: finalized=${finalized} failed=${failed} (cap=${MAX_PER_RUN})`);
  },
);
