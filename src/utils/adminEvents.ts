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
// press. Counts only; meeting and interruption readers use isAdminPress.
export function isPress(e: { type?: unknown }): boolean {
  const x = e as { type?: unknown; undoneStudy?: unknown; continued?: unknown };
  return (x.type === 'ADMIN' || x.type === 'COMMS' || x.type === 'BREAK' || x.type === 'DOUBLE_TAP')
    && !x.undoneStudy && !x.continued;
}
