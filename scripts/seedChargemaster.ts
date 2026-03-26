/**
 * Seed chargemaster to production Firestore via REST API.
 * Uses the Firebase CLI's stored access token.
 *
 * CSV format:
 *   AE Title, CPT1, CPT2, CPT3
 *   CT HEAD WO CONTRAST, 70450
 *   CTA CHEST W CT ABD PEL W, 71275, 74177
 *
 * On import, unknown CPTs are triaged into three buckets:
 *   1. MATCHED — CPT in our database, ready to write
 *   2. CANDIDATE — CPT has work RVU in CMS file but we don't carry it yet
 *   3. FACILITY-ONLY — CPT has no professional component (work RVU = 0)
 *
 * Candidates and facility-only codes are reported but not written.
 * Use --report to write the triage report to a file.
 * Use --dry-run to skip the Firestore write entirely.
 *
 * Usage:
 *   npx tsx scripts/seedChargemaster.ts --csv data/chargemaster.csv --system "Mercy"
 *   npx tsx scripts/seedChargemaster.ts --csv data/chargemaster.csv --system "Mercy" --rvu /tmp/PPRRVU2026_Jan_nonQPP.csv
 *   npx tsx scripts/seedChargemaster.ts --csv data/chargemaster.csv --system "Mercy" --rvu /tmp/PPRRVU2026_Jan_nonQPP.csv --report triage.txt --dry-run
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Parse CLI args ──────────────────────────────────────────────────────────

function getArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 && idx + 1 < process.argv.length ? process.argv[idx + 1] : undefined;
}
function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

const csvPath = getArg('--csv');
const systemName = getArg('--system');
const rvuPath = getArg('--rvu');
const reportPath = getArg('--report');
const dryRun = hasFlag('--dry-run');

if (!csvPath || !systemName) {
  console.error('Usage: npx tsx scripts/seedChargemaster.ts --csv <path> --system <name> [--rvu <cms-rvu.csv>] [--report <out.txt>] [--dry-run]');
  process.exit(1);
}

// ── Load CPT database (our curated 553 entries) ────────────────────────────

const cptJsonPath = join(__dirname, '..', 'data', 'cpt-rvu-2026.json');
const cptDb = JSON.parse(readFileSync(cptJsonPath, 'utf-8'));
const cptEntries: Record<string, { description: string; modality: string; bodyPart: string; protocol: string; workRvu?: number }> = cptDb.entries;
console.log(`Loaded ${Object.keys(cptEntries).length} CPT entries from database`);

// ── Load CMS RVU file (optional, for triage of unknown CPTs) ───────────────

// Parse CMS CSV to extract work RVU and description for any CPT
// Same parser as addComponentRvus.ts
interface CmsLookup {
  description: string;
  workRvu: number;     // modifier-26 work if available, else global work
  globalRvu: number;   // global row total (work + facPE + MP), 0 if no global row
  tcRvu: number;       // TC row total, or global - mod26 if no TC row
  hasPC: boolean;      // true if work RVU > 0 (professional component exists)
}

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

let cmsLookup: Record<string, CmsLookup> | null = null;

// Auto-detect RVU file if not specified
const rvuCandidates = [
  rvuPath,
  '/tmp/PPRRVU2026_Jan_nonQPP.csv',
  join(__dirname, '..', 'data', 'PPRRVU2026_Jan_nonQPP.csv'),
].filter((p): p is string => !!p);

const resolvedRvuPath = rvuCandidates.find(p => existsSync(p));

if (resolvedRvuPath) {
  console.log(`Loading CMS RVU file: ${resolvedRvuPath}`);
  const csvRaw = readFileSync(resolvedRvuPath, 'utf-8');
  const csvLines = csvRaw.split(/\r?\n/);

  let headerIdx = -1;
  for (let i = 0; i < csvLines.length; i++) {
    if (csvLines[i].startsWith('HCPCS')) { headerIdx = i; break; }
  }

  if (headerIdx !== -1) {
    // First pass: collect mod-26, TC, and global rows
    // CMS columns: [0]HCPCS [1]MOD [2]DESC ... [5]WORK_RVU [8]FAC_PE_RVU [10]MP_RVU [11]TOTAL
    interface CmsRaw {
      desc?: string;
      mod26Work?: number; mod26Total?: number;
      tcTotal?: number;
      globalWork?: number; globalTotal?: number;
    }
    const raw: Record<string, CmsRaw> = {};

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
      const total = +(work + facPe + mp).toFixed(2);
      const desc = fields[2] || '';

      if (!raw[cpt]) raw[cpt] = {};
      if (!raw[cpt].desc && desc) raw[cpt].desc = desc;

      if (mod === '26') {
        raw[cpt].mod26Work = work;
        raw[cpt].mod26Total = total;
      } else if (mod === 'TC') {
        raw[cpt].tcTotal = total;
      } else if (mod === '' || mod === undefined) {
        raw[cpt].globalWork = work;
        raw[cpt].globalTotal = total;
      }
    }

    // Second pass: resolve to best values
    cmsLookup = {};
    for (const [cpt, r] of Object.entries(raw)) {
      const workRvu = r.mod26Work ?? r.globalWork ?? 0;
      const globalRvu = r.globalTotal ?? ((r.mod26Total ?? 0) + (r.tcTotal ?? 0));
      const tcRvu = r.tcTotal ?? (globalRvu - (r.mod26Total ?? 0));
      cmsLookup[cpt] = {
        description: r.desc || '(no description)',
        workRvu,
        globalRvu,
        tcRvu: Math.max(0, tcRvu),
        hasPC: workRvu > 0,
      };
    }

    console.log(`Parsed ${Object.keys(cmsLookup).length} CPTs from CMS RVU file`);
  } else {
    console.warn('Could not find HCPCS header row in CMS RVU file — skipping lookup');
  }
} else {
  console.log('No CMS RVU file found — unknown CPTs will not be triaged');
  console.log('  (To enable triage: --rvu /tmp/PPRRVU2026_Jan_nonQPP.csv)');
}

// ── Parse chargemaster CSV ──────────────────────────────────────────────────

interface ChargemasterEntry {
  aeTitle: string;
  cpts: string[];
  bilateralFlags: boolean[];
  modality: string;
  bodyPart: string;
  protocol: string;
  facilityOnly?: boolean;
  globalRvu?: number;
  tcRvu?: number;
  workRvu?: number;
}

const chargemasterCsv = readFileSync(csvPath, 'utf-8');
const lines = chargemasterCsv.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));

const firstLine = lines[0]?.toLowerCase() || '';
const startIdx = (firstLine.includes('ae title') || firstLine.includes('aetitle') || firstLine.includes('cpt')) ? 1 : 0;

const chargemaster: ChargemasterEntry[] = [];

// Triage buckets
interface TriageEntry {
  aeTitle: string;
  cpt: string;
  cmsDesc?: string;
  workRvu?: number;
  globalRvu?: number;
  line: number;
}
const candidates: TriageEntry[] = [];    // Has work RVU in CMS but not in our DB — should add
const facilityOnlyReport: TriageEntry[] = [];  // For the report — individual CPTs with no PC
const fullyUnknown: TriageEntry[] = [];  // Not in CMS file at all
const parseErrors: string[] = [];

// Helper: sum RVUs from CMS for a list of CPTs (for facility-only entries not in our DB)
function sumCmsRvus(cpts: string[]): { globalRvu: number; tcRvu: number; workRvu: number } {
  let globalRvu = 0, tcRvu = 0, workRvu = 0;
  for (const cpt of cpts) {
    const cms = cmsLookup?.[cpt];
    const dbEntry = cptEntries[cpt] as Record<string, unknown> | undefined;
    if (dbEntry) {
      // Use our database values (authoritative)
      globalRvu += (dbEntry.globalRvu as number) || 0;
      tcRvu += (dbEntry.tcRvu as number) || 0;
      workRvu += (dbEntry.workRvu as number) || 0;
    } else if (cms) {
      // Fall back to CMS lookup for codes not in our DB
      globalRvu += cms.globalRvu;
      tcRvu += cms.tcRvu;
      workRvu += cms.workRvu;
    }
  }
  return {
    globalRvu: +globalRvu.toFixed(2),
    tcRvu: +tcRvu.toFixed(2),
    workRvu: +workRvu.toFixed(2),
  };
}

for (let i = startIdx; i < lines.length; i++) {
  const cols = lines[i].split(',').map(c => c.trim());
  const aeTitle = cols[0];
  if (!aeTitle) {
    parseErrors.push(`Line ${i + 1}: Empty AE Title`);
    continue;
  }

  const cpts = cols.slice(1).filter(Boolean);
  if (cpts.length === 0) {
    parseErrors.push(`Line ${i + 1}: No CPT codes for "${aeTitle}"`);
    continue;
  }

  // Classify each CPT
  const knownCpts: string[] = [];       // In our DB
  const candidateCpts: string[] = [];   // Has PC in CMS but not in our DB
  const facilityCpts: string[] = [];    // No PC in CMS (work RVU = 0)
  const unknownCpts: string[] = [];     // Not in CMS at all

  for (const cpt of cpts) {
    if (cptEntries[cpt]) {
      knownCpts.push(cpt);
    } else {
      const cms = cmsLookup?.[cpt];
      if (cms) {
        if (cms.hasPC) {
          candidateCpts.push(cpt);
          candidates.push({ aeTitle, cpt, cmsDesc: cms.description, workRvu: cms.workRvu, globalRvu: cms.globalRvu, line: i + 1 });
        } else {
          facilityCpts.push(cpt);
          facilityOnlyReport.push({ aeTitle, cpt, cmsDesc: cms.description, workRvu: 0, globalRvu: cms.globalRvu, line: i + 1 });
        }
      } else {
        unknownCpts.push(cpt);
        fullyUnknown.push({ aeTitle, cpt, line: i + 1 });
      }
    }
  }

  // Decision: what to write
  const allKnown = knownCpts.length === cpts.length;
  const allFacility = facilityCpts.length === cpts.length;
  const knownPlusFacility = knownCpts.length + facilityCpts.length === cpts.length && knownCpts.length > 0;

  if (allKnown) {
    // All CPTs in our DB — standard professional entry
    const primary = cptEntries[knownCpts[0]];
    const rvus = sumCmsRvus(knownCpts);
    chargemaster.push({
      aeTitle, cpts: knownCpts,
      bilateralFlags: knownCpts.map(() => false),
      modality: primary.modality, bodyPart: primary.bodyPart, protocol: primary.protocol,
      ...rvus,
    });
  } else if (allFacility) {
    // All CPTs are facility-only — retain for global RVU reporting
    const cms0 = cmsLookup?.[facilityCpts[0]];
    const rvus = sumCmsRvus(facilityCpts);
    chargemaster.push({
      aeTitle, cpts: facilityCpts,
      bilateralFlags: facilityCpts.map(() => false),
      modality: 'FACILITY', bodyPart: 'Supply/Admin', protocol: cms0?.description || aeTitle,
      facilityOnly: true,
      ...rvus,
    });
  } else if (knownPlusFacility) {
    // Mix of professional (in our DB) + facility-only CPTs
    // Write the professional CPTs as the entry; facility CPTs contribute to RVU totals
    const primary = cptEntries[knownCpts[0]];
    const rvus = sumCmsRvus([...knownCpts, ...facilityCpts]);
    chargemaster.push({
      aeTitle, cpts: [...knownCpts, ...facilityCpts],
      bilateralFlags: [...knownCpts, ...facilityCpts].map(() => false),
      modality: primary.modality, bodyPart: primary.bodyPart, protocol: primary.protocol,
      ...rvus,
    });
  }
  // else: has candidate or unknown CPTs — skip (need to add those to our DB first)
}

// ── Triage Report ───────────────────────────────────────────────────────────

const report: string[] = [];
function out(line: string) {
  console.log(line);
  report.push(line);
}

out('');
out('═'.repeat(80));
out(`CHARGEMASTER IMPORT TRIAGE — ${systemName}`);
out(`CSV: ${csvPath}`);
out(`Date: ${new Date().toISOString().slice(0, 10)}`);
out('═'.repeat(80));

const profEntries = chargemaster.filter(e => !e.facilityOnly);
const facEntries = chargemaster.filter(e => e.facilityOnly);

out(`\n✓ PROFESSIONAL: ${profEntries.length} entries (${profEntries.filter(e => e.cpts.length > 1).length} combos)`);
out('  Visible to radiologists in Sidecar navigation.');
out('─'.repeat(80));
for (const entry of profEntries.slice(0, 20)) {
  const combo = entry.cpts.length > 1 ? ` [COMBO ${entry.cpts.length}]` : '';
  out(`  ${entry.aeTitle.padEnd(42)} ${entry.cpts.join(', ').padEnd(15)} ${(entry.workRvu ?? 0).toFixed(2)} wRVU  ${(entry.globalRvu ?? 0).toFixed(2)} gRVU${combo}`);
}
if (profEntries.length > 20) out(`  ... and ${profEntries.length - 20} more`);

if (facEntries.length > 0) {
  out(`\n✓ FACILITY-ONLY: ${facEntries.length} entries retained (hidden from Sidecar, used in reports)`);
  out('  No professional component — facility supply/admin/technical-only codes.');
  out('  Used for global RVU impact calculations (outage reports, admin dashboards).');
  out('─'.repeat(80));
  for (const entry of facEntries.slice(0, 15)) {
    out(`  ${entry.aeTitle.padEnd(42)} ${entry.cpts.join(', ').padEnd(15)} ${(entry.globalRvu ?? 0).toFixed(2)} gRVU`);
  }
  if (facEntries.length > 15) out(`  ... and ${facEntries.length - 15} more`);
}

if (candidates.length > 0) {
  out(`\n⚠ CANDIDATES TO ADD: ${candidates.length} CPTs have a professional component but are not in our database`);
  out('  These are legitimate radiology codes we should consider adding to cpt-rvu-2026.json.');
  out('  Their AE Title entries are NOT written until the CPT is added.');
  out('─'.repeat(80));
  const seen = new Set<string>();
  for (const c of candidates) {
    if (seen.has(c.cpt)) continue;
    seen.add(c.cpt);
    out(`  ${c.cpt}  ${(c.workRvu ?? 0).toFixed(2)} wRVU  ${(c.globalRvu ?? 0).toFixed(2)} gRVU  ${(c.cmsDesc || '').padEnd(35)}  ← "${c.aeTitle}"`);
  }
}

if (fullyUnknown.length > 0) {
  out(`\n? UNKNOWN: ${fullyUnknown.length} CPTs not found in CMS RVU file`);
  out('  May be non-radiology, local/custom codes, or HCPCS Level II.');
  out('─'.repeat(80));
  const seen = new Set<string>();
  for (const u of fullyUnknown) {
    if (seen.has(u.cpt)) continue;
    seen.add(u.cpt);
    out(`  ${u.cpt}  (line ${u.line})  ← "${u.aeTitle}"`);
  }
}

if (parseErrors.length > 0) {
  out(`\n✗ PARSE ERRORS: ${parseErrors.length}`);
  out('─'.repeat(80));
  for (const err of parseErrors) out(`  ${err}`);
}

// Summary totals
const totalGlobalRvu = chargemaster.reduce((sum, e) => sum + (e.globalRvu ?? 0), 0);
const totalWorkRvu = chargemaster.reduce((sum, e) => sum + (e.workRvu ?? 0), 0);
const totalTcRvu = chargemaster.reduce((sum, e) => sum + (e.tcRvu ?? 0), 0);

out('');
out('═'.repeat(80));
out(`Entries: ${profEntries.length} professional + ${facEntries.length} facility-only = ${chargemaster.length} total`);
out(`Pending: ${candidates.length} candidates (need DB addition) | ${fullyUnknown.length} unknown | ${parseErrors.length} errors`);
out(`RVU coverage: ${totalWorkRvu.toFixed(2)} wRVU + ${totalTcRvu.toFixed(2)} tcRVU = ${totalGlobalRvu.toFixed(2)} globalRVU across all entries`);
out('═'.repeat(80));

// Write report file if requested
if (reportPath) {
  writeFileSync(reportPath, report.join('\n') + '\n');
  console.log(`\nReport written to: ${reportPath}`);
}

if (chargemaster.length === 0) {
  console.error('\nNo valid entries to write.');
  process.exit(1);
}

if (dryRun) {
  console.log('\n--dry-run: skipping Firestore write.');
  process.exit(0);
}

// ── Auth ─────────────────────────────────────────────────────────────────────

const configPath = join(homedir(), '.config', 'configstore', 'firebase-tools.json');
const config = JSON.parse(readFileSync(configPath, 'utf-8'));
const refreshToken = config.tokens?.refresh_token;

if (!refreshToken) {
  console.error('No Firebase CLI refresh token found. Run: npx firebase login');
  process.exit(1);
}

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
console.log('\nObtained fresh access token');

// ── Write to Firestore ──────────────────────────────────────────────────────

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

const url = `https://firestore.googleapis.com/v1/projects/radtach/databases/(default)/documents/systems/${encodeURIComponent(systemName)}?updateMask.fieldPaths=chargemaster`;

const body = JSON.stringify({
  fields: {
    chargemaster: toFirestoreValue(chargemaster),
  },
});

console.log(`Payload size: ${(body.length / 1024).toFixed(1)} KB`);
console.log(`Writing ${chargemaster.length} entries to systems/${systemName}.chargemaster...`);

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

console.log(`Written. ${chargemaster.length} entries, ${chargemaster.filter(e => e.cpts.length > 1).length} combos.`);
console.log('Done.');
process.exit(0);
