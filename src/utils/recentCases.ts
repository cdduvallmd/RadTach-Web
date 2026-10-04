// Recent Cases (October 2026 UI Refresh): the last few studies as a passive
// visual checksum against the worklist. Derived from mode-enum's event list on
// every render; nothing here is recorded. Exam names come from an in-memory map
// keyed by studyId and are never persisted (owner, 2026-10-04: RadTach must not
// name the exam it timed — legal discovery risk).
import type { ModeEvent } from '../hooks/useTimerMode';

export type RecentState = 'inProgress' | 'normal' | 'bilateral' | 'doubleTap' | 'undone';

export interface RecentRow {
  key: string;
  name: string;
  rvu: number;
  markers: string;   // B bilateral, C combo, ↻ double tap (all that apply)
  state: RecentState; // drives the text color; precedence undone > doubleTap > bilateral > normal
}

export interface InProgress {
  studyId: string;
  name: string;
  rvu: number;
  bilateral: boolean;
  combo: boolean;
}

const MAX_ROWS = 5;

// Name for a study picked from the modality grid: the modality plus any
// complications other than Bilateral (which has its own B marker).
export function gridStudyName(modality: string, complications: string[]): string {
  const extra = complications.filter(c => c !== 'Bilateral');
  return extra.length > 0 ? `${modality} (${extra.join(', ')})` : modality;
}

export function deriveRecentCases(
  events: ModeEvent[],
  names: ReadonlyMap<string, string>,
  inProgress: InProgress | null,
  doubleTapRunning = false, // a double tap shows while it runs, not only once it ends
): RecentRow[] {
  type Done = { key: string; name: string; rvu: number; bilateral: boolean; combo: boolean; undone: boolean; doubleTap: boolean };
  const done: Done[] = [];
  for (const e of events) {
    if (e.type === 'STUDY') {
      done.push({
        key: e.studyId ?? `n${e.studyNumber}`,
        name: (e.studyId && names.get(e.studyId)) || gridStudyName(e.modality, e.complications),
        rvu: e.rvu,
        bilateral: e.complications.includes('Bilateral'),
        combo: (e.cpts?.length ?? 0) > 1,
        undone: false,
        doubleTap: false,
      });
    } else if (e.type === 'ADMIN' && e.undoneStudy?.originalType === 'STUDY'
      && !e.undoneStudy.neverResumed && !e.undoneStudy.openAtStop) {
      const u = e.undoneStudy;
      done.push({
        key: u.studyId,
        name: names.get(u.studyId) || gridStudyName(u.modality ?? '', u.complications ?? []),
        rvu: u.rvu ?? 0,
        bilateral: (u.complications ?? []).includes('Bilateral'),
        combo: (u.cpts?.length ?? 0) > 1,
        undone: true,
        doubleTap: false,
      });
    } else if (e.type === 'DOUBLE_TAP' && done.length > 0) {
      // Double tap reopens the study just completed (owner, 2026-10-04).
      done[done.length - 1].doubleTap = true;
    }
  }
  if (doubleTapRunning && done.length > 0) done[done.length - 1].doubleTap = true;

  const rows: RecentRow[] = done.map(d => ({
    key: d.key,
    name: d.name,
    rvu: d.rvu,
    markers: `${d.bilateral ? 'B' : ''}${d.combo ? 'C' : ''}${d.doubleTap ? '↻' : ''}`,
    state: d.undone ? 'undone' : d.doubleTap ? 'doubleTap' : d.bilateral ? 'bilateral' : 'normal',
  }));
  if (inProgress) {
    rows.push({
      key: `open-${inProgress.studyId}`,
      name: inProgress.name,
      rvu: inProgress.rvu,
      markers: `${inProgress.bilateral ? 'B' : ''}${inProgress.combo ? 'C' : ''}`,
      state: 'inProgress',
    });
  }
  return rows.reverse().slice(0, MAX_ROWS); // newest on top
}
