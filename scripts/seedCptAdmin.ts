/**
 * Seed CPT database to production Firestore via REST API.
 * Uses the Firebase CLI's stored access token.
 *
 * Usage: npx tsx scripts/seedCptAdmin.ts
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Get a fresh access token via Firebase CLI's refresh token
const configPath = join(homedir(), '.config', 'configstore', 'firebase-tools.json');
const config = JSON.parse(readFileSync(configPath, 'utf-8'));
const refreshToken = config.tokens?.refresh_token;

if (!refreshToken) {
  console.error('No Firebase CLI refresh token found. Run: npx firebase login');
  process.exit(1);
}

// Exchange refresh token for fresh access token using Google OAuth
const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com',
    client_secret: 'j9iVZfS8kkCEFUPaAeJV0sAi',
  }),
});

if (!tokenRes.ok) {
  console.error('Failed to refresh access token:', await tokenRes.text());
  process.exit(1);
}

const tokenData = await tokenRes.json() as { access_token: string };
const accessToken = tokenData.access_token;
console.log('Obtained fresh access token');

// Read CPT data
const jsonPath = join(__dirname, '..', 'data', 'cpt-rvu-2026.json');
const database = JSON.parse(readFileSync(jsonPath, 'utf-8'));
const entryCount = Object.keys(database.entries).length;
console.log(`Loaded ${entryCount} CPT entries`);

// Convert to Firestore REST API format
function toFirestoreValue(val: unknown): unknown {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === 'string') return { stringValue: val };
  if (typeof val === 'boolean') return { booleanValue: val };
  if (typeof val === 'number') {
    return Number.isInteger(val) ? { integerValue: String(val) } : { doubleValue: val };
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

const fields: Record<string, unknown> = {};
for (const [k, v] of Object.entries(database)) {
  fields[k] = toFirestoreValue(v);
}

const body = JSON.stringify({ fields });
console.log(`Payload size: ${(body.length / 1024 / 1024).toFixed(1)} MB`);
console.log('Writing to Config/cptDatabase...');

const url = 'https://firestore.googleapis.com/v1/projects/radtach/databases/(default)/documents/Config/cptDatabase';

const res = await fetch(url, {
  method: 'PATCH',
  headers: {
    'Authorization': `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  },
  body,
});

if (!res.ok) {
  const text = await res.text();
  console.error(`Failed (${res.status}): ${text}`);
  process.exit(1);
}

console.log('Written. Verifying...');

const verifyRes = await fetch(url, {
  headers: { 'Authorization': `Bearer ${accessToken}` },
});
const verifyData = await verifyRes.json() as { fields: Record<string, { mapValue?: { fields: Record<string, unknown> } }> };
const entries = verifyData.fields?.entries?.mapValue?.fields || {};
console.log(`Verified: ${Object.keys(entries).length} entries`);

console.log('Done.');
process.exit(0);
