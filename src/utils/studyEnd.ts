// When a STUDY ended on the session timeline (mode-enum plan step 3e).
// elapsedTime is reading time only, so start + elapsed is the end only for a
// study nothing interrupted. STUDY events carry the true end
// (`endTimeSession`) from 3c (mode-enum) and 3e (legacy's in-memory copy);
// older events fall back to start + elapsed.
// Totals (study time, RVU, variance) must keep using elapsedTime.
export function studyEndTime(s: { startTimeSession: number; elapsedTime: number; endTimeSession?: number }): number {
  return s.endTimeSession ?? s.startTimeSession + s.elapsedTime;
}
