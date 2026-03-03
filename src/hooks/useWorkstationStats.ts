// Hook: Fetch workstation stats (GAW) for a date range from Firestore
// Used by IT sections for workstation health metrics.

import { useState, useEffect, useRef } from 'react';
import { firestoreService } from '../services/firestore';
import type { WorkstationStats, DateRange } from '../types/reports';

interface UseWorkstationStatsResult {
  wsDays: WorkstationStats[];
  loading: boolean;
  error: string | null;
}

function dateRangeKey(range: DateRange): string {
  return `${range.start.toISOString()}_${range.end.toISOString()}`;
}

export function useWorkstationStats(
  system: string | null,
  dateRange: DateRange | null
): UseWorkstationStatsResult {
  const [wsDays, setWsDays] = useState<WorkstationStats[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cacheRef = useRef<Map<string, WorkstationStats[]>>(new Map());

  useEffect(() => {
    if (!system || !dateRange) {
      setWsDays([]);
      setLoading(false);
      setError(null);
      return;
    }

    const key = `${system}_${dateRangeKey(dateRange)}`;
    const cached = cacheRef.current.get(key);
    if (cached) {
      setWsDays(cached);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    firestoreService.getWorkstationStats(system, dateRange.start, dateRange.end)
      .then(result => {
        if (cancelled) return;
        cacheRef.current.set(key, result);
        setWsDays(result);
        setLoading(false);
      })
      .catch(err => {
        if (cancelled) return;
        console.error('useWorkstationStats error:', err);
        setError(err instanceof Error ? err.message : 'Failed to fetch workstation stats');
        setLoading(false);
      });

    return () => { cancelled = true; };
  }, [system, dateRange?.start.getTime(), dateRange?.end.getTime()]);

  return { wsDays, loading, error };
}
