/**
 * seedCptDatabase.ts — CPT/RVU Database Seeder for RadTach
 *
 * Reads data/cpt-rvu-2026.json and writes to Firestore Config/cptDatabase.
 * By default targets the local emulator; use --prod for production.
 *
 * Usage:
 *   npm run seed:cpt                # emulator (localhost:8080)
 *   npm run seed:cpt -- --prod      # production — uses Firebase CLI token
 *                                   #   (requires: firebase login)
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const isProd = process.argv.includes('--prod');

// ── Firestore REST helpers ──────────────────────────────────────────────────

// Convert a JS value to Firestore REST API Value format
function toFirestoreValue(val: unknown): Record<string, unknown> {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === 'string') return { stringValue: val };
  if (typeof val === 'boolean') return { booleanValue: val };
  if (typeof val === 'number') {
    if (Number.isInteger(val)) return { integerValue: String(val) };
    return { doubleValue: val };
  }
  if (Array.isArray(val)) {
    return { arrayValue: { values: val.map(toFirestoreValue) } };
  }
  if (typeof val === 'object') {
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      fields[k] = toFirestoreValue(v);
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(val) };
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

  if (isProd) {
    // ── Production: Firestore REST API with Firebase CLI token ────────────
    const configPath = join(process.env.HOME || '~', '.config', 'configstore', 'firebase-tools.json');
    const firebaseConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
    const refreshToken = firebaseConfig?.tokens?.refresh_token;
    if (!refreshToken) {
      console.error('  ✗ No Firebase CLI refresh token found. Run: firebase login');
      process.exit(1);
    }

    // Exchange refresh token for access token
    const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com',
        client_secret: 'j9iVZfS8kkCEFUPaAeJV0sAi',
      }),
    });
    const tokenData = await tokenResp.json() as { access_token?: string; error?: string };
    if (!tokenData.access_token) {
      console.error('  ✗ Token exchange failed:', tokenData.error || 'unknown error');
      process.exit(1);
    }
    const accessToken = tokenData.access_token;
    console.log('  ✓ Authenticated via Firebase CLI token\n');

    // Build Firestore document body
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(database)) {
      fields[k] = toFirestoreValue(v);
    }

    // Write via REST API (PATCH = create or overwrite)
    const docUrl = 'https://firestore.googleapis.com/v1/projects/radtach/databases/(default)/documents/Config/cptDatabase';
    console.log('  Writing to Config/cptDatabase...');

    const writeResp = await fetch(docUrl, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ fields }),
    });

    if (!writeResp.ok) {
      const errText = await writeResp.text();
      console.error(`  ✗ Write failed (${writeResp.status}):`, errText);
      process.exit(1);
    }
    console.log('  ✓ Document written');

    // Verify by reading back
    const readResp = await fetch(docUrl, {
      headers: { 'Authorization': `Bearer ${accessToken}` },
    });
    if (!readResp.ok) {
      console.error('  ✗ Verification read failed');
      process.exit(1);
    }
    const readData = await readResp.json() as { fields?: Record<string, unknown> };
    const entriesField = readData.fields?.entries as { mapValue?: { fields?: Record<string, unknown> } } | undefined;
    const verifiedCount = Object.keys(entriesField?.mapValue?.fields || {}).length;
    console.log(`  ✓ Verified: ${verifiedCount} entries read back`);
  } else {
    // ── Emulator: client SDK ──────────────────────────────────────────────
    const { initializeApp } = await import('firebase/app');
    const { getFirestore, connectFirestoreEmulator, doc, setDoc, getDoc } = await import('firebase/firestore');

    const app = initializeApp({
      apiKey: 'fake-api-key',
      authDomain: 'localhost',
      projectId: 'radtach',
    });

    const db = getFirestore(app);
    connectFirestoreEmulator(db, '127.0.0.1', 8080);

    const docRef = doc(db, 'Config', 'cptDatabase');
    console.log(`  Writing to Config/cptDatabase...`);
    await setDoc(docRef, database);
    console.log(`  ✓ Document written`);

    const verifySnap = await getDoc(docRef);
    if (!verifySnap.exists()) {
      console.error('  ✗ Verification failed — document not found after write');
      process.exit(1);
    }
    const verified = verifySnap.data();
    const verifiedCount = Object.keys(verified.entries || {}).length;
    console.log(`  ✓ Verified: ${verifiedCount} entries read back`);

    const sampleCpt = '74177';
    const sample = verified.entries?.[sampleCpt];
    if (sample) {
      console.log(`  ✓ Sample: ${sampleCpt} — ${sample.description} — pcRvu=${sample.pcRvu}`);
    } else {
      console.warn(`  ⚠ Sample entry ${sampleCpt} not found in verified data`);
    }
  }

  console.log(`\n  Done.\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
