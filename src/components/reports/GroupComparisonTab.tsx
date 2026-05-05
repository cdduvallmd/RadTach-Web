// Phase 6: Group Comparison Tab
// Permanent home for cross-radiologist and cross-system views.
// Only visible to president and above.

import { useState, useMemo } from 'react';
import { useAllSystemSessions } from '../../hooks/useAllSystemSessions';
import { useGroupStats } from '../../hooks/useGroupStats';
import { getWeekRange, getMonthRange, getQuarterRange, getYearRange } from '../../utils/periodAggregation';
import type { DateRange, StoredSession } from '../../types/reports';
import { getDisplayName } from '../../utils/displayName';
import { addWeeks, subWeeks, addMonths, subMonths, addQuarters, subQuarters, format } from 'date-fns';
import RadiologistTable from './shared/RadiologistTable';
import BoxPlotChart from './shared/BoxPlotChart';

interface GroupComparisonTabProps {
  userSystem: string | null;
  formatTime: (seconds: number) => string;
}

type PeriodType = 'weekly' | 'monthly' | 'quarterly' | 'yearly';

interface UserCompMetrics {
  id: string;
  name: string;
  sessions: number;
  studies: number;
  totalRVU: number;
  rvuPerHour: number;
  productiveRatio: number;
  avgVariance: number;
}

function computeCompMetrics(sessions: StoredSession[]): UserCompMetrics[] {
  const byUser = new Map<string, StoredSession[]>();
  for (const s of sessions) {
    const uid = s.userAbbrev;
    const existing = byUser.get(uid) || [];
    existing.push(s);
    byUser.set(uid, existing);
  }

  const metrics: UserCompMetrics[] = [];
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

    metrics.push({
      id: uid,
      name: getDisplayName(userSessions),
      sessions: userSessions.length,
      studies: totalStudies,
      totalRVU,
      rvuPerHour: hours > 0 ? totalRVU / hours : 0,
      productiveRatio: totalSessionTime > 0 ? (studyTime + totalDoubleTap) / totalSessionTime : 0,
      avgVariance: variances.length > 0 ? variances.reduce((a, b) => a + b, 0) / variances.length : 0,
    });
  }

  return metrics.sort((a, b) => b.rvuPerHour - a.rvuPerHour);
}

export default function GroupComparisonTab({ userSystem }: GroupComparisonTabProps) {
  const [periodType, setPeriodType] = useState<PeriodType>('weekly');
  const [currentDate, setCurrentDate] = useState(new Date());

  const dateRange: DateRange = useMemo(() => {
    switch (periodType) {
      case 'weekly': return getWeekRange(currentDate, 'monday');
      case 'monthly': return getMonthRange(currentDate.getFullYear(), currentDate.getMonth() + 1);
      case 'quarterly': {
        const q = (Math.floor(currentDate.getMonth() / 3) + 1) as 1 | 2 | 3 | 4;
        return getQuarterRange(currentDate.getFullYear(), q);
      }
      case 'yearly': return getYearRange(currentDate.getFullYear());
    }
  }, [periodType, currentDate]);

  const { sessions, loading, error } = useAllSystemSessions(userSystem, dateRange);
  const { garDays } = useGroupStats(userSystem, dateRange);

  const userMetrics = useMemo(() => computeCompMetrics(sessions), [sessions]);

  // Group totals
  const groupTotals = useMemo(() => ({
    totalRVU: sessions.reduce((sum, s) => sum + s.totalRVU, 0),
    totalStudies: sessions.reduce((sum, s) => sum + s.studiesCompleted, 0),
    totalSessions: sessions.length,
    radiologists: new Set(sessions.map(s => s.userAbbrev)).size,
  }), [sessions]);

  // Rotation efficiency
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
      return { rotation: rot, sessions: rotSessions.length, radiologists, rvuPerHour: hours > 0 ? totalRVU / hours : 0, totalRVU };
    }).sort((a, b) => b.rvuPerHour - a.rvuPerHour);
  }, [sessions]);

  const navigate = (dir: -1 | 1) => {
    switch (periodType) {
      case 'weekly': setCurrentDate(d => dir === 1 ? addWeeks(d, 1) : subWeeks(d, 1)); break;
      case 'monthly': setCurrentDate(d => dir === 1 ? addMonths(d, 1) : subMonths(d, 1)); break;
      case 'quarterly': setCurrentDate(d => dir === 1 ? addQuarters(d, 1) : subQuarters(d, 1)); break;
      case 'yearly': setCurrentDate(d => new Date(d.getFullYear() + dir, 0, 1)); break;
    }
  };

  const periodLabel = (() => {
    switch (periodType) {
      case 'weekly': return `${format(dateRange.start, 'MMM d')} – ${format(dateRange.end, 'MMM d, yyyy')}`;
      case 'monthly': return format(dateRange.start, 'MMMM yyyy');
      case 'quarterly': {
        const q = Math.floor(dateRange.start.getMonth() / 3) + 1;
        return `Q${q} ${dateRange.start.getFullYear()}`;
      }
      case 'yearly': return `${dateRange.start.getFullYear()}`;
    }
  })();

  return (
    <div className="space-y-6">
      {/* Period selector + navigation */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
        <div style={{ display: 'flex', gap: 4 }}>
          {(['weekly', 'monthly', 'quarterly', 'yearly'] as PeriodType[]).map(p => (
            <button
              key={p}
              onClick={() => setPeriodType(p)}
              style={{
                padding: '4px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600,
                backgroundColor: periodType === p ? '#7c3aed' : '#374151',
                color: periodType === p ? 'white' : '#9ca3af',
                border: 'none', cursor: 'pointer',
              }}
            >
              {p.charAt(0).toUpperCase() + p.slice(1)}
            </button>
          ))}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button onClick={() => navigate(-1)} style={{ background: 'none', border: 'none', color: '#9ca3af', fontSize: 18, cursor: 'pointer' }}>◀</button>
          <span style={{ color: '#d1d5db', fontSize: 14, fontWeight: 600, minWidth: 180, textAlign: 'center' }}>{periodLabel}</span>
          <button onClick={() => navigate(1)} style={{ background: 'none', border: 'none', color: '#9ca3af', fontSize: 18, cursor: 'pointer' }}>▶</button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ backgroundColor: '#7c3aed', color: 'white', fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 9999, textTransform: 'uppercase' }}>
            President
          </span>
          {userSystem && <span style={{ color: '#6b7280', fontSize: 12 }}>{userSystem}</span>}
        </div>
      </div>

      {loading && (
        <div style={{ color: '#9ca3af', textAlign: 'center', padding: 32 }}>Loading group data...</div>
      )}

      {error && (
        <div style={{ backgroundColor: 'rgba(127, 29, 29, 0.3)', borderRadius: 8, padding: 16, color: '#fca5a5', fontSize: 14 }}>
          Error: {error}
        </div>
      )}

      {!loading && !error && sessions.length === 0 && (
        <div style={{ color: '#6b7280', textAlign: 'center', padding: 48, fontSize: 14 }}>
          No group sessions found for this period.
        </div>
      )}

      {!loading && !error && sessions.length > 0 && (
        <>
          {/* Group summary cards */}
          <div className="grid grid-cols-4 gap-4">
            <div className="bg-gray-800 rounded-lg p-4 text-center">
              <div className="text-gray-400 text-xs mb-1">Radiologists</div>
              <div className="text-2xl font-bold text-white">{groupTotals.radiologists}</div>
            </div>
            <div className="bg-gray-800 rounded-lg p-4 text-center">
              <div className="text-gray-400 text-xs mb-1">Group Sessions</div>
              <div className="text-2xl font-bold text-white">{groupTotals.totalSessions}</div>
            </div>
            <div className="bg-gray-800 rounded-lg p-4 text-center">
              <div className="text-gray-400 text-xs mb-1">Group Studies</div>
              <div className="text-2xl font-bold text-white">{groupTotals.totalStudies}</div>
            </div>
            <div className="bg-gray-800 rounded-lg p-4 text-center">
              <div className="text-gray-400 text-xs mb-1">Group RVU</div>
              <div className="text-2xl font-bold text-white">{groupTotals.totalRVU.toFixed(2)}</div>
            </div>
          </div>

          {/* Radiologist performance table */}
          <RadiologistTable
            title="Radiologist Performance"
            columns={[
              { key: 'sessions', label: 'Sessions' },
              { key: 'studies', label: 'Studies' },
              { key: 'totalRVU', label: 'RVU', format: (v: number) => v.toFixed(2) },
              { key: 'rvuPerHour', label: 'RVU/hr', format: (v: number) => v.toFixed(2), colorFn: (v: number) => v >= 4 ? '#22c55e' : v >= 3 ? '#3b82f6' : v >= 2 ? '#f59e0b' : '#ef4444' },
              { key: 'avgVariance', label: 'Avg Var', format: (v: number) => `${v > 0 ? '+' : ''}${Math.round(v)}s`, colorFn: (v: number) => v <= 0 ? '#22c55e' : '#ef4444' },
              { key: 'productiveRatio', label: 'Prod %', format: (v: number) => `${(v * 100).toFixed(0)}%` },
            ]}
            rows={userMetrics.map(u => ({
              id: u.id, name: u.name, sessions: u.sessions, studies: u.studies,
              totalRVU: u.totalRVU, rvuPerHour: u.rvuPerHour, avgVariance: u.avgVariance,
              productiveRatio: u.productiveRatio,
            }))}
            sortBy="rvuPerHour"
          />

          {/* Group RVU/hr distribution box plot */}
          {garDays.length > 0 && (
            <BoxPlotChart
              title="Group RVU/hr Distribution"
              items={garDays.map(g => ({
                label: g.date.slice(5),
                distribution: g.rvuPerHour,
              }))}
            />
          )}

          {/* Rotation efficiency ranking */}
          {rotationMetrics.length > 1 && (
            <div style={{ backgroundColor: '#1f2937', borderRadius: 8, padding: 16 }}>
              <h3 style={{ color: '#9ca3af', fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 12 }}>
                Rotation Efficiency
              </h3>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid #374151', color: '#9ca3af' }}>Rotation</th>
                    <th style={{ textAlign: 'right', padding: '6px 8px', borderBottom: '1px solid #374151', color: '#9ca3af' }}>Sessions</th>
                    <th style={{ textAlign: 'right', padding: '6px 8px', borderBottom: '1px solid #374151', color: '#9ca3af' }}>Radiologists</th>
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
                      <td style={{ padding: '6px 8px', color: '#d1d5db', textAlign: 'right' }}>{r.rvuPerHour.toFixed(2)}</td>
                      <td style={{ padding: '6px 8px', color: '#d1d5db', textAlign: 'right' }}>{r.totalRVU.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
