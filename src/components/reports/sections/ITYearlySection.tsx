// IT Yearly Section
// Annual health report card, lifecycle analysis, annual disruption report,
// replacement forecast.

import { useMemo } from 'react';
import { useWorkstationStats } from '../../../hooks/useWorkstationStats';
import { useGroupStats } from '../../../hooks/useGroupStats';
import type { DateRange } from '../../../types/reports';

interface ITYearlySectionProps {
  system: string | null;
  dateRange: DateRange;
}

function groupByMonth<T extends { date: string }>(items: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const month = item.date.slice(0, 7);
    const existing = map.get(month) || [];
    existing.push(item);
    map.set(month, existing);
  }
  return map;
}

export default function ITYearlySection({ system, dateRange }: ITYearlySectionProps) {
  const { wsDays, loading: wsLoading, error: wsError } = useWorkstationStats(system, dateRange);
  const { garDays, loading: garLoading } = useGroupStats(system, dateRange);

  const loading = wsLoading || garLoading;

  // Monthly interference trend (12 months)
  const monthlyInterference = useMemo(() => {
    const byMonth = groupByMonth(garDays);
    const months = [...byMonth.keys()].sort();
    return months.map(m => {
      const days = byMonth.get(m) || [];
      const count = days.reduce((sum, g) => sum + (g.tagFrequency['Network & Application Interference'] || 0), 0);
      return { month: m, count };
    });
  }, [garDays]);

  const totalInterference = monthlyInterference.reduce((sum, m) => sum + m.count, 0);

  // Annual workstation health report card
  const workstationAnnual = useMemo(() => {
    if (wsDays.length === 0) return [];

    const wsAgg: Record<string, { bottom5ByMonth: Map<string, number[]>; sessionCount: number; totalDays: number }> = {};
    for (const day of wsDays) {
      const month = day.date.slice(0, 7);
      for (const [ws, data] of Object.entries(day.workstations)) {
        if (!wsAgg[ws]) wsAgg[ws] = { bottom5ByMonth: new Map(), sessionCount: 0, totalDays: 0 };
        const monthArr = wsAgg[ws].bottom5ByMonth.get(month) || [];
        monthArr.push(data.bottom5Avg.median);
        wsAgg[ws].bottom5ByMonth.set(month, monthArr);
        wsAgg[ws].sessionCount += data.sessionCount;
        wsAgg[ws].totalDays++;
      }
    }

    return Object.entries(wsAgg).map(([ws, data]) => {
      const allBottom5: number[] = [];
      data.bottom5ByMonth.forEach(vals => allBottom5.push(...vals));
      const avgBottom5 = allBottom5.reduce((a, b) => a + b, 0) / allBottom5.length;

      // Trend: compare first half vs second half of available months
      const months = [...data.bottom5ByMonth.keys()].sort();
      let trend = 'stable';
      if (months.length >= 2) {
        const mid = Math.floor(months.length / 2);
        const firstHalf = months.slice(0, mid).flatMap(m => data.bottom5ByMonth.get(m) || []);
        const secondHalf = months.slice(mid).flatMap(m => data.bottom5ByMonth.get(m) || []);
        const firstAvg = firstHalf.reduce((a, b) => a + b, 0) / (firstHalf.length || 1);
        const secondAvg = secondHalf.reduce((a, b) => a + b, 0) / (secondHalf.length || 1);
        if (secondAvg > firstAvg * 1.1) trend = 'degrading';
        else if (secondAvg < firstAvg * 0.9) trend = 'improving';
      }

      return {
        workstation: ws,
        avgBottom5,
        sessionCount: data.sessionCount,
        totalDays: data.totalDays,
        healthScore: 100 - Math.min(avgBottom5, 100),
        trend,
        monthsActive: data.bottom5ByMonth.size,
      };
    }).sort((a, b) => a.healthScore - b.healthScore);
  }, [wsDays]);

  const degradingWorkstations = workstationAnnual.filter(ws => ws.trend === 'degrading');

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
        <span style={{ color: '#9ca3af', fontSize: 14, fontWeight: 600 }}>Annual System Health Report</span>
      </div>

      {/* Annual summary */}
      <div className="grid grid-cols-4 gap-4">
        <div className="bg-gray-800 rounded-lg p-4 text-center">
          <div className="text-gray-400 text-xs mb-1">Annual Interference</div>
          <div style={{ color: totalInterference > 0 ? '#ef4444' : '#22c55e', fontSize: 28, fontWeight: 700 }}>
            {totalInterference}
          </div>
        </div>
        <div className="bg-gray-800 rounded-lg p-4 text-center">
          <div className="text-gray-400 text-xs mb-1">Workstations</div>
          <div className="text-2xl font-bold text-white">{workstationAnnual.length}</div>
        </div>
        <div className="bg-gray-800 rounded-lg p-4 text-center">
          <div className="text-gray-400 text-xs mb-1">Degrading</div>
          <div style={{ color: degradingWorkstations.length > 0 ? '#ef4444' : '#22c55e', fontSize: 28, fontWeight: 700 }}>
            {degradingWorkstations.length}
          </div>
        </div>
        <div className="bg-gray-800 rounded-lg p-4 text-center">
          <div className="text-gray-400 text-xs mb-1">Data Days</div>
          <div className="text-2xl font-bold text-white">{wsDays.length}</div>
        </div>
      </div>

      {/* Monthly interference trend */}
      {monthlyInterference.length > 1 && (
        <div style={{ backgroundColor: '#1f2937', borderRadius: 8, padding: 16 }}>
          <h3 style={{ color: '#9ca3af', fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 12 }}>
            Monthly Interference Trend
          </h3>
          <div className="flex items-end gap-1 h-24">
            {monthlyInterference.map((m, i) => {
              const max = Math.max(...monthlyInterference.map(x => x.count), 1);
              const height = max > 0 ? (m.count / max) * 100 : 0;
              return (
                <div key={i} className="flex-1 flex flex-col items-center">
                  <div style={{ fontSize: 8, color: m.count > 0 ? '#fca5a5' : '#9ca3af', marginBottom: 1 }}>{m.count}</div>
                  <div style={{
                    width: '100%', borderRadius: '3px 3px 0 0', minHeight: 2,
                    height: `${height}%`,
                    backgroundColor: m.count > 0 ? '#ef4444' : '#374151',
                  }} />
                  <div style={{ fontSize: 7, color: '#6b7280', marginTop: 1 }}>{m.month.slice(5)}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Degrading workstations alert */}
      {degradingWorkstations.length > 0 && (
        <div style={{ backgroundColor: 'rgba(239, 68, 68, 0.1)', borderRadius: 8, padding: 16, border: '1px solid rgba(239, 68, 68, 0.3)' }}>
          <h3 style={{ color: '#fca5a5', fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 12 }}>
            Replacement Forecast — Degrading Workstations
          </h3>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid #374151', color: '#fca5a5' }}>Workstation</th>
                <th style={{ textAlign: 'right', padding: '6px 8px', borderBottom: '1px solid #374151', color: '#fca5a5' }}>Health</th>
                <th style={{ textAlign: 'right', padding: '6px 8px', borderBottom: '1px solid #374151', color: '#fca5a5' }}>Trend</th>
                <th style={{ textAlign: 'right', padding: '6px 8px', borderBottom: '1px solid #374151', color: '#fca5a5' }}>Avg Bottom 5 (s)</th>
              </tr>
            </thead>
            <tbody>
              {degradingWorkstations.map(ws => (
                <tr key={ws.workstation}>
                  <td style={{ padding: '6px 8px', color: '#d1d5db' }}>{ws.workstation}</td>
                  <td style={{ padding: '6px 8px', color: '#ef4444', textAlign: 'right', fontWeight: 700 }}>{ws.healthScore.toFixed(0)}</td>
                  <td style={{ padding: '6px 8px', color: '#ef4444', textAlign: 'right' }}>Degrading</td>
                  <td style={{ padding: '6px 8px', color: '#d1d5db', textAlign: 'right' }}>{ws.avgBottom5.toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Full annual report card */}
      {workstationAnnual.length > 0 && (
        <div style={{ backgroundColor: '#1f2937', borderRadius: 8, padding: 16 }}>
          <h3 style={{ color: '#9ca3af', fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 12 }}>
            Annual Workstation Report Card
          </h3>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid #374151', color: '#9ca3af' }}>Workstation</th>
                <th style={{ textAlign: 'right', padding: '6px 8px', borderBottom: '1px solid #374151', color: '#9ca3af' }}>Health</th>
                <th style={{ textAlign: 'right', padding: '6px 8px', borderBottom: '1px solid #374151', color: '#9ca3af' }}>Trend</th>
                <th style={{ textAlign: 'right', padding: '6px 8px', borderBottom: '1px solid #374151', color: '#9ca3af' }}>Bottom 5 (s)</th>
                <th style={{ textAlign: 'right', padding: '6px 8px', borderBottom: '1px solid #374151', color: '#9ca3af' }}>Sessions</th>
                <th style={{ textAlign: 'right', padding: '6px 8px', borderBottom: '1px solid #374151', color: '#9ca3af' }}>Months</th>
              </tr>
            </thead>
            <tbody>
              {workstationAnnual.sort((a, b) => b.healthScore - a.healthScore).map(ws => {
                const trendColor = ws.trend === 'improving' ? '#22c55e' : ws.trend === 'degrading' ? '#ef4444' : '#9ca3af';
                const trendLabel = ws.trend === 'improving' ? 'Improving' : ws.trend === 'degrading' ? 'Degrading' : 'Stable';
                return (
                  <tr key={ws.workstation}>
                    <td style={{ padding: '6px 8px', color: '#d1d5db' }}>{ws.workstation}</td>
                    <td style={{ padding: '6px 8px', color: ws.healthScore >= 90 ? '#22c55e' : ws.healthScore >= 70 ? '#f59e0b' : '#ef4444', textAlign: 'right' }}>
                      {ws.healthScore.toFixed(0)}
                    </td>
                    <td style={{ padding: '6px 8px', color: trendColor, textAlign: 'right' }}>{trendLabel}</td>
                    <td style={{ padding: '6px 8px', color: '#d1d5db', textAlign: 'right' }}>{ws.avgBottom5.toFixed(1)}</td>
                    <td style={{ padding: '6px 8px', color: '#d1d5db', textAlign: 'right' }}>{ws.sessionCount}</td>
                    <td style={{ padding: '6px 8px', color: '#d1d5db', textAlign: 'right' }}>{ws.monthsActive}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
