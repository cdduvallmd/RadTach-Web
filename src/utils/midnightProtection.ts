// Midnight Protection (Epic midnight-boundary handling, owner 2026-10-06).
// Epic's running RVU total resets at local midnight, so a session that crosses
// midnight needs the pre-midnight total, and a second session the same day
// needs Epic's total at its start (baseline). Pure helpers; App wires them.
// Kept separate from PVC's same-day shift credit on purpose.

export const DEFAULT_PROMPT_TIME = '23:50';

/** Local date part (YYYY-MM-DD) of a local ISO string like 2026-10-05T21:24:01. */
export function localDate(iso: string): string {
  return iso.slice(0, 10);
}

/** Local date of `d` as YYYY-MM-DD. */
export function dateOf(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** True from the prompt time (HH:MM, local) until midnight. */
export function inPromptWindow(now: Date, promptTime: string): boolean {
  const [h, m] = promptTime.split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return false;
  return now.getHours() * 60 + now.getMinutes() >= h * 60 + m;
}

const num = (s: string): number | null => {
  const t = s.trim();
  if (t === '') return null;
  const v = parseFloat(t);
  return Number.isFinite(v) ? v : null;
};

export interface EpicInputs {
  baseline: string;    // Epic's total at session start (blank = 0)
  preMidnight: string; // Epic's total just before midnight (crossed sessions)
  end: string;         // Epic's total at Stop (or the combined figure if missed)
  crossed: boolean;    // the session crossed local midnight
}

export interface EpicResult {
  verifiedRVU: number | null;
  missed: boolean;     // crossed midnight with no pre-midnight total: `end` is the combined figure
  negative: boolean;   // the totals give less than zero: not stored (Clyde 261006 #3)
}

/**
 * This session's Epic RVU:
 * - no midnight crossing: end − baseline
 * - crossed midnight: (pre-midnight − baseline) + end  (Epic reset at midnight)
 * - crossed, pre-midnight missed: `end` is the combined figure, used as is
 */
export function computeEpicRVU(x: EpicInputs): EpicResult {
  const end = num(x.end);
  if (end === null) return { verifiedRVU: null, missed: false, negative: false };
  const baseline = num(x.baseline) ?? 0;
  const pre = num(x.preMidnight);
  const missed = x.crossed && pre === null;
  const value = !x.crossed ? end - baseline : missed ? end : (pre as number) - baseline + end;
  if (value < 0) return { verifiedRVU: null, missed, negative: true };
  return { verifiedRVU: +value.toFixed(2), missed, negative: false };
}
