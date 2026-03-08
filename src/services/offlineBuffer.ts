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
  createdAt: number;
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
    request.onerror = () => reject(request.error);
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

export async function bufferedFlushEvents(
  userId: string,
  sessionKey: string,
  events: Record<string, any>[],
  startIndex: number,
): Promise<boolean> {
  await addPendingWrite({
    operation: 'flushEvents',
    userId,
    sessionKey,
    payload: { events },
    startIndex,
    createdAt: Date.now(),
  });
  try {
    await firestoreService.flushEvents(userId, sessionKey, events, startIndex);
    const all = await getAllPendingWrites();
    const match = all.find(
      w => w.operation === 'flushEvents' && w.sessionKey === sessionKey && w.startIndex === startIndex,
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
    case 'flushEvents':
      await firestoreService.flushEvents(
        write.userId,
        write.sessionKey,
        write.payload.events,
        write.startIndex ?? 0,
      );
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

  // Order for session chain: createSession → flushEvents (by startIndex) → endSession
  const opOrder: Record<string, number> = { createSession: 0, flushEvents: 1, endSession: 2 };
  for (const [, chain] of bySession) {
    chain.sort((a, b) => {
      const orderDiff = (opOrder[a.operation] ?? 1) - (opOrder[b.operation] ?? 1);
      if (orderDiff !== 0) return orderDiff;
      // Within flushEvents, sort by startIndex
      return (a.startIndex ?? 0) - (b.startIndex ?? 0);
    });

    let chainFailed = false;
    for (const w of chain) {
      if (chainFailed) break;
      try {
        // Audit trail: stamp cross-user flushes so they're attributable
        if (currentAuthUid && w.userId !== currentAuthUid) {
          const flushedAt = new Date().toISOString();
          w.payload._flushedBy = currentAuthUid;
          w.payload._flushedAt = flushedAt;
          // flushEvents writes each event as a separate doc — stamp each one
          if (w.operation === 'flushEvents' && Array.isArray(w.payload.events)) {
            for (const evt of w.payload.events) {
              evt._flushedBy = currentAuthUid;
              evt._flushedAt = flushedAt;
            }
          }
        }
        await executeWrite(w);
        // For late createSession/endSession writes, create a stale GAR marker
        // so group stats get recomputed to include this late-arriving data.
        // Don't delete the IDB entry until the marker also succeeds.
        if (
          (w.operation === 'createSession' || w.operation === 'endSession') &&
          w.payload.startDateTime && w.payload.system
        ) {
          const sessionDate = String(w.payload.startDateTime).slice(0, 10);
          const todayDate = new Date().toISOString().slice(0, 10);
          if (sessionDate < todayDate) {
            await firestoreService.writeStaleMarker(w.payload.system, sessionDate, w.userId);
          }
        }
        if (w.id != null) await deletePendingWrite(w.id);
        flushed++;
      } catch (err: any) {
        chainFailed = true;
        const code = err?.code || '';
        const isNetworkError = code === 'unavailable' || code === 'resource-exhausted';
        if (isNetworkError) canRead = false;
        // Skip to next session chain (don't block independent sessions)
      }
    }
  }

  const remaining = await getPendingCount();
  return { flushed, remaining, canRead };
}
