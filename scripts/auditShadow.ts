/**
 * auditShadow.ts — Shadow vs Production event audit
 *
 * For each session in the last N days, fetches both the production `events`
 * and parallel `shadow_events` subcollections and reports per-type count and
 * duration diffs. Designed to assess match rate after Clyde's 2026-05-18 fixes.
 *
 * Usage:
 *   npm run audit:shadow                # default: last 7 days, prod
 *   npm run audit:shadow -- --days 14   # specify window
 *   npm run audit:shadow -- --uid <UID> # filter to one user
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const argv = process.argv.slice(2);
const daysArg = argv.indexOf('--days');
const DAYS = daysArg >= 0 ? Number(argv[daysArg + 1]) || 7 : 7;
const uidArg = argv.indexOf('--uid');
const ONLY_UID: string | null = uidArg >= 0 ? argv[uidArg + 1] : null;

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
  if (!refreshToken) {
    throw new Error('No Firebase CLI refresh token. Run: firebase login');
  }
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
  const data = await resp.json() as { access_token?: string; error?: string };
  if (!data.access_token) throw new Error(`Token exchange failed: ${data.error}`);
  return data.access_token;
}

// List user UIDs from /users collection.
async function listUsers(token: string): Promise<string[]> {
  if (ONLY_UID) return [ONLY_UID];
  const url = `${BASE}/users?pageSize=300`;
  const out: string[] = [];
  let next: string | undefined;
  do {
    const u = next ? `${url}&pageToken=${encodeURIComponent(next)}` : url;
    const resp = await fetch(u, { headers: { Authorization: `Bearer ${token}` } });
    if (!resp.ok) throw new Error(`list users failed: ${resp.status}`);
    const data = await resp.json() as { documents?: Array<{ name: string }>; nextPageToken?: string };
    for (const d of data.documents ?? []) {
      const m = d.name.match(/users\/([^/]+)$/);
      if (m) out.push(m[1]);
    }
    next = data.nextPageToken;
  } while (next);
  return out;
}

// Per-user session query with startTime filter — uses default single-collection index.
async function fetchUserSessions(token: string, uid: string, sinceIso: string): Promise<Array<{ uid: string; sid: string; name: string; data: Record<string, unknown> }>> {
  const body = {
    structuredQuery: {
      from: [{ collectionId: 'sessions' }],
      where: {
        fieldFilter: {
          field: { fieldPath: 'startTime' },
          op: 'GREATER_THAN_OR_EQUAL',
          value: { timestampValue: sinceIso },
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
  if (!resp.ok) {
    // 404 = user has no sessions subcollection yet; skip silently
    if (resp.status === 404) return [];
    throw new Error(`runQuery for ${uid} failed: ${resp.status}`);
  }
  const rows = await resp.json() as Array<{ document?: { name: string; fields?: Record<string, FirestoreValue> } }>;
  const out: Array<{ uid: string; sid: string; name: string; data: Record<string, unknown> }> = [];
  for (const row of rows) {
    if (!row.document) continue;
    const name = row.document.name;
    const m = name.match(/users\/([^/]+)\/sessions\/([^/]+)$/);
    if (!m) continue;
    const [, , sid] = m;
    out.push({ uid, sid, name, data: flatten(row.document) });
  }
  return out;
}

async function fetchRecentSessions(token: string, sinceIso: string): Promise<Array<{ uid: string; sid: string; name: string; data: Record<string, unknown> }>> {
  const uids = await listUsers(token);
  const results = await Promise.all(uids.map(uid => fetchUserSessions(token, uid, sinceIso)));
  const flat = results.flat();
  flat.sort((a, b) => String(b.data.startDateTime ?? '').localeCompare(String(a.data.startDateTime ?? '')));
  return flat;
}

async function listSubcollection(token: string, parent: string, sub: 'events' | 'shadow_events'): Promise<Array<Record<string, unknown>>> {
  const url = `${BASE}/${parent}/${sub}?pageSize=300`;
  const all: Array<Record<string, unknown>> = [];
  let next: string | undefined;
  do {
    const u = next ? `${url}&pageToken=${encodeURIComponent(next)}` : url;
    const resp = await fetch(u, { headers: { Authorization: `Bearer ${token}` } });
    if (!resp.ok) {
      // Subcollection missing is fine — return empty.
      if (resp.status === 404) return [];
      throw new Error(`list ${sub} failed: ${resp.status}`);
    }
    const data = await resp.json() as { documents?: Array<{ name: string; fields?: Record<string, FirestoreValue> }>; nextPageToken?: string };
    for (const d of data.documents ?? []) all.push(flatten(d));
    next = data.nextPageToken;
  } while (next);
  return all;
}

type Tally = { count: number; totalDuration: number; totalElapsed: number };
function emptyTally(): Tally { return { count: 0, totalDuration: 0, totalElapsed: 0 }; }

function tallyEvents(events: Array<Record<string, unknown>>): Record<string, Tally> {
  const out: Record<string, Tally> = {};
  for (const e of events) {
    const t = (e.type as string) ?? 'UNKNOWN';
    if (!out[t]) out[t] = emptyTally();
    out[t].count += 1;
    if (typeof e.duration === 'number') out[t].totalDuration += e.duration;
    if (typeof e.elapsedTime === 'number') out[t].totalElapsed += e.elapsedTime;
  }
  return out;
}

const TYPES = ['STUDY', 'INTERSTITIAL', 'ADMIN', 'COMMS', 'BREAK', 'DOUBLE_TAP'];

function fmt(n: number, w: number = 6): string {
  return n.toFixed(0).padStart(w);
}

function pct(matches: number, total: number): string {
  if (total === 0) return '   —';
  return ((matches / total) * 100).toFixed(1).padStart(4) + '%';
}

async function main() {
  console.log(`\n  Shadow Audit — last ${DAYS} days, project=${PROJECT}\n`);
  const token = await getAccessToken();
  console.log('  ✓ Authenticated\n');

  const since = new Date(Date.now() - DAYS * 86400 * 1000).toISOString();
  console.log(`  Fetching sessions started since ${since}...`);
  const sessions = await fetchRecentSessions(token, since);
  console.log(`  Found ${sessions.length} sessions${ONLY_UID ? ` for uid=${ONLY_UID}` : ''}\n`);

  if (sessions.length === 0) {
    console.log('  Nothing to audit.\n');
    process.exit(0);
  }

  // Per-session detail rows
  console.log('  PER-SESSION DETAIL');
  console.log(`  ${'session'.padEnd(36)} ${'rotation'.padEnd(16)} type             prod[n,Σdur]   shadow[n,Σdur]   diff_n   diff_dur`);

  // Aggregate diffs
  let totalSessions = 0;
  let sessionsWithShadow = 0;
  const aggMatch: Record<string, { matchedSessions: number; countMatches: number; durationMatches: number; n: number }> = {};
  for (const t of TYPES) aggMatch[t] = { matchedSessions: 0, countMatches: 0, durationMatches: 0, n: 0 };

  for (const s of sessions) {
    totalSessions += 1;
    const parent = `users/${s.uid}/sessions/${s.sid}`;
    const [prod, shadow] = await Promise.all([
      listSubcollection(token, parent, 'events'),
      listSubcollection(token, parent, 'shadow_events'),
    ]);
    if (shadow.length === 0) continue;
    sessionsWithShadow += 1;

    const prodT = tallyEvents(prod);
    const shadowT = tallyEvents(shadow);
    const rotation = String(s.data.rotation ?? '?').slice(0, 16);
    const shortId = String(s.data.sessionId ?? s.sid).slice(0, 36).padEnd(36);

    for (const t of TYPES) {
      const p = prodT[t] ?? emptyTally();
      const sh = shadowT[t] ?? emptyTally();
      const pDur = t === 'STUDY' ? p.totalElapsed : p.totalDuration;
      const shDur = t === 'STUDY' ? sh.totalElapsed : sh.totalDuration;
      const dn = sh.count - p.count;
      const dd = shDur - pDur;
      const significant = Math.abs(dn) > 0 || Math.abs(dd) > 2; // 2s tolerance
      aggMatch[t].n += 1;
      if (sh.count === p.count) aggMatch[t].countMatches += 1;
      if (Math.abs(dd) <= 2) aggMatch[t].durationMatches += 1;
      if (sh.count === p.count && Math.abs(dd) <= 2) aggMatch[t].matchedSessions += 1;

      if (significant) {
        console.log(`  ${shortId} ${rotation.padEnd(16)} ${t.padEnd(13)} [${fmt(p.count, 3)},${fmt(pDur, 6)}]  [${fmt(sh.count, 3)},${fmt(shDur, 6)}]  ${(dn >= 0 ? '+' : '') + dn}`.padEnd(4) + `   ${dd >= 0 ? '+' : ''}${dd.toFixed(0)}s`);
        shortId.replace(/./g, ' '); // visual continuation
      }
    }
  }

  console.log(`\n  Sessions audited: ${totalSessions} (${sessionsWithShadow} have shadow data)\n`);
  console.log('  MATCH RATES (count match / duration match within ±2s / both)');
  console.log('  ' + 'type'.padEnd(13) + 'count_match'.padStart(13) + 'dur_match'.padStart(13) + 'both'.padStart(13));
  for (const t of TYPES) {
    const a = aggMatch[t];
    if (a.n === 0) continue;
    console.log(`  ${t.padEnd(13)}${pct(a.countMatches, a.n).padStart(13)}${pct(a.durationMatches, a.n).padStart(13)}${pct(a.matchedSessions, a.n).padStart(13)}`);
  }
  console.log();
  process.exit(0);
}

main().catch(err => {
  console.error('\n  ✗', err);
  process.exit(1);
});
