/**
 * seedCptDatabase.ts — CPT/RVU Database Seeder for RadTach
 *
 * Reads data/cpt-rvu-2026.json and writes to Firestore Config/cptDatabase.
 * By default targets the local emulator; use --prod for production.
 *
 * Usage:
 *   npm run seed:cpt                # emulator (localhost:8080)
 *   npm run seed:cpt -- --prod      # production (radtach.firebaseapp.com)
 *
 * Prerequisites (emulator):
 *   - Firestore emulator running on localhost:8080
 *
 * Prerequisites (production):
 *   - Valid Firebase config in .env
 */

import { initializeApp } from 'firebase/app';
import { getFirestore, connectFirestoreEmulator, doc, setDoc, getDoc } from 'firebase/firestore';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const isProd = process.argv.includes('--prod');

// ── Firebase init ────────────────────────────────────────────────────────────

const app = initializeApp(
  isProd
    ? {
        apiKey: 'AIzaSyA0Dns_j55wLWmQ-qeCS8iufvOpyZ6TFXY',
        authDomain: 'radtach.firebaseapp.com',
        projectId: 'radtach',
      }
    : {
        apiKey: 'fake-api-key',
        authDomain: 'localhost',
        projectId: 'radtach',
      }
);

const db = getFirestore(app);

if (!isProd) {
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const target = isProd ? 'PRODUCTION (radtach.firebaseapp.com)' : 'EMULATOR (localhost:8080)';
  console.log(`\n  CPT Database Seeder — target: ${target}\n`);

  // Read JSON source file
  const jsonPath = join(__dirname, '..', 'data', 'cpt-rvu-2026.json');
  const raw = readFileSync(jsonPath, 'utf-8');
  const database = JSON.parse(raw);

  const entryCount = Object.keys(database.entries).length;
  console.log(`  Loaded ${entryCount} CPT entries from ${jsonPath}`);
  console.log(`  Year: ${database.year}, Source: ${database.source}`);

  // Write to Firestore
  const docRef = doc(db, 'Config', 'cptDatabase');
  console.log(`  Writing to Config/cptDatabase...`);
  await setDoc(docRef, database);
  console.log(`  ✓ Document written`);

  // Verify by reading back
  const verifySnap = await getDoc(docRef);
  if (!verifySnap.exists()) {
    console.error('  ✗ Verification failed — document not found after write');
    process.exit(1);
  }

  const verified = verifySnap.data();
  const verifiedCount = Object.keys(verified.entries || {}).length;
  console.log(`  ✓ Verified: ${verifiedCount} entries read back`);

  // Spot-check a sample entry
  const sampleCpt = '74177';
  const sample = verified.entries?.[sampleCpt];
  if (sample) {
    console.log(`  ✓ Sample: ${sampleCpt} — ${sample.description} — pcRvu=${sample.pcRvu}`);
  } else {
    console.warn(`  ⚠ Sample entry ${sampleCpt} not found in verified data`);
  }

  console.log(`\n  Done.\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
