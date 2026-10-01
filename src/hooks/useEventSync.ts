/**
 * useEventSync — keeps mode-enum's events crash-safe and uploaded
 * (mode-enum plan step 3b).
 *
 * record() is useTimerMode's change callback. Every added or edited event is
 * written, in order, to the local crash log and the upload queue in one IDB
 * transaction (recordEvent). flush() runs the offline buffer's replay — the
 * only writer of events to Firestore — which merges the queue by index so the
 * newest version of each event wins. Edits (SWAP, Undo) are just more changes.
 *
 * The session's identity is fixed by begin() once its key is known; changes
 * reported before then are held and written at begin(). end() closes it and
 * resolves when all of its events are queued.
 */
import { useRef, useCallback } from 'react';
import { recordEvent, flushBuffer, type FlushResult } from '../services/offlineBuffer';
import type { ShadowEventChange } from './useTimerMode';

interface SyncSession {
  userId: string;
  sessionKey: string;
}

export function useEventSync() {
  const session = useRef<SyncSession | null>(null);
  const early = useRef<ShadowEventChange[]>([]);
  // Writes are chained so the queue order matches the change order.
  const writes = useRef<Promise<void>>(Promise.resolve());

  const write = (s: SyncSession, changes: ShadowEventChange[]) => {
    for (const { index, event } of changes) {
      writes.current = writes.current
        .then(() => recordEvent(s.userId, s.sessionKey, index, event as Record<string, any>))
        .catch(() => {});
    }
  };

  const record = useCallback((changes: ShadowEventChange[]) => {
    if (session.current) write(session.current, changes);
    else early.current.push(...changes);
  }, []);

  const begin = useCallback((s: SyncSession) => {
    session.current = s;
    const held = early.current;
    early.current = [];
    write(s, held);
  }, []);

  // Close the session. Resolves once all of its events are in the queue —
  // no upload involved, so it doesn't wait on the network.
  const end = useCallback((): Promise<void> => {
    session.current = null;
    early.current = [];
    return writes.current;
  }, []);

  // Upload: wait for queued writes to land, then run the replay.
  const flush = useCallback((): Promise<FlushResult | null> => {
    const s = session.current;
    if (!s) return writes.current.then(() => null);
    return writes.current.then(() => flushBuffer(s.userId));
  }, []);

  return { record, begin, end, flush };
}
