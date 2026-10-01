/**
 * useEventSync — one session's persistence (mode-enum plan step 3b).
 *
 * Everything a session writes goes through the offline buffer's queue, in the
 * order it happens: the session document at begin, each event change from
 * useTimerMode, then the session end and settings at finish. The buffer's
 * replay is the only thing that uploads; this hook runs it every 30 s while a
 * session is open and once more at finish, and reports each result.
 *
 * Offline, a Firestore write doesn't fail — it waits for the network, so an
 * upload can hang until reconnect. A tick that finds the last upload still
 * running reports the queue as stuck instead of joining it, and finish stops
 * waiting after a few seconds. (Clyde 2026-10-01c #1)
 *
 * Lifecycle:
 *   open()                     at Start, before useTimerMode starts. Returns a token.
 *   begin(token, session, doc) once the session key is known. Returns false if
 *                              the session was stopped in the meantime.
 *   record(changes)            useTimerMode's change callback.
 *   finish(end, settings)      at Stop. Queues without waiting on the network,
 *                              then uploads; resolves with the upload result, or
 *                              with the pending count if it takes over 5 s.
 */
import { useState, useEffect } from 'react';
import { recordEvent, queueSessionWrite, flushBuffer, getPendingCount, type FlushResult } from '../services/offlineBuffer';
import type { EventChange } from './useTimerMode';

type Doc = Record<string, unknown>;

interface SyncSession {
  userId: string;
  sessionKey: string;
}

const UPLOAD_INTERVAL_MS = 30000;
const FINISH_WAIT_MS = 5000;

type UploadListener = (result: FlushResult | null) => void;

// The unit itself: plain closure state, created once per App.
function createEventSync() {
  let onUpload: UploadListener = () => {};
  let session: SyncSession | null = null;
  let generation = 0;
  // Changes reported between open() and begin(), written at begin().
  let held: EventChange[] = [];
  // Every queue write is chained, so the queue order matches the change order.
  let writes: Promise<void> = Promise.resolve();
  let timer: ReturnType<typeof setInterval> | null = null;
  // Uploads started and not yet settled.
  let uploading = 0;

  const chain = (step: () => Promise<void>) => {
    writes = writes.then(step).catch(err => console.error('Event sync: write failed', err));
  };

  const queueChanges = (s: SyncSession, changes: EventChange[]) => {
    for (const { index, event } of changes) {
      chain(() => recordEvent(s.userId, s.sessionKey, index, event as unknown as Doc));
    }
  };

  // Wait for queued writes to land, then replay the queue.
  const upload = (): Promise<FlushResult | null> => {
    uploading++;
    return writes
      .then(() => flushBuffer())
      .catch(err => { console.error('Event sync: upload failed', err); return null; })
      .then(result => { uploading--; onUpload(result); return result; });
  };

  // What's still queued, reported as unreachable — used when an upload hangs.
  const stuck = (): Promise<FlushResult | null> =>
    getPendingCount()
      .then(remaining => ({ flushed: 0, remaining, canRead: false }))
      .catch(() => null);

  const tick = () => {
    if (uploading > 0) stuck().then(result => onUpload(result));
    else upload();
  };

  const stopTimer = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };

  return {
    stopTimer,

    setOnUpload(listener: UploadListener): void {
      onUpload = listener;
    },

    open(): number {
      stopTimer();
      session = null;
      held = [];
      return ++generation;
    },

    begin(token: number, s: SyncSession, sessionDoc: Doc): boolean {
      // Stopped (or restarted) while the session was starting up. (Clyde 2026-10-01b #3)
      if (token !== generation) return false;
      session = s;
      chain(() => queueSessionWrite('createSession', s.userId, s.sessionKey, sessionDoc));
      queueChanges(s, held);
      held = [];
      upload();
      timer = setInterval(tick, UPLOAD_INTERVAL_MS);
      return true;
    },

    record(changes: EventChange[]): void {
      if (session) queueChanges(session, changes);
      else held.push(...changes);
    },

    finish(sessionEnd: Doc, settings: Doc): Promise<FlushResult | null> {
      generation++;
      stopTimer();
      held = [];
      const s = session;
      session = null;
      if (!s) return Promise.resolve(null);
      chain(() => queueSessionWrite('endSession', s.userId, s.sessionKey, sessionEnd));
      chain(() => queueSessionWrite('saveUserSettings', s.userId, s.sessionKey, settings));
      return new Promise(resolve => {
        const wait = setTimeout(() => stuck().then(resolve), FINISH_WAIT_MS);
        upload().then(result => { clearTimeout(wait); resolve(result); });
      });
    },
  };
}

// One stable instance for the App's lifetime; its methods never change identity.
export function useEventSync(onUpload: UploadListener) {
  const [sync] = useState(createEventSync);
  useEffect(() => sync.setOnUpload(onUpload), [sync, onUpload]);
  useEffect(() => sync.stopTimer, [sync]);
  return sync;
}
