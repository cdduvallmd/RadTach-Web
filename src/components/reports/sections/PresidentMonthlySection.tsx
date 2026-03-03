// President (President) Monthly Section
// Cross-radiologist view within a single month.
// Unique: staffing calendar heatmap, radiologist-modality efficiency matrix.

import { useMemo } from 'react';
import { useAllSystemSessions } from '../../../hooks/useAllSystemSessions';
import { useGroupStats } from '../../../hooks/useGroupStats';
import type { DateRange, StoredSession } from '../../../types/reports';
import { getDisplayName } from '../../../utils/displayName';
import { parseISO, getDate } from 'date-fns';
import RadiologistTable from '../shared/RadiologistTable';
import HeatmapChart from '../shared/HeatmapChart';
import CalendarHeatmap from '../shared/CalendarHeatmap';

interface PresidentMonthlySectionProps {
  system: string | null;
  dateRange: DateRange;
  formatTime: (seconds: number) => string;
}

interface UserMonthMetrics {
  id: string;
  name: string;
  sessions: number;
  studies: number;
  totalRVU: number;
  rvuPerHour: number;
  productiveRatio: number;
  avgVariance: number;
  breakEvents: number;
  studiesByModality: Record<string, number>;
  rvuPerHourByModality: Record<string, number>;
}

function computeUserMetrics(sessions: StoredSession[]): UserMonthMetrics[] {
  const byUser = new Map<string, StoredSession[]>();
  for (const s of sessions) {
    const uid = s.userAbbrev;
    const existing = byUser.get(uid) || [];
    existing.push(s);
    byUser.set(uid, existing);
  }

  const metrics: UserMonthMetrics[] = [];
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

    const studiesByModality: Record<string, number> = {};
    const rvuPerHourByModality: Record<string, number[]> = {};
    for (const s of userSessions) {
      if (s.summary) {
        for (const [mod, count] of Object.entries(s.summary.studiesByModality)) {
          studiesByModality[mod] = (studiesByModality[mod] || 0) + count;
        }
        for (const [mod, rate] of Object.entries(s.summary.rvuPerHourByModality)) {
          if (!rvuPerHourByModality[mod]) rvuPerHourByModality[mod] = [];
          rvuPerHourByModality[mod].push(rate);
        }
      }
    }
    const avgRvuPerHourByMod: Record<string, number> = {};
    for (const [mod, rates] of Object.entries(rvuPerHourByModality)) {
      avgRvuPerHourByMod[mod] = rates.reduce((a, b) => a + b, 0) / rates.length;
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
      studiesByModality,
      rvuPerHourByModality: avgRvuPerHourByMod,
    });
  }

  return metrics.sort((a, b) => b.rvuPerHour - a.rvuPerHour);
}

export default function PresidentMonthlySection({ system, dateRange }: PresidentMonthlySectionProps) {
  const { sessions, loading, error } = useAllSystemSessions(system, dateRange);
  const { garDays } = useGroupStats(system, dateRange);

  const userMetrics = useMemo(() => computeUserMetrics(sessions), [sessions]);

  // Staffing calendar: sessions per day of month
  const staffingByDay = useMemo(() => {
    const byDay: Record<number, number> = {};
    for (const s of sessions) {
      const day = getDate(parseISO(s.startDateTime));
      byDay[day] = (byDay[day] || 0) + 1;
    }
    return byDay;
  }, [sessions]);

  // Radiologist-modality efficiency matrix
  const allModalities = useMemo(() => {
    const mods = new Set<string>();
    for (const u of userMetrics) {
      for (const mod of Object.keys(u.studiesByModality)) mods.add(mod);
    }
    return [...mods].sort();
  }, [userMetrics]);

  const modalityHeatmapData = useMemo(() => {
    return userMetrics.map(u => {
      return allModalities.map(mod => ({
        value: u.rvuPerHourByModality[mod] || 0,
        label: `${u.name} / ${mod}: ${(u.rvuPerHourByModality[mod] || 0).toFixed(1)} RVU/hr`,
      }));
    });
  }, [userMetrics, allModalities]);

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
      return {
        rotation: rot,
        sessions: rotSessions.length,
        radiologists,
        rvuPerHour: hours > 0 ? totalRVU / hours : 0,
      };
    }).sort((a, b) => b.rvuPerHour - a.rvuPerHour);
  }, [sessions]);

  if (loading) {
    return <div style={{ color: '#9ca3af', textAlign: 'center', padding: 32 }}>Loading group data...</div>;
  }
  if (error) {
    return <div style={{ backgroundColor: 'rgba(127, 29, 29, 0.3)', borderRadius: 8, padding: 16, color: '#fca5a5', fontSize: 14 }}>Error: {error}</div>;
  }
  if (sessions.length === 0) return null;

  const year = dateRange.start.getFullYear();
  const month = dateRange.start.getMonth() + 1;

  return (
    <div className="space-y-6" style={{ borderTop: '2px solid #4b5563', paddingTop: 24, marginTop: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ backgroundColor: '#7c3aed', color: 'white', fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 9999, textTransform: 'uppercase' }}>
          President
        </span>
        <span style={{ color: '#9ca3af', fontSize: 14, fontWeight: 600 }}>Monthly Group Overview</span>
      </div>

      {/* Radiologist performance table */}
      <RadiologistTable
        title="Radiologist Performance"
        columns={[
          { key: 'sessions', label: 'Sessions' },
          { key: 'studies', label: 'Studies' },
          { key: 'totalRVU', label: 'RVU', format: (v: number) => v.toFixed(1) },
          { key: 'rvuPerHour', label: 'RVU/hr', format: (v: number) => v.toFixed(1), colorFn: (v: number) => v >= 4 ? '#22c55e' : v >= 3 ? '#3b82f6' : v >= 2 ? '#f59e0b' : '#ef4444' },
          { key: 'avgVariance', label: 'Avg Var', format: (v: number) => `${v > 0 ? '+' : ''}${Math.round(v)}s`, colorFn: (v: number) => v <= 0 ? '#22c55e' : '#ef4444' },
          { key: 'productiveRatio', label: 'Prod %', format: (v: number) => `${(v * 100).toFixed(0)}%` },
          { key: 'breakEvents', label: 'Breaks' },
        ]}
        rows={userMetrics.map(u => ({
          id: u.id, name: u.name, sessions: u.sessions, studies: u.studies,
          totalRVU: u.totalRVU, rvuPerHour: u.rvuPerHour, avgVariance: u.avgVariance,
          productiveRatio: u.productiveRatio, breakEvents: u.breakEvents,
        }))}
        sortBy="rvuPerHour"
      />

      {/* Staffing calendar heatmap */}
      <CalendarHeatmap
        title="Staffing Coverage"
        year={year}
        month={month}
        dayValues={staffingByDay}
      />

      {/* Radiologist-modality efficiency matrix */}
      {userMetrics.length > 0 && allModalities.length > 0 && (
        <HeatmapChart
          title="Radiologist-Modality Efficiency (RVU/hr)"
          rowLabels={userMetrics.map(u => u.name)}
          colLabels={allModalities}
          data={modalityHeatmapData}
          colorScale={(v) => {
            if (v === 0) return '#1f2937';
            if (v >= 5) return '#15803d';
            if (v >= 3) return '#22c55e';
            if (v >= 2) return '#84cc16';
            if (v >= 1) return '#eab308';
            return '#f97316';
          }}
        />
      )}

      {/* Rotation efficiency */}
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
              </tr>
            </thead>
            <tbody>
              {rotationMetrics.map(r => (
                <tr key={r.rotation}>
                  <td style={{ padding: '6px 8px', color: '#d1d5db' }}>{r.rotation}</td>
                  <td style={{ padding: '6px 8px', color: '#d1d5db', textAlign: 'right' }}>{r.sessions}</td>
                  <td style={{ padding: '6px 8px', color: '#d1d5db', textAlign: 'right' }}>{r.radiologists}</td>
                  <td style={{ padding: '6px 8px', color: '#d1d5db', textAlign: 'right' }}>{r.rvuPerHour.toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Group RVU/hr trend from GAR */}
      {garDays.length > 1 && (
        <div style={{ backgroundColor: '#1f2937', borderRadius: 8, padding: 16 }}>
          <h3 style={{ color: '#9ca3af', fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 12 }}>
            Daily Group RVU/hr (Median)
          </h3>
          <div className="flex items-end gap-1 h-24">
            {garDays.map((g, i) => {
              const max = Math.max(...garDays.map(d => d.rvuPerHour.median), 1);
              const height = (g.rvuPerHour.median / max) * 100;
              return (
                <div key={i} className="flex-1 flex flex-col items-center">
                  <div style={{ fontSize: 9, color: '#9ca3af', marginBottom: 2 }}>{g.rvuPerHour.median.toFixed(1)}</div>
                  <div style={{ width: '100%', borderRadius: '4px 4px 0 0', height: `${height}%`, backgroundColor: '#7c3aed', minHeight: 4 }} />
                  <div style={{ fontSize: 9, color: '#6b7280', marginTop: 2 }}>{g.date.slice(5)}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
