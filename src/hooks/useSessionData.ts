// Hook: Fetch user's sessions for a date range from Firestore
// Caches results to avoid re-fetching visited periods

import { useState, useEffect, useRef } from 'react';
import { firestoreService } from '../services/firestore';
import type { StoredSession, DateRange } from '../types/reports';

interface UseSessionDataResult {
  sessions: StoredSession[];
  loading: boolean;
  error: string | null;
}

function dateRangeKey(range: DateRange): string {
  return `${range.start.toISOString()}_${range.end.toISOString()}`;
}

export function useSessionData(
  userId: string | null,
  dateRange: DateRange | null
): UseSessionDataResult {
  const [sessions, setSessions] = useState<StoredSession[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cacheRef = useRef<Map<string, StoredSession[]>>(new Map());

  useEffect(() => {
    if (!userId || !dateRange) {
      setSessions([]);
      setLoading(false);
      setError(null);
      return;
    }

    const key = dateRangeKey(dateRange);
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

    firestoreService.getSessionsInRange(userId, dateRange.start, dateRange.end)
      .then(result => {
        if (cancelled) return;
        cacheRef.current.set(key, result);
        setSessions(result);
        setLoading(false);
      })
      .catch(err => {
        if (cancelled) return;
        console.error('useSessionData error:', err);
        setError(err instanceof Error ? err.message : 'Failed to fetch sessions');
        setLoading(false);
      });

    return () => { cancelled = true; };
  }, [userId, dateRange?.start.getTime(), dateRange?.end.getTime()]);

  return { sessions, loading, error };
}
