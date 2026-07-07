/**
 * repairSwapElapsedTime.ts — one-shot repair for today's swap-flagged STUDY
 * events written before the applySwap elapsedTime bug fix landed.
 *
 * Old (buggy) formula:
 *   elapsedTime = interstitial.originalDuration
 * Correct formula:
 *   elapsedTime = interstitial.originalDuration + currentTime - 10
 *              = T_par - study.startTimeSession
 *   where T_par = session time when Par Time was pressed to end the study
 *              = startTimeSession of the immediately-next event after the STUDY
 *
 * Reconstruction strategy:
 *   1. Fetch all events sorted by Firestore doc ID (proxy for insertion order —
 *      Firestore auto-IDs are timestamp-prefixed base62 strings so this
 *      approximates real-time write order much better than sorting by
 *      startTimeSystem (which is swap-corrupted for swapped studies)).
 *   2. For each STUDY with swapped:true, find the doc that comes immediately
 *      after it in the sorted list.
 *   3. Compute new_elapsed = next_doc.startTimeSession - study.startTimeSession
 *   4. Sanity gate: skip if new_elapsed <= old_elapsed (no improvement),
 *      OR if new_elapsed > 3 × parTime (unrealistic — probably stale-state
 *      swap that grabbed a wrong interstitial hours earlier).
 *   5. Update study.elapsedTime AND study.variance = new_elapsed - parTime.
 *
 * Usage:
 *   npx tsx scripts/repairSwapElapsedTime.ts --dry-run       # preview only
 *   npx tsx scripts/repairSwapElapsedTime.ts                 # apply
 *
 * Only touches session 20260706-01. Extend to a range later if needed.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const PROJECT = 'radtach';
const UID = 'x36JKQqVh8NCgyLhLSCBSIyAMUn2';
const SID = '20260706-01-x36JKQq-bac8';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const PARENT = `users/${UID}/sessions/${SID}`;
const DRY_RUN = process.argv.includes('--dry-run');

async function getAccessToken(): Promise<string> {
  const configPath = join(process.env.HOME || '~', '.config', 'configstore', 'firebase-tools.json');
  const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: cfg.tokens.refresh_token,
      client_id: '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com',
      client_secret: 'j9iVZfS8kkCEFUPaAeJV0sAi',
    }),
  });
  return (await resp.json() as { access_token: string }).access_token;
}

interface EventDoc {
  docId: string;
  fields: Record<string, any>;
}

async function fetchEventsInInsertionOrder(token: string): Promise<EventDoc[]> {
  const all: EventDoc[] = [];
  let next: string | undefined;
  do {
    const url = `${BASE}/${PARENT}/events?pageSize=500${next ? `&pageToken=${encodeURIComponent(next)}` : ''}`;
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!resp.ok) throw new Error(`list events failed: ${resp.status}`);
    const data = await resp.json() as { documents?: Array<{ name: string; fields?: any }>; nextPageToken?: string };
    for (const d of data.documents ?? []) {
      const m = d.name.match(/events\/([^/]+)$/);
      if (!m) continue;
      const fields: Record<string, any> = {};
      for (const [k, v] of Object.entries(d.fields ?? {})) {
        const vv = v as any;
        if (vv.stringValue !== undefined) fields[k] = vv.stringValue;
        else if (vv.doubleValue !== undefined) fields[k] = vv.doubleValue;
        else if (vv.integerValue !== undefined) fields[k] = Number(vv.integerValue);
        else if (vv.booleanValue !== undefined) fields[k] = vv.booleanValue;
        else if (vv.timestampValue !== undefined) fields[k] = vv.timestampValue;
      }
      all.push({ docId: m[1], fields });
    }
    next = data.nextPageToken;
  } while (next);
  // Sort by doc ID as insertion-order proxy. Firestore auto-IDs are 20-char
  // base62 strings with a timestamp prefix, so lexicographic sort ≈ time order.
  all.sort((a, b) => a.docId.localeCompare(b.docId));
  return all;
}

async function patchEvent(
  token: string,
  docId: string,
  fields: { elapsedTime: number; variance: number },
): Promise<void> {
  const body = {
    fields: {
      elapsedTime: { doubleValue: fields.elapsedTime },
      variance: { doubleValue: fields.variance },
    },
  };
  const mask = 'updateMask.fieldPaths=elapsedTime&updateMask.fieldPaths=variance';
  const resp = await fetch(`${BASE}/${PARENT}/events/${docId}?${mask}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    throw new Error(`patch ${docId} failed: ${resp.status} — ${await resp.text()}`);
  }
}

async function main(): Promise<void> {
  console.log(`\n  Swap elapsedTime repair — session ${SID}   ${DRY_RUN ? '(DRY RUN)' : '(WRITING)'}\n`);
  const token = await getAccessToken();
  console.log('  ✓ Authenticated');
  const events = await fetchEventsInInsertionOrder(token);
  console.log(`  ✓ Fetched ${events.length} event(s) sorted by insertion order`);

  console.log(`\n  ${'#'.padEnd(4)} ${'docId'.padEnd(22)} ${'modality'.padEnd(3)} ${'oldElapsed'.padStart(11)} ${'nextStart'.padStart(9)} ${'studyStart'.padStart(10)} ${'newElapsed'.padStart(11)}  action`);

  let repaired = 0;
  let skipped = 0;
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev.fields.type !== 'STUDY' || ev.fields.swapped !== true) continue;
    const oldElapsed = Number(ev.fields.elapsedTime ?? 0);
    const parTime = Number(ev.fields.parTime ?? 0);
    const studyStart = Number(ev.fields.startTimeSession ?? 0);
    const modality = ev.fields.modality ?? '?';

    // Find the immediately-next event by insertion order
    const nextEv = events[i + 1];
    if (!nextEv) {
      console.log(`  #${String(i+1).padEnd(3)} ${ev.docId.padEnd(22)} ${modality.padEnd(3)} ${String(oldElapsed).padStart(11)}   (no next event)                              SKIP (last)`);
      skipped++;
      continue;
    }
    const nextStart = Number(nextEv.fields.startTimeSession ?? 0);
    const newElapsed = nextStart - studyStart;

    let action = '';
    let apply = true;
    if (newElapsed <= oldElapsed) {
      action = 'SKIP (no improvement)';
      apply = false;
    } else if (newElapsed > 3 * parTime && parTime > 0) {
      action = `SKIP (${newElapsed}s > 3×parTime, likely stale-state swap)`;
      apply = false;
    } else if (newElapsed < 0) {
      action = 'SKIP (negative)';
      apply = false;
    } else {
      action = `patch to ${newElapsed}s, variance ${newElapsed - parTime}`;
    }
    console.log(`  #${String(i+1).padEnd(3)} ${ev.docId.padEnd(22)} ${modality.padEnd(3)} ${String(oldElapsed).padStart(11)} ${String(nextStart).padStart(9)} ${String(studyStart).padStart(10)} ${String(newElapsed).padStart(11)}  ${action}`);

    if (apply) {
      if (!DRY_RUN) {
        await patchEvent(token, ev.docId, {
          elapsedTime: newElapsed,
          variance: newElapsed - parTime,
        });
      }
      repaired++;
    } else {
      skipped++;
    }
  }

  console.log(`\n  ${DRY_RUN ? 'Would repair' : 'Repaired'}: ${repaired}   Skipped: ${skipped}\n`);
  if (DRY_RUN) console.log(`  Re-run without --dry-run to apply.\n`);
}

main().catch(err => { console.error(err); process.exit(1); });
