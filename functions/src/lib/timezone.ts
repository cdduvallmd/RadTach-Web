// Timezone helpers for calendar-day bucketing.
// Uses America/Chicago as the practice default unless the user has a timezone
// configured on their user doc.

import { formatInTimeZone } from 'date-fns-tz';

export const DEFAULT_TZ = 'America/Chicago';

/** Return 'yyyy-MM-dd' for the given date in the given timezone. */
export function isoDateInTimezone(d: Date, tz: string = DEFAULT_TZ): string {
  return formatInTimeZone(d, tz, 'yyyy-MM-dd');
}

/** Return calendar-day bucket key for an ISO timestamp string. */
export function dayKeyForIso(iso: string, tz: string = DEFAULT_TZ): string {
  return isoDateInTimezone(new Date(iso), tz);
}
