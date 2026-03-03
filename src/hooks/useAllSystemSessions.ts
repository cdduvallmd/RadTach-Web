// Hook: Fetch ALL users' sessions for a system via collectionGroup query
// Used by President (Group Admin) sections for cross-radiologist analysis.
// Requires admin-level Firestore security rules.

import { useState, useEffect, useRef } from 'react';
import { firestoreService } from '../services/firestore';
import type { StoredSession, DateRange } from '../types/reports';

interface UseAllSystemSessionsResult {
  sessions: StoredSession[];
  loading: boolean;
  error: string | null;
}

function dateRangeKey(range: DateRange): string {
  return `${range.start.toISOString()}_${range.end.toISOString()}`;
}

export function useAllSystemSessions(
  system: string | null,
  dateRange: DateRange | null
): UseAllSystemSessionsResult {
  const [sessions, setSessions] = useState<StoredSession[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cacheRef = useRef<Map<string, StoredSession[]>>(new Map());

  useEffect(() => {
    if (!system || !dateRange) {
      setSessions([]);
      setLoading(false);
      setError(null);
      return;
    }

    const key = `${system}_${dateRangeKey(dateRange)}`;
    const cached = cacheRef.current.get(key);
    if (cached) {
      setSessions(cached);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    firestoreService.getAllSessionsForSystem(system, dateRange.start, dateRange.end)
      .then(result => {
        if (cancelled) return;
        cacheRef.current.set(key, result);
        setSessions(result);
        setLoading(false);
      })
      .catch(err => {
        if (cancelled) return;
        console.error('useAllSystemSessions error:', err);
        setError(err instanceof Error ? err.message : 'Failed to fetch system sessions');
        setLoading(false);
      });

    return () => { cancelled = true; };
  }, [system, dateRange?.start.getTime(), dateRange?.end.getTime()]);

  return { sessions, loading, error };
}
