// President (President) Weekly Section
// Cross-radiologist view within a single week.
// Rendered below user sections when role === 'president'.

import { useMemo } from 'react';
import { useAllSystemSessions } from '../../../hooks/useAllSystemSessions';
import { useGroupStats } from '../../../hooks/useGroupStats';
import type { DateRange, StoredSession } from '../../../types/reports';
import { getDisplayName } from '../../../utils/displayName';
import RadiologistTable from '../shared/RadiologistTable';
import BoxPlotChart from '../shared/BoxPlotChart';

interface PresidentWeeklySectionProps {
  system: string | null;
  dateRange: DateRange;
  formatTime: (seconds: number) => string;
}

interface UserMetrics {
  id: string;
  name: string;
  sessions: number;
  studies: number;
  totalRVU: number;
  rvuPerHour: number;
  productiveRatio: number;
  avgVariance: number;
  breakEvents: number;
}

function computeUserMetrics(sessions: StoredSession[]): UserMetrics[] {
  const byUser = new Map<string, StoredSession[]>();
  for (const s of sessions) {
    const uid = s.userAbbrev;
    const existing = byUser.get(uid) || [];
    existing.push(s);
    byUser.set(uid, existing);
  }

  const metrics: UserMetrics[] = [];
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
      breakEvents: userSessions.reduce((sum, s) => sum + s.breakEvents, 0),
    });
  }

  return metrics.sort((a, b) => b.rvuPerHour - a.rvuPerHour);
}

export default function PresidentWeeklySection({ system, dateRange }: PresidentWeeklySectionProps) {
  const { sessions, loading, error } = useAllSystemSessions(system, dateRange);
  const { garDays } = useGroupStats(system, dateRange);

  const userMetrics = useMemo(() => computeUserMetrics(sessions), [sessions]);

  // Tag frequency across all users
  const tagFrequency = useMemo(() => {
    const freq: Record<string, number> = {};
    for (const s of sessions) {
      if (s.notes?.tags) {
        for (const t of s.notes.tags) {
          if (t !== 'No Comment') freq[t] = (freq[t] || 0) + 1;
        }
      }
    }
    return freq;
  }, [sessions]);

  // Group totals
  const groupTotals = useMemo(() => ({
    totalRVU: sessions.reduce((sum, s) => sum + s.totalRVU, 0),
    totalStudies: sessions.reduce((sum, s) => sum + s.studiesCompleted, 0),
    totalSessions: sessions.length,
    radiologists: new Set(sessions.map(s => s.userAbbrev)).size,
  }), [sessions]);

  if (loading) {
    return <div style={{ color: '#9ca3af', textAlign: 'center', padding: 32 }}>Loading group data...</div>;
  }

  if (error) {
    return (
      <div style={{ backgroundColor: 'rgba(127, 29, 29, 0.3)', borderRadius: 8, padding: 16, color: '#fca5a5', fontSize: 14 }}>
        Error loading group data: {error}
      </div>
    );
  }

  if (sessions.length === 0 || userMetrics.length === 0) return null;

  return (
    <div className="space-y-6" style={{ borderTop: '2px solid #4b5563', paddingTop: 24, marginTop: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ backgroundColor: '#7c3aed', color: 'white', fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 9999, textTransform: 'uppercase' }}>
          President
        </span>
        <span style={{ color: '#9ca3af', fontSize: 14, fontWeight: 600 }}>Weekly Group Overview</span>
      </div>

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
          <div className="text-2xl font-bold text-white">{groupTotals.totalRVU.toFixed(1)}</div>
        </div>
      </div>

      {/* Radiologist performance table */}
      <RadiologistTable
        title="Radiologist Performance"
        columns={[
          { key: 'sessions', label: 'Sessions' },
          { key: 'studies', label: 'Studies' },
          { key: 'totalRVU', label: 'RVU', format: (v: number) => v.toFixed(1) },
          {
            key: 'rvuPerHour', label: 'RVU/hr',
            format: (v: number) => v.toFixed(1),
            colorFn: (v: number) => v >= 4 ? '#22c55e' : v >= 3 ? '#3b82f6' : v >= 2 ? '#f59e0b' : '#ef4444',
          },
          {
            key: 'avgVariance', label: 'Avg Var',
            format: (v: number) => `${v > 0 ? '+' : ''}${Math.round(v)}s`,
            colorFn: (v: number) => v <= 0 ? '#22c55e' : '#ef4444',
          },
          {
            key: 'productiveRatio', label: 'Prod %',
            format: (v: number) => `${(v * 100).toFixed(0)}%`,
          },
        ]}
        rows={userMetrics.map(u => ({
          id: u.id,
          name: u.name,
          sessions: u.sessions,
          studies: u.studies,
          totalRVU: u.totalRVU,
          rvuPerHour: u.rvuPerHour,
          avgVariance: u.avgVariance,
          productiveRatio: u.productiveRatio,
        }))}
        sortBy="rvuPerHour"
      />

      {/* Group RVU/hr distribution box plot */}
      {garDays.length > 0 && (
        <BoxPlotChart
          title="Group RVU/hr Distribution"
          items={garDays.map(g => ({
            label: g.date.slice(5),  // MM-DD
            distribution: g.rvuPerHour,
          }))}
        />
      )}

      {/* Tag frequency */}
      {Object.keys(tagFrequency).length > 0 && (
        <div style={{ backgroundColor: '#1f2937', borderRadius: 8, padding: 16 }}>
          <h3 style={{ color: '#9ca3af', fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 12 }}>
            Group Session Tags
          </h3>
          <div className="flex flex-wrap gap-2">
            {Object.entries(tagFrequency)
              .sort(([, a], [, b]) => b - a)
              .map(([tag, count]) => {
                const TAG_COLORS: Record<string, string> = {
                  'Good Day': '#22c55e', 'Not Feeling It Today': '#f59e0b',
                  'Network & Application Interference': '#ef4444', 'Low Volume = Low Productivity': '#8b5cf6',
                  'Real World Intrusion': '#f97316', 'High Volume': '#3b82f6', 'Short Staffed': '#ec4899',
                };
                return (
                  <span key={tag} style={{ backgroundColor: TAG_COLORS[tag] || '#6b7280', color: 'white', fontSize: 11, fontWeight: 500, padding: '3px 10px', borderRadius: 9999 }}>
                    {tag} ({count})
                  </span>
                );
              })}
          </div>
          {/* Outlier flag: Network interference */}
          {(tagFrequency['Network & Application Interference'] || 0) >= 3 && (
            <div style={{ marginTop: 12, padding: '8px 12px', backgroundColor: 'rgba(239, 68, 68, 0.15)', borderRadius: 6, border: '1px solid rgba(239, 68, 68, 0.3)', fontSize: 12, color: '#fca5a5' }}>
              ⚠ "Network & Application Interference" reported by {tagFrequency['Network & Application Interference']} radiologists this week
            </div>
          )}
        </div>
      )}

      {/* Break compliance */}
      <div style={{ backgroundColor: '#1f2937', borderRadius: 8, padding: 16 }}>
        <h3 style={{ color: '#9ca3af', fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 12 }}>
          Break Compliance
        </h3>
        <div className="grid grid-cols-3 gap-4 text-center text-sm">
          {userMetrics.map(u => (
            <div key={u.id} style={{ backgroundColor: '#111827', borderRadius: 6, padding: 8 }}>
              <div style={{ color: '#9ca3af', fontSize: 11 }}>{u.name}</div>
              <div style={{ color: u.breakEvents > 0 ? '#22c55e' : '#ef4444', fontSize: 16, fontWeight: 700 }}>
                {u.breakEvents}
              </div>
              <div style={{ color: '#6b7280', fontSize: 10 }}>breaks</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
