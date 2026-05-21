// Quick script to compute GroupStats from emulator session data
import { initializeApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, signInWithEmailAndPassword } from 'firebase/auth';
import { getFirestore, connectFirestoreEmulator, collectionGroup, collection, doc, setDoc, getDocs, query, where, orderBy, Timestamp } from 'firebase/firestore';

const app = initializeApp({ apiKey: 'fake', authDomain: 'localhost', projectId: 'radtach' });
const auth = getAuth(app);
connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
const db = getFirestore(app);
connectFirestoreEmulator(db, '127.0.0.1', 8080);

await signInWithEmailAndPassword(auth, 'ab@test.radtach.com', 'Test123!');

// Get all sessions
const sessionsQ = query(collectionGroup(db, 'sessions'), where('system', '==', 'Test System'), orderBy('startTime', 'desc'));
const snap = await getDocs(sessionsQ);
console.log(`Found ${snap.size} sessions`);

// Group by date
const byDate = new Map();
for (const d of snap.docs) {
  const data = d.data();
  const dateKey = data.startDateTime?.slice(0, 10);
  if (!dateKey) continue;
  if (!byDate.has(dateKey)) byDate.set(dateKey, []);
  byDate.get(dateKey).push({ id: d.id, ...data });
}

console.log(`${byDate.size} unique dates`);

// Compute simple GroupStats per date
for (const [dateKey, sessions] of byDate) {
  const userIds = new Set(sessions.map(s => s.userAbbrev));
  const totalRVU = sessions.reduce((sum, s) => sum + (s.totalRVU || 0), 0);
  const totalTcRVU = sessions.reduce((sum, s) => sum + (s.totalTcRVU || 0), 0);
  const totalStudies = sessions.reduce((sum, s) => sum + (s.studiesCompleted || 0), 0);
  const totalSessionHours = sessions.reduce((sum, s) => sum + (s.totalSessionTime || 0), 0) / 3600;
  const totalBreakHours = sessions.reduce((sum, s) => sum + (s.breakTime || 0), 0) / 3600;
  const totalAdminHours = sessions.reduce((sum, s) => sum + (s.adminTime || 0), 0) / 3600;
  const totalCommsHours = sessions.reduce((sum, s) => sum + (s.commsTime || 0), 0) / 3600;

  // By modality (from session summaries if available)
  const byModality = {};
  for (const s of sessions) {
    if (s.summary?.studiesByModality) {
      for (const [mod, count] of Object.entries(s.summary.studiesByModality)) {
        if (!byModality[mod]) byModality[mod] = { studies: 0, rvu: 0 };
        byModality[mod].studies += count;
      }
    }
    if (s.summary?.rvuPerHourByModality) {
      for (const [mod] of Object.entries(s.summary.rvuPerHourByModality)) {
        if (!byModality[mod]) byModality[mod] = { studies: 0, rvu: 0 };
      }
    }
  }
  // Estimate RVU by modality from total
  const totalModStudies = Object.values(byModality).reduce((sum, m) => sum + m.studies, 0);
  for (const mod of Object.keys(byModality)) {
    byModality[mod].rvu = totalModStudies > 0 ? totalRVU * (byModality[mod].studies / totalModStudies) : 0;
  }

  // Tag frequency
  const tagFreq = {};
  for (const s of sessions) {
    if (s.notes?.tags) {
      for (const tag of s.notes.tags) {
        if (tag !== 'No Comment') tagFreq[tag] = (tagFreq[tag] || 0) + 1;
      }
    }
  }

  // RVU/hr distribution (simple)
  const rvuPerHourValues = sessions.map(s => {
    const hrs = ((s.totalSessionTime || 0) - (s.breakTime || 0)) / 3600;
    return hrs > 0 ? (s.totalRVU || 0) / hrs : 0;
  }).filter(v => v > 0);

  const mean = rvuPerHourValues.length > 0 ? rvuPerHourValues.reduce((a, b) => a + b, 0) / rvuPerHourValues.length : 0;
  const sorted = [...rvuPerHourValues].sort((a, b) => a - b);
  const p25 = sorted[Math.floor(sorted.length * 0.25)] || 0;
  const p50 = sorted[Math.floor(sorted.length * 0.5)] || 0;
  const p75 = sorted[Math.floor(sorted.length * 0.75)] || 0;

  const groupStats = {
    date: dateKey,
    system: 'Test System',
    sessionCount: sessions.length,
    uniqueUsers: userIds.size,
    groupTotals: {
      totalRVU: Math.round(totalRVU * 100) / 100,
      totalTcRVU: Math.round(totalTcRVU * 100) / 100,
      totalStudies,
      totalSessionHours: Math.round(totalSessionHours * 100) / 100,
      totalBreakHours: Math.round(totalBreakHours * 100) / 100,
      totalAdminHours: Math.round(totalAdminHours * 100) / 100,
      totalCommsHours: Math.round(totalCommsHours * 100) / 100,
    },
    groupTotalsByModality: byModality,
    rvuPerHour: { mean, median: p50, p25, p50, p75, stdDev: 0, n: rvuPerHourValues.length },
    productiveRatio: { mean: 0.7, median: 0.7, p25: 0.6, p50: 0.7, p75: 0.8, stdDev: 0.1, n: sessions.length },
    tagFrequency: tagFreq,
    computedAt: Timestamp.now(),
  };

  const ref = doc(db, 'Config', 'groupStats', 'Test System', dateKey);
  await setDoc(ref, groupStats);
}

console.log(`Wrote ${byDate.size} GroupStats documents`);
console.log('Done!');
process.exit(0);
