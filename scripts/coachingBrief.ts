// One-off: pull a user's last N days of session docs (including the
// computeSessionSummary results stored on each) and write a structured brief
// to stdout / /tmp/coaching_brief.json. Used as the input to a draft AI
// coaching read.
//
// Run: npx tsx scripts/coachingBrief.ts --days 56 [--uid <UID>]

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const argv = process.argv.slice(2);
const daysArg = argv.indexOf('--days');
const DAYS = daysArg >= 0 ? Number(argv[daysArg + 1]) || 56 : 56;
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
  nullValue?: null;
}

function fromFirestoreValue(v: FirestoreValue | undefined): unknown {
  if (!v) return undefined;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.integerValue !== undefined) return Number(v.integerValue);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.booleanValue !== undefined) return v.booleanValue;
  if (v.timestampValue !== undefined) return v.timestampValue;
  if (v.nullValue !== undefined) return null;
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
  const data = await resp.json() as { access_token?: string; error?: string };
  if (!data.access_token) throw new Error(`Token exchange failed: ${data.error}`);
  return data.access_token;
}

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

async function fetchUserSessions(token: string, uid: string, sinceIso: string): Promise<Array<Record<string, unknown>>> {
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
    if (resp.status === 404) return [];
    throw new Error(`runQuery for ${uid} failed: ${resp.status}`);
  }
  const rows = await resp.json() as Array<{ document?: { fields?: Record<string, FirestoreValue> } }>;
  return rows
    .filter(r => r.document)
    .map(r => flatten(r.document!));
}

async function main() {
  console.log(`Coaching brief — last ${DAYS} days, project=${PROJECT}`);
  const token = await getAccessToken();
  console.log('✓ Authenticated');

  const sinceIso = new Date(Date.now() - DAYS * 86400 * 1000).toISOString();
  const uids = await listUsers(token);
  console.log(`Found ${uids.length} users to scan`);

  let mainUid: string | null = null;
  let mainSessions: Array<Record<string, unknown>> = [];
  for (const uid of uids) {
    const sessions = await fetchUserSessions(token, uid, sinceIso);
    if (sessions.length > mainSessions.length) {
      mainUid = uid;
      mainSessions = sessions;
    }
  }

  if (!mainUid) {
    console.log('No sessions found.');
    return;
  }

  console.log(`Main user: ${mainUid} with ${mainSessions.length} sessions`);
  // Sort chronologically
  mainSessions.sort((a, b) => String(a.startDateTime ?? '').localeCompare(String(b.startDateTime ?? '')));

  // Strip event-level data (we have session-level summary) and slim
  // the per-session payload to what the brief needs.
  const slim = mainSessions.map(s => ({
    sessionId: s.sessionId,
    startDateTime: s.startDateTime,
    stopDateTime: s.stopDateTime,
    system: s.system,
    rotation: s.rotation,
    halfDay: s.halfDay,
    workstationId: s.workstationId,
    totalSessionTime: s.totalSessionTime,
    studiesCompleted: s.studiesCompleted,
    deletedStudies: s.deletedStudies,
    cumulativeParTime: s.cumulativeParTime,
    interstitialTime: s.interstitialTime,
    adminTime: s.adminTime,
    adminEvents: s.adminEvents,
    commsTime: s.commsTime,
    commsEvents: s.commsEvents,
    breakTime: s.breakTime,
    breakEvents: s.breakEvents,
    doubleTapTime: s.doubleTapTime,
    doubleTapEvents: s.doubleTapEvents,
    swapEvents: s.swapEvents,
    totalRVU: s.totalRVU,
    verifiedRVU: s.verifiedRVU,
    pvcShiftCredit: s.pvcShiftCredit,
    pvcBonusRvu: s.pvcBonusRvu,
    pvcRotationAtStart: s.pvcRotationAtStart,
    pvcWrvuOverride: s.pvcWrvuOverride,
    pvcMeetingHours: s.pvcMeetingHours,
    pvcPendingClassification: s.pvcPendingClassification,
    notes: s.notes,
    summary: s.summary, // computeSessionSummary stored at session end
  }));

  const outPath = '/tmp/coaching_brief.json';
  writeFileSync(outPath, JSON.stringify({ uid: mainUid, daysWindow: DAYS, sessionCount: slim.length, sessions: slim }, null, 2));
  console.log(`Wrote ${slim.length} sessions to ${outPath}`);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
