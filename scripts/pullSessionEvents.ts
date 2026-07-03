/**
 * pullSessionEvents.ts — pull events + shadow_events for one or more sessions
 * so we can eyeball where mode-enum and legacy diverge event-by-event.
 *
 * Post-cutover: `events` is mode-enum canonical, `shadow_events` is legacy
 * comparator. This script prints a merged timeline where each event is tagged
 * with its source and duration, so a bridge-across-COMMS pattern (mode-enum
 * holds STUDY live across a COMMS→BREAK, legacy cuts it) shows up as a longer
 * STUDY run in `events` and a shorter one + extra segment boundaries in
 * `shadow_events`.
 *
 * Usage:
 *   npx tsx scripts/pullSessionEvents.ts <session-suffix> [<session-suffix> ...]
 *
 * Where <session-suffix> is the last 4 hex chars shown in the audit output
 * (e.g. "cede" from "20260702-02-x36JKQq-cede"). Script scans recent sessions
 * to resolve suffix → full path.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const SUFFIXES = process.argv.slice(2);
if (SUFFIXES.length === 0) {
  console.error('Usage: pullSessionEvents.ts <session-suffix> [<session-suffix> ...]');
  process.exit(1);
}

const PROJECT = 'radtach';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

interface FirestoreValue {
  stringValue?: string;
  integerValue?: string;
  doubleValue?: number;
  booleanValue?: boolean;
  timestampValue?: string;
  arrayValue?: { values?: FirestoreValue[] };
  mapValue?: { fields?: Record<string, FirestoreValue> };
}

function fromFirestoreValue(v: FirestoreValue | undefined): unknown {
  if (!v) return undefined;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.integerValue !== undefined) return Number(v.integerValue);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.booleanValue !== undefined) return v.booleanValue;
  if (v.timestampValue !== undefined) return v.timestampValue;
  if (v.arrayValue) return (v.arrayValue.values ?? []).map(fromFirestoreValue);
  if (v.mapValue) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v.mapValue.fields ?? {})) out[k] = fromFirestoreValue(x);
    return out;
  }
  return undefined;
}

function flatten(doc: { fields?: Record<string, FirestoreValue> }): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc.fields ?? {})) out[k] = fromFirestoreValue(v);
  return out;
}

async function getAccessToken(): Promise<string> {
  const configPath = join(process.env.HOME || '~', '.config', 'configstore', 'firebase-tools.json');
  const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
  const refreshToken = cfg?.tokens?.refresh_token;
  if (!refreshToken) throw new Error('No Firebase CLI refresh token. Run: firebase login');
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com',
      client_secret: 'j9iVZfS8kkCEFUPaAeJV0sAi',
    }),
  });
  const data = (await resp.json()) as { access_token?: string; error?: string };
  if (!data.access_token) throw new Error(`Token exchange failed: ${data.error}`);
  return data.access_token;
}

async function listUsers(token: string): Promise<string[]> {
  const url = `${BASE}/users?pageSize=300`;
  const out: string[] = [];
  let next: string | undefined;
  do {
    const u = next ? `${url}&pageToken=${encodeURIComponent(next)}` : url;
    const resp = await fetch(u, { headers: { Authorization: `Bearer ${token}` } });
    if (!resp.ok) throw new Error(`list users failed: ${resp.status}`);
    const data = (await resp.json()) as { documents?: Array<{ name: string }>; nextPageToken?: string };
    for (const d of data.documents ?? []) {
      const m = d.name.match(/users\/([^/]+)$/);
      if (m) out.push(m[1]);
    }
    next = data.nextPageToken;
  } while (next);
  return out;
}

async function findSession(
  token: string,
  suffix: string,
): Promise<{ uid: string; sid: string; parentPath: string } | null> {
  // Scan last 14 days of sessions across all users; return the first sid ending in `suffix`.
  const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  const uids = await listUsers(token);
  for (const uid of uids) {
    const body = {
      structuredQuery: {
        from: [{ collectionId: 'sessions' }],
        where: {
          fieldFilter: {
            field: { fieldPath: 'startTime' },
            op: 'GREATER_THAN_OR_EQUAL',
            value: { timestampValue: since },
          },
        },
        limit: 200,
      },
    };
    const resp = await fetch(`${BASE}/users/${uid}:runQuery`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) continue;
    const rows = (await resp.json()) as Array<{ document?: { name: string } }>;
    for (const row of rows) {
      if (!row.document) continue;
      const m = row.document.name.match(/users\/([^/]+)\/sessions\/([^/]+)$/);
      if (!m) continue;
      const [, foundUid, sid] = m;
      if (sid.endsWith(suffix)) {
        return { uid: foundUid, sid, parentPath: `users/${foundUid}/sessions/${sid}` };
      }
    }
  }
  return null;
}

async function listSub(
  token: string,
  parent: string,
  sub: 'events' | 'shadow_events',
): Promise<Array<Record<string, unknown>>> {
  const url = `${BASE}/${parent}/${sub}?pageSize=300`;
  const all: Array<Record<string, unknown>> = [];
  let next: string | undefined;
  do {
    const u = next ? `${url}&pageToken=${encodeURIComponent(next)}` : url;
    const resp = await fetch(u, { headers: { Authorization: `Bearer ${token}` } });
    if (!resp.ok) {
      if (resp.status === 404) return [];
      throw new Error(`list ${sub} failed: ${resp.status}`);
    }
    const data = (await resp.json()) as {
      documents?: Array<{ name: string; fields?: Record<string, FirestoreValue> }>;
      nextPageToken?: string;
    };
    for (const d of data.documents ?? []) all.push(flatten(d));
    next = data.nextPageToken;
  } while (next);
  return all;
}

function tsMs(e: Record<string, unknown>): number {
  const t = e.startTimeSystem ?? e.startTimeSession ?? e.timestamp;
  if (typeof t === 'string') return Date.parse(t);
  if (typeof t === 'number') return t;
  return 0;
}
function dur(e: Record<string, unknown>): number {
  const d = e.duration;
  return typeof d === 'number' ? d : 0;
}
function ty(e: Record<string, unknown>): string {
  return (e.type as string) ?? 'UNKNOWN';
}
function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}
function padL(s: string, n: number): string {
  return s.length >= n ? s : ' '.repeat(n - s.length) + s;
}
function hhmmss(ms: number): string {
  if (!ms) return '  --:--  ';
  const d = new Date(ms);
  return d.toISOString().slice(11, 19);
}
function fmt(e: Record<string, unknown>, i: number): string {
  return `${pad(String(i + 1), 4)} ${pad(hhmmss(tsMs(e)), 10)} ${pad(ty(e), 14)} ${padL(String(Math.round(dur(e))), 8)}s`;
}

/** Type-only alignment walk. Returns divergence windows: contiguous
 *  regions where the sequences don't line up by type. Ignores timestamps
 *  since order is preserved by Firestore doc-ID insertion. */
function findDivergences(
  prod: Array<Record<string, unknown>>,
  shadow: Array<Record<string, unknown>>,
): Array<{ pStart: number; pEnd: number; sStart: number; sEnd: number }> {
  const divs: Array<{ pStart: number; pEnd: number; sStart: number; sEnd: number }> = [];
  let i = 0, j = 0;
  while (i < prod.length && j < shadow.length) {
    if (ty(prod[i]) === ty(shadow[j])) {
      i++; j++; continue;
    }
    // Divergence starts here. Look ahead to find where sequences realign.
    const pStart = i, sStart = j;
    let realigned = false;
    const AHEAD = 8;
    outer: for (let ai = 0; ai <= AHEAD && i + ai < prod.length; ai++) {
      for (let aj = 0; aj <= AHEAD && j + aj < shadow.length; aj++) {
        if (ai === 0 && aj === 0) continue;
        if (ty(prod[i + ai]) === ty(shadow[j + aj])) {
          // Confirm at least 3-event realignment to avoid false positives
          let match = 0;
          for (let k = 0; k < 3 && i + ai + k < prod.length && j + aj + k < shadow.length; k++) {
            if (ty(prod[i + ai + k]) === ty(shadow[j + aj + k])) match++;
            else break;
          }
          if (match >= 3 || (i + ai + match === prod.length) || (j + aj + match === shadow.length)) {
            divs.push({ pStart, pEnd: i + ai - 1, sStart, sEnd: j + aj - 1 });
            i += ai; j += aj;
            realigned = true;
            break outer;
          }
        }
      }
    }
    if (!realigned) {
      divs.push({ pStart, pEnd: prod.length - 1, sStart, sEnd: shadow.length - 1 });
      break;
    }
  }
  // Trailing extras on either side
  if (i < prod.length || j < shadow.length) {
    divs.push({ pStart: i, pEnd: prod.length - 1, sStart: j, sEnd: shadow.length - 1 });
  }
  return divs;
}

function printDivergences(
  prod: Array<Record<string, unknown>>,
  shadow: Array<Record<string, unknown>>,
): void {
  const divs = findDivergences(prod, shadow);
  if (divs.length === 0) {
    console.log(`\n  No divergences — sequences align by type end-to-end.`);
    return;
  }
  console.log(`\n  DIVERGENCES  (n=${divs.length})`);
  for (let k = 0; k < divs.length; k++) {
    const d = divs[k];
    console.log(`\n  ─── Divergence #${k + 1} ───`);
    const CONTEXT = 3;
    const pFrom = Math.max(0, d.pStart - CONTEXT);
    const sFrom = Math.max(0, d.sStart - CONTEXT);
    const pTo = Math.min(prod.length - 1, d.pEnd + CONTEXT);
    const sTo = Math.min(shadow.length - 1, d.sEnd + CONTEXT);
    console.log(`    PROD (mode-enum)   #${d.pStart + 1}..${d.pEnd + 1}  (${d.pEnd - d.pStart + 1} event(s))`);
    for (let i = pFrom; i <= pTo; i++) {
      const marker = i >= d.pStart && i <= d.pEnd ? '  >' : '   ';
      console.log(`   ${marker} ${fmt(prod[i], i)}`);
    }
    console.log(`    SHADOW (legacy)    #${d.sStart + 1}..${d.sEnd + 1}  (${d.sEnd - d.sStart + 1} event(s))`);
    for (let j = sFrom; j <= sTo; j++) {
      const marker = j >= d.sStart && j <= d.sEnd ? '  >' : '   ';
      console.log(`   ${marker} ${fmt(shadow[j], j)}`);
    }
    // Characterize the divergence
    const prodDelta = d.pEnd - d.pStart + 1;
    const shadowDelta = d.sEnd - d.sStart + 1;
    const prodExtraTypes: Record<string, number> = {};
    const shadowExtraTypes: Record<string, number> = {};
    let prodDur = 0, shadowDur = 0;
    for (let i = d.pStart; i <= d.pEnd; i++) {
      prodExtraTypes[ty(prod[i])] = (prodExtraTypes[ty(prod[i])] ?? 0) + 1;
      prodDur += dur(prod[i]);
    }
    for (let j = d.sStart; j <= d.sEnd; j++) {
      shadowExtraTypes[ty(shadow[j])] = (shadowExtraTypes[ty(shadow[j])] ?? 0) + 1;
      shadowDur += dur(shadow[j]);
    }
    console.log(`    ─ Δ prod: ${prodDelta} event(s), ${Math.round(prodDur)}s  (${Object.entries(prodExtraTypes).map(([t, n]) => `${t}×${n}`).join(', ') || '-'})`);
    console.log(`    ─ Δ shadow: ${shadowDelta} event(s), ${Math.round(shadowDur)}s  (${Object.entries(shadowExtraTypes).map(([t, n]) => `${t}×${n}`).join(', ') || '-'})`);
    console.log(`    ─ NET  prod−shadow: ${prodDelta - shadowDelta} event(s), ${Math.round(prodDur - shadowDur)}s`);
  }
}

async function main(): Promise<void> {
  console.log(`\n  Session Event Puller — post-cutover semantics (events = mode-enum, shadow_events = legacy)`);
  const token = await getAccessToken();
  console.log(`  ✓ Authenticated`);

  for (const suffix of SUFFIXES) {
    console.log(`\n  ═════════════════════════════════════════════════════════════════════════════════════════`);
    console.log(`  Resolving suffix "${suffix}"…`);
    const found = await findSession(token, suffix);
    if (!found) {
      console.log(`  ✗ No session with sid ending in "${suffix}" in the last 14 days.`);
      continue;
    }
    console.log(`  ✓ ${found.sid}  (uid=${found.uid})`);

    const [prod, shadow] = await Promise.all([
      listSub(token, found.parentPath, 'events'),
      listSub(token, found.parentPath, 'shadow_events'),
    ]);

    // Sort by wall-clock start; if timestamps missing, doc insertion order
    // survives via the fetch pagination order.
    const pSorted = [...prod].sort((a, b) => tsMs(a) - tsMs(b));
    const sSorted = [...shadow].sort((a, b) => tsMs(a) - tsMs(b));
    console.log(`\n  PROD (mode-enum)   n=${pSorted.length}   SHADOW (legacy)   n=${sSorted.length}`);
    printDivergences(pSorted, sSorted);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
