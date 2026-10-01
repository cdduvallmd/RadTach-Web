import { firestoreService } from './firestore';
import { auth } from './firebase';

// Offline buffer: every Firestore write RadTach makes for a session goes into
// an IndexedDB queue first, and the replay (flushBuffer) is the only thing that
// sends it. A crash or a network outage leaves the queue intact; the next
// replay picks up where the last one stopped. Alongside the queue, a crash log
// (localEvents) keeps the session's events so an unfinished session can be
// rebuilt after a crash.

// ── Types ────────────────────────────────────────────────────────────────────

export interface PendingWrite {
  id?: number;
  operation: 'createSession' | 'flushEvents' | 'endSession' | 'saveUserSettings';
  userId: string;
  sessionKey: string;
  payload: Record<string, any>;
  startIndex?: number;
  createdAt: number;
}

export interface FlushResult {
  flushed: number;
  remaining: number;
  canRead: boolean;
}

export interface LocalEvent {
  id?: number;
  sessionKey: string;
  event: Record<string, any>;
  // Position in mode-enum's event list (= Firestore evt-NNNN). Present on
  // entries written by recordEvent; absent on pre-3b entries.
  index?: number;
  createdAt: number;
}

// One event at its position in the session's event list.
export interface IndexedEvent {
  index: number;
  event: Record<string, any>;
}

// Latest version wins: entries in write order, later ones replace earlier
// ones at the same index. Used by replay and by crash recovery.
export function mergeByIndex(entries: IndexedEvent[]): IndexedEvent[] {
  const latest = new Map<number, Record<string, any>>();
  for (const { index, event } of entries) latest.set(index, event);
  return [...latest.entries()].sort((a, b) => a[0] - b[0]).map(([index, event]) => ({ index, event }));
}

// ── Constants ────────────────────────────────────────────────────────────────

const DB_NAME = 'radtach-offline';
const DB_VERSION = 2;
const STORE_NAME = 'pendingWrites';
const LOCAL_EVENTS_STORE = 'localEvents';
const TTL_MS = 60 * 24 * 60 * 60 * 1000; // 60 days

// ── IDB Lifecycle ────────────────────────────────────────────────────────────

let dbInstance: IDBDatabase | null = null;

export async function openBuffer(): Promise<IDBDatabase> {
  if (dbInstance) return dbInstance;

  // Request persistent storage so the browser won't evict IDB under pressure
  navigator.storage?.persist?.();

  // If a newer version is opened in another tab, close this connection so the
  // upgrade isn't blocked; the next call reopens. (Clyde 2026-10-01b L4)
  const keep = (db: IDBDatabase) => {
    db.onversionchange = () => { db.close(); dbInstance = null; };
    dbInstance = db;
    return db;
  };

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains(LOCAL_EVENTS_STORE)) {
        const store = db.createObjectStore(LOCAL_EVENTS_STORE, { keyPath: 'id', autoIncrement: true });
        store.createIndex('sessionKey', 'sessionKey', { unique: false });
      }
    };
    request.onblocked = () => console.warn('Offline buffer upgrade blocked by another open RadTach tab');
    request.onsuccess = () => resolve(keep(request.result));
    request.onerror = () => {
      // The stored database is newer than this code expects — e.g. a deploy
      // that raised DB_VERSION was reverted. Open at whatever version exists
      // instead of failing, so buffering keeps working (the stores this code
      // uses are never removed by later versions). Clyde 2026-09-29 #16.
      if (request.error?.name === 'VersionError') {
        const fallback = indexedDB.open(DB_NAME);
        fallback.onsuccess = () => resolve(keep(fallback.result));
        fallback.onerror = () => reject(fallback.error);
        return;
      }
      reject(request.error);
    };
  });
}

// ── Queue ────────────────────────────────────────────────────────────────────

// A write transaction can fail at commit (Chrome reports a full disk this way)
// with `abort` and no `error`. Reject on both, or the promise never settles and
// the fallback never runs. (Clyde 2026-10-01c #2)
function rejectOnFailure(tx: IDBTransaction, reject: (err: unknown) => void) {
  tx.onerror = () => reject(tx.error);
  tx.onabort = () => reject(tx.error ?? new Error('IDB transaction aborted'));
}

export async function addPendingWrite(write: Omit<PendingWrite, 'id'>): Promise<void> {
  const db = await openBuffer();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).add(write);
    tx.oncomplete = () => resolve();
    rejectOnFailure(tx, reject);
  });
}

// Queue a session-document or settings write. It is sent only by the replay,
// in order: createSession → events → endSession. If local storage fails, the
// write goes straight to Firestore instead so it isn't lost. (Clyde 2026-10-01b #2)
export async function queueSessionWrite(
  operation: 'createSession' | 'endSession' | 'saveUserSettings',
  userId: string,
  sessionKey: string,
  payload: Record<string, any>,
): Promise<void> {
  const write = { operation, userId, sessionKey, payload, createdAt: Date.now() };
  try {
    await addPendingWrite(write);
  } catch (err) {
    console.error(`Offline buffer: could not queue ${operation}, sending directly`, err);
    sendDirect(() => executeWrite(write));
  }
}

async function getAllPendingWrites(): Promise<PendingWrite[]> {
  const db = await openBuffer();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function deletePendingWrite(id: number): Promise<void> {
  const db = await openBuffer();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => resolve();
    rejectOnFailure(tx, reject);
  });
}

export async function getPendingCount(): Promise<number> {
  const db = await openBuffer();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).count();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// Orphan recovery skips a session whose endSession is still queued.
export async function hasPendingEndSession(sessionKey: string): Promise<boolean> {
  const all = await getAllPendingWrites();
  return all.some(w => w.operation === 'endSession' && w.sessionKey === sessionKey);
}

// ── Crash log ────────────────────────────────────────────────────────────────

// Mode-enum event added or edited: in ONE transaction, append it to the crash
// log and queue it for upload, both tagged with its index. The queued entry
// uses the existing flushEvents shape (one event at startIndex = index), so
// any build can replay it, and replay in queue order applies the newest
// version last. Because both copies are written together, the queue always
// holds an upload copy of everything in the crash log — clearing the crash
// log never loses an event that hasn't reached Firestore. If local storage
// fails, the event goes straight to Firestore instead. (Clyde 2026-10-01b #2)
export async function recordEvent(
  userId: string,
  sessionKey: string,
  index: number,
  event: Record<string, any>,
): Promise<void> {
  try {
    await logAndQueueEvent(userId, sessionKey, index, event);
  } catch (err) {
    console.error('Offline buffer: could not log event, sending directly', err);
    sendDirect(() => firestoreService.writeEventsByIndex(userId, sessionKey, [{ index, event: stripUndefined(event) }]));
  }
}

// Fallback when local storage fails: start the Firestore write without waiting
// on it. Offline it would wait for the network and hold up the session's later
// writes, which local storage may still accept. The SDK sends writes in the
// order they were issued. Accepted edge: if storage fails between two versions
// of one event, the older (queued) version can replay over the newer (direct)
// one. Needs storage to start failing mid-session. (Clyde 2026-10-01c #3)
function sendDirect(write: () => Promise<unknown>): void {
  write().catch(err => console.error('Offline buffer: direct write failed', err));
}

async function logAndQueueEvent(
  userId: string,
  sessionKey: string,
  index: number,
  event: Record<string, any>,
): Promise<void> {
  const db = await openBuffer();
  const createdAt = Date.now();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([LOCAL_EVENTS_STORE, STORE_NAME], 'readwrite');
    tx.objectStore(LOCAL_EVENTS_STORE).add({ sessionKey, index, event, createdAt });
    tx.objectStore(STORE_NAME).add({
      operation: 'flushEvents', userId, sessionKey, payload: { events: [event] }, startIndex: index, createdAt,
    });
    tx.oncomplete = () => resolve();
    rejectOnFailure(tx, reject);
  });
}

// This session's crash log entries that carry an index, in write order.
export async function getLocalEventLog(sessionKey: string): Promise<IndexedEvent[]> {
  const rows = await getLocalRows(sessionKey);
  return rows.filter(r => r.index != null).map(r => ({ index: r.index as number, event: r.event }));
}

// Crash log entries without an index, from sessions recorded before step 3b
// (2026-10-01). Recovery fallback only — remove after 2026-12-31, once no
// pre-3b session can still be unrecovered.
export async function getLocalEvents(sessionKey: string): Promise<Record<string, any>[]> {
  const rows = await getLocalRows(sessionKey);
  return rows.filter(r => r.index == null).map(r => r.event);
}

async function getLocalRows(sessionKey: string): Promise<LocalEvent[]> {
  const db = await openBuffer();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(LOCAL_EVENTS_STORE, 'readonly');
    const request = tx.objectStore(LOCAL_EVENTS_STORE).index('sessionKey').getAll(sessionKey);
    request.onsuccess = () => resolve(request.result as LocalEvent[]);
    request.onerror = () => reject(request.error);
  });
}

export async function clearLocalEvents(sessionKey: string): Promise<void> {
  const db = await openBuffer();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(LOCAL_EVENTS_STORE, 'readwrite');
    const request = tx.objectStore(LOCAL_EVENTS_STORE).index('sessionKey').openCursor(sessionKey);
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
    tx.oncomplete = () => resolve();
    rejectOnFailure(tx, reject);
  });
}

// ── Replay ───────────────────────────────────────────────────────────────────

// Firestore rejects `undefined` field values; one such field would block the
// whole session's replay. Drop them before writing; array elements become null
// so positions are kept. (Clyde 2026-10-01b #4, 2026-10-01c L5)
function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) return value.map(v => (v === undefined ? null : stripUndefined(v))) as T;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = stripUndefined(v);
    return out as T;
  }
  return value;
}

async function executeWrite(write: PendingWrite): Promise<void> {
  const payload = stripUndefined(write.payload);
  switch (write.operation) {
    case 'createSession':
      await firestoreService.createSession(write.userId, write.sessionKey, payload);
      break;
    case 'endSession':
      await firestoreService.endSession(write.userId, write.sessionKey, payload);
      break;
    case 'saveUserSettings':
      await firestoreService.saveUserSettings(write.userId, payload);
      break;
  }
}

// Replay coalescing (Clyde 2026-10-01b #1): a flush requested while one is
// running is never dropped — the running flush runs once more before it
// finishes, and every caller gets that final result. That holds when a round
// throws, too (Clyde 2026-10-01c L1). Across tabs, the Web Lock makes replays
// wait their turn rather than skip.
let running: Promise<FlushResult> | null = null;
let again = false;

export function flushBuffer(): Promise<FlushResult> {
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    // Clear `running` in the same step as the final `again` check, inside the
    // function: a request arriving after that check must start a new flush,
    // not join one that has already finished.
    try {
      let result: FlushResult;
      do {
        again = false;
        try {
          result = await withTabLock(() => doFlush());
        } catch (err) {
          if (!again) throw err;
        }
      } while (again);
      return result!;
    } finally {
      running = null;
    }
  })();
  return running;
}

// All current browsers support Web Locks; without it replays are still
// serialised within a tab, just not across tabs. (Clyde 2026-10-01b L3)
async function withTabLock(fn: () => Promise<FlushResult>): Promise<FlushResult> {
  if (typeof navigator !== 'undefined' && 'locks' in navigator) {
    return await navigator.locks.request('radtach-flush', fn);
  }
  return fn();
}

// createSession / endSession: write, mark late-arriving dates stale for group
// stats, then dequeue (kept if the marker write fails). After endSession the
// session's crash log is no longer needed. (Clyde 2026-10-01b L1)
async function runSessionWrite(w: PendingWrite, stamp: Record<string, string> | null): Promise<void> {
  if (stamp) Object.assign(w.payload, stamp);
  await executeWrite(w);
  if (w.payload.startDateTime && w.payload.system) {
    const sessionDate = String(w.payload.startDateTime).slice(0, 10);
    const todayDate = new Date().toISOString().slice(0, 10);
    if (sessionDate < todayDate) {
      await firestoreService.writeStaleMarker(w.payload.system, sessionDate, w.userId);
    }
  }
  if (w.id != null) await deletePendingWrite(w.id);
  if (w.operation === 'endSession') await clearLocalEvents(w.sessionKey).catch(() => {});
}

async function serverSettingsNewer(w: PendingWrite): Promise<boolean> {
  const updatedAt = (await firestoreService.getUserSettings(w.userId))?.updatedAt;
  const newer = typeof updatedAt?.toMillis === 'function' && updatedAt.toMillis() > w.createdAt;
  if (newer) console.warn('Offline buffer: settings changed since this snapshot was queued; not sending it');
  return newer;
}

function isNetworkError(err: any): boolean {
  const code = err?.code || '';
  return code === 'unavailable' || code === 'resource-exhausted';
}

async function doFlush(): Promise<FlushResult> {
  const all = await getAllPendingWrites();
  if (all.length === 0) return { flushed: 0, remaining: 0, canRead: true };

  const now = Date.now();
  let flushed = 0;
  let canRead = true;

  // TTL cleanup: remove entries older than 60 days
  for (const w of all) {
    if (now - w.createdAt > TTL_MS && w.id != null) await deletePendingWrite(w.id);
  }
  const live = all.filter(w => now - w.createdAt <= TTL_MS);
  const byId = (a: PendingWrite, b: PendingWrite) => (a.id ?? 0) - (b.id ?? 0);

  // Settings writes are independent of sessions. Each is a full snapshot of
  // the settings doc, so only a user's newest queued one is sent, and only if
  // the server copy hasn't changed since it was taken — a snapshot queued
  // offline must not replay days later over newer settings saved elsewhere.
  // Older snapshots are dropped. (Clyde 2026-10-01c L4)
  const settingsWrites = live.filter(x => x.operation === 'saveUserSettings').sort(byId);
  const newestSettings = new Map(settingsWrites.map(w => [w.userId, w]));
  for (const w of settingsWrites) {
    try {
      if (newestSettings.get(w.userId) === w && !(await serverSettingsNewer(w))) await executeWrite(w);
      if (w.id != null) await deletePendingWrite(w.id);
      flushed++;
    } catch (err) {
      if (isNetworkError(err)) canRead = false;
      else console.error('Offline buffer: settings write failed', err);
    }
  }

  const bySession = new Map<string, PendingWrite[]>();
  for (const w of live) {
    if (w.operation === 'saveUserSettings') continue;
    bySession.set(w.sessionKey, [...(bySession.get(w.sessionKey) ?? []), w]);
  }

  // Each session chain runs in order: createSession → events → endSession.
  // Queued events are merged by index in queue order (newest version wins),
  // then sent as one write. A failure skips to the next session.
  for (const [sessionKey, chain] of bySession) {
    const creates = chain.filter(w => w.operation === 'createSession').sort(byId);
    const eventWrites = chain.filter(w => w.operation === 'flushEvents').sort(byId);
    const ends = chain.filter(w => w.operation === 'endSession').sort(byId);
    // Audit trail: writes flushed by a different signed-in user are stamped.
    // Read the user now, not when the flush was requested: a rerun can start
    // after a sign-out and sign-in as someone else. The data itself always
    // goes to the user who recorded it. (Clyde 2026-10-01c L2)
    const authUid = auth.currentUser?.uid;
    const stamp = authUid && chain[0].userId !== authUid
      ? { _flushedBy: authUid, _flushedAt: new Date().toISOString() }
      : null;

    try {
      for (const w of creates) { await runSessionWrite(w, stamp); flushed++; }
      if (eventWrites.length > 0) {
        const queued = eventWrites.flatMap(w =>
          (w.payload.events as Record<string, any>[]).map((event, i) => ({ index: (w.startIndex ?? 0) + i, event })));
        const items = mergeByIndex(queued).map(it =>
          ({ index: it.index, event: stripUndefined(stamp ? { ...it.event, ...stamp } : it.event) }));
        await firestoreService.writeEventsByIndex(chain[0].userId, sessionKey, items);
        for (const w of eventWrites) if (w.id != null) await deletePendingWrite(w.id);
        flushed += eventWrites.length;
      }
      for (const w of ends) { await runSessionWrite(w, stamp); flushed++; }
    } catch (err) {
      if (isNetworkError(err)) canRead = false;
      // Anything else (rules rejection, bad data) would repeat on every
      // replay — make it visible. (Clyde 2026-10-01b #4)
      else console.error(`Offline buffer: replay failed for session ${sessionKey}`, err);
    }
  }

  const remaining = await getPendingCount();
  return { flushed, remaining, canRead };
}
