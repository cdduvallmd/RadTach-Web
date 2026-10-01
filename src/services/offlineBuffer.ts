import { firestoreService } from './firestore';

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
const LOCK_KEY = 'radtach_flush_lock';
const LOCK_TTL = 10000; // 10 seconds

// Firestore writeBatch limit is 500 operations. Max realistic batch for a full
// shift offline is ~320 events. Well within limit, but noted here for awareness.

// ── IDB Lifecycle ────────────────────────────────────────────────────────────

let dbInstance: IDBDatabase | null = null;

export async function openBuffer(): Promise<IDBDatabase> {
  if (dbInstance) return dbInstance;

  // Request persistent storage so the browser won't evict IDB under pressure
  navigator.storage?.persist?.();

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
    request.onsuccess = () => {
      dbInstance = request.result;
      resolve(dbInstance);
    };
    request.onerror = () => {
      // The stored database is newer than this code expects — e.g. a deploy
      // that raised DB_VERSION was reverted. Open at whatever version exists
      // instead of failing, so buffering keeps working (the stores this code
      // uses are never removed by later versions). Clyde 2026-09-29 #16.
      if (request.error?.name === 'VersionError') {
        const fallback = indexedDB.open(DB_NAME);
        fallback.onsuccess = () => {
          dbInstance = fallback.result;
          resolve(dbInstance);
        };
        fallback.onerror = () => reject(fallback.error);
        return;
      }
      reject(request.error);
    };
  });
}

// ── Low-Level IDB Operations ─────────────────────────────────────────────────

export async function addPendingWrite(write: Omit<PendingWrite, 'id'>): Promise<void> {
  const db = await openBuffer();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).add(write);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getAllPendingWrites(): Promise<PendingWrite[]> {
  const db = await openBuffer();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function deletePendingWrite(id: number): Promise<void> {
  const db = await openBuffer();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function clearAllPendingWrites(): Promise<void> {
  const db = await openBuffer();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
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

// ── Orphan Recovery Helper ───────────────────────────────────────────────────

export async function hasPendingEndSession(sessionKey: string): Promise<boolean> {
  const all = await getAllPendingWrites();
  return all.some(w => w.operation === 'endSession' && w.sessionKey === sessionKey);
}

// ── Local Event Log (crash-proof event storage) ─────────────────────────────

export async function addLocalEvent(sessionKey: string, event: Record<string, any>): Promise<void> {
  const db = await openBuffer();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(LOCAL_EVENTS_STORE, 'readwrite');
    tx.objectStore(LOCAL_EVENTS_STORE).add({ sessionKey, event, createdAt: Date.now() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getLocalEvents(sessionKey: string): Promise<Record<string, any>[]> {
  const db = await openBuffer();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(LOCAL_EVENTS_STORE, 'readonly');
    const index = tx.objectStore(LOCAL_EVENTS_STORE).index('sessionKey');
    const request = index.getAll(sessionKey);
    request.onsuccess = () => resolve((request.result as LocalEvent[]).map(r => r.event));
    request.onerror = () => reject(request.error);
  });
}

// Mode-enum event added or edited: in ONE transaction, append it to the crash
// log and queue it for upload, both tagged with its index. The queued entry
// uses the existing flushEvents shape (one event at startIndex = index), so
// any build can replay it, and replay in queue order applies the newest
// version last. Replay is the only writer of events to Firestore.
export async function recordEvent(
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
    tx.onerror = () => reject(tx.error);
  });
}

// This session's crash log entries that carry an index (written by
// recordEvent), in write order.
export async function getLocalEventLog(sessionKey: string): Promise<IndexedEvent[]> {
  const db = await openBuffer();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(LOCAL_EVENTS_STORE, 'readonly');
    const request = tx.objectStore(LOCAL_EVENTS_STORE).index('sessionKey').getAll(sessionKey);
    request.onsuccess = () => {
      const rows = (request.result as LocalEvent[]).filter(r => r.index != null);
      resolve(rows.map(r => ({ index: r.index as number, event: r.event })));
    };
    request.onerror = () => reject(request.error);
  });
}

export async function clearLocalEvents(sessionKey: string): Promise<void> {
  const db = await openBuffer();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(LOCAL_EVENTS_STORE, 'readwrite');
    const store = tx.objectStore(LOCAL_EVENTS_STORE);
    const index = store.index('sessionKey');
    const request = index.openCursor(sessionKey);
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ── Multi-Tab Lock ───────────────────────────────────────────────────────────

function acquireLock(): boolean {
  const now = Date.now();
  const existing = parseInt(localStorage.getItem(LOCK_KEY) || '0');
  if (now - existing < LOCK_TTL) return false;
  localStorage.setItem(LOCK_KEY, String(now));
  return true;
}

function releaseLock(): void {
  localStorage.removeItem(LOCK_KEY);
}

// ── Buffered Write Wrappers ──────────────────────────────────────────────────

export async function bufferedCreateSession(
  userId: string,
  sessionKey: string,
  sessionData: Record<string, any>,
): Promise<boolean> {
  await addPendingWrite({
    operation: 'createSession',
    userId,
    sessionKey,
    payload: sessionData,
    createdAt: Date.now(),
  });
  try {
    await firestoreService.createSession(userId, sessionKey, sessionData);
    // Success — find and remove the entry we just wrote
    const all = await getAllPendingWrites();
    const match = all.find(
      w => w.operation === 'createSession' && w.sessionKey === sessionKey && w.userId === userId,
    );
    if (match?.id != null) await deletePendingWrite(match.id);
    return true;
  } catch {
    return false;
  }
}

export async function bufferedEndSession(
  userId: string,
  sessionKey: string,
  finalData: Record<string, any>,
): Promise<boolean> {
  await addPendingWrite({
    operation: 'endSession',
    userId,
    sessionKey,
    payload: finalData,
    createdAt: Date.now(),
  });
  try {
    await firestoreService.endSession(userId, sessionKey, finalData);
    const all = await getAllPendingWrites();
    const match = all.find(
      w => w.operation === 'endSession' && w.sessionKey === sessionKey && w.userId === userId,
    );
    if (match?.id != null) await deletePendingWrite(match.id);
    return true;
  } catch {
    return false;
  }
}

export async function bufferedSaveUserSettings(
  userId: string,
  settings: Record<string, any>,
): Promise<boolean> {
  await addPendingWrite({
    operation: 'saveUserSettings',
    userId,
    sessionKey: '_settings',
    payload: settings,
    createdAt: Date.now(),
  });
  try {
    await firestoreService.saveUserSettings(userId, settings);
    const all = await getAllPendingWrites();
    const match = all.find(
      w => w.operation === 'saveUserSettings' && w.userId === userId,
    );
    if (match?.id != null) await deletePendingWrite(match.id);
    return true;
  } catch {
    return false;
  }
}

// ── Replay Engine ────────────────────────────────────────────────────────────

async function executeWrite(write: PendingWrite): Promise<void> {
  switch (write.operation) {
    case 'createSession':
      await firestoreService.createSession(write.userId, write.sessionKey, write.payload);
      break;
    case 'endSession':
      await firestoreService.endSession(write.userId, write.sessionKey, write.payload);
      break;
    case 'saveUserSettings':
      await firestoreService.saveUserSettings(write.userId, write.payload);
      break;
  }
}

export async function flushBuffer(currentAuthUid?: string): Promise<FlushResult> {
  // Multi-tab safety: use navigator.locks if available, else localStorage lock
  if (typeof navigator !== 'undefined' && 'locks' in navigator) {
    return new Promise((resolve) => {
      navigator.locks.request('radtach-flush', { ifAvailable: true }, async (lock) => {
        if (!lock) {
          // Another tab is flushing — report current state without doing work
          const remaining = await getPendingCount();
          resolve({ flushed: 0, remaining, canRead: true });
          return;
        }
        resolve(await doFlush(currentAuthUid));
      });
    });
  }

  // Fallback: localStorage timestamp lock
  if (!acquireLock()) {
    const remaining = await getPendingCount();
    return { flushed: 0, remaining, canRead: true };
  }
  try {
    return await doFlush(currentAuthUid);
  } finally {
    releaseLock();
  }
}

// createSession / endSession replay: write, mark late-arriving dates stale for
// group stats, then dequeue. The entry is kept if the marker write fails.
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
}

async function doFlush(currentAuthUid?: string): Promise<FlushResult> {
  const all = await getAllPendingWrites();
  if (all.length === 0) return { flushed: 0, remaining: 0, canRead: true };

  const now = Date.now();
  let flushed = 0;
  let canRead = true;

  // TTL cleanup: remove entries older than 60 days
  const expired = all.filter(w => now - w.createdAt > TTL_MS);
  for (const w of expired) {
    if (w.id != null) await deletePendingWrite(w.id);
  }
  const live = all.filter(w => now - w.createdAt <= TTL_MS);

  // Separate settings writes (independent) from session writes
  const settingsWrites = live.filter(w => w.operation === 'saveUserSettings');
  const sessionWrites = live.filter(w => w.operation !== 'saveUserSettings');

  // Process settings first
  for (const w of settingsWrites) {
    try {
      await executeWrite(w);
      if (w.id != null) await deletePendingWrite(w.id);
      flushed++;
    } catch (err: any) {
      const code = err?.code || '';
      const isNetworkError = code === 'unavailable' || code === 'resource-exhausted';
      if (isNetworkError) canRead = false;
    }
  }

  // Group session writes by sessionKey, process each chain in order
  const bySession = new Map<string, PendingWrite[]>();
  for (const w of sessionWrites) {
    const existing = bySession.get(w.sessionKey) || [];
    existing.push(w);
    bySession.set(w.sessionKey, existing);
  }

  // Each session chain runs in order: createSession → events → endSession.
  // Queued events are merged by index in queue order (newest version wins),
  // then sent as one write.
  for (const [sessionKey, chain] of bySession) {
    const byId = (a: PendingWrite, b: PendingWrite) => (a.id ?? 0) - (b.id ?? 0);
    const creates = chain.filter(w => w.operation === 'createSession').sort(byId);
    const eventWrites = chain.filter(w => w.operation === 'flushEvents').sort(byId);
    const ends = chain.filter(w => w.operation === 'endSession').sort(byId);
    const stamp = currentAuthUid && chain[0].userId !== currentAuthUid
      ? { _flushedBy: currentAuthUid, _flushedAt: new Date().toISOString() }
      : null;

    try {
      for (const w of creates) { await runSessionWrite(w, stamp); flushed++; }
      if (eventWrites.length > 0) {
        const queued = eventWrites.flatMap(w =>
          (w.payload.events as Record<string, any>[]).map((event, i) => ({ index: (w.startIndex ?? 0) + i, event })));
        // Audit trail: cross-user flushes are stamped on each event doc
        const items = mergeByIndex(queued).map(it => (stamp ? { index: it.index, event: { ...it.event, ...stamp } } : it));
        await firestoreService.writeEventsByIndex(chain[0].userId, sessionKey, items);
        for (const w of eventWrites) if (w.id != null) await deletePendingWrite(w.id);
        flushed += eventWrites.length;
      }
      for (const w of ends) { await runSessionWrite(w, stamp); flushed++; }
    } catch (err: any) {
      const code = err?.code || '';
      const isNetworkError = code === 'unavailable' || code === 'resource-exhausted';
      if (isNetworkError) canRead = false;
      // Skip to next session chain (don't block independent sessions)
    }
  }

  const remaining = await getPendingCount();
  return { flushed, remaining, canRead };
}
