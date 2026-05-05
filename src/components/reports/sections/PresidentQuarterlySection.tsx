// President (President) Quarterly Section
// Radiologist growth Q-start vs Q-end, rotation optimization, tag trends.

import { useMemo } from 'react';
import { useAllSystemSessions } from '../../../hooks/useAllSystemSessions';
import { groupSessionsByMonth } from '../../../utils/periodAggregation';
import type { DateRange, StoredSession } from '../../../types/reports';
import { getDisplayName } from '../../../utils/displayName';
import RadiologistTable from '../shared/RadiologistTable';

interface PresidentQuarterlySectionProps {
  system: string | null;
  dateRange: DateRange;
  formatTime: (seconds: number) => string;
}

interface UserGrowth {
  id: string;
  name: string;
  firstMonthRVUPerHour: number;
  lastMonthRVUPerHour: number;
  delta: number;
  totalSessions: number;
  totalRVU: number;
}

function computeRVUPerHour(sessions: StoredSession[]): number {
  const totalRVU = sessions.reduce((sum, s) => sum + s.totalRVU, 0);
  const hours = sessions.reduce((sum, s) => sum + (s.totalSessionTime - s.breakTime), 0) / 3600;
  return hours > 0 ? totalRVU / hours : 0;
}

export default function PresidentQuarterlySection({ system, dateRange }: PresidentQuarterlySectionProps) {
  const { sessions, loading, error } = useAllSystemSessions(system, dateRange);

  const userGrowth = useMemo(() => {
    if (sessions.length === 0) return [];

    const byMonth = groupSessionsByMonth(sessions);
    const months = [...byMonth.keys()].sort();
    if (months.length < 2) return [];

    const firstMonth = months[0];
    const lastMonth = months[months.length - 1];
    const firstSessions = byMonth.get(firstMonth) || [];
    const lastSessions = byMonth.get(lastMonth) || [];

    // Group by user
    const allUsers = new Set<string>();
    for (const s of sessions) allUsers.add(s.userAbbrev);

    const growth: UserGrowth[] = [];
    for (const uid of allUsers) {
      const firstUserSessions = firstSessions.filter(s => s.userAbbrev === uid);
      const lastUserSessions = lastSessions.filter(s => s.userAbbrev === uid);
      if (firstUserSessions.length === 0 || lastUserSessions.length === 0) continue;

      const firstRate = computeRVUPerHour(firstUserSessions);
      const lastRate = computeRVUPerHour(lastUserSessions);
      const allUserSessions = sessions.filter(s => s.userAbbrev === uid);

      growth.push({
        id: uid,
        name: getDisplayName(allUserSessions),
        firstMonthRVUPerHour: firstRate,
        lastMonthRVUPerHour: lastRate,
        delta: lastRate - firstRate,
        totalSessions: allUserSessions.length,
        totalRVU: allUserSessions.reduce((sum, s) => sum + s.totalRVU, 0),
      });
    }

    return growth.sort((a, b) => b.delta - a.delta);
  }, [sessions]);

  // Tag trend across months
  const tagTrend = useMemo(() => {
    const byMonth = groupSessionsByMonth(sessions);
    const months = [...byMonth.keys()].sort();
    const tags = new Set<string>();
    for (const s of sessions) {
      if (s.notes?.tags) s.notes.tags.filter(t => t !== 'No Comment').forEach(t => tags.add(t));
    }
    return { months, tags: [...tags], byMonth };
  }, [sessions]);

  // Rotation optimization
  const rotationMetrics = useMemo(() => {
    const byRotation = new Map<string, StoredSession[]>();
    for (const s of sessions) {
      const rot = s.rotation || 'Unknown';
      const existing = byRotation.get(rot) || [];
      existing.push(s);
      byRotation.set(rot, existing);
    }

    return [...byRotation.entries()].map(([rot, rotSessions]) => {
      const totalRVU = rotSessions.reduce((sum, s) => sum + s.totalRVU, 0);
      const hours = rotSessions.reduce((sum, s) => sum + (s.totalSessionTime - s.breakTime), 0) / 3600;
      const radiologists = new Set(rotSessions.map(s => s.userAbbrev)).size;
      const studies = rotSessions.reduce((sum, s) => sum + s.studiesCompleted, 0);
      return { rotation: rot, sessions: rotSessions.length, radiologists, rvuPerHour: hours > 0 ? totalRVU / hours : 0, studies, totalRVU };
    }).sort((a, b) => b.rvuPerHour - a.rvuPerHour);
  }, [sessions]);

  // Modality demand trend
  const modalityByMonth = useMemo(() => {
    const byMonth = groupSessionsByMonth(sessions);
    const months = [...byMonth.keys()].sort();
    const allMods = new Set<string>();
    for (const s of sessions) {
      if (s.summary?.studiesByModality) Object.keys(s.summary.studiesByModality).forEach(m => allMods.add(m));
    }
    const modalities = [...allMods].sort();

    const data = months.map(m => {
      const monthSessions = byMonth.get(m) || [];
      const counts: Record<string, number> = {};
      for (const s of monthSessions) {
        if (s.summary?.studiesByModality) {
          for (const [mod, count] of Object.entries(s.summary.studiesByModality)) {
            counts[mod] = (counts[mod] || 0) + count;
          }
        }
      }
      return { month: m, counts };
    });

    return { months, modalities, data };
  }, [sessions]);

  if (loading) {
    return <div style={{ color: '#9ca3af', textAlign: 'center', padding: 32 }}>Loading group data...</div>;
  }
  if (error) {
    return <div style={{ backgroundColor: 'rgba(127, 29, 29, 0.3)', borderRadius: 8, padding: 16, color: '#fca5a5', fontSize: 14 }}>Error: {error}</div>;
  }
  if (sessions.length === 0) return null;

  return (
    <div className="space-y-6" style={{ borderTop: '2px solid #4b5563', paddingTop: 24, marginTop: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ backgroundColor: '#7c3aed', color: 'white', fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 9999, textTransform: 'uppercase' }}>
          President
        </span>
        <span style={{ color: '#9ca3af', fontSize: 14, fontWeight: 600 }}>Quarterly Group Overview</span>
      </div>

      {/* Radiologist growth table */}
      {userGrowth.length > 0 && (
        <RadiologistTable
          title="Radiologist Growth (Month 1 → Month 3)"
          columns={[
            { key: 'firstMonthRVUPerHour', label: 'M1 RVU/hr', format: (v: number) => v.toFixed(2) },
            { key: 'lastMonthRVUPerHour', label: 'M3 RVU/hr', format: (v: number) => v.toFixed(2) },
            { key: 'delta', label: 'Change', format: (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(2)}`, colorFn: (v: number) => v > 0 ? '#22c55e' : v < 0 ? '#ef4444' : '#9ca3af' },
            { key: 'totalSessions', label: 'Sessions' },
            { key: 'totalRVU', label: 'Total RVU', format: (v: number) => v.toFixed(2) },
          ]}
          rows={userGrowth.map(u => ({
            id: u.id, name: u.name, firstMonthRVUPerHour: u.firstMonthRVUPerHour,
            lastMonthRVUPerHour: u.lastMonthRVUPerHour, delta: u.delta,
            totalSessions: u.totalSessions, totalRVU: u.totalRVU,
          }))}
          sortBy="delta"
        />
      )}

      {/* Rotation optimization */}
      {rotationMetrics.length > 0 && (
        <div style={{ backgroundColor: '#1f2937', borderRadius: 8, padding: 16 }}>
          <h3 style={{ color: '#9ca3af', fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 12 }}>
            Rotation Optimization
          </h3>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid #374151', color: '#9ca3af' }}>Rotation</th>
                <th style={{ textAlign: 'right', padding: '6px 8px', borderBottom: '1px solid #374151', color: '#9ca3af' }}>Sessions</th>
                <th style={{ textAlign: 'right', padding: '6px 8px', borderBottom: '1px solid #374151', color: '#9ca3af' }}>Rads</th>
                <th style={{ textAlign: 'right', padding: '6px 8px', borderBottom: '1px solid #374151', color: '#9ca3af' }}>Studies</th>
                <th style={{ textAlign: 'right', padding: '6px 8px', borderBottom: '1px solid #374151', color: '#9ca3af' }}>RVU/hr</th>
                <th style={{ textAlign: 'right', padding: '6px 8px', borderBottom: '1px solid #374151', color: '#9ca3af' }}>Total RVU</th>
              </tr>
            </thead>
            <tbody>
              {rotationMetrics.map(r => (
                <tr key={r.rotation}>
                  <td style={{ padding: '6px 8px', color: '#d1d5db' }}>{r.rotation}</td>
                  <td style={{ padding: '6px 8px', color: '#d1d5db', textAlign: 'right' }}>{r.sessions}</td>
                  <td style={{ padding: '6px 8px', color: '#d1d5db', textAlign: 'right' }}>{r.radiologists}</td>
                  <td style={{ padding: '6px 8px', color: '#d1d5db', textAlign: 'right' }}>{r.studies}</td>
                  <td style={{ padding: '6px 8px', color: '#d1d5db', textAlign: 'right' }}>{r.rvuPerHour.toFixed(2)}</td>
                  <td style={{ padding: '6px 8px', color: '#d1d5db', textAlign: 'right' }}>{r.totalRVU.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Modality demand by month */}
      {modalityByMonth.months.length > 1 && modalityByMonth.modalities.length > 0 && (
        <div style={{ backgroundColor: '#1f2937', borderRadius: 8, padding: 16 }}>
          <h3 style={{ color: '#9ca3af', fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 12 }}>
            Modality Demand Trend
          </h3>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: '4px 8px', borderBottom: '1px solid #374151', color: '#9ca3af' }}>Modality</th>
                {modalityByMonth.months.map(m => (
                  <th key={m} style={{ textAlign: 'right', padding: '4px 8px', borderBottom: '1px solid #374151', color: '#9ca3af' }}>
                    {m.slice(5)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {modalityByMonth.modalities.map(mod => (
                <tr key={mod}>
                  <td style={{ padding: '4px 8px', color: '#d1d5db' }}>{mod}</td>
                  {modalityByMonth.data.map((d, i) => (
                    <td key={i} style={{ padding: '4px 8px', color: '#d1d5db', textAlign: 'right' }}>
                      {d.counts[mod] || 0}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Tag trend */}
      {tagTrend.tags.length > 0 && tagTrend.months.length > 1 && (
        <div style={{ backgroundColor: '#1f2937', borderRadius: 8, padding: 16 }}>
          <h3 style={{ color: '#9ca3af', fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 12 }}>
            Group Tag Trend
          </h3>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: '4px 8px', borderBottom: '1px solid #374151', color: '#9ca3af' }}>Tag</th>
                {tagTrend.months.map(m => (
                  <th key={m} style={{ textAlign: 'right', padding: '4px 8px', borderBottom: '1px solid #374151', color: '#9ca3af' }}>{m.slice(5)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tagTrend.tags.map(tag => (
                <tr key={tag}>
                  <td style={{ padding: '4px 8px', color: '#d1d5db', fontSize: 11 }}>{tag}</td>
                  {tagTrend.months.map(m => {
                    const monthSessions = tagTrend.byMonth.get(m) || [];
                    const count = monthSessions.filter(s => s.notes?.tags?.includes(tag)).length;
                    return <td key={m} style={{ padding: '4px 8px', color: count > 0 ? '#d1d5db' : '#4b5563', textAlign: 'right' }}>{count}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
