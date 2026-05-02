import { db } from './firebase';
import {
  collection,
  collectionGroup,
  doc,

  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  writeBatch,
  serverTimestamp,
  query,
  orderBy,
  limit,
  where,
  Timestamp,
  onSnapshot,
} from 'firebase/firestore';
import type { StoredSession, GroupStats, CompositeStats, WorkstationStats } from '../types/reports';
import type { CptDatabase, ChargemasterEntry } from '../types/cpt';
import type { SidecarCommand } from '../types/sidecar';

export const firestoreService = {
  async createUserProfile(userId: string, data: { timezone: string; email: string; firstName: string; lastName: string; credentials?: string }) {
    const userRef = doc(db, 'users', userId);
    await setDoc(userRef, {
      ...data,
      createdAt: serverTimestamp(),
    });
  },

  // Lookup system → returns { key, offices, officeZips } or null if system not found
  async getSystemOffices(systemName: string): Promise<{ key: string; offices: string[]; officeZips?: Record<string, string> } | null> {
    const docRef = doc(db, 'systems', systemName);
    const docSnap = await getDoc(docRef);
    if (!docSnap.exists()) return null;
    const data = docSnap.data();
    if (!Array.isArray(data.offices)) return null;
    const officeZips = (data.officeZips && typeof data.officeZips === 'object')
      ? data.officeZips as Record<string, string>
      : undefined;
    return { key: systemName, offices: data.offices, officeZips };
  },

  // Lookup system → returns rotation list or null if system not found
  async getSystemRotations(systemName: string): Promise<string[] | null> {
    const docRef = doc(db, 'systems', systemName);
    const docSnap = await getDoc(docRef);
    if (!docSnap.exists()) return null;
    const data = docSnap.data();
    return Array.isArray(data.rotations) ? data.rotations : null;
  },

  async createSession(userId: string, sessionKey: string, sessionData: Record<string, any>) {
    const docRef = doc(db, 'users', userId, 'sessions', sessionKey);
    // Use client-provided startDateTime for the indexed startTime field.
    // This ensures offline-buffered sessions land in the correct date range for reports.
    // Falls back to serverTimestamp() if startDateTime is missing (defensive).
    const startTime = sessionData.startDateTime
      ? Timestamp.fromDate(new Date(sessionData.startDateTime))
      : serverTimestamp();
    await setDoc(docRef, { ...sessionData, startTime });
    return sessionKey;
  },

  async endSession(userId: string, sessionId: string, finalData: Record<string, any>) {
    const docRef = doc(db, 'users', userId, 'sessions', sessionId);
    // Use client-provided stopDateTime for the indexed endTime field.
    // Falls back to serverTimestamp() if stopDateTime is missing (defensive).
    const endTime = finalData.stopDateTime
      ? Timestamp.fromDate(new Date(finalData.stopDateTime))
      : serverTimestamp();
    await updateDoc(docRef, { ...finalData, endTime });
  },

  // Batch write: sends multiple events in a single network request (deterministic IDs for idempotency)
  async flushEvents(userId: string, sessionId: string, events: Record<string, any>[], startIndex: number) {
    if (events.length === 0) return;
    const batch = writeBatch(db);
    const eventsRef = collection(db, 'users', userId, 'sessions', sessionId, 'events');
    for (let i = 0; i < events.length; i++) {
      const eventDocRef = doc(eventsRef, `evt-${String(startIndex + i).padStart(4, '0')}`);
      batch.set(eventDocRef, { ...events[i], recordedAt: serverTimestamp() });
    }
    await batch.commit();
  },

  // Shadow mode-enum events: parallel subcollection for validation
  async flushShadowEvents(userId: string, sessionId: string, events: Record<string, any>[], startIndex: number) {
    if (events.length === 0) return;
    const batch = writeBatch(db);
    const eventsRef = collection(db, 'users', userId, 'sessions', sessionId, 'shadow_events');
    for (let i = 0; i < events.length; i++) {
      const eventDocRef = doc(eventsRef, `evt-${String(startIndex + i).padStart(4, '0')}`);
      batch.set(eventDocRef, { ...events[i], recordedAt: serverTimestamp() });
    }
    await batch.commit();
  },

  async getUserSettings(userId: string): Promise<Record<string, any> | null> {
    const docRef = doc(db, 'users', userId, 'settings', 'current');
    const docSnap = await getDoc(docRef);
    return docSnap.exists() ? docSnap.data() : null;
  },

  async saveUserSettings(userId: string, settings: Record<string, any>) {
    const docRef = doc(db, 'users', userId, 'settings', 'current');
    await setDoc(docRef, {
      ...settings,
      updatedAt: serverTimestamp(),
    });
  },

  async updateSession(userId: string, sessionId: string, data: Record<string, any>) {
    const docRef = doc(db, 'users', userId, 'sessions', sessionId);
    await updateDoc(docRef, data);
  },

  // Count sessions whose sessionId field starts with today's date prefix (YYYYMMDD).
  // Used to generate collision-free session IDs across browser restarts.
  async countTodaySessions(userId: string, datePrefix: string): Promise<number> {
    const sessionsRef = collection(db, 'users', userId, 'sessions');
    // sessionId format is "YYYYMMDD-##-uid7". Query for IDs starting with today's date.
    // Lexicographic range: "20260227" <= sessionId < "20260228"
    const endPrefix = datePrefix.slice(0, -1) + String.fromCharCode(datePrefix.charCodeAt(datePrefix.length - 1) + 1);
    const q = query(
      sessionsRef,
      where('sessionId', '>=', datePrefix),
      where('sessionId', '<', endPrefix),
    );
    const snapshot = await getDocs(q);
    return snapshot.size;
  },

  async getRecentSessions(userId: string, maxResults = 30): Promise<{ id: string; [key: string]: any }[]> {
    const sessionsRef = collection(db, 'users', userId, 'sessions');
    const q = query(sessionsRef, orderBy('startTime', 'desc'), limit(maxResults));
    const snapshot = await getDocs(q);
    return snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
  },

  async checkIsAdmin(userId: string): Promise<boolean> {
    const docRef = doc(db, 'Config', 'admins');
    const docSnap = await getDoc(docRef);
    if (!docSnap.exists()) return false;
    const data = docSnap.data();
    return data[userId] === true;
  },

  async getSystemSettings(system: string): Promise<{
    admins: Record<string, boolean>;
    presidents: Record<string, boolean>;
    hospitalAdmins: Record<string, boolean>;
    itAccess: Record<string, boolean>;
    hospitalAdminIndividualAccess: boolean;
    adminIndividualAccess: boolean;
  }> {
    const docRef = doc(db, 'systems', system);
    const docSnap = await getDoc(docRef);
    const defaults = {
      admins: {} as Record<string, boolean>,
      presidents: {} as Record<string, boolean>,
      hospitalAdmins: {} as Record<string, boolean>,
      itAccess: {} as Record<string, boolean>,
      hospitalAdminIndividualAccess: false,
      adminIndividualAccess: false,
    };
    if (!docSnap.exists()) return defaults;
    const data = docSnap.data();
    return {
      admins: (data.admins && typeof data.admins === 'object') ? data.admins : {},
      presidents: (data.presidents && typeof data.presidents === 'object') ? data.presidents : {},
      hospitalAdmins: (data.hospitalAdmins && typeof data.hospitalAdmins === 'object') ? data.hospitalAdmins : {},
      itAccess: (data.itAccess && typeof data.itAccess === 'object') ? data.itAccess : {},
      hospitalAdminIndividualAccess: data.hospitalAdminIndividualAccess === true,
      adminIndividualAccess: data.adminIndividualAccess === true,
    };
  },

  async getUserProfile(userId: string): Promise<{ firstName?: string; lastName?: string; credentials?: string; email?: string; timezone?: string } | null> {
    const docRef = doc(db, 'users', userId);
    const docSnap = await getDoc(docRef);
    if (!docSnap.exists()) return null;
    const data = docSnap.data();
    return {
      firstName: data.firstName || undefined,
      lastName: data.lastName || undefined,
      credentials: data.credentials || undefined,
      email: data.email || undefined,
      timezone: data.timezone || undefined,
    };
  },

  async updateUserProfile(userId: string, data: Record<string, any>) {
    const userRef = doc(db, 'users', userId);
    await updateDoc(userRef, data);
  },

  // ── Report Query Functions ────────────────────────────────────────────────

  async getSessionsInRange(userId: string, startDate: Date, endDate: Date): Promise<StoredSession[]> {
    const sessionsRef = collection(db, 'users', userId, 'sessions');
    const startTs = Timestamp.fromDate(startDate);
    const endTs = Timestamp.fromDate(endDate);
    const q = query(
      sessionsRef,
      where('startTime', '>=', startTs),
      where('startTime', '<', endTs),
      orderBy('startTime', 'desc')
    );
    const snapshot = await getDocs(q);
    return snapshot.docs.map(d => ({ id: d.id, ...d.data() } as StoredSession));
  },

  async getAllSessionsForSystem(system: string, startDate: Date, endDate: Date): Promise<StoredSession[]> {
    const sessionsGroup = collectionGroup(db, 'sessions');
    const startTs = Timestamp.fromDate(startDate);
    const endTs = Timestamp.fromDate(endDate);
    const q = query(
      sessionsGroup,
      where('system', '==', system),
      where('startTime', '>=', startTs),
      where('startTime', '<', endTs),
      orderBy('startTime', 'desc')
    );
    const snapshot = await getDocs(q);
    return snapshot.docs.map(d => ({ id: d.id, ...d.data() } as StoredSession));
  },

  async getGroupStats(system: string, startDate: Date, endDate: Date): Promise<GroupStats[]> {
    const statsRef = collection(db, 'Config', 'groupStats', system);
    const startStr = startDate.toISOString().slice(0, 10);
    const endStr = endDate.toISOString().slice(0, 10);
    const q = query(
      statsRef,
      where('date', '>=', startStr),
      where('date', '<=', endStr),
      orderBy('date', 'asc')
    );
    const snapshot = await getDocs(q);
    return snapshot.docs.map(d => d.data() as GroupStats);
  },

  async getCompositeStats(startDate: Date, endDate: Date): Promise<CompositeStats[]> {
    const statsRef = collection(db, 'Config', 'compositeStats', 'daily');
    const startStr = startDate.toISOString().slice(0, 10);
    const endStr = endDate.toISOString().slice(0, 10);
    const q = query(
      statsRef,
      where('date', '>=', startStr),
      where('date', '<=', endStr),
      orderBy('date', 'asc')
    );
    const snapshot = await getDocs(q);
    return snapshot.docs.map(d => d.data() as CompositeStats);
  },

  async getWorkstationStats(system: string, startDate: Date, endDate: Date): Promise<WorkstationStats[]> {
    const statsRef = collection(db, 'Config', 'workstationStats', system);
    const startStr = startDate.toISOString().slice(0, 10);
    const endStr = endDate.toISOString().slice(0, 10);
    const q = query(
      statsRef,
      where('date', '>=', startStr),
      where('date', '<=', endStr),
      orderBy('date', 'asc')
    );
    const snapshot = await getDocs(q);
    return snapshot.docs.map(d => d.data() as WorkstationStats);
  },

  async writeGroupStats(system: string, date: string, stats: GroupStats): Promise<void> {
    const docRef = doc(db, 'Config', 'groupStats', system, date);
    await setDoc(docRef, stats);
  },

  async writeCompositeStats(date: string, stats: CompositeStats): Promise<void> {
    const docRef = doc(db, 'Config', 'compositeStats', 'daily', date);
    await setDoc(docRef, stats);
  },

  async writeWorkstationStats(system: string, date: string, stats: WorkstationStats): Promise<void> {
    const docRef = doc(db, 'Config', 'workstationStats', system, date);
    await setDoc(docRef, stats);
  },

  async getAllGroupStatsForDate(date: string): Promise<GroupStats[]> {
    // Get all known systems from systems collection, then fetch each system's groupStats for this date
    const systemsSnap = await getDocs(collection(db, 'systems'));
    if (systemsSnap.empty) return [];

    const results: GroupStats[] = [];
    for (const systemDoc of systemsSnap.docs) {
      const statsDoc = await getDoc(doc(db, 'Config', 'groupStats', systemDoc.id, date));
      if (statsDoc.exists()) {
        results.push(statsDoc.data() as GroupStats);
      }
    }
    return results;
  },

  async groupStatsExists(system: string, date: string): Promise<boolean> {
    const docRef = doc(db, 'Config', 'groupStats', system, date);
    const docSnap = await getDoc(docRef);
    return docSnap.exists();
  },

  // ── System / Report Access Config ─────────────────────────────────────────

  async listSystems(): Promise<string[]> {
    const snapshot = await getDocs(collection(db, 'systems'));
    return snapshot.docs.map(d => d.id);
  },

  async getReportAccess(system: string): Promise<Record<string, string[]> | null> {
    const docRef = doc(db, 'systems', system);
    const docSnap = await getDoc(docRef);
    if (!docSnap.exists()) return null;
    const data = docSnap.data();
    return data.reportAccess ?? null;
  },

  async setReportAccess(system: string, access: Record<string, string[]>): Promise<void> {
    const docRef = doc(db, 'systems', system);
    await updateDoc(docRef, { reportAccess: access });
  },

  // ── Role Request Functions ──────────────────────────────────────────────────

  async createRoleRequest(userId: string, data: { displayName: string; email: string; requestedRole: string }) {
    const docRef = doc(db, 'roleRequests', userId);
    await setDoc(docRef, {
      ...data,
      requestedAt: serverTimestamp(),
    });
  },

  async getRoleRequests(): Promise<Array<{ uid: string; displayName: string; email: string; requestedRole: string; requestedAt: any }>> {
    const colRef = collection(db, 'roleRequests');
    const snapshot = await getDocs(colRef);
    return snapshot.docs.map(d => ({ uid: d.id, ...d.data() } as { uid: string; displayName: string; email: string; requestedRole: string; requestedAt: any }));
  },

  async dismissRoleRequest(userId: string) {
    const docRef = doc(db, 'roleRequests', userId);
    await deleteDoc(docRef);
  },

  // ── Stale GAR Marker Functions ────────────────────────────────────────────

  // Orphaned session recovery: find sessions missing endTime (crash/power loss)
  async getOrphanedSessions(userId: string): Promise<{ id: string; [key: string]: any }[]> {
    // Firestore can't query for missing fields directly, so we fetch recent sessions
    // and filter client-side for docs where endTime is absent.
    const sessions = await this.getRecentSessions(userId, 30);
    return sessions.filter(s => !s.endTime);
  },

  // Orphaned session recovery: read all events from a session's events subcollection
  async getSessionEvents(userId: string, sessionId: string): Promise<Record<string, any>[]> {
    const eventsRef = collection(db, 'users', userId, 'sessions', sessionId, 'events');
    const q = query(eventsRef, orderBy('__name__'));
    const snapshot = await getDocs(q);
    return snapshot.docs.map(d => d.data());
  },

  async writeStaleMarker(system: string, date: string, reportedBy: string) {
    const markerId = `${system}_${date}`;
    const docRef = doc(db, 'staleGAR', markerId);
    await setDoc(docRef, {
      system,
      date,
      reportedBy,
      reportedAt: serverTimestamp(),
    });
  },

  async getStaleMarkers(system: string): Promise<Array<{ id: string; system: string; date: string }>> {
    const colRef = collection(db, 'staleGAR');
    const q = query(colRef, where('system', '==', system));
    const snapshot = await getDocs(q);
    return snapshot.docs.map(d => ({ id: d.id, ...d.data() } as { id: string; system: string; date: string }));
  },

  async deleteStaleMarker(markerId: string) {
    const docRef = doc(db, 'staleGAR', markerId);
    await deleteDoc(docRef);
  },

  // ── CPT Database Functions ──────────────────────────────────────────────────

  async getCptDatabase(): Promise<CptDatabase | null> {
    const docRef = doc(db, 'Config', 'cptDatabase');
    const docSnap = await getDoc(docRef);
    if (!docSnap.exists()) return null;
    return docSnap.data() as CptDatabase;
  },

  async writeCptDatabase(database: CptDatabase): Promise<void> {
    const docRef = doc(db, 'Config', 'cptDatabase');
    await setDoc(docRef, database);
  },

  // ── Chargemaster Functions ──────────────────────────────────────────────

  async getSystemChargemaster(systemName: string): Promise<ChargemasterEntry[] | null> {
    const docRef = doc(db, 'systems', systemName);
    const docSnap = await getDoc(docRef);
    if (!docSnap.exists()) return null;
    const data = docSnap.data();
    if (!Array.isArray(data.chargemaster)) return null;
    return data.chargemaster as ChargemasterEntry[];
  },

  // ── Sidecar / HL7 Command Doc Functions ─────────────────────────────────

  // Listen to command doc — returns unsubscribe function
  listenToCommandDoc(userId: string, callback: (cmd: SidecarCommand | null) => void): () => void {
    const docRef = doc(db, 'users', userId, 'commands', 'current');
    return onSnapshot(docRef, (snap) => {
      callback(snap.exists() ? snap.data() as SidecarCommand : null);
    });
  },

  // Acknowledge command (receiver sets ack: true)
  async ackCommandDoc(userId: string): Promise<void> {
    const docRef = doc(db, 'users', userId, 'commands', 'current');
    await updateDoc(docRef, { ack: true });
  },

  // Write "completed" action (RadTach → Sidecar)
  async writeCommandCompleted(userId: string): Promise<void> {
    const docRef = doc(db, 'users', userId, 'commands', 'current');
    await setDoc(docRef, {
      action: 'completed' as const,
      source: 'radtach' as const,
      timestamp: serverTimestamp(),
    });
  },

  // ── Session Status (Sidecar gating) ──────────────────────────────────────

  async writeSessionStatus(userId: string, active: boolean): Promise<void> {
    const docRef = doc(db, 'users', userId, 'status', 'current');
    await setDoc(docRef, { sessionActive: active, updatedAt: serverTimestamp() });
  },

  async clearCommandDoc(userId: string): Promise<void> {
    const docRef = doc(db, 'users', userId, 'commands', 'current');
    await setDoc(docRef, {
      action: 'session_started' as const,
      source: 'radtach' as const,
      timestamp: serverTimestamp(),
    });
  },

  async writeSessionEnded(userId: string): Promise<void> {
    const docRef = doc(db, 'users', userId, 'commands', 'current');
    await setDoc(docRef, {
      action: 'session_ended' as const,
      source: 'radtach' as const,
      timestamp: serverTimestamp(),
    });
  },
};
