/**
 * useEventSync — one session's persistence (mode-enum plan step 3b).
 *
 * Everything a session writes goes through the offline buffer's queue, in the
 * order it happens: the session document at begin, each event change from
 * useTimerMode, then the session end and settings at finish. The buffer's
 * replay is the only thing that uploads; this hook runs it every 30 s while a
 * session is open and once more at finish, and reports each result.
 *
 * Lifecycle:
 *   open()                     at Start, before useTimerMode starts. Returns a token.
 *   begin(token, session, doc) once the session key is known. Returns false if
 *                              the session was stopped in the meantime.
 *   record(changes)            useTimerMode's change callback.
 *   finish(end, settings)      at Stop. Queues without waiting on the network,
 *                              then uploads; resolves with the upload result.
 */
import { useRef, useCallback, useEffect } from 'react';
import { recordEvent, queueSessionWrite, flushBuffer, type FlushResult } from '../services/offlineBuffer';
import type { EventChange } from './useTimerMode';

interface SyncSession {
  userId: string;
  sessionKey: string;
}

const UPLOAD_INTERVAL_MS = 30000;

export function useEventSync(onUpload: (result: FlushResult | null) => void) {
  const session = useRef<SyncSession | null>(null);
  const generation = useRef(0);
  // Changes reported between open() and begin(), written at begin().
  const held = useRef<EventChange[]>([]);
  // Every queue write is chained, so the queue order matches the change order.
  const writes = useRef<Promise<void>>(Promise.resolve());
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const onUploadRef = useRef(onUpload);
  useEffect(() => { onUploadRef.current = onUpload; }, [onUpload]);

  const chain = (step: () => Promise<void>) => {
    writes.current = writes.current.then(step).catch(err => console.error('Event sync: write failed', err));
  };

  const queueChanges = (s: SyncSession, changes: EventChange[]) => {
    for (const { index, event } of changes) {
      chain(() => recordEvent(s.userId, s.sessionKey, index, event as Record<string, any>));
    }
  };

  // Wait for queued writes to land, then replay the queue.
  const upload = (userId: string): Promise<FlushResult | null> =>
    writes.current
      .then(() => flushBuffer(userId))
      .catch(err => { console.error('Event sync: upload failed', err); return null; })
      .then(result => { onUploadRef.current(result); return result; });

  const stopTimer = () => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
  };

  useEffect(() => stopTimer, []);

  const open = useCallback((): number => {
    stopTimer();
    session.current = null;
    held.current = [];
    return ++generation.current;
  }, []);

  const begin = useCallback((token: number, s: SyncSession, sessionDoc: Record<string, any>): boolean => {
    // Stopped (or restarted) while the session was starting up. (Clyde 2026-10-01b #3)
    if (token !== generation.current) return false;
    session.current = s;
    chain(() => queueSessionWrite('createSession', s.userId, s.sessionKey, sessionDoc));
    queueChanges(s, held.current);
    held.current = [];
    upload(s.userId);
    timer.current = setInterval(() => upload(s.userId), UPLOAD_INTERVAL_MS);
    return true;
  }, []);

  const record = useCallback((changes: EventChange[]) => {
    if (session.current) queueChanges(session.current, changes);
    else held.current.push(...changes);
  }, []);

  const finish = useCallback((sessionEnd: Record<string, any>, settings: Record<string, any>): Promise<FlushResult | null> => {
    generation.current++;
    stopTimer();
    held.current = [];
    const s = session.current;
    session.current = null;
    if (!s) return Promise.resolve(null);
    chain(() => queueSessionWrite('endSession', s.userId, s.sessionKey, sessionEnd));
    chain(() => queueSessionWrite('saveUserSettings', s.userId, s.sessionKey, settings));
    return upload(s.userId);
  }, []);

  return { open, begin, record, finish };
}
