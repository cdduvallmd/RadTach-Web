/**
 * Build static GPCI lookup files from CMS source data.
 *
 * Input:
 *   /tmp/localities2026.csv     — GPCI values by locality (110 rows)
 *   /tmp/ZIP5_APR2026.txt       — Fixed-width ZIP→carrier/locality mapping (43K rows)
 *
 * Output:
 *   data/gpci-2026.json         — Locality code → { name, work, pe, mp }
 *   data/zip-locality.json      — ZIP → 7-digit locality code
 *
 * Usage: npx tsx scripts/buildGpciData.ts
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const dataDir = join(__dirname, '..', 'data');

// ── Parse localities CSV ─────────────────────────────────────────────────────
// Format: year,gpci_work,gpci_pe,gpci_mp,locality,loc_description,mac,mac_description
const localitiesCsv = readFileSync('/tmp/localities2026.csv', 'utf-8');
const localityLines = localitiesCsv.trim().split('\n').slice(1); // skip header

interface GpciRow {
  name: string;
  work: number;
  pe: number;
  mp: number;
}

const gpciTable: Record<string, GpciRow> = {};

for (const line of localityLines) {
  // CSV with possible commas in description — split carefully
  const parts = line.split(',');
  // year=0, gpci_work=1, gpci_pe=2, gpci_mp=3, locality=4, loc_description=5+, mac, mac_description
  const work = parseFloat(parts[1]);
  const pe = parseFloat(parts[2]);
  const mp = parseFloat(parts[3]);
  const locality = parts[4].trim();

  // Description may contain commas — rejoin from parts[5] to second-to-last two fields
  // mac is 5-digit, mac_description is last
  // Find mac field: it's a 5-digit number near the end
  // Safer: locality is 7 digits, mac is 5 digits
  // Work backwards: last field = mac_description, second-to-last = mac
  const macDesc = parts[parts.length - 1].trim();
  const mac = parts[parts.length - 2].trim();
  const name = parts.slice(5, parts.length - 2).join(',').trim();

  if (locality === '0000000') continue; // skip NATIONAL row

  gpciTable[locality] = {
    name,
    work: +work.toFixed(3),
    pe: +pe.toFixed(3),
    mp: +mp.toFixed(3),
  };
}

console.log(`Parsed ${Object.keys(gpciTable).length} locality entries`);

// ── Parse ZIP5 fixed-width file ──────────────────────────────────────────────
// Layout: State(1-2), ZIP(3-7), Carrier(8-12), PricingLocality(13-14)
// 7-digit locality code = Carrier(5) + Locality(2)
const zip5Raw = readFileSync('/tmp/ZIP5_APR2026.txt', 'utf-8');
const zip5Lines = zip5Raw.trim().split(/\r?\n/);

const zipLocality: Record<string, string> = {};
let unmapped = 0;

for (const line of zip5Lines) {
  const zip = line.substring(2, 7).trim();
  const carrier = line.substring(7, 12).trim();
  const pricingLocality = line.substring(12, 14).trim();

  if (!zip || !carrier || !pricingLocality) continue;

  const localityCode = carrier + pricingLocality;

  // Only include ZIPs that map to a known locality
  if (gpciTable[localityCode]) {
    zipLocality[zip] = localityCode;
  } else {
    unmapped++;
  }
}

console.log(`Parsed ${Object.keys(zipLocality).length} ZIP→locality mappings (${unmapped} unmapped)`);

// ── Write output files ───────────────────────────────────────────────────────
const gpciPath = join(dataDir, 'gpci-2026.json');
writeFileSync(gpciPath, JSON.stringify(gpciTable, null, 2) + '\n');
console.log(`Wrote ${gpciPath}`);

const zipPath = join(dataDir, 'zip-locality.json');
// Compact format for zip-locality (no pretty-print — 43K entries)
writeFileSync(zipPath, JSON.stringify(zipLocality) + '\n');
console.log(`Wrote ${zipPath} (${(Buffer.byteLength(JSON.stringify(zipLocality)) / 1024).toFixed(0)} KB)`);

// ── Verify a sample ──────────────────────────────────────────────────────────
const sampleZip = '77001'; // Houston, TX
const sampleLocality = zipLocality[sampleZip];
if (sampleLocality) {
  const sampleGpci = gpciTable[sampleLocality];
  console.log(`\nSample: ZIP ${sampleZip} → locality ${sampleLocality} → ${sampleGpci?.name}`);
  console.log(`  Work: ${sampleGpci?.work}, PE: ${sampleGpci?.pe}, MP: ${sampleGpci?.mp}`);
} else {
  console.log(`\nSample ZIP ${sampleZip} not found in mapping`);
}

console.log('\nDone.');
