/**
 * seedEmulator.ts — Synthetic Test Data Generator for RadTach
 *
 * Seeds the local Firestore emulator with 30 days of realistic radiologist
 * session data for 10 synthetic users. Uses D&D-style stat rolling to create
 * varied but reproducible radiologist profiles.
 *
 * Usage:
 *   npm run seed
 *   # or directly:
 *   npx tsx scripts/seedEmulator.ts
 *
 * Prerequisites:
 *   - Firestore emulator running on localhost:8080
 *   - Auth emulator running on localhost:9099
 */

import { initializeApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, createUserWithEmailAndPassword, signInWithEmailAndPassword } from 'firebase/auth';
import { getFirestore, connectFirestoreEmulator, doc, setDoc, writeBatch, Timestamp } from 'firebase/firestore';
import { writeFileSync, existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// ── Firebase init (emulator only) ──────────────────────────────────────────

const app = initializeApp({
  apiKey: 'fake-api-key',
  authDomain: 'localhost',
  projectId: 'radtach',
});

const auth = getAuth(app);
connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });

const db = getFirestore(app);
connectFirestoreEmulator(db, '127.0.0.1', 8080);

// ── Types ──────────────────────────────────────────────────────────────────

type Modality = 'XR' | 'FL' | 'CT' | 'US' | 'MR' | 'NM' | 'MA' | 'PET-CT';

interface RadiologistProfile {
  name: string;
  firstName: string;
  lastName: string;
  credentials: string;
  initials: string;
  gender: 'M' | 'F';
  speed: number;         // studies/hr (8-14)
  bestModality: Modality;
  dayLength: number;     // hours (8-10)
  avgRVUPerHour: number; // target RVU/hr (6-10)
  offices: string[];     // 4-5 of the 10 offices
}

interface SessionEvent {
  type: string;
  [key: string]: unknown;
}

// ── Constants ──────────────────────────────────────────────────────────────

const ALL_MODALITIES: Modality[] = ['XR', 'FL', 'CT', 'US', 'MR', 'NM', 'MA', 'PET-CT'];

const DEFAULT_PAR_TIMES: Record<Modality, number> = {
  'XR': 90, 'FL': 120, 'CT': 240, 'US': 120, 'MR': 240, 'NM': 240, 'MA': 240, 'PET-CT': 600,
};

const DEFAULT_RVU_VALUES: Record<Modality, number> = {
  'XR': 0.2, 'FL': 0.4, 'CT': 1.0, 'US': 0.5, 'MR': 1.3, 'NM': 0.6, 'MA': 1.3, 'PET-CT': 2.4,
};

const COMPLICATIONS = [
  { name: 'Cancer Follow', parAdd: 60, rvuAdd: 0.1 },
  { name: '+1 Section', parAdd: 120, rvuAdd: 0.5 },
  { name: '+2 Section', parAdd: 180, rvuAdd: 1.0 },
  { name: 'Multiple Priors', parAdd: 45, rvuAdd: 0 },
  { name: 'Age >70', parAdd: 30, rvuAdd: 0 },
  { name: 'Complex Hx', parAdd: 60, rvuAdd: 0.1 },
  { name: 'Prior Surg Hx', parAdd: 45, rvuAdd: 0 },
  { name: 'CTA', parAdd: 120, rvuAdd: 0.5 },
  { name: 'Vascular', parAdd: 90, rvuAdd: 0.3 },
];

const SYSTEM_NAME = 'Test System';

const OFFICES = [
  'Office 1', 'Office 2', 'Office 3', 'Office 4', 'Office 5',
  'Office 6', 'Office 7', 'Office 8', 'Office 9', 'Office 10',
];

const ROTATIONS = ['Body', 'Neuro', 'MSK', 'Chest', 'ER', 'Mammo'];

const DOC_TEMPLATES: Array<{
  firstName: string; lastName: string; initials: string; gender: 'M' | 'F';
}> = [
  { firstName: 'Andrew', lastName: 'Brown', initials: 'AB', gender: 'M' },
  { firstName: 'Claire', lastName: 'Davis', initials: 'CD', gender: 'F' },
  { firstName: 'Ethan', lastName: 'Foster', initials: 'EF', gender: 'M' },
  { firstName: 'Grace', lastName: 'Harper', initials: 'GH', gender: 'F' },
  { firstName: 'Isaac', lastName: 'Jensen', initials: 'IJ', gender: 'M' },
  { firstName: 'Karen', lastName: 'Liu', initials: 'KL', gender: 'F' },
  { firstName: 'Marcus', lastName: 'Nash', initials: 'MN', gender: 'M' },
  { firstName: 'Olivia', lastName: 'Park', initials: 'OP', gender: 'F' },
  { firstName: 'Quinn', lastName: 'Rivera', initials: 'QR', gender: 'M' },
  { firstName: 'Samuel', lastName: 'Torres', initials: 'ST', gender: 'M' },
];

// ── Seeded PRNG (deterministic) ────────────────────────────────────────────

let _seed = 42;
function seededRandom(): number {
  _seed = (_seed * 16807 + 0) % 2147483647;
  return (_seed - 1) / 2147483646;
}

function randInt(min: number, max: number): number {
  return Math.floor(seededRandom() * (max - min + 1)) + min;
}

function randFloat(min: number, max: number): number {
  return seededRandom() * (max - min) + min;
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(seededRandom() * arr.length)];
}

function pickN<T>(arr: T[], n: number): T[] {
  const shuffled = [...arr].sort(() => seededRandom() - 0.5);
  return shuffled.slice(0, n);
}

function gaussianIsh(mean: number, stdDev: number): number {
  // Box-Muller approximation using seeded random
  const u1 = seededRandom();
  const u2 = seededRandom();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + z * stdDev;
}

// ── Stat Rolling ───────────────────────────────────────────────────────────

function rollProfiles(): RadiologistProfile[] {
  return DOC_TEMPLATES.map(tmpl => {
    const speed = randInt(8, 14);
    const bestModality = pick(ALL_MODALITIES);
    const dayLength = randInt(8, 10);
    const avgRVUPerHour = randFloat(6, 10);
    const numOffices = randInt(4, 5);
    const offices = pickN(OFFICES, numOffices);

    return {
      name: `${tmpl.firstName} ${tmpl.lastName}`,
      firstName: tmpl.firstName,
      lastName: tmpl.lastName,
      credentials: 'MD',
      initials: tmpl.initials,
      gender: tmpl.gender,
      speed,
      bestModality,
      dayLength,
      avgRVUPerHour,
      offices,
    };
  });
}

// ── Session Generation ─────────────────────────────────────────────────────

function generateModalityForStudy(profile: RadiologistProfile): Modality {
  // Best modality gets 60-70% of studies
  if (seededRandom() < 0.65) return profile.bestModality;
  // Rest distributed among others
  const others = ALL_MODALITIES.filter(m => m !== profile.bestModality);
  return pick(others);
}

function generateComplications(modality: Modality, rvuTarget: number): string[] {
  const complications: string[] = [];
  // Higher RVU/hr target → more complications
  const complicationChance = Math.min(0.15 + (rvuTarget - 6) * 0.05, 0.45);

  // CT/MR get section additions more often
  if ((modality === 'CT' || modality === 'MR') && seededRandom() < complicationChance) {
    complications.push(seededRandom() < 0.6 ? '+1 Section' : '+2 Section');
  }

  // CTA for CT
  if (modality === 'CT' && seededRandom() < 0.15) {
    complications.push('CTA');
  }

  // General complications
  for (const comp of ['Cancer Follow', 'Multiple Priors', 'Age >70', 'Complex Hx', 'Prior Surg Hx', 'Vascular']) {
    if (seededRandom() < 0.08) {
      complications.push(comp);
    }
  }

  return complications;
}

function getWorkday(dayIndex: number): Date {
  // Start from 30 workdays ago, skipping weekends
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let workdaysBack = 30 - dayIndex;
  const date = new Date(today);
  while (workdaysBack > 0) {
    date.setDate(date.getDate() - 1);
    const dow = date.getDay();
    if (dow !== 0 && dow !== 6) workdaysBack--;
  }
  return date;
}

function generateSession(
  profile: RadiologistProfile,
  date: Date,
  sessionNumber: number,
): { sessionData: Record<string, unknown>; events: SessionEvent[] } {
  const events: SessionEvent[] = [];

  // Session start time: 7-8 AM with some variance
  const startHour = 7 + randFloat(0, 1);
  const sessionStart = new Date(date);
  sessionStart.setHours(Math.floor(startHour), Math.round((startHour % 1) * 60), 0, 0);

  // Slight day-to-day variance in speed and duration
  const daySpeed = Math.max(4, profile.speed + gaussianIsh(0, 1.5));
  const dayDurationHrs = profile.dayLength + gaussianIsh(0, 0.5);
  const totalStudies = Math.round(daySpeed * dayDurationHrs);
  const totalSessionSec = Math.round(dayDurationHrs * 3600);

  const office = pick(profile.offices);
  const rotation = pick(ROTATIONS);
  const isOffice7 = office === 'Office 7';

  let sessionTimeCursor = 0; // seconds into session
  let studyNumber = 0;
  let totalRVU = 0;
  let cumulativeParTime = 0;
  let totalStudyTime = 0;
  let totalInterstitialTime = 0;
  let totalAdminTime = 0;
  let totalCommsTime = 0;
  let totalBreakTime = 0;
  let totalDoubleTapTime = 0;
  let adminEventCount = 0;
  let commsEventCount = 0;
  let breakEventCount = 0;
  let doubleTapEventCount = 0;
  let timeSinceLastBreak = 0;

  // Half day if dayDurationHrs < 6
  const isHalfDay = dayDurationHrs < 6;

  for (let i = 0; i < totalStudies && sessionTimeCursor < totalSessionSec; i++) {
    // Break check every ~2 hours
    if (timeSinceLastBreak > 7200 && seededRandom() < 0.8) {
      const breakDur = randInt(300, 900); // 5-15 min
      const breakStartSystem = new Date(sessionStart.getTime() + sessionTimeCursor * 1000);
      const breakEndSystem = new Date(breakStartSystem.getTime() + breakDur * 1000);

      events.push({
        type: 'BREAK',
        startTimeSession: sessionTimeCursor,
        startTimeSystem: breakStartSystem.toISOString(),
        endTimeSession: sessionTimeCursor + breakDur,
        endTimeSystem: breakEndSystem.toISOString(),
        duration: breakDur,
      });

      totalBreakTime += breakDur;
      breakEventCount++;
      sessionTimeCursor += breakDur;
      timeSinceLastBreak = 0;
      continue;
    }

    // Interstitial (gap between studies)
    const baseInterstitial = randInt(10, 45);
    const interstitialDur = isOffice7 ? baseInterstitial + randInt(30, 60) : baseInterstitial;
    const interstitialStartSystem = new Date(sessionStart.getTime() + sessionTimeCursor * 1000);
    const interstitialEndSystem = new Date(interstitialStartSystem.getTime() + interstitialDur * 1000);

    if (i > 0) { // No interstitial before first study
      events.push({
        type: 'INTERSTITIAL',
        startTimeSession: sessionTimeCursor,
        startTimeSystem: interstitialStartSystem.toISOString(),
        endTimeSession: sessionTimeCursor + interstitialDur,
        endTimeSystem: interstitialEndSystem.toISOString(),
        duration: interstitialDur,
      });
      totalInterstitialTime += interstitialDur;
      sessionTimeCursor += interstitialDur;
      timeSinceLastBreak += interstitialDur;
    }

    // Occasional admin/comms event interrupting interstitial
    if (seededRandom() < 0.08) {
      const isAdmin = seededRandom() < 0.5;
      const eventDur = randInt(30, 180);
      const evtStartSys = new Date(sessionStart.getTime() + sessionTimeCursor * 1000);
      const evtEndSys = new Date(evtStartSys.getTime() + eventDur * 1000);

      events.push({
        type: isAdmin ? 'ADMIN' : 'COMMS',
        startTimeSession: sessionTimeCursor,
        startTimeSystem: evtStartSys.toISOString(),
        endTimeSession: sessionTimeCursor + eventDur,
        endTimeSystem: evtEndSys.toISOString(),
        duration: eventDur,
      });

      if (isAdmin) { totalAdminTime += eventDur; adminEventCount++; }
      else { totalCommsTime += eventDur; commsEventCount++; }
      sessionTimeCursor += eventDur;
      timeSinceLastBreak += eventDur;
    }

    // Generate the study
    studyNumber++;
    const modality = generateModalityForStudy(profile);
    const complications = generateComplications(modality, profile.avgRVUPerHour);

    const baseParTime = DEFAULT_PAR_TIMES[modality];
    const compParAdd = complications.reduce((sum, c) => {
      const comp = COMPLICATIONS.find(x => x.name === c);
      return sum + (comp?.parAdd || 0);
    }, 0);
    const parTime = baseParTime + compParAdd;

    const baseRVU = DEFAULT_RVU_VALUES[modality];
    const compRVUAdd = complications.reduce((sum, c) => {
      const comp = COMPLICATIONS.find(x => x.name === c);
      return sum + (comp?.rvuAdd || 0);
    }, 0);
    const rvu = baseRVU + compRVUAdd;

    // Elapsed time: normally distributed around par time, biased by speed
    const speedFactor = 10 / profile.speed; // faster docs finish under par
    const elapsedTime = Math.max(
      15,
      Math.round(gaussianIsh(parTime * speedFactor, parTime * 0.25))
    );
    const variance = elapsedTime - parTime;

    // Occasional pause (10% chance)
    const pauseUsed = seededRandom() < 0.1;
    const pauseTime = pauseUsed ? randInt(10, 60) : 0;

    const studyStartSystem = new Date(sessionStart.getTime() + sessionTimeCursor * 1000);

    events.push({
      type: 'STUDY',
      studyNumber,
      startTimeSession: sessionTimeCursor,
      startTimeSystem: studyStartSystem.toISOString(),
      modality,
      complications,
      parTime,
      elapsedTime,
      variance,
      rvu,
      pauseTime,
      pauseUsed,
      drafted: false,
      swapped: false,
    });

    totalRVU += rvu;
    cumulativeParTime += parTime;
    totalStudyTime += elapsedTime;
    sessionTimeCursor += elapsedTime + pauseTime;
    timeSinceLastBreak += elapsedTime + pauseTime;

    // Occasional double-tap (3% chance, reopening the study just completed)
    if (seededRandom() < 0.03 && studyNumber > 1) {
      const dtDur = randInt(15, 90);
      const dtStartSys = new Date(sessionStart.getTime() + sessionTimeCursor * 1000);
      const dtEndSys = new Date(dtStartSys.getTime() + dtDur * 1000);

      events.push({
        type: 'DOUBLE_TAP',
        startTimeSession: sessionTimeCursor,
        startTimeSystem: dtStartSys.toISOString(),
        endTimeSession: sessionTimeCursor + dtDur,
        endTimeSystem: dtEndSys.toISOString(),
        duration: dtDur,
        associatedModality: modality,
      });

      totalDoubleTapTime += dtDur;
      doubleTapEventCount++;
      sessionTimeCursor += dtDur;
      timeSinceLastBreak += dtDur;
    }
  }

  const stopDateTime = new Date(sessionStart.getTime() + sessionTimeCursor * 1000);
  const uid7 = profile.initials.toLowerCase() + 'x'.repeat(5);
  const dateStr = date.toISOString().slice(0, 10).replace(/-/g, '');
  const sessionId = `${dateStr}-${String(sessionNumber).padStart(2, '0')}-${uid7}`;

  const displayName = `${profile.firstName} ${profile.lastName}, ${profile.credentials}`;

  const sessionData = {
    sessionId,
    userAbbrev: uid7,
    workstationId: office,
    system: SYSTEM_NAME,
    rotation,
    halfDay: isHalfDay,
    startDateTime: sessionStart.toISOString(),
    stopDateTime: stopDateTime.toISOString(),
    totalSessionTime: sessionTimeCursor,
    studiesCompleted: studyNumber,
    deletedStudies: 0,
    cumulativeParTime,
    interstitialTime: totalInterstitialTime,
    adminTime: totalAdminTime,
    adminEvents: adminEventCount,
    commsTime: totalCommsTime,
    commsEvents: commsEventCount,
    breakTime: totalBreakTime,
    breakEvents: breakEventCount,
    doubleTapTime: totalDoubleTapTime,
    doubleTapEvents: doubleTapEventCount,
    swapEvents: 0,
    totalRVU: Math.round(totalRVU * 10) / 10,
    displayName,
  };

  return { sessionData, events };
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('RadTach Seed Emulator — generating synthetic data...\n');

  // Step 1: Roll profiles (or load from file for determinism)
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const profilesPath = join(__dirname, 'seedProfiles.json');

  let profiles: RadiologistProfile[];
  if (existsSync(profilesPath)) {
    console.log('Loading existing profiles from seedProfiles.json');
    profiles = JSON.parse(readFileSync(profilesPath, 'utf-8'));
  } else {
    console.log('Rolling new profiles...');
    profiles = rollProfiles();
    writeFileSync(profilesPath, JSON.stringify(profiles, null, 2));
    console.log(`Saved profiles to ${profilesPath}`);
  }

  console.log('\nRadiologist Profiles:');
  console.log('─'.repeat(90));
  console.log(
    'Name'.padEnd(20) +
    'Speed'.padEnd(8) +
    'Best'.padEnd(10) +
    'DayLen'.padEnd(8) +
    'RVU/hr'.padEnd(8) +
    'Offices'
  );
  console.log('─'.repeat(90));
  for (const p of profiles) {
    console.log(
      p.name.padEnd(20) +
      String(p.speed).padEnd(8) +
      p.bestModality.padEnd(10) +
      String(p.dayLength).padEnd(8) +
      p.avgRVUPerHour.toFixed(1).padEnd(8) +
      p.offices.join(', ')
    );
  }
  console.log();

  // Step 2: Create Auth users + Firestore profiles
  const userUIDs: string[] = [];

  for (const profile of profiles) {
    const email = `${profile.initials.toLowerCase()}@test.radtach.com`;
    try {
      let uid: string;
      try {
        const cred = await createUserWithEmailAndPassword(auth, email, 'Test123!');
        uid = cred.user.uid;
        console.log(`Created user: ${profile.name} (${email}) → ${uid}`);
      } catch (createErr: unknown) {
        // User already exists in auth emulator — sign in instead
        const cred = await signInWithEmailAndPassword(auth, email, 'Test123!');
        uid = cred.user.uid;
        console.log(`Existing user: ${profile.name} (${email}) → ${uid}`);
      }
      userUIDs.push(uid);

      // Create user profile
      await setDoc(doc(db, 'users', uid), {
        email,
        timezone: 'America/Chicago',
        firstName: profile.firstName,
        lastName: profile.lastName,
        credentials: profile.credentials,
        createdAt: Timestamp.now(),
      });

      // Create default settings
      await setDoc(doc(db, 'users', uid, 'settings', 'current'), {
        parTimes: DEFAULT_PAR_TIMES,
        rvuValues: DEFAULT_RVU_VALUES,
        stealthMode: false,
        useHMSFormat: false,
        updatedAt: Timestamp.now(),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Failed to create/login user ${profile.name}: ${msg}`);
      userUIDs.push(`fallback-${profile.initials.toLowerCase()}`);
    }
  }

  // Sign back in as Andrew Brown (first user = admin).
  // createUserWithEmailAndPassword auto-signs-in as each user, so after creating 10 users
  // the SDK is authenticated as the last one (Samuel Torres). We need Andrew Brown for admin writes.
  await signInWithEmailAndPassword(auth, `${DOC_TEMPLATES[0].initials.toLowerCase()}@test.radtach.com`, 'Test123!');
  console.log(`\nSigned in as ${DOC_TEMPLATES[0].firstName} ${DOC_TEMPLATES[0].lastName} (admin)`);

  // Step 3: Create Config documents for the test system
  // Bootstrap problem: security rules require Config/admins to exist for isAdmin() check,
  // but we can't write Config/admins without passing isAdmin(). Solve by writing the
  // admins doc via the emulator REST API (bypasses security rules), then use the SDK
  // (which respects rules) for everything else.
  console.log('\nCreating Config documents...');

  const adminMap: Record<string, boolean> = {};
  if (userUIDs[0]) adminMap[userUIDs[0]] = true;

  // Bootstrap: write Config/admins via emulator REST API with owner token (bypasses security rules)
  const adminFields: Record<string, { mapValue: { fields: Record<string, { booleanValue: boolean }> } } | { booleanValue: boolean }> = {};
  for (const uid of Object.keys(adminMap)) {
    adminFields[uid] = { booleanValue: true };
  }
  const restUrl = `http://127.0.0.1:8080/v1/projects/radtach/databases/(default)/documents/Config/admins`;
  const resp = await fetch(restUrl, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer owner',
    },
    body: JSON.stringify({ fields: adminFields }),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Failed to bootstrap Config/admins via REST: ${resp.status} ${errText}`);
  }
  console.log('  Config/admins bootstrapped via REST API (admin = Andrew Brown)');

  // Primary: systems/{system} — offices, rotations, role maps
  await setDoc(doc(db, 'systems', SYSTEM_NAME), {
    offices: OFFICES,
    rotations: ROTATIONS,
    admins: adminMap,
    presidents: {},
    hospitalAdmins: {},
    itAccess: {},
    hospitalAdminIndividualAccess: false,
    adminIndividualAccess: false,
  });
  console.log('  systems/Test System created');

  // Legacy fallback (kept for migration testing — delete these to verify new path works)
  await setDoc(doc(db, 'Config', 'Systems'), {
    [SYSTEM_NAME]: OFFICES,
  });
  console.log('  Config/Systems created (legacy)');

  await setDoc(doc(db, 'Config', 'Rotation'), {
    [SYSTEM_NAME]: ROTATIONS,
  });
  console.log('  Config/Rotation created (legacy)');

  console.log('Config documents created.');

  // Step 4: Generate 30 days of sessions for each doctor
  console.log('\nGenerating sessions...');

  let totalSessions = 0;
  let totalEvents = 0;

  for (let docIdx = 0; docIdx < profiles.length; docIdx++) {
    const profile = profiles[docIdx];
    const uid = userUIDs[docIdx];
    let sessionCount = 0;

    // Sign in as this user so writes pass the _flushedBy rule (request.auth.uid == userId)
    const email = `${profile.initials.toLowerCase()}@test.radtach.com`;
    await signInWithEmailAndPassword(auth, email, 'Test123!');

    for (let dayIdx = 0; dayIdx < 30; dayIdx++) {
      const date = getWorkday(dayIdx);

      // Not every doc works every day (85% chance of working)
      if (seededRandom() < 0.15) continue;

      sessionCount++;
      const { sessionData, events } = generateSession(profile, date, sessionCount);

      // Write session document with startTime index field
      const sessionRef = doc(db, 'users', uid, 'sessions', sessionData.sessionId as string);
      await setDoc(sessionRef, {
        ...sessionData,
        startTime: Timestamp.fromDate(new Date(sessionData.startDateTime as string)),
        endTime: Timestamp.fromDate(new Date(sessionData.stopDateTime as string)),
      });

      // Write events in batches of 500 (Firestore batch limit)
      for (let batchStart = 0; batchStart < events.length; batchStart += 500) {
        const batch = writeBatch(db);
        const batchEvents = events.slice(batchStart, batchStart + 500);
        for (let i = 0; i < batchEvents.length; i++) {
          const eventId = `evt-${String(batchStart + i).padStart(4, '0')}`;
          const eventRef = doc(db, 'users', uid, 'sessions', sessionData.sessionId as string, 'events', eventId);
          batch.set(eventRef, {
            ...batchEvents[i],
            recordedAt: Timestamp.now(),
          });
        }
        await batch.commit();
      }

      totalEvents += events.length;
      totalSessions++;
    }

    console.log(`  ${profile.name}: ${sessionCount} sessions`);
  }

  console.log(`\nDone! Created ${totalSessions} sessions with ${totalEvents} events.`);
  console.log('\nTo use this data:');
  console.log('  1. Start emulators: npx firebase emulators:start');
  console.log('  2. Run seed: npm run seed');
  console.log('  3. Start dev: npm run dev');
  console.log('  4. Log in as ab@test.radtach.com / Test123! (admin/president)');
  console.log('  5. Navigate to Reports to see the data');
}

main().catch(err => {
  console.error('Seed failed:', err);
  process.exit(1);
});
