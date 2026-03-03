// GAR Aggregation Trigger — runs on admin login
// Checks last 7 dates for missing groupStats documents.
// For each missing date, fetches all sessions via collectionGroup,
// computes GroupStats/CompositeStats/WorkstationStats, and writes to Firestore.
// Also processes stale GAR markers left by offline buffer replays.

import { firestoreService } from '../services/firestore';
import { computeGroupStats, computeCompositeStats, computeWorkstationStats } from './garComputation';
import { format, subDays } from 'date-fns';

const STALE_MARKER_MAX_AGE_DAYS = 30;

export interface GARTriggerResult {
  daysChecked: number;
  daysComputed: number;
  staleDaysRecomputed: number;
  errors: string[];
}

export async function triggerGARAggregation(
  _adminUserId: string,
  system: string
): Promise<GARTriggerResult> {
  const result: GARTriggerResult = { daysChecked: 0, daysComputed: 0, staleDaysRecomputed: 0, errors: [] };

  // Check last 7 days (skip today — sessions may still be in progress)
  const today = new Date();
  const datesToCheck: string[] = [];
  for (let i = 1; i <= 7; i++) {
    const d = subDays(today, i);
    datesToCheck.push(format(d, 'yyyy-MM-dd'));
  }

  for (const dateStr of datesToCheck) {
    result.daysChecked++;

    try {
      // Check if stats already exist for this date
      const exists = await firestoreService.groupStatsExists(system, dateStr);
      if (exists) continue;

      // Fetch all sessions for this system on this date
      const dayStart = new Date(dateStr + 'T00:00:00Z');
      const dayEnd = new Date(dateStr + 'T23:59:59.999Z');
      const sessions = await firestoreService.getAllSessionsForSystem(system, dayStart, dayEnd);

      if (sessions.length === 0) continue;

      // Compute and write GroupStats (GAR)
      const groupStats = computeGroupStats(sessions, system, dateStr);
      if (groupStats) {
        await firestoreService.writeGroupStats(system, dateStr, groupStats);

        // Attempt CompositeStats (CR) — best-effort
        // CR requires stats from 2+ systems. Query all systems' GroupStats for this date.
        try {
          const allSystemStats = await firestoreService.getAllGroupStatsForDate(dateStr);
          if (allSystemStats.length >= 2) {
            const crStats = computeCompositeStats(allSystemStats, dateStr);
            if (crStats) {
              await firestoreService.writeCompositeStats(dateStr, crStats);
            }
          }
        } catch {
          // Non-critical — CR is supplementary
        }
      }

      // Compute and write WorkstationStats (GAW)
      const wsStats = computeWorkstationStats(sessions, system, dateStr);
      if (wsStats) {
        await firestoreService.writeWorkstationStats(system, dateStr, wsStats);
      }

      result.daysComputed++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`${dateStr}: ${msg}`);
      console.error(`GAR computation failed for ${dateStr}:`, err);
    }
  }

  // Process stale GAR markers (late-arriving data from offline buffer replays)
  try {
    const markers = await firestoreService.getStaleMarkers(system);
    const today = new Date();

    for (const marker of markers) {
      try {
        // Skip markers older than 30 days — data too old to meaningfully update GAR
        const markerDate = new Date(marker.date + 'T00:00:00Z');
        const ageMs = today.getTime() - markerDate.getTime();
        if (ageMs > STALE_MARKER_MAX_AGE_DAYS * 24 * 60 * 60 * 1000) {
          await firestoreService.deleteStaleMarker(marker.id);
          continue;
        }

        const dayStart = new Date(marker.date + 'T00:00:00Z');
        const dayEnd = new Date(marker.date + 'T23:59:59.999Z');
        const sessions = await firestoreService.getAllSessionsForSystem(system, dayStart, dayEnd);

        if (sessions.length === 0) {
          await firestoreService.deleteStaleMarker(marker.id);
          continue;
        }

        // Recompute GroupStats (GAR)
        const groupStats = computeGroupStats(sessions, system, marker.date);
        if (groupStats) {
          await firestoreService.writeGroupStats(system, marker.date, groupStats);
        }

        // Recompute WorkstationStats (GAW)
        const wsStats = computeWorkstationStats(sessions, system, marker.date);
        if (wsStats) {
          await firestoreService.writeWorkstationStats(system, marker.date, wsStats);
        }

        // Recompute CompositeStats (CR) — late data may change cross-system aggregates
        try {
          const allSystemStats = await firestoreService.getAllGroupStatsForDate(marker.date);
          if (allSystemStats.length >= 2) {
            const crStats = computeCompositeStats(allSystemStats, marker.date);
            if (crStats) {
              await firestoreService.writeCompositeStats(marker.date, crStats);
            }
          }
        } catch {
          // Non-critical — CR is supplementary
        }

        await firestoreService.deleteStaleMarker(marker.id);
        result.staleDaysRecomputed++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(`stale-${marker.date}: ${msg}`);
      }
    }
  } catch (err) {
    // Non-critical — stale marker query failure doesn't block normal GAR
    console.error('Failed to query stale GAR markers:', err);
  }

  if (result.daysComputed > 0 || result.staleDaysRecomputed > 0) {
    console.log(`GAR aggregation: computed ${result.daysComputed}/${result.daysChecked} days, ${result.staleDaysRecomputed} stale days recomputed for ${system}`);
  }

  return result;
}
