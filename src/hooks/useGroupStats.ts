// Hook: Fetch GAR/CR group stats for a date range from Firestore

import { useState, useEffect, useRef } from 'react';
import { firestoreService } from '../services/firestore';
import type { GroupStats, CompositeStats, DateRange } from '../types/reports';

interface UseGroupStatsResult {
  garDays: GroupStats[];
  crDays: CompositeStats[];
  loading: boolean;
  error: string | null;
}

function dateRangeKey(range: DateRange): string {
  return `${range.start.toISOString()}_${range.end.toISOString()}`;
}

export function useGroupStats(
  system: string | null,
  dateRange: DateRange | null
): UseGroupStatsResult {
  const [garDays, setGarDays] = useState<GroupStats[]>([]);
  const [crDays, setCrDays] = useState<CompositeStats[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cacheRef = useRef<Map<string, { gar: GroupStats[]; cr: CompositeStats[] }>>(new Map());

  useEffect(() => {
    if (!system || !dateRange) {
      setGarDays([]);
      setCrDays([]);
      setLoading(false);
      setError(null);
      return;
    }

    const key = `${system}_${dateRangeKey(dateRange)}`;
    const cached = cacheRef.current.get(key);
    if (cached) {
      setGarDays(cached.gar);
      setCrDays(cached.cr);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    Promise.all([
      firestoreService.getGroupStats(system, dateRange.start, dateRange.end),
      firestoreService.getCompositeStats(dateRange.start, dateRange.end),
    ])
      .then(([gar, cr]) => {
        if (cancelled) return;
        cacheRef.current.set(key, { gar, cr });
        setGarDays(gar);
        setCrDays(cr);
        setLoading(false);
      })
      .catch(err => {
        if (cancelled) return;
        console.error('useGroupStats error:', err);
        setError(err instanceof Error ? err.message : 'Failed to fetch group stats');
        setLoading(false);
      });

    return () => { cancelled = true; };
  }, [system, dateRange?.start.getTime(), dateRange?.end.getTime()]);

  return { garDays, crDays, loading, error };
}
