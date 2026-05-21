// Compute and seed GroupStats from emulator session + event data
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
  byDate.get(dateKey).push({ id: d.id, path: d.ref.path, ...data });
}

console.log(`${byDate.size} unique dates`);
console.log('Reading events for modality data...');

// For each session, read its events to get modality breakdown
const sessionModalities = new Map(); // sessionId -> { mod: count, ... }
let eventsRead = 0;
for (const [, sessions] of byDate) {
  for (const s of sessions) {
    // Parse the user UID from the path: users/{uid}/sessions/{sessionId}
    const pathParts = s.path.split('/');
    const uid = pathParts[1];
    const sessionId = pathParts[3];

    const eventsRef = collection(db, 'users', uid, 'sessions', sessionId, 'events');
    const eventsSnap = await getDocs(eventsRef);

    const modCounts = {};
    const modRvu = {};
    const hourlyStudies = {};
    const sessionStartMs = new Date(s.startDateTime).getTime();
    for (const e of eventsSnap.docs) {
      const evt = e.data();
      if (evt.type === 'STUDY') {
        const mod = evt.modality || 'Unknown';
        modCounts[mod] = (modCounts[mod] || 0) + 1;
        modRvu[mod] = (modRvu[mod] || 0) + (evt.rvu || 0);
        // Hourly bucket
        const studyMs = sessionStartMs + (evt.startTimeSession || 0) * 1000;
        const hour = String(new Date(studyMs).getHours()).padStart(2, '0');
        hourlyStudies[hour] = (hourlyStudies[hour] || 0) + 1;
      }
    }
    sessionModalities.set(s.id, { counts: modCounts, rvu: modRvu, hourly: hourlyStudies });
    eventsRead += eventsSnap.size;
  }
}
console.log(`Read ${eventsRead} events across ${sessionModalities.size} sessions`);

// Tags to inject (synthetic — the seed doesn't generate tags, so create some)
const SYNTHETIC_TAGS = ['Good Day', 'Not Feeling It Today', 'Network & Application Interference', 'High Volume', 'Low Volume = Low Productivity'];

// Compute GroupStats per date
for (const [dateKey, sessions] of byDate) {
  const userIds = new Set(sessions.map(s => s.userAbbrev));
  const totalRVU = sessions.reduce((sum, s) => sum + (s.totalRVU || 0), 0);
  const totalTcRVU = sessions.reduce((sum, s) => sum + (s.totalTcRVU || 0), 0);
  const totalStudies = sessions.reduce((sum, s) => sum + (s.studiesCompleted || 0), 0);
  const totalSessionHours = sessions.reduce((sum, s) => sum + (s.totalSessionTime || 0), 0) / 3600;
  const totalBreakHours = sessions.reduce((sum, s) => sum + (s.breakTime || 0), 0) / 3600;
  const totalAdminHours = sessions.reduce((sum, s) => sum + (s.adminTime || 0), 0) / 3600;
  const totalCommsHours = sessions.reduce((sum, s) => sum + (s.commsTime || 0), 0) / 3600;

  // Aggregate modality data from events
  const byModality = {};
  for (const s of sessions) {
    const mods = sessionModalities.get(s.id);
    if (!mods) continue;
    for (const [mod, count] of Object.entries(mods.counts)) {
      if (!byModality[mod]) byModality[mod] = { studies: 0, rvu: 0 };
      byModality[mod].studies += count;
    }
    for (const [mod, rvu] of Object.entries(mods.rvu)) {
      if (!byModality[mod]) byModality[mod] = { studies: 0, rvu: 0 };
      byModality[mod].rvu += rvu;
    }
  }

  // Hourly studies aggregated
  const hourlyStudies = {};
  for (const s of sessions) {
    const mods = sessionModalities.get(s.id);
    if (!mods?.hourly) continue;
    for (const [hour, count] of Object.entries(mods.hourly)) {
      hourlyStudies[hour] = (hourlyStudies[hour] || 0) + count;
    }
  }

  // Synthetic tag frequency (10% chance of Network interference per session)
  const tagFreq = {};
  let seed = dateKey.split('-').reduce((a, b) => a + parseInt(b), 0);
  for (const s of sessions) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    if ((seed % 100) < 10) {
      tagFreq['Network & Application Interference'] = (tagFreq['Network & Application Interference'] || 0) + 1;
    }
    if ((seed % 100) >= 60 && (seed % 100) < 75) {
      tagFreq['Good Day'] = (tagFreq['Good Day'] || 0) + 1;
    }
    if ((seed % 100) >= 85) {
      tagFreq['High Volume'] = (tagFreq['High Volume'] || 0) + 1;
    }
  }

  // RVU/hr distribution
  const rvuPerHourValues = sessions.map(s => {
    const hrs = ((s.totalSessionTime || 0) - (s.breakTime || 0)) / 3600;
    return hrs > 0 ? (s.totalRVU || 0) / hrs : 0;
  }).filter(v => v > 0);

  const mean = rvuPerHourValues.length > 0 ? rvuPerHourValues.reduce((a, b) => a + b, 0) / rvuPerHourValues.length : 0;
  const sorted = [...rvuPerHourValues].sort((a, b) => a - b);
  const n = sorted.length;
  const p25 = sorted[Math.floor(n * 0.25)] || 0;
  const p50 = sorted[Math.floor(n * 0.5)] || 0;
  const p75 = sorted[Math.floor(n * 0.75)] || 0;
  const stdDev = n > 1 ? Math.sqrt(rvuPerHourValues.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (n - 1)) : 0;

  // Productive ratio distribution
  const prValues = sessions.map(s => {
    const total = s.totalSessionTime || 0;
    const study = total - (s.interstitialTime || 0) - (s.adminTime || 0) - (s.commsTime || 0) - (s.breakTime || 0);
    return total > 0 ? Math.max(0, study / total) : 0;
  });
  const prMean = prValues.length > 0 ? prValues.reduce((a, b) => a + b, 0) / prValues.length : 0;
  const prSorted = [...prValues].sort((a, b) => a - b);

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
    rvuPerHour: { mean: Math.round(mean * 100) / 100, median: Math.round(p50 * 100) / 100, p25: Math.round(p25 * 100) / 100, p50: Math.round(p50 * 100) / 100, p75: Math.round(p75 * 100) / 100, stdDev: Math.round(stdDev * 100) / 100, n },
    productiveRatio: { mean: Math.round(prMean * 1000) / 1000, median: Math.round((prSorted[Math.floor(prSorted.length * 0.5)] || 0) * 1000) / 1000, p25: Math.round((prSorted[Math.floor(prSorted.length * 0.25)] || 0) * 1000) / 1000, p50: Math.round((prSorted[Math.floor(prSorted.length * 0.5)] || 0) * 1000) / 1000, p75: Math.round((prSorted[Math.floor(prSorted.length * 0.75)] || 0) * 1000) / 1000, stdDev: 0.1, n: prValues.length },
    tagFrequency: tagFreq,
    hourlyStudies,
    computedAt: Timestamp.now(),
  };

  const ref = doc(db, 'Config', 'groupStats', 'Test System', dateKey);
  await setDoc(ref, groupStats);
}

console.log(`Wrote ${byDate.size} GroupStats documents with modality data + tags`);
console.log('Done!');
process.exit(0);
