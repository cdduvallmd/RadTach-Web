/**
 * Add component RVU breakdown (workRvu, facPeRvu, mpRvu) to CPT database.
 *
 * Source: CMS RVU26A — PPRRVU2026_Jan_nonQPP.csv
 * For each CPT in our database:
 *   - If a modifier-26 row exists, use it (professional component)
 *   - If only a global row exists AND our pcRvu matches the work RVU,
 *     set workRvu=pcRvu, facPeRvu=0, mpRvu=0 (work-only code)
 *   - If global row exists AND pcRvu matches the full sum, use all 3 components
 *
 * Verify: workRvu + facPeRvu + mpRvu ≈ pcRvu (within rounding tolerance)
 *
 * Usage: npx tsx scripts/addComponentRvus.ts
 *
 * Prerequisites:
 *   - /tmp/PPRRVU2026_Jan_nonQPP.csv (extract from rvu26a.zip)
 *   - data/cpt-rvu-2026.json (existing CPT database)
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Parse RVU26A CSV ─────────────────────────────────────────────────────────
const csvPath = '/tmp/PPRRVU2026_Jan_nonQPP.csv';
const csvRaw = readFileSync(csvPath, 'utf-8');
const csvLines = csvRaw.split(/\r?\n/);

// Find header row (starts with "HCPCS")
let headerIdx = -1;
for (let i = 0; i < csvLines.length; i++) {
  if (csvLines[i].startsWith('HCPCS')) {
    headerIdx = i;
    break;
  }
}
if (headerIdx === -1) {
  console.error('Could not find HCPCS header row in CSV');
  process.exit(1);
}

// Simple CSV line parser (handles quoted fields)
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      fields.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

interface CmsRow {
  mod: string;       // '26', 'TC', or '' (global)
  work: number;
  facPe: number;
  mp: number;
  pctc: string;      // PC/TC indicator
}

// Build lookup: for each CPT, store mod-26 row and global row
const cmsRows: Record<string, { mod26?: CmsRow; global?: CmsRow }> = {};

for (let i = headerIdx + 1; i < csvLines.length; i++) {
  const line = csvLines[i];
  if (!line.trim()) continue;

  const fields = parseCsvLine(line);
  if (fields.length < 14) continue;

  const cpt = fields[0];
  const mod = fields[1];
  if (!cpt || !/^\d/.test(cpt)) continue;

  const work = parseFloat(fields[5]) || 0;
  const facPe = parseFloat(fields[8]) || 0;
  const mp = parseFloat(fields[10]) || 0;
  const pctc = fields[13] || '';

  const row: CmsRow = { mod, work, facPe, mp, pctc };

  if (!cmsRows[cpt]) cmsRows[cpt] = {};

  if (mod === '26') {
    cmsRows[cpt].mod26 = row;
  } else if (mod === '' || mod === undefined) {
    cmsRows[cpt].global = row;
  }
}

console.log(`Parsed ${Object.keys(cmsRows).length} unique CPTs from RVU26A`);

// ── Load our CPT database ────────────────────────────────────────────────────
const jsonPath = join(__dirname, '..', 'data', 'cpt-rvu-2026.json');
const database = JSON.parse(readFileSync(jsonPath, 'utf-8'));
const entries = database.entries as Record<string, Record<string, unknown>>;

let matched = 0;
let workOnly = 0;
let missing = 0;
let mismatch = 0;

for (const [cpt, entry] of Object.entries(entries)) {
  const pcRvu = entry.pcRvu as number;
  const cms = cmsRows[cpt];

  if (!cms) {
    missing++;
    console.warn(`  MISSING: ${cpt} not found in RVU26A`);
    continue;
  }

  // Prefer modifier-26 row
  if (cms.mod26) {
    const { work, facPe, mp } = cms.mod26;
    const sum = +(work + facPe + mp).toFixed(2);
    const diff = Math.abs(pcRvu - sum);

    if (diff <= 0.02) {
      entry.workRvu = work;
      entry.facPeRvu = facPe;
      entry.mpRvu = mp;
      matched++;
    } else {
      mismatch++;
      console.warn(`  MISMATCH (mod-26): ${cpt} pcRvu=${pcRvu} vs sum=${sum} (W=${work} PE=${facPe} MP=${mp})`);
      // Still set the values — they're from CMS, our pcRvu may need review
      entry.workRvu = work;
      entry.facPeRvu = facPe;
      entry.mpRvu = mp;
    }
  } else if (cms.global) {
    const { work, facPe, mp } = cms.global;
    const globalSum = +(work + facPe + mp).toFixed(2);

    if (Math.abs(pcRvu - globalSum) <= 0.02) {
      // pcRvu matches global sum — use full components
      entry.workRvu = work;
      entry.facPeRvu = facPe;
      entry.mpRvu = mp;
      matched++;
    } else if (Math.abs(pcRvu - work) <= 0.02) {
      // pcRvu matches work RVU only — work-only code
      entry.workRvu = pcRvu;
      entry.facPeRvu = 0;
      entry.mpRvu = 0;
      workOnly++;
    } else {
      mismatch++;
      console.warn(`  MISMATCH (global): ${cpt} pcRvu=${pcRvu} vs globalSum=${globalSum} vs work=${work}`);
      // Default: treat as work-only
      entry.workRvu = pcRvu;
      entry.facPeRvu = 0;
      entry.mpRvu = 0;
    }
  }
}

console.log(`\nResults:`);
console.log(`  Matched (mod-26 or global): ${matched}`);
console.log(`  Work-only (global codes):   ${workOnly}`);
console.log(`  Missing from RVU26A:        ${missing}`);
console.log(`  Mismatched:                 ${mismatch}`);
console.log(`  Total entries:              ${Object.keys(entries).length}`);

// ── Verify all entries have components ────────────────────────────────────────
let hasComponents = 0;
let missingComponents = 0;
for (const entry of Object.values(entries)) {
  if ('workRvu' in entry && 'facPeRvu' in entry && 'mpRvu' in entry) {
    hasComponents++;
  } else {
    missingComponents++;
  }
}
console.log(`\nComponent coverage: ${hasComponents}/${hasComponents + missingComponents}`);

// ── Update metadata and write back ───────────────────────────────────────────
database.updatedAt = new Date().toISOString().slice(0, 10);
writeFileSync(jsonPath, JSON.stringify(database, null, 2) + '\n');
console.log(`\nWrote updated database to ${jsonPath}`);

// ── Spot check ───────────────────────────────────────────────────────────────
const checks = ['74177', '70553', '70030', '71275'];
console.log('\nSpot checks:');
for (const cpt of checks) {
  const e = entries[cpt];
  if (e) {
    const sum = +((e.workRvu as number) + (e.facPeRvu as number) + (e.mpRvu as number)).toFixed(2);
    console.log(`  ${cpt}: pcRvu=${e.pcRvu}, W=${e.workRvu} PE=${e.facPeRvu} MP=${e.mpRvu} sum=${sum}`);
  }
}

console.log('\nDone.');
