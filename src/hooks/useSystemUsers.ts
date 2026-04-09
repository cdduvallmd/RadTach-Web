// Hook: Fetch list of users who have sessions in a given system (last 90 days)
// Uses collectionGroup query. Extracts Firebase UIDs from document paths
// so the user picker can provide UIDs for useSessionData.

import { useState, useEffect, useRef } from 'react';
import { db } from '../services/firebase';
import { collectionGroup, query, where, orderBy, getDocs, Timestamp } from 'firebase/firestore';
import { subDays } from 'date-fns';

export interface SystemUser {
  uid: string;          // Firebase UID (from doc path: users/{uid}/sessions/...)
  abbrev: string;       // userAbbrev field
  displayName: string;  // displayName or fallback to abbrev
}

interface UseSystemUsersResult {
  users: SystemUser[];
  loading: boolean;
}

export function useSystemUsers(system: string | null): UseSystemUsersResult {
  const [users, setUsers] = useState<SystemUser[]>([]);
  const [loading, setLoading] = useState(false);
  const cacheRef = useRef<Map<string, SystemUser[]>>(new Map());

  useEffect(() => {
    if (!system) {
      setUsers([]);
      setLoading(false);
      return;
    }

    const cached = cacheRef.current.get(system);
    if (cached) {
      setUsers(cached);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);

    const endDate = new Date();
    const startDate = subDays(endDate, 90);
    const startTs = Timestamp.fromDate(startDate);
    const endTs = Timestamp.fromDate(endDate);

    const sessionsGroup = collectionGroup(db, 'sessions');
    const q = query(
      sessionsGroup,
      where('system', '==', system),
      where('startTime', '>=', startTs),
      where('startTime', '<', endTs),
      orderBy('startTime', 'desc')
    );

    getDocs(q)
      .then(snapshot => {
        if (cancelled) return;
        // Extract unique users by userAbbrev, capturing Firebase UID from doc path
        const seen = new Map<string, { uid: string; displayName: string }>();
        for (const d of snapshot.docs) {
          const data = d.data();
          const abbrev = data.userAbbrev as string;
          if (!abbrev || seen.has(abbrev)) continue;
          // Doc path: users/{uid}/sessions/{sessionId} → parent.parent.id = uid
          const uid = d.ref.parent.parent?.id || '';
          seen.set(abbrev, {
            uid,
            displayName: (data.displayName as string) || abbrev,
          });
        }
        const result: SystemUser[] = [...seen.entries()]
          .map(([abbrev, { uid, displayName }]) => ({ uid, abbrev, displayName }))
          .sort((a, b) => a.displayName.localeCompare(b.displayName));
        cacheRef.current.set(system, result);
        setUsers(result);
        setLoading(false);
      })
      .catch(err => {
        if (cancelled) return;
        console.error('useSystemUsers error:', err);
        setLoading(false);
      });

    return () => { cancelled = true; };
  }, [system]);

  return { users, loading };
}
