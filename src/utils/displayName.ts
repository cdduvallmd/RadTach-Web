// Resolve display name from session data.
// Checks displayName field (new sessions), falls back to userAbbrev.slice(0, 7) (legacy sessions).

import type { StoredSession } from '../types/reports';

export function getDisplayName(sessions: StoredSession[]): string {
  for (const s of sessions) {
    if (s.displayName) return s.displayName;
  }
  return sessions.length > 0 ? sessions[0].userAbbrev.slice(0, 7) : 'Unknown';
}
