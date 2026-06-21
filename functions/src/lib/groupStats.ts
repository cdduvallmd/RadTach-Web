// Admin SDK port of src/utils/garTrigger.ts. The pure math (computeGroupStats,
// computeCompositeStats, computeWorkstationStats) lives in garComputation.ts in
// the browser tree — that file has no Firestore dependencies and could be
// shared via a small build step. For now, the math we use here is the GAR
// computation flow: count distinct UIDs (cohort gate), fetch sessions for
// {system, date}, compute aggregates, write.
//
// Implements:
//   - Claim-then-process pattern (Clyde CRITICAL #2): markers acquired via
//     atomic transaction on the marker doc before processing.
//   - Minimum-cohort gate: skip computation if fewer than MIN_COHORT distinct
//     users have a session in the trailing 30-day window for this system.
//   - _autoFinalized exclusion (Clyde HIGH #3): orphan-finalized sessions are
//     never included in group statistics — they aren't representative work.

import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import type { StoredSession, StaleMarker } from './types';

export const STALE_MARKER_MAX_AGE_DAYS = 30;
export const STALE_CLAIM_AGE_MS = 5 * 60 * 1000;  // 5 minutes — stuck claims taken over
export const MIN_COHORT = 3;
export const COHORT_LOOKBACK_DAYS = 30;

/** Count distinct UIDs with ≥1 non-autoFinalized session in the trailing N days. */
export async function cohortSizeForSystem(system: string): Promise<number> {
  const db = getFirestore();
  const since = Timestamp.fromMillis(Date.now() - COHORT_LOOKBACK_DAYS * 86400 * 1000);
  const snap = await db.collectionGroup('sessions')
    .where('system', '==', system)
    .where('startTime', '>=', since)
    .get();
  const uids = new Set<string>();
  for (const d of snap.docs) {
    const s = d.data() as StoredSession;
    if (s._autoFinalized) continue;
    // userAbbrev is the canonical owner field, but the parent doc path also
    // identifies the user (users/{uid}/sessions/...). Use the path for safety.
    const m = d.ref.path.match(/users\/([^/]+)\/sessions/);
    if (m) uids.add(m[1]);
    else if (s.userAbbrev) uids.add(s.userAbbrev);
  }
  return uids.size;
}

/** Atomically claim a marker, returning the latest doc snapshot or null on lost race. */
export async function claimMarker(markerId: string, claimerLabel: string): Promise<StaleMarker | null> {
  const db = getFirestore();
  const ref = db.doc(`staleGAR/${markerId}`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const data = snap.data() as StaleMarker;
    if (data.claimedBy) {
      const claimedAtMs = data.claimedAt?.toMillis?.() ?? 0;
      if (Date.now() - claimedAtMs < STALE_CLAIM_AGE_MS) return null;  // active claim — back off
      // Stuck claim — take over.
    }
    tx.update(ref, {
      claimedBy: claimerLabel,
      claimedAt: FieldValue.serverTimestamp(),
    });
    return { ...data, id: markerId };
  });
}

/** Fetch all non-_autoFinalized sessions for {system, date}. */
export async function fetchSessionsForSystemDate(system: string, dateStr: string): Promise<StoredSession[]> {
  const db = getFirestore();
  const dayStart = Timestamp.fromDate(new Date(`${dateStr}T00:00:00Z`));
  const dayEnd = Timestamp.fromDate(new Date(`${dateStr}T23:59:59.999Z`));
  const snap = await db.collectionGroup('sessions')
    .where('system', '==', system)
    .where('startTime', '>=', dayStart)
    .where('startTime', '<=', dayEnd)
    .get();
  const out: StoredSession[] = [];
  for (const d of snap.docs) {
    const s = d.data() as StoredSession;
    if (s._autoFinalized) continue;
    out.push(s);
  }
  return out;
}

/**
 * Minimal GroupStats document — just enough to be useful and to verify the
 * function works end-to-end. Mirrors the shape of writeGroupStats() in
 * src/services/firestore.ts (fields: totalSessions, totalRVU, totalStudies,
 * sessionTimeHours, system, date, userCount, updatedAt). The full distribution
 * computation (percentiles, etc.) lives in src/utils/garComputation.ts in the
 * browser tree; if that math is needed in the function later, the cleanest
 * path is to share garComputation.ts via a small build copy step rather than
 * duplicating it here. For now, basic totals are sufficient since this code
 * ships dormant.
 */
export interface GroupStatsLite {
  system: string;
  date: string;
  totalSessions: number;
  totalStudies: number;
  totalRVU: number;
  totalSessionTimeSec: number;
  userCount: number;
  cohortSizeAtCompute: number;
  computedBy: 'cloud-function';
  updatedAt: FirebaseFirestore.FieldValue;
}

export function computeGroupStatsLite(
  sessions: StoredSession[],
  system: string,
  dateStr: string,
  cohortSize: number,
): GroupStatsLite {
  const uids = new Set<string>();
  let totalStudies = 0;
  let totalRVU = 0;
  let totalSessionTimeSec = 0;
  for (const s of sessions) {
    if (s.userAbbrev) uids.add(s.userAbbrev);
    totalStudies += s.studiesCompleted ?? 0;
    totalRVU += s.totalRVU ?? 0;
    totalSessionTimeSec += s.totalSessionTime ?? 0;
  }
  return {
    system,
    date: dateStr,
    totalSessions: sessions.length,
    totalStudies,
    totalRVU,
    totalSessionTimeSec,
    userCount: uids.size,
    cohortSizeAtCompute: cohortSize,
    computedBy: 'cloud-function',
    updatedAt: FieldValue.serverTimestamp(),
  };
}

export async function writeGroupStats(stats: GroupStatsLite): Promise<void> {
  const db = getFirestore();
  await db.doc(`Config/groupStats/${stats.system}/${stats.date}`).set(stats, { merge: true });
}

/**
 * Recompute group stats for {system, date}. Returns true if stats were
 * written; false if no sessions exist (a vacuous date) or cohort < MIN_COHORT.
 */
export async function recomputeStats(
  system: string,
  dateStr: string,
): Promise<{ written: boolean; reason?: string; cohortSize?: number }> {
  const cohortSize = await cohortSizeForSystem(system);
  if (cohortSize < MIN_COHORT) {
    return { written: false, reason: `cohort=${cohortSize} < ${MIN_COHORT}`, cohortSize };
  }
  const sessions = await fetchSessionsForSystemDate(system, dateStr);
  if (sessions.length === 0) {
    return { written: false, reason: 'no-sessions', cohortSize };
  }
  const stats = computeGroupStatsLite(sessions, system, dateStr, cohortSize);
  await writeGroupStats(stats);
  return { written: true, cohortSize };
}

/** Delete a marker by ID (idempotent — silent on missing). */
export async function deleteMarker(markerId: string): Promise<void> {
  const db = getFirestore();
  try {
    await db.doc(`staleGAR/${markerId}`).delete();
  } catch (err) {
    console.warn(`deleteMarker(${markerId}) failed (ignored):`, err);
  }
}

/** List all stale markers (optionally filtered to one system). */
export async function listMarkers(system?: string): Promise<StaleMarker[]> {
  const db = getFirestore();
  const q = system
    ? db.collection('staleGAR').where('system', '==', system)
    : db.collection('staleGAR');
  const snap = await q.get();
  return snap.docs.map(d => ({ id: d.id, ...(d.data() as Omit<StaleMarker, 'id'>) }));
}

/** Is a marker older than STALE_MARKER_MAX_AGE_DAYS? */
export function markerIsExpired(m: StaleMarker): boolean {
  const markerDateMs = new Date(`${m.date}T00:00:00Z`).getTime();
  return Date.now() - markerDateMs > STALE_MARKER_MAX_AGE_DAYS * 86400 * 1000;
}
