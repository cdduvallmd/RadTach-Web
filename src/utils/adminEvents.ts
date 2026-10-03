// An ADMIN event is either a press of the Admin button or the Admin time left
// by an undone study (plan step 3c, flagged with `undoneStudy`). Both count
// toward Admin time; only presses count as Admin events, interruptions, or
// meeting candidates. Every reader that counts or classifies ADMIN events
// should use this.
export function isAdminPress(e: { type?: unknown }): boolean {
  return e.type === 'ADMIN' && !(e as { undoneStudy?: unknown }).undoneStudy;
}

// One press of Admin, Comms, Break or Double Tap: what the on-screen and
// report counts show (Phase 4). Excludes undone-study Admin and the rest of
// an interruption split at a study's end (`continued`), which is the same
// press. Counts only; meeting (findAdminBlocks) and interruption readers use
// isAdminPress.
export function isPress(e: { type?: unknown }): boolean {
  const x = e as { type?: unknown; undoneStudy?: unknown; continued?: unknown };
  return (x.type === 'ADMIN' || x.type === 'COMMS' || x.type === 'BREAK' || x.type === 'DOUBLE_TAP')
    && !x.undoneStudy && !x.continued;
}

export const ADMIN_BLOCK_MIN_SEC = 30 * 60;

export interface AdminBlockSpan { startTimeSession: number; startTimeSystem: string; durationSec: number }

type TimedLike = { type?: unknown; startTimeSession?: number; startTimeSystem?: string; endTimeSession?: number; duration?: number; continued?: unknown };

// Admin blocks long enough to classify as a meeting (PVC). One block per
// Admin press: a press split at a study's end (its `continued` rest follows
// at the same instant) is one block. `running` adds the Admin still running
// at Stop. Used at End Session and by the retroactive classifier, so both
// offer the same blocks (Phase 6, Clyde 261003f #2).
export function findAdminBlocks(
  events: TimedLike[],
  running?: { start: number; startSystem: string; now: number; continuing: boolean },
  minSec: number = ADMIN_BLOCK_MIN_SEC,
): AdminBlockSpan[] {
  const blocks: Array<AdminBlockSpan & { end: number }> = [];
  const admins = events
    .filter(isAdminPress)
    .sort((a, b) => (a.startTimeSession ?? 0) - (b.startTimeSession ?? 0));
  const add = (start: number, startSystem: string, end: number, dur: number, continued: boolean) => {
    const last = blocks[blocks.length - 1];
    if (continued && last && last.end === start) {
      last.durationSec += dur;
      last.end = end;
    } else {
      blocks.push({ startTimeSession: start, startTimeSystem: startSystem, durationSec: dur, end });
    }
  };
  for (const e of admins) {
    const start = e.startTimeSession ?? 0;
    add(start, e.startTimeSystem ?? '', e.endTimeSession ?? start + (e.duration ?? 0), e.duration ?? 0, !!e.continued);
  }
  if (running && running.now > running.start) {
    add(running.start, running.startSystem, running.now, running.now - running.start, running.continuing);
  }
  return blocks
    .filter(b => b.durationSec >= minSec)
    .map(({ startTimeSession, startTimeSystem, durationSec }) => ({ startTimeSession, startTimeSystem, durationSec }));
}
