/**
 * seedEmulator.ts — CPT-Aware Synthetic Test Data Generator for RadTach
 *
 * Seeds the local Firestore emulator with 30 days of realistic radiologist
 * session data for 10 synthetic users. Uses radiologist subspecialty classes
 * (Neuro, Body, MSK, Mammo, General) to drive modality/rotation/CPT selection
 * from the real CMS CPT/RVU database (553 codes).
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
type Specialty = 'Neuro' | 'Body' | 'MSK' | 'Mammo' | 'General';

interface CptEntry {
  cpt: string;
  description: string;
  workRvu: number;
  tcRvu: number;
  modality: string;
  bodyPart: string;
  protocol: string;
}

type ShiftType = 'early' | 'standard' | 'late';

interface RadiologistProfile {
  name: string;
  firstName: string;
  lastName: string;
  credentials: string;
  initials: string;
  gender: 'M' | 'F';
  speed: number;         // studies/hr (8-14)
  specialty: Specialty;
  dayLength: number;     // hours (8-10)
  avgRVUPerHour: number; // rolled stat, used for speed variance
  offices: string[];     // 4-5 of the 10 offices
  shift: ShiftType;      // weekday shift assignment
}

interface SessionEvent {
  type: string;
  [key: string]: unknown;
}

// ── CPT Database Loading ───────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadCptDatabase(): CptEntry[] {
  const cptPath = join(__dirname, '..', 'data', 'cpt-rvu-2026.json');
  const raw = JSON.parse(readFileSync(cptPath, 'utf-8'));
  return Object.values(raw.entries) as CptEntry[];
}

function buildCptIndexes(entries: CptEntry[]) {
  const byModality = new Map<string, CptEntry[]>();
  const byModalityBodyPart = new Map<string, CptEntry[]>();

  for (const entry of entries) {
    if (entry.workRvu <= 0) continue; // Skip facility-only codes

    const mod = entry.modality;
    if (!byModality.has(mod)) byModality.set(mod, []);
    byModality.get(mod)!.push(entry);

    const key = `${mod}|${entry.bodyPart}`;
    if (!byModalityBodyPart.has(key)) byModalityBodyPart.set(key, []);
    byModalityBodyPart.get(key)!.push(entry);
  }

  return { byModality, byModalityBodyPart };
}

// Module-level indexes, populated in main()
let cptByModality: Map<string, CptEntry[]>;
let cptByModalityBodyPart: Map<string, CptEntry[]>;

// ── Constants ──────────────────────────────────────────────────────────────

const ALL_MODALITIES: Modality[] = ['XR', 'FL', 'CT', 'US', 'MR', 'NM', 'MA', 'PET-CT'];

// Kept for user settings writes (backward compat — app reads these from Firestore)
const DEFAULT_PAR_TIMES: Record<Modality, number> = {
  'XR': 90, 'FL': 120, 'CT': 240, 'US': 120, 'MR': 240, 'NM': 240, 'MA': 240, 'PET-CT': 600,
};

const DEFAULT_RVU_VALUES: Record<Modality, number> = {
  'XR': 0.2, 'FL': 0.4, 'CT': 1.0, 'US': 0.5, 'MR': 1.3, 'NM': 0.6, 'MA': 1.3, 'PET-CT': 2.4,
};

// Par time only — RVU comes from CPT database
const COMPLICATIONS = [
  { name: 'Cancer Follow', parAdd: 60 },
  { name: 'Multiple Priors', parAdd: 45 },
  { name: 'Age >70', parAdd: 30 },
  { name: 'Complex Hx', parAdd: 60 },
  { name: 'Prior Surg Hx', parAdd: 45 },
];

const SYSTEM_NAME = 'Test System';

const OFFICES = [
  'Office 1', 'Office 2', 'Office 3', 'Office 4', 'Office 5',
  'Office 6', 'Office 7', 'Office 8', 'Office 9', 'Office 10',
];

const ROTATIONS = ['Body', 'Neuro', 'MSK', 'Chest', 'ER', 'Mammo', 'Call', 'Weekend'];

const DOC_TEMPLATES: Array<{
  firstName: string; lastName: string; initials: string; gender: 'M' | 'F'; specialty: Specialty;
}> = [
  { firstName: 'Andrew', lastName: 'Brown', initials: 'AB', gender: 'M', specialty: 'Neuro' },
  { firstName: 'Claire', lastName: 'Davis', initials: 'CD', gender: 'F', specialty: 'Body' },
  { firstName: 'Ethan', lastName: 'Foster', initials: 'EF', gender: 'M', specialty: 'MSK' },
  { firstName: 'Grace', lastName: 'Harper', initials: 'GH', gender: 'F', specialty: 'Mammo' },
  { firstName: 'Isaac', lastName: 'Jensen', initials: 'IJ', gender: 'M', specialty: 'Body' },
  { firstName: 'Karen', lastName: 'Liu', initials: 'KL', gender: 'F', specialty: 'Neuro' },
  { firstName: 'Marcus', lastName: 'Nash', initials: 'MN', gender: 'M', specialty: 'General' },
  { firstName: 'Olivia', lastName: 'Park', initials: 'OP', gender: 'F', specialty: 'MSK' },
  { firstName: 'Quinn', lastName: 'Rivera', initials: 'QR', gender: 'M', specialty: 'General' },
  { firstName: 'Samuel', lastName: 'Torres', initials: 'ST', gender: 'M', specialty: 'Mammo' },
];

// ── Specialty-Driven Weights ───────────────────────────────────────────────

const SPECIALTY_MODALITY_WEIGHTS: Record<Specialty, Record<string, number>> = {
  Neuro:   { MR: 40, CT: 35, XR: 15, US: 3, FL: 2, NM: 2, MA: 0, 'PET-CT': 3 },
  Body:    { CT: 40, US: 25, MR: 15, FL: 10, XR: 10, NM: 0, MA: 0, 'PET-CT': 0 },
  MSK:     { MR: 35, XR: 35, US: 15, CT: 10, FL: 5, NM: 0, MA: 0, 'PET-CT': 0 },
  Mammo:   { MA: 70, US: 15, MR: 10, CT: 3, XR: 2, FL: 0, NM: 0, 'PET-CT': 0 },
  General: { CT: 25, XR: 25, US: 15, MR: 15, FL: 10, NM: 5, MA: 3, 'PET-CT': 2 },
};

const SPECIALTY_ROTATION_WEIGHTS: Record<Specialty, Record<string, number>> = {
  Neuro:   { Neuro: 60, ER: 25, Body: 5, Chest: 5, MSK: 5 },
  Body:    { Body: 50, Chest: 20, ER: 20, Neuro: 5, MSK: 5 },
  MSK:     { MSK: 60, ER: 25, Body: 5, Neuro: 5, Chest: 5 },
  Mammo:   { Mammo: 75, Body: 10, ER: 10, Chest: 5 },
  General: { ER: 30, Body: 25, Neuro: 15, MSK: 15, Chest: 10, Mammo: 5 },
};

const ROTATION_BODY_PART_WEIGHTS: Record<string, Record<string, number>> = {
  Body: {
    'Abdomen': 10, 'Abdomen/Pelvis': 10, 'Pelvis': 8,
    'Chest': 5, 'Vascular': 3, 'Renal': 3, 'GU': 3,
    'GI Upper': 2, 'GI Lower': 2, 'Retroperitoneal': 2, 'Scrotum': 2,
  },
  Neuro: {
    'Brain': 10, 'Head': 10, 'Spine-C': 8, 'Spine-L': 8,
    'Spine-T': 5, 'Spine-TL': 3, 'Neck': 3,
  },
  MSK: {
    'Shoulder': 10, 'Knee': 10, 'Hip': 8,
    'Ankle/Foot': 5, 'Wrist/Hand': 5, 'Elbow': 5,
    'Joint-Lower': 3, 'Joint-Upper': 3, 'Lower Extremity': 3,
    'Upper Extremity': 3, 'Extremity': 3, 'Bone': 3,
  },
  Chest: {
    'Chest': 10, 'Vascular': 5, 'Cardiac': 5, 'Thyroid': 2,
  },
  ER: {
    'Head': 8, 'Brain': 8, 'Chest': 8, 'Abdomen/Pelvis': 8,
    'Spine-C': 4, 'Spine-L': 4, 'Pelvis': 4, 'Extremity': 4,
    'Lower Extremity': 3, 'Upper Extremity': 3, 'Hip': 3,
    'Knee': 3, 'Ankle/Foot': 3, 'Shoulder': 3, 'Wrist/Hand': 3,
  },
  Mammo: {
    'Breast': 10, 'Bone': 2,
  },
};

const PROTOCOL_WEIGHTS: Record<string, number> = {
  'STANDARD': 10, 'WITHOUT': 10, 'Mammography': 10,
  'WITH': 5, 'Screening': 5, 'Complete': 5,
  'WO/W': 3,
  'CTA': 2, 'Limited': 2, 'MRI': 2, 'Ultrasound': 2,
  'Procedures': 1,
};

const PAR_TIME_PARAMS: Record<Modality, { floor: number; perRvu: number }> = {
  'XR':     { floor: 30,  perRvu: 120 },
  'FL':     { floor: 60,  perRvu: 150 },
  'CT':     { floor: 90,  perRvu: 110 },
  'US':     { floor: 60,  perRvu: 120 },
  'MR':     { floor: 120, perRvu: 80 },
  'NM':     { floor: 120, perRvu: 120 },
  'MA':     { floor: 60,  perRvu: 100 },
  'PET-CT': { floor: 300, perRvu: 120 },
};

// ── Combo Study Templates ──────────────────────────────────────────────────

interface ComboComponent {
  bodyParts: string[];     // Try in order until a matching CPT is found
  preferProtocol?: string; // Prefer this protocol type
}

interface ComboTemplate {
  modality: Modality;
  components: ComboComponent[];
  affinityRotations: string[]; // At least one must match the session rotation
}

const COMBO_RATES: Partial<Record<Modality, number>> = { CT: 0.12, MR: 0.10 };

const COMBO_TEMPLATES: ComboTemplate[] = [
  // CT combos
  { modality: 'CT', components: [
    { bodyParts: ['Chest'], preferProtocol: 'WITH' },
    { bodyParts: ['Abdomen/Pelvis', 'Abdomen'], preferProtocol: 'WITH' },
  ], affinityRotations: ['Body', 'ER', 'Chest'] },
  { modality: 'CT', components: [
    { bodyParts: ['Chest'], preferProtocol: 'WITHOUT' },
    { bodyParts: ['Abdomen/Pelvis', 'Abdomen'], preferProtocol: 'WITHOUT' },
  ], affinityRotations: ['Body', 'ER', 'Chest'] },
  { modality: 'CT', components: [
    { bodyParts: ['Chest'], preferProtocol: 'CTA' },
    { bodyParts: ['Abdomen/Pelvis', 'Abdomen', 'Vascular'], preferProtocol: 'CTA' },
  ], affinityRotations: ['Body', 'ER', 'Chest'] },
  { modality: 'CT', components: [
    { bodyParts: ['Head', 'Brain'], preferProtocol: 'WITHOUT' },
    { bodyParts: ['Head', 'Brain', 'Vascular'], preferProtocol: 'CTA' },
  ], affinityRotations: ['Neuro', 'ER'] },
  { modality: 'CT', components: [
    { bodyParts: ['Head', 'Brain'], preferProtocol: 'WITHOUT' },
    { bodyParts: ['Spine-C'], preferProtocol: 'WITHOUT' },
  ], affinityRotations: ['Neuro', 'ER'] },
  // MR combos
  { modality: 'MR', components: [
    { bodyParts: ['Brain', 'Head'], preferProtocol: 'WITHOUT' },
    { bodyParts: ['Spine-C'], preferProtocol: 'WITHOUT' },
  ], affinityRotations: ['Neuro', 'ER'] },
  { modality: 'MR', components: [
    { bodyParts: ['Spine-L'], preferProtocol: 'WITHOUT' },
    { bodyParts: ['Spine-T'], preferProtocol: 'WITHOUT' },
  ], affinityRotations: ['Neuro', 'MSK'] },
  { modality: 'MR', components: [
    { bodyParts: ['Abdomen'], preferProtocol: 'WITH' },
    { bodyParts: ['Pelvis'], preferProtocol: 'WITH' },
  ], affinityRotations: ['Body'] },
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
  const u1 = seededRandom();
  const u2 = seededRandom();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + z * stdDev;
}

function weightedPick(weights: Record<string, number>): string {
  const entries = Object.entries(weights).filter(([, w]) => w > 0);
  if (entries.length === 0) return '';
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  let r = seededRandom() * total;
  for (const [key, weight] of entries) {
    r -= weight;
    if (r <= 0) return key;
  }
  return entries[entries.length - 1][0];
}

// ── CPT Selection ──────────────────────────────────────────────────────────

function findCptForComponent(
  modality: string,
  bodyParts: string[],
  preferProtocol?: string,
): CptEntry | null {
  for (const bp of bodyParts) {
    const key = `${modality}|${bp}`;
    const candidates = cptByModalityBodyPart.get(key) || [];
    if (candidates.length === 0) continue;

    if (preferProtocol) {
      const preferred = candidates.filter(c => c.protocol === preferProtocol);
      if (preferred.length > 0) return pick(preferred);
    }
    return pick(candidates);
  }
  return null;
}

function selectCptForStudy(
  modality: Modality,
  rotation: string,
): { cpt: string; workRvu: number; tcRvu: number } {
  const bodyPartWeights = ROTATION_BODY_PART_WEIGHTS[rotation] || ROTATION_BODY_PART_WEIGHTS['ER'];

  // Collect candidates weighted by bodyPartAffinity * protocolWeight
  const candidates: Array<{ entry: CptEntry; weight: number }> = [];

  for (const [bodyPart, bpWeight] of Object.entries(bodyPartWeights)) {
    const key = `${modality}|${bodyPart}`;
    const entries = cptByModalityBodyPart.get(key) || [];
    for (const entry of entries) {
      const protWeight = PROTOCOL_WEIGHTS[entry.protocol] || 1;
      candidates.push({ entry, weight: bpWeight * protWeight });
    }
  }

  // Fallback: modality-wide pool (rare modality+rotation combos)
  if (candidates.length === 0) {
    const pool = cptByModality.get(modality) || [];
    if (pool.length === 0) return { cpt: '99199', workRvu: 0.5, tcRvu: 1.25 }; // Ultimate fallback
    const entry = pick(pool);
    return { cpt: entry.cpt, workRvu: entry.workRvu, tcRvu: entry.tcRvu || entry.workRvu * 2.5 };
  }

  // Weighted random selection
  const total = candidates.reduce((sum, c) => sum + c.weight, 0);
  let r = seededRandom() * total;
  for (const c of candidates) {
    r -= c.weight;
    if (r <= 0) return { cpt: c.entry.cpt, workRvu: c.entry.workRvu, tcRvu: c.entry.tcRvu || c.entry.workRvu * 2.5 };
  }
  const last = candidates[candidates.length - 1];
  return { cpt: last.entry.cpt, workRvu: last.entry.workRvu, tcRvu: last.entry.tcRvu || last.entry.workRvu * 2.5 };
}

function tryComboStudy(
  modality: Modality,
  rotation: string,
): { cpts: string[]; workRvu: number; tcRvu: number; parTime: number } | null {
  const eligible = COMBO_TEMPLATES.filter(t =>
    t.modality === modality && t.affinityRotations.includes(rotation)
  );
  if (eligible.length === 0) return null;

  const template = pick(eligible);
  const cpts: string[] = [];
  let totalRvu = 0;
  let totalTcRvu = 0;
  let totalParTime = 0;

  for (const comp of template.components) {
    const entry = findCptForComponent(modality, comp.bodyParts, comp.preferProtocol);
    if (!entry) return null;
    cpts.push(entry.cpt);
    totalRvu += entry.workRvu;
    totalTcRvu += entry.tcRvu || entry.workRvu * 2.5;
    const { floor, perRvu } = PAR_TIME_PARAMS[modality];
    totalParTime += floor + entry.workRvu * perRvu;
  }

  return {
    cpts,
    workRvu: Math.round(totalRvu * 100) / 100,
    tcRvu: Math.round(totalTcRvu * 100) / 100,
    parTime: Math.round(totalParTime * 0.85),
  };
}

function computeParTime(modality: Modality, workRvu: number): number {
  const { floor, perRvu } = PAR_TIME_PARAMS[modality];
  return Math.round(floor + workRvu * perRvu);
}

// ── Stat Rolling ───────────────────────────────────────────────────────────

function rollProfiles(): RadiologistProfile[] {
  // Shift assignments: index 0 = early, 1-6 = standard, 7 = late
  const SHIFT_MAP: ShiftType[] = ['early', 'standard', 'standard', 'standard', 'standard', 'standard', 'standard', 'late', 'standard', 'standard'];

  return DOC_TEMPLATES.map((tmpl, idx) => {
    const shift = SHIFT_MAP[idx];
    // Day length based on shift: early=8h, standard=9h, late=8h
    const dayLength = shift === 'standard' ? 9 : 8;
    const speed = randInt(8, 14);
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
      specialty: tmpl.specialty,
      dayLength,
      avgRVUPerHour,
      offices,
      shift,
    };
  });
}

// ── Session Generation ─────────────────────────────────────────────────────

function generateComplications(): string[] {
  const complications: string[] = [];
  for (const comp of COMPLICATIONS) {
    if (seededRandom() < 0.08) {
      complications.push(comp.name);
    }
  }
  return complications;
}

function getCalendarDay(dayIndex: number): Date {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const date = new Date(today);
  date.setDate(date.getDate() - (30 - dayIndex));
  return date;
}

function isWeekend(date: Date): boolean {
  const dow = date.getDay();
  return dow === 0 || dow === 6;
}

function getWeekNumber(date: Date): number {
  // Week number within the 30-day window (for vacation assignment)
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const daysDiff = Math.floor((today.getTime() - date.getTime()) / 86400000);
  return Math.floor(daysDiff / 7);
}

function generateSession(
  profile: RadiologistProfile,
  date: Date,
  sessionNumber: number,
  weekendSlot?: 'morning' | 'afternoon',
): { sessionData: Record<string, unknown>; events: SessionEvent[] } {
  const events: SessionEvent[] = [];

  // Session start time based on shift type or weekend slot
  let startHour: number;
  let dayDurationHrsBase: number;
  if (weekendSlot === 'morning') {
    startHour = 7 + randFloat(0, 0.3);
    dayDurationHrsBase = 6; // 7am-1pm
  } else if (weekendSlot === 'afternoon') {
    startHour = 13 + randFloat(0, 0.3);
    dayDurationHrsBase = 6; // 1pm-7pm
  } else if (profile.shift === 'early') {
    startHour = 6 + randFloat(0, 0.3);
    dayDurationHrsBase = 8; // 6am-2pm
  } else if (profile.shift === 'late') {
    startHour = 11 + randFloat(0, 0.3);
    dayDurationHrsBase = 8; // 11am-7pm
  } else {
    startHour = 8 + randFloat(0, 0.3);
    dayDurationHrsBase = 9; // 8am-5pm
  }
  const sessionStart = new Date(date);
  sessionStart.setHours(Math.floor(startHour), Math.round((startHour % 1) * 60), 0, 0);

  // Slight day-to-day variance in speed and duration
  const daySpeed = Math.max(4, profile.speed + gaussianIsh(0, 1.5));
  const dayDurationHrs = dayDurationHrsBase + gaussianIsh(0, 0.3);
  const totalStudies = Math.round(daySpeed * dayDurationHrs);
  const totalSessionSec = Math.round(dayDurationHrs * 3600);

  const office = pick(profile.offices);
  const rotation = weekendSlot ? pick(['Call', 'Weekend']) : weightedPick(SPECIALTY_ROTATION_WEIGHTS[profile.specialty]);
  const isOffice7 = office === 'Office 7';

  let sessionTimeCursor = 0; // seconds into session
  let studyNumber = 0;
  let totalRVU = 0;
  let totalTcRVU = 0;
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

    // ── Generate the study (CPT-aware) ──
    studyNumber++;
    const modality = weightedPick(SPECIALTY_MODALITY_WEIGHTS[profile.specialty]) as Modality;

    let studyCpts: string[];
    let workRvu: number;
    let tcRvu: number;
    let parTime: number;

    // Check for combo study
    const comboRate = COMBO_RATES[modality] || 0;
    const combo = comboRate > 0 && seededRandom() < comboRate
      ? tryComboStudy(modality, rotation)
      : null;

    if (combo) {
      studyCpts = combo.cpts;
      workRvu = combo.workRvu;
      tcRvu = combo.tcRvu ?? combo.workRvu * 2.5; // fallback estimate
      parTime = combo.parTime;
    } else {
      const selected = selectCptForStudy(modality, rotation);
      studyCpts = [selected.cpt];
      workRvu = selected.workRvu;
      tcRvu = selected.tcRvu || selected.workRvu * 2.5; // fallback estimate
      parTime = computeParTime(modality, workRvu);
    }

    // Complications (par time only, no RVU effect)
    const complications = generateComplications();
    const compParAdd = complications.reduce((sum, c) => {
      const comp = COMPLICATIONS.find(x => x.name === c);
      return sum + (comp?.parAdd || 0);
    }, 0);
    parTime += compParAdd;

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
      rvu: workRvu,
      pauseTime,
      pauseUsed,
      drafted: false,
      swapped: false,
      rvuSource: 'sidecar',
      cpts: studyCpts,
    });

    totalRVU += workRvu;
    totalTcRVU += tcRvu;
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
    totalRVU: Math.round(totalRVU * 100) / 100,
    totalTcRVU: Math.round(totalTcRVU * 100) / 100,
    displayName,
  };

  return { sessionData, events };
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('RadTach Seed Emulator — CPT-aware synthetic data generator\n');

  // Step 0: Load CPT database and build indexes
  console.log('Loading CPT database...');
  const cptEntries = loadCptDatabase();
  const indexes = buildCptIndexes(cptEntries);
  cptByModality = indexes.byModality;
  cptByModalityBodyPart = indexes.byModalityBodyPart;
  console.log(`  ${cptEntries.length} CPT codes loaded, ${cptByModality.size} modalities indexed`);

  // Print coverage summary
  for (const mod of ALL_MODALITIES) {
    const count = cptByModality.get(mod)?.length || 0;
    console.log(`  ${mod.padEnd(8)} ${count} codes`);
  }
  console.log();

  // Step 1: Roll profiles (or load from file for determinism)
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
  console.log('─'.repeat(95));
  console.log(
    'Name'.padEnd(20) +
    'Specialty'.padEnd(10) +
    'Speed'.padEnd(8) +
    'DayLen'.padEnd(8) +
    'RVU/hr'.padEnd(8) +
    'Offices'
  );
  console.log('─'.repeat(95));
  for (const p of profiles) {
    console.log(
      p.name.padEnd(20) +
      p.specialty.padEnd(10) +
      String(p.speed).padEnd(8) +
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

  // Sign back in as Andrew Brown (first user = admin)
  await signInWithEmailAndPassword(auth, `${DOC_TEMPLATES[0].initials.toLowerCase()}@test.radtach.com`, 'Test123!');
  console.log(`\nSigned in as ${DOC_TEMPLATES[0].firstName} ${DOC_TEMPLATES[0].lastName} (admin)`);

  // Step 3: Create Config documents for the test system
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

  // Primary: systems/{system}
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

  // Legacy fallback
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

  // Tracking for summary stats
  const profileStats: Array<{
    name: string;
    specialty: string;
    sessions: number;
    studies: number;
    totalRvu: number;
    totalHours: number;
    comboCount: number;
    cptCounts: Map<string, number>;
    rotationCounts: Map<string, number>;
    modalityCounts: Map<string, number>;
  }> = profiles.map(p => ({
    name: p.name,
    specialty: p.specialty,
    sessions: 0,
    studies: 0,
    totalRvu: 0,
    totalHours: 0,
    comboCount: 0,
    cptCounts: new Map(),
    rotationCounts: new Map(),
    modalityCounts: new Map(),
  }));

  // Pre-compute vacation weeks per radiologist (1 in 5 chance per week)
  const vacationWeeks: Set<string>[] = profiles.map(() => {
    const weeks = new Set<string>();
    for (let w = 0; w < 5; w++) { // 5 weeks in 30 days
      if (seededRandom() < 0.20) weeks.add(String(w));
    }
    return weeks;
  });

  // Weekend rotation: assign 2 radiologists per weekend day (rotating)
  const weekendAssignments = new Map<string, Array<{ docIdx: number; slot: 'morning' | 'afternoon' }>>();

  for (let docIdx = 0; docIdx < profiles.length; docIdx++) {
    const profile = profiles[docIdx];
    const uid = userUIDs[docIdx];
    const stats = profileStats[docIdx];
    let sessionCount = 0;

    // Sign in as this user
    const email = `${profile.initials.toLowerCase()}@test.radtach.com`;
    await signInWithEmailAndPassword(auth, email, 'Test123!');

    for (let dayIdx = 0; dayIdx < 30; dayIdx++) {
      const date = getCalendarDay(dayIdx);
      const weekNum = getWeekNumber(date);
      const weekend = isWeekend(date);

      // Vacation: skip entire week
      if (vacationWeeks[docIdx].has(String(weekNum))) continue;

      // Determine if this radiologist works today
      let weekendSlot: 'morning' | 'afternoon' | undefined;
      if (weekend) {
        const dayKey = date.toISOString().slice(0, 10);
        if (!weekendAssignments.has(dayKey)) {
          const morningIdx = (dayIdx * 3 + 0) % profiles.length;
          const afternoonIdx = (dayIdx * 3 + 1) % profiles.length;
          weekendAssignments.set(dayKey, [
            { docIdx: morningIdx, slot: 'morning' },
            { docIdx: afternoonIdx, slot: 'afternoon' },
          ]);
        }
        const assignment = weekendAssignments.get(dayKey)!.find(a => a.docIdx === docIdx);
        if (!assignment) continue;
        weekendSlot = assignment.slot;
      } else {
        if (seededRandom() < 0.10) continue;
      }

      sessionCount++;
      const { sessionData, events } = generateSession(profile, date, sessionCount, weekendSlot);

      // Collect stats
      stats.sessions++;
      stats.totalHours += (sessionData.totalSessionTime as number) / 3600;
      stats.totalRvu += sessionData.totalRVU as number;

      const rotation = sessionData.rotation as string;
      stats.rotationCounts.set(rotation, (stats.rotationCounts.get(rotation) || 0) + 1);

      for (const evt of events) {
        if (evt.type === 'STUDY') {
          stats.studies++;
          const cpts = evt.cpts as string[];
          if (cpts.length > 1) stats.comboCount++;
          for (const cpt of cpts) {
            stats.cptCounts.set(cpt, (stats.cptCounts.get(cpt) || 0) + 1);
          }
          const mod = evt.modality as string;
          stats.modalityCounts.set(mod, (stats.modalityCounts.get(mod) || 0) + 1);
        }
      }

      // Write session document
      const sessionRef = doc(db, 'users', uid, 'sessions', sessionData.sessionId as string);
      await setDoc(sessionRef, {
        ...sessionData,
        startTime: Timestamp.fromDate(new Date(sessionData.startDateTime as string)),
        endTime: Timestamp.fromDate(new Date(sessionData.stopDateTime as string)),
      });

      // Write events in batches of 500
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

    console.log(`  ${profile.name} (${profile.specialty}): ${sessionCount} sessions`);
  }

  // ── Summary Statistics ──
  console.log(`\nDone! Created ${totalSessions} sessions with ${totalEvents} events.\n`);

  console.log('─'.repeat(100));
  console.log('SUMMARY STATISTICS');
  console.log('─'.repeat(100));

  console.log('\nPer-Radiologist:');
  console.log(
    'Name'.padEnd(18) +
    'Spec'.padEnd(8) +
    'Sess'.padEnd(6) +
    'Studies'.padEnd(9) +
    'Combos'.padEnd(8) +
    'wRVU'.padEnd(9) +
    'wRVU/hr'.padEnd(9) +
    'Top Modalities'.padEnd(22) +
    'Top Rotations'
  );
  console.log('─'.repeat(100));

  for (const s of profileStats) {
    const rvuPerHr = s.totalHours > 0 ? (s.totalRvu / s.totalHours).toFixed(1) : '—';

    // Top 3 modalities
    const topMods = [...s.modalityCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([m, n]) => `${m}:${n}`)
      .join(' ');

    // Top 3 rotations
    const topRots = [...s.rotationCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([r, n]) => `${r}:${n}`)
      .join(' ');

    console.log(
      s.name.padEnd(18) +
      s.specialty.padEnd(8) +
      String(s.sessions).padEnd(6) +
      String(s.studies).padEnd(9) +
      String(s.comboCount).padEnd(8) +
      s.totalRvu.toFixed(1).padEnd(9) +
      String(rvuPerHr).padEnd(9) +
      topMods.padEnd(22) +
      topRots
    );
  }

  // Unique CPT codes used
  const allCpts = new Set<string>();
  for (const s of profileStats) {
    for (const cpt of s.cptCounts.keys()) allCpts.add(cpt);
  }
  console.log(`\nUnique CPT codes used: ${allCpts.size} of ${cptEntries.length}`);

  // Combo rate verification
  const totalCt = profileStats.reduce((sum, s) => sum + (s.modalityCounts.get('CT') || 0), 0);
  const totalMr = profileStats.reduce((sum, s) => sum + (s.modalityCounts.get('MR') || 0), 0);
  const totalCombos = profileStats.reduce((sum, s) => sum + s.comboCount, 0);
  console.log(`Total CT studies: ${totalCt}, MR studies: ${totalMr}, Combos: ${totalCombos}`);

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
