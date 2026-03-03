/**
 * refreshDates.ts — Shift synthetic session dates to keep them current
 *
 * Reads all sessions from the Firestore emulator, finds the most recent one,
 * calculates how many days to shift so the most recent session = yesterday,
 * and updates all date fields in place (session metadata + every event).
 *
 * Usage:
 *   npm run seed:refresh
 *   # or directly:
 *   npx tsx scripts/refreshDates.ts
 *
 * Prerequisites:
 *   - Firestore emulator running on localhost:8080 with seeded data
 */

import { initializeApp } from 'firebase/app';
import {
  getFirestore, connectFirestoreEmulator,
  collection, collectionGroup, doc,
  getDocs, updateDoc, writeBatch,
  Timestamp,
} from 'firebase/firestore';

// ── Firebase init (emulator only) ──────────────────────────────────────────

const app = initializeApp({
  apiKey: 'fake-api-key',
  authDomain: 'localhost',
  projectId: 'demo-radtach',
});

const db = getFirestore(app);
connectFirestoreEmulator(db, '127.0.0.1', 8080);

// ── Helpers ────────────────────────────────────────────────────────────────

function shiftISO(iso: string, offsetMs: number): string {
  return new Date(new Date(iso).getTime() + offsetMs).toISOString();
}

function shiftTimestamp(ts: Timestamp, offsetMs: number): Timestamp {
  return Timestamp.fromDate(new Date(ts.toDate().getTime() + offsetMs));
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('RadTach Date Refresh — scanning emulator sessions...\n');

  // Step 1: Find all users
  const usersSnap = await getDocs(collection(db, 'users'));
  const userIds = usersSnap.docs.map(d => d.id);
  console.log(`Found ${userIds.length} users`);

  if (userIds.length === 0) {
    console.log('No users found. Run npm run seed first.');
    process.exit(0);
  }

  // Step 2: Find the most recent session across all users
  let latestSessionDate: Date | null = null;
  let totalSessions = 0;

  for (const uid of userIds) {
    const sessionsSnap = await getDocs(collection(db, 'users', uid, 'sessions'));
    for (const sessionDoc of sessionsSnap.docs) {
      totalSessions++;
      const data = sessionDoc.data();
      if (data.startDateTime) {
        const d = new Date(data.startDateTime);
        if (!latestSessionDate || d > latestSessionDate) {
          latestSessionDate = d;
        }
      }
    }
  }

  if (!latestSessionDate) {
    console.log('No sessions with startDateTime found. Nothing to refresh.');
    process.exit(0);
  }

  console.log(`Found ${totalSessions} sessions across ${userIds.length} users`);
  console.log(`Most recent session: ${latestSessionDate.toISOString().slice(0, 10)}`);

  // Step 3: Calculate the offset
  // Target: most recent session date = yesterday (so today is available for new sessions)
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  yesterday.setHours(0, 0, 0, 0);

  const latestDay = new Date(latestSessionDate);
  latestDay.setHours(0, 0, 0, 0);

  const offsetMs = yesterday.getTime() - latestDay.getTime();
  const offsetDays = Math.round(offsetMs / (24 * 60 * 60 * 1000));

  if (offsetDays === 0) {
    console.log('Data is already current (most recent session = yesterday). Nothing to do.');
    process.exit(0);
  }

  if (offsetDays < 0) {
    console.log(`Most recent session is ${-offsetDays} day(s) in the future. Shifting backward.`);
  } else {
    console.log(`Shifting all dates forward by ${offsetDays} day(s)...`);
  }

  // Step 4: Update every session and its events
  let updatedSessions = 0;
  let updatedEvents = 0;

  for (const uid of userIds) {
    const sessionsSnap = await getDocs(collection(db, 'users', uid, 'sessions'));

    for (const sessionDoc of sessionsSnap.docs) {
      const data = sessionDoc.data();
      const sessionRef = doc(db, 'users', uid, 'sessions', sessionDoc.id);

      // Build the session update
      const sessionUpdate: Record<string, unknown> = {};

      if (data.startDateTime) {
        sessionUpdate.startDateTime = shiftISO(data.startDateTime, offsetMs);
      }
      if (data.stopDateTime) {
        sessionUpdate.stopDateTime = shiftISO(data.stopDateTime, offsetMs);
      }
      if (data.startTime && data.startTime instanceof Timestamp) {
        sessionUpdate.startTime = shiftTimestamp(data.startTime, offsetMs);
      }
      if (data.endTime && data.endTime instanceof Timestamp) {
        sessionUpdate.endTime = shiftTimestamp(data.endTime, offsetMs);
      }

      // Update sessionId to reflect new date (YYYYMMDD-##-uid)
      if (data.sessionId && data.startDateTime) {
        const newDate = new Date(sessionUpdate.startDateTime as string);
        const y = newDate.getFullYear();
        const m = String(newDate.getMonth() + 1).padStart(2, '0');
        const d = String(newDate.getDate()).padStart(2, '0');
        const newDateStr = `${y}${m}${d}`;
        // Replace the date prefix, keep the rest (-##-uid...)
        const oldId = data.sessionId as string;
        const suffix = oldId.slice(8); // everything after YYYYMMDD
        sessionUpdate.sessionId = `${newDateStr}${suffix}`;
      }

      await updateDoc(sessionRef, sessionUpdate);
      updatedSessions++;

      // Update events for this session
      const eventsSnap = await getDocs(
        collection(db, 'users', uid, 'sessions', sessionDoc.id, 'events')
      );

      // Batch event updates (max 500 per batch)
      const eventDocs = eventsSnap.docs;
      for (let batchStart = 0; batchStart < eventDocs.length; batchStart += 500) {
        const batch = writeBatch(db);
        const batchDocs = eventDocs.slice(batchStart, batchStart + 500);

        for (const eventDoc of batchDocs) {
          const eData = eventDoc.data();
          const eventUpdate: Record<string, unknown> = {};

          if (eData.startTimeSystem) {
            eventUpdate.startTimeSystem = shiftISO(eData.startTimeSystem, offsetMs);
          }
          if (eData.endTimeSystem) {
            eventUpdate.endTimeSystem = shiftISO(eData.endTimeSystem, offsetMs);
          }

          if (Object.keys(eventUpdate).length > 0) {
            const eventRef = doc(
              db, 'users', uid, 'sessions', sessionDoc.id, 'events', eventDoc.id
            );
            batch.update(eventRef, eventUpdate);
            updatedEvents++;
          }
        }

        await batch.commit();
      }
    }
  }

  console.log(`\nDone! Shifted ${updatedSessions} sessions and ${updatedEvents} events by ${offsetDays} day(s).`);
  console.log(`Most recent session is now: ${yesterday.toISOString().slice(0, 10)}`);
}

main().catch(err => {
  console.error('Refresh failed:', err);
  process.exit(1);
});
