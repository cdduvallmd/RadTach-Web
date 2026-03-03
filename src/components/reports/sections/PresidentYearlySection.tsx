// President (President) Yearly Section
// Annual radiologist performance, group RVU by month, rotation ranking,
// workforce stability, "Network Interference" annual cost.

import { useMemo } from 'react';
import { useAllSystemSessions } from '../../../hooks/useAllSystemSessions';
import { groupSessionsByMonth } from '../../../utils/periodAggregation';
import type { DateRange, StoredSession } from '../../../types/reports';
import { getDisplayName } from '../../../utils/displayName';
import RadiologistTable from '../shared/RadiologistTable';

interface PresidentYearlySectionProps {
  system: string | null;
  dateRange: DateRange;
  formatTime: (seconds: number) => string;
}

interface UserYearMetrics {
  id: string;
  name: string;
  sessions: number;
  studies: number;
  totalRVU: number;
  rvuPerHour: number;
  productiveRatio: number;
  avgVariance: number;
  monthsActive: number;
}

function computeUserYearMetrics(sessions: StoredSession[]): UserYearMetrics[] {
  const byUser = new Map<string, StoredSession[]>();
  for (const s of sessions) {
    const uid = s.userAbbrev;
    const existing = byUser.get(uid) || [];
    existing.push(s);
    byUser.set(uid, existing);
  }

  const metrics: UserYearMetrics[] = [];
  for (const [uid, userSessions] of byUser) {
    const totalSessionTime = userSessions.reduce((sum, s) => sum + s.totalSessionTime, 0);
    const totalBreakTime = userSessions.reduce((sum, s) => sum + s.breakTime, 0);
    const totalStudies = userSessions.reduce((sum, s) => sum + s.studiesCompleted, 0);
    const totalRVU = userSessions.reduce((sum, s) => sum + s.totalRVU, 0);
    const hours = (totalSessionTime - totalBreakTime) / 3600;
    const totalDoubleTap = userSessions.reduce((sum, s) => sum + s.doubleTapTime, 0);
    const studyTime = userSessions.reduce((sum, s) =>
      sum + (s.summary?.timeAllocation.study ?? (s.totalSessionTime - s.interstitialTime - s.adminTime - s.commsTime - s.breakTime - s.doubleTapTime)), 0);

    const variances: number[] = [];
    for (const s of userSessions) {
      if (s.summary?.avgVarianceByModality) {
        const v = Object.values(s.summary.avgVarianceByModality);
        if (v.length > 0) variances.push(v.reduce((a, b) => a + b, 0) / v.length);
      }
    }

    // Count distinct months active
    const activeMonths = new Set(userSessions.map(s => s.startDateTime.slice(0, 7)));

    metrics.push({
      id: uid,
      name: getDisplayName(userSessions),
      sessions: userSessions.length,
      studies: totalStudies,
      totalRVU,
      rvuPerHour: hours > 0 ? totalRVU / hours : 0,
      productiveRatio: totalSessionTime > 0 ? (studyTime + totalDoubleTap) / totalSessionTime : 0,
      avgVariance: variances.length > 0 ? variances.reduce((a, b) => a + b, 0) / variances.length : 0,
      monthsActive: activeMonths.size,
    });
  }

  return metrics.sort((a, b) => b.rvuPerHour - a.rvuPerHour);
}

export default function PresidentYearlySection({ system, dateRange }: PresidentYearlySectionProps) {
  const { sessions, loading, error } = useAllSystemSessions(system, dateRange);

  const userMetrics = useMemo(() => computeUserYearMetrics(sessions), [sessions]);

  // Group RVU by month
  const monthlyGroupRVU = useMemo(() => {
    const byMonth = groupSessionsByMonth(sessions);
    const months = [...byMonth.keys()].sort();
    return months.map(m => {
      const monthSessions = byMonth.get(m) || [];
      const totalRVU = monthSessions.reduce((sum, s) => sum + s.totalRVU, 0);
      const hours = monthSessions.reduce((sum, s) => sum + (s.totalSessionTime - s.breakTime), 0) / 3600;
      const radiologists = new Set(monthSessions.map(s => s.userAbbrev)).size;
      return { month: m, totalRVU, rvuPerHour: hours > 0 ? totalRVU / hours : 0, radiologists, sessions: monthSessions.length };
    });
  }, [sessions]);

  // Rotation efficiency ranking (annual)
  const rotationRanking = useMemo(() => {
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

  // Workforce stability: months active per radiologist
  const workforceStability = useMemo(() => {
    if (userMetrics.length === 0) return null;
    const totalMonths = monthlyGroupRVU.length;
    if (totalMonths === 0) return null;
    const fullYearRads = userMetrics.filter(u => u.monthsActive >= totalMonths).length;
    const partialRads = userMetrics.filter(u => u.monthsActive < totalMonths).length;
    const avgMonthsActive = userMetrics.reduce((sum, u) => sum + u.monthsActive, 0) / userMetrics.length;
    return { totalRads: userMetrics.length, fullYearRads, partialRads, avgMonthsActive, totalMonths };
  }, [userMetrics, monthlyGroupRVU]);

  // Network interference annual cost
  const networkInterference = useMemo(() => {
    let totalOccurrences = 0;
    let affectedSessions = 0;
    for (const s of sessions) {
      if (s.notes?.tags?.includes('Network & Application Interference')) {
        totalOccurrences++;
        affectedSessions++;
      }
    }
    return { totalOccurrences, affectedSessions, totalSessions: sessions.length };
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
        <span style={{ color: '#9ca3af', fontSize: 14, fontWeight: 600 }}>Annual Group Overview</span>
      </div>

      {/* Annual radiologist performance table */}
      <RadiologistTable
        title="Annual Radiologist Performance"
        columns={[
          { key: 'sessions', label: 'Sessions' },
          { key: 'studies', label: 'Studies' },
          { key: 'totalRVU', label: 'RVU', format: (v: number) => v.toFixed(1) },
          { key: 'rvuPerHour', label: 'RVU/hr', format: (v: number) => v.toFixed(1), colorFn: (v: number) => v >= 4 ? '#22c55e' : v >= 3 ? '#3b82f6' : v >= 2 ? '#f59e0b' : '#ef4444' },
          { key: 'avgVariance', label: 'Avg Var', format: (v: number) => `${v > 0 ? '+' : ''}${Math.round(v)}s`, colorFn: (v: number) => v <= 0 ? '#22c55e' : '#ef4444' },
          { key: 'productiveRatio', label: 'Prod %', format: (v: number) => `${(v * 100).toFixed(0)}%` },
          { key: 'monthsActive', label: 'Months' },
        ]}
        rows={userMetrics.map(u => ({
          id: u.id, name: u.name, sessions: u.sessions, studies: u.studies,
          totalRVU: u.totalRVU, rvuPerHour: u.rvuPerHour, avgVariance: u.avgVariance,
          productiveRatio: u.productiveRatio, monthsActive: u.monthsActive,
        }))}
        sortBy="rvuPerHour"
      />

      {/* Group RVU by month */}
      {monthlyGroupRVU.length > 1 && (
        <div style={{ backgroundColor: '#1f2937', borderRadius: 8, padding: 16 }}>
          <h3 style={{ color: '#9ca3af', fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 12 }}>
            Monthly Group RVU
          </h3>
          <div className="flex items-end gap-1 h-32">
            {monthlyGroupRVU.map((m, i) => {
              const max = Math.max(...monthlyGroupRVU.map(d => d.totalRVU), 1);
              const height = (m.totalRVU / max) * 100;
              return (
                <div key={i} className="flex-1 flex flex-col items-center">
                  <div style={{ fontSize: 9, color: '#9ca3af', marginBottom: 2 }}>{m.totalRVU.toFixed(0)}</div>
                  <div style={{ width: '100%', borderRadius: '4px 4px 0 0', height: `${height}%`, backgroundColor: '#7c3aed', minHeight: 4 }} />
                  <div style={{ fontSize: 9, color: '#6b7280', marginTop: 2 }}>{m.month.slice(5)}</div>
                  <div style={{ fontSize: 8, color: '#4b5563' }}>{m.radiologists} rads</div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Rotation efficiency ranking */}
      {rotationRanking.length > 0 && (
        <div style={{ backgroundColor: '#1f2937', borderRadius: 8, padding: 16 }}>
          <h3 style={{ color: '#9ca3af', fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 12 }}>
            Rotation Efficiency Ranking
          </h3>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid #374151', color: '#9ca3af' }}>Rank</th>
                <th style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid #374151', color: '#9ca3af' }}>Rotation</th>
                <th style={{ textAlign: 'right', padding: '6px 8px', borderBottom: '1px solid #374151', color: '#9ca3af' }}>Sessions</th>
                <th style={{ textAlign: 'right', padding: '6px 8px', borderBottom: '1px solid #374151', color: '#9ca3af' }}>Rads</th>
                <th style={{ textAlign: 'right', padding: '6px 8px', borderBottom: '1px solid #374151', color: '#9ca3af' }}>Studies</th>
                <th style={{ textAlign: 'right', padding: '6px 8px', borderBottom: '1px solid #374151', color: '#9ca3af' }}>RVU/hr</th>
                <th style={{ textAlign: 'right', padding: '6px 8px', borderBottom: '1px solid #374151', color: '#9ca3af' }}>Total RVU</th>
              </tr>
            </thead>
            <tbody>
              {rotationRanking.map((r, i) => (
                <tr key={r.rotation}>
                  <td style={{ padding: '6px 8px', color: i === 0 ? '#fbbf24' : '#d1d5db', fontWeight: i === 0 ? 700 : 400 }}>#{i + 1}</td>
                  <td style={{ padding: '6px 8px', color: '#d1d5db' }}>{r.rotation}</td>
                  <td style={{ padding: '6px 8px', color: '#d1d5db', textAlign: 'right' }}>{r.sessions}</td>
                  <td style={{ padding: '6px 8px', color: '#d1d5db', textAlign: 'right' }}>{r.radiologists}</td>
                  <td style={{ padding: '6px 8px', color: '#d1d5db', textAlign: 'right' }}>{r.studies}</td>
                  <td style={{ padding: '6px 8px', color: '#d1d5db', textAlign: 'right' }}>{r.rvuPerHour.toFixed(1)}</td>
                  <td style={{ padding: '6px 8px', color: '#d1d5db', textAlign: 'right' }}>{r.totalRVU.toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Workforce stability */}
      {workforceStability && (
        <div style={{ backgroundColor: '#1f2937', borderRadius: 8, padding: 16 }}>
          <h3 style={{ color: '#9ca3af', fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 12 }}>
            Workforce Stability
          </h3>
          <div className="grid grid-cols-4 gap-4 text-center">
            <div style={{ backgroundColor: '#111827', borderRadius: 6, padding: 12 }}>
              <div style={{ color: '#9ca3af', fontSize: 11 }}>Total Radiologists</div>
              <div style={{ color: 'white', fontSize: 20, fontWeight: 700 }}>{workforceStability.totalRads}</div>
            </div>
            <div style={{ backgroundColor: '#111827', borderRadius: 6, padding: 12 }}>
              <div style={{ color: '#9ca3af', fontSize: 11 }}>Full Year</div>
              <div style={{ color: '#22c55e', fontSize: 20, fontWeight: 700 }}>{workforceStability.fullYearRads}</div>
            </div>
            <div style={{ backgroundColor: '#111827', borderRadius: 6, padding: 12 }}>
              <div style={{ color: '#9ca3af', fontSize: 11 }}>Partial Year</div>
              <div style={{ color: workforceStability.partialRads > 0 ? '#f59e0b' : '#9ca3af', fontSize: 20, fontWeight: 700 }}>{workforceStability.partialRads}</div>
            </div>
            <div style={{ backgroundColor: '#111827', borderRadius: 6, padding: 12 }}>
              <div style={{ color: '#9ca3af', fontSize: 11 }}>Avg Months Active</div>
              <div style={{ color: 'white', fontSize: 20, fontWeight: 700 }}>{workforceStability.avgMonthsActive.toFixed(1)}</div>
              <div style={{ color: '#6b7280', fontSize: 10 }}>of {workforceStability.totalMonths}</div>
            </div>
          </div>
        </div>
      )}

      {/* Network interference annual cost */}
      {networkInterference.totalOccurrences > 0 && (
        <div style={{ backgroundColor: 'rgba(239, 68, 68, 0.1)', borderRadius: 8, padding: 16, border: '1px solid rgba(239, 68, 68, 0.3)' }}>
          <h3 style={{ color: '#fca5a5', fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 12 }}>
            Network & Application Interference — Annual Impact
          </h3>
          <div className="grid grid-cols-3 gap-4 text-center">
            <div>
              <div style={{ color: '#fca5a5', fontSize: 11 }}>Reported Incidents</div>
              <div style={{ color: '#ef4444', fontSize: 24, fontWeight: 700 }}>{networkInterference.totalOccurrences}</div>
            </div>
            <div>
              <div style={{ color: '#fca5a5', fontSize: 11 }}>Affected Sessions</div>
              <div style={{ color: '#ef4444', fontSize: 24, fontWeight: 700 }}>
                {((networkInterference.affectedSessions / networkInterference.totalSessions) * 100).toFixed(1)}%
              </div>
            </div>
            <div>
              <div style={{ color: '#fca5a5', fontSize: 11 }}>Total Sessions</div>
              <div style={{ color: '#d1d5db', fontSize: 24, fontWeight: 700 }}>{networkInterference.totalSessions}</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
