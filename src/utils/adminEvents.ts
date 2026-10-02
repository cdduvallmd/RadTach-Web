// An ADMIN event is either a press of the Admin button or the Admin time left
// by an undone study (plan step 3c, flagged with `undoneStudy`). Both count
// toward Admin time; only presses count as Admin events, interruptions, or
// meeting candidates. Every reader that counts or classifies ADMIN events
// should use this.
export function isAdminPress(e: { type?: unknown }): boolean {
  return e.type === 'ADMIN' && !(e as { undoneStudy?: unknown }).undoneStudy;
}
