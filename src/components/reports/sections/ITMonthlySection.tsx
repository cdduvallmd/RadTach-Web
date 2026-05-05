// IT Monthly Section
// Monthly interference trend, workstation health ranking,
// uptime proxy, utilization.

import { useMemo } from 'react';
import { useWorkstationStats } from '../../../hooks/useWorkstationStats';
import { useGroupStats } from '../../../hooks/useGroupStats';
import type { DateRange } from '../../../types/reports';

interface ITMonthlySectionProps {
  system: string | null;
  dateRange: DateRange;
}

export default function ITMonthlySection({ system, dateRange }: ITMonthlySectionProps) {
  const { wsDays, loading: wsLoading, error: wsError } = useWorkstationStats(system, dateRange);
  const { garDays, loading: garLoading } = useGroupStats(system, dateRange);

  const loading = wsLoading || garLoading;

  // Daily interference trend
  const interferenceTrend = useMemo(() => {
    return garDays.map(g => ({
      date: g.date,
      count: g.tagFrequency['Network & Application Interference'] || 0,
      sessions: g.sessionCount,
    }));
  }, [garDays]);

  const totalInterference = useMemo(() =>
    interferenceTrend.reduce((sum, d) => sum + d.count, 0), [interferenceTrend]);

  // Workstation health ranking (monthly aggregate)
  const workstationRanking = useMemo(() => {
    if (wsDays.length === 0) return [];

    const wsAgg: Record<string, { bottom5Totals: number[]; floorTotals: number[]; sessionCount: number }> = {};
    for (const day of wsDays) {
      for (const [ws, data] of Object.entries(day.workstations)) {
        if (!wsAgg[ws]) wsAgg[ws] = { bottom5Totals: [], floorTotals: [], sessionCount: 0 };
        wsAgg[ws].bottom5Totals.push(data.bottom5Avg.median);
        wsAgg[ws].floorTotals.push(data.sameModalityFloor.median);
        wsAgg[ws].sessionCount += data.sessionCount;
      }
    }

    return Object.entries(wsAgg).map(([ws, data]) => ({
      workstation: ws,
      avgBottom5: data.bottom5Totals.reduce((a, b) => a + b, 0) / data.bottom5Totals.length,
      avgFloor: data.floorTotals.reduce((a, b) => a + b, 0) / data.floorTotals.length,
      sessionCount: data.sessionCount,
      daysActive: data.bottom5Totals.length,
      // Health score: lower bottom5 = healthier (inverted)
      healthScore: 100 - Math.min(data.bottom5Totals.reduce((a, b) => a + b, 0) / data.bottom5Totals.length, 100),
    })).sort((a, b) => b.healthScore - a.healthScore);
  }, [wsDays]);

  if (loading) {
    return <div style={{ color: '#9ca3af', textAlign: 'center', padding: 32 }}>Loading IT data...</div>;
  }
  if (wsError) {
    return <div style={{ backgroundColor: 'rgba(127, 29, 29, 0.3)', borderRadius: 8, padding: 16, color: '#fca5a5', fontSize: 14 }}>Error: {wsError}</div>;
  }
  if (wsDays.length === 0 && garDays.length === 0) return null;

  return (
    <div className="space-y-6" style={{ borderTop: '2px solid #4b5563', paddingTop: 24, marginTop: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ backgroundColor: '#059669', color: 'white', fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 9999, textTransform: 'uppercase' }}>
          IT
        </span>
        <span style={{ color: '#9ca3af', fontSize: 14, fontWeight: 600 }}>Monthly System Health</span>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-gray-800 rounded-lg p-4 text-center">
          <div className="text-gray-400 text-xs mb-1">Interference Reports</div>
          <div style={{ color: totalInterference > 0 ? '#ef4444' : '#22c55e', fontSize: 28, fontWeight: 700 }}>
            {totalInterference}
          </div>
        </div>
        <div className="bg-gray-800 rounded-lg p-4 text-center">
          <div className="text-gray-400 text-xs mb-1">Workstations</div>
          <div className="text-2xl font-bold text-white">{workstationRanking.length}</div>
        </div>
        <div className="bg-gray-800 rounded-lg p-4 text-center">
          <div className="text-gray-400 text-xs mb-1">Data Days</div>
          <div className="text-2xl font-bold text-white">{wsDays.length}</div>
        </div>
      </div>

      {/* Daily interference trend */}
      {interferenceTrend.length > 1 && (
        <div style={{ backgroundColor: '#1f2937', borderRadius: 8, padding: 16 }}>
          <h3 style={{ color: '#9ca3af', fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 12 }}>
            Daily Interference Trend
          </h3>
          <div className="flex items-end gap-1 h-20">
            {interferenceTrend.map((d, i) => {
              const max = Math.max(...interferenceTrend.map(x => x.count), 1);
              const height = max > 0 ? (d.count / max) * 100 : 0;
              return (
                <div key={i} className="flex-1 flex flex-col items-center">
                  {d.count > 0 && <div style={{ fontSize: 8, color: '#fca5a5', marginBottom: 1 }}>{d.count}</div>}
                  <div style={{
                    width: '100%', borderRadius: '3px 3px 0 0', minHeight: 2,
                    height: `${height}%`,
                    backgroundColor: d.count > 0 ? '#ef4444' : '#374151',
                  }} />
                  <div style={{ fontSize: 7, color: '#6b7280', marginTop: 1 }}>{d.date.slice(8)}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Workstation health ranking */}
      {workstationRanking.length > 0 && (
        <div style={{ backgroundColor: '#1f2937', borderRadius: 8, padding: 16 }}>
          <h3 style={{ color: '#9ca3af', fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 12 }}>
            Workstation Health Ranking
          </h3>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid #374151', color: '#9ca3af' }}>Rank</th>
                <th style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid #374151', color: '#9ca3af' }}>Workstation</th>
                <th style={{ textAlign: 'right', padding: '6px 8px', borderBottom: '1px solid #374151', color: '#9ca3af' }}>Health</th>
                <th style={{ textAlign: 'right', padding: '6px 8px', borderBottom: '1px solid #374151', color: '#9ca3af' }}>Bottom 5 (s)</th>
                <th style={{ textAlign: 'right', padding: '6px 8px', borderBottom: '1px solid #374151', color: '#9ca3af' }}>Floor (s)</th>
                <th style={{ textAlign: 'right', padding: '6px 8px', borderBottom: '1px solid #374151', color: '#9ca3af' }}>Sessions</th>
              </tr>
            </thead>
            <tbody>
              {workstationRanking.map((ws, i) => (
                <tr key={ws.workstation}>
                  <td style={{ padding: '6px 8px', color: i === 0 ? '#22c55e' : '#d1d5db', fontWeight: i === 0 ? 700 : 400 }}>#{i + 1}</td>
                  <td style={{ padding: '6px 8px', color: '#d1d5db' }}>{ws.workstation}</td>
                  <td style={{ padding: '6px 8px', color: ws.healthScore >= 90 ? '#22c55e' : ws.healthScore >= 70 ? '#f59e0b' : '#ef4444', textAlign: 'right' }}>
                    {ws.healthScore.toFixed(0)}
                  </td>
                  <td style={{ padding: '6px 8px', color: '#d1d5db', textAlign: 'right' }}>{ws.avgBottom5.toFixed(2)}</td>
                  <td style={{ padding: '6px 8px', color: '#d1d5db', textAlign: 'right' }}>{ws.avgFloor.toFixed(2)}</td>
                  <td style={{ padding: '6px 8px', color: '#d1d5db', textAlign: 'right' }}>{ws.sessionCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
