// IT Quarterly Section
// System health summary, equipment replacement priority,
// interference trend, workstation lifecycle curve.

import { useMemo } from 'react';
import { useWorkstationStats } from '../../../hooks/useWorkstationStats';
import { useGroupStats } from '../../../hooks/useGroupStats';
import type { DateRange } from '../../../types/reports';

interface ITQuarterlySectionProps {
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

export default function ITQuarterlySection({ system, dateRange }: ITQuarterlySectionProps) {
  const { wsDays, loading: wsLoading, error: wsError } = useWorkstationStats(system, dateRange);
  const { garDays, loading: garLoading } = useGroupStats(system, dateRange);

  const loading = wsLoading || garLoading;

  // Monthly interference trend
  const monthlyInterference = useMemo(() => {
    const byMonth = groupByMonth(garDays);
    const months = [...byMonth.keys()].sort();
    return months.map(m => {
      const days = byMonth.get(m) || [];
      const count = days.reduce((sum, g) => sum + (g.tagFrequency['Network & Application Interference'] || 0), 0);
      const sessions = days.reduce((sum, g) => sum + g.sessionCount, 0);
      return { month: m, count, sessions };
    });
  }, [garDays]);

  const totalInterference = monthlyInterference.reduce((sum, m) => sum + m.count, 0);

  // Workstation health summary (quarterly aggregate)
  const workstationSummary = useMemo(() => {
    if (wsDays.length === 0) return [];

    const wsAgg: Record<string, { bottom5Totals: number[]; sessionCount: number }> = {};
    for (const day of wsDays) {
      for (const [ws, data] of Object.entries(day.workstations)) {
        if (!wsAgg[ws]) wsAgg[ws] = { bottom5Totals: [], sessionCount: 0 };
        wsAgg[ws].bottom5Totals.push(data.bottom5Avg.median);
        wsAgg[ws].sessionCount += data.sessionCount;
      }
    }

    return Object.entries(wsAgg).map(([ws, data]) => {
      const avgBottom5 = data.bottom5Totals.reduce((a, b) => a + b, 0) / data.bottom5Totals.length;
      return {
        workstation: ws,
        avgBottom5,
        sessionCount: data.sessionCount,
        daysActive: data.bottom5Totals.length,
        healthScore: 100 - Math.min(avgBottom5, 100),
      };
    }).sort((a, b) => a.healthScore - b.healthScore); // Worst first for replacement priority
  }, [wsDays]);

  // Equipment replacement priority: workstations with lowest health
  const replacementCandidates = useMemo(() =>
    workstationSummary.filter(ws => ws.healthScore < 70), [workstationSummary]);

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
        <span style={{ color: '#9ca3af', fontSize: 14, fontWeight: 600 }}>Quarterly System Health</span>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-gray-800 rounded-lg p-4 text-center">
          <div className="text-gray-400 text-xs mb-1">Quarterly Interference</div>
          <div style={{ color: totalInterference > 0 ? '#ef4444' : '#22c55e', fontSize: 28, fontWeight: 700 }}>
            {totalInterference}
          </div>
        </div>
        <div className="bg-gray-800 rounded-lg p-4 text-center">
          <div className="text-gray-400 text-xs mb-1">Workstations</div>
          <div className="text-2xl font-bold text-white">{workstationSummary.length}</div>
        </div>
        <div className="bg-gray-800 rounded-lg p-4 text-center">
          <div className="text-gray-400 text-xs mb-1">Replacement Candidates</div>
          <div style={{ color: replacementCandidates.length > 0 ? '#f59e0b' : '#22c55e', fontSize: 28, fontWeight: 700 }}>
            {replacementCandidates.length}
          </div>
        </div>
      </div>

      {/* Monthly interference trend */}
      {monthlyInterference.length > 1 && (
        <div style={{ backgroundColor: '#1f2937', borderRadius: 8, padding: 16 }}>
          <h3 style={{ color: '#9ca3af', fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 12 }}>
            Monthly Interference Trend
          </h3>
          <div className="flex items-end gap-4 h-24">
            {monthlyInterference.map((m, i) => {
              const max = Math.max(...monthlyInterference.map(x => x.count), 1);
              const height = max > 0 ? (m.count / max) * 100 : 0;
              return (
                <div key={i} className="flex-1 flex flex-col items-center">
                  <div style={{ fontSize: 10, color: m.count > 0 ? '#fca5a5' : '#9ca3af', marginBottom: 2 }}>{m.count}</div>
                  <div style={{
                    width: '100%', borderRadius: '4px 4px 0 0', minHeight: 4,
                    height: `${height}%`,
                    backgroundColor: m.count > 0 ? '#ef4444' : '#374151',
                  }} />
                  <div style={{ fontSize: 10, color: '#6b7280', marginTop: 2 }}>{m.month.slice(5)}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Equipment replacement priority */}
      {replacementCandidates.length > 0 && (
        <div style={{ backgroundColor: 'rgba(245, 158, 11, 0.1)', borderRadius: 8, padding: 16, border: '1px solid rgba(245, 158, 11, 0.3)' }}>
          <h3 style={{ color: '#fbbf24', fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 12 }}>
            Equipment Replacement Priority
          </h3>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid #374151', color: '#fbbf24' }}>Workstation</th>
                <th style={{ textAlign: 'right', padding: '6px 8px', borderBottom: '1px solid #374151', color: '#fbbf24' }}>Health Score</th>
                <th style={{ textAlign: 'right', padding: '6px 8px', borderBottom: '1px solid #374151', color: '#fbbf24' }}>Avg Bottom 5 (s)</th>
                <th style={{ textAlign: 'right', padding: '6px 8px', borderBottom: '1px solid #374151', color: '#fbbf24' }}>Sessions</th>
              </tr>
            </thead>
            <tbody>
              {replacementCandidates.map(ws => (
                <tr key={ws.workstation}>
                  <td style={{ padding: '6px 8px', color: '#d1d5db' }}>{ws.workstation}</td>
                  <td style={{ padding: '6px 8px', color: '#ef4444', textAlign: 'right', fontWeight: 700 }}>{ws.healthScore.toFixed(0)}</td>
                  <td style={{ padding: '6px 8px', color: '#d1d5db', textAlign: 'right' }}>{ws.avgBottom5.toFixed(1)}</td>
                  <td style={{ padding: '6px 8px', color: '#d1d5db', textAlign: 'right' }}>{ws.sessionCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Full workstation summary */}
      {workstationSummary.length > 0 && (
        <div style={{ backgroundColor: '#1f2937', borderRadius: 8, padding: 16 }}>
          <h3 style={{ color: '#9ca3af', fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 12 }}>
            All Workstations
          </h3>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid #374151', color: '#9ca3af' }}>Workstation</th>
                <th style={{ textAlign: 'right', padding: '6px 8px', borderBottom: '1px solid #374151', color: '#9ca3af' }}>Health</th>
                <th style={{ textAlign: 'right', padding: '6px 8px', borderBottom: '1px solid #374151', color: '#9ca3af' }}>Bottom 5 (s)</th>
                <th style={{ textAlign: 'right', padding: '6px 8px', borderBottom: '1px solid #374151', color: '#9ca3af' }}>Sessions</th>
                <th style={{ textAlign: 'right', padding: '6px 8px', borderBottom: '1px solid #374151', color: '#9ca3af' }}>Days Active</th>
              </tr>
            </thead>
            <tbody>
              {workstationSummary.sort((a, b) => b.healthScore - a.healthScore).map(ws => (
                <tr key={ws.workstation}>
                  <td style={{ padding: '6px 8px', color: '#d1d5db' }}>{ws.workstation}</td>
                  <td style={{ padding: '6px 8px', color: ws.healthScore >= 90 ? '#22c55e' : ws.healthScore >= 70 ? '#f59e0b' : '#ef4444', textAlign: 'right' }}>
                    {ws.healthScore.toFixed(0)}
                  </td>
                  <td style={{ padding: '6px 8px', color: '#d1d5db', textAlign: 'right' }}>{ws.avgBottom5.toFixed(1)}</td>
                  <td style={{ padding: '6px 8px', color: '#d1d5db', textAlign: 'right' }}>{ws.sessionCount}</td>
                  <td style={{ padding: '6px 8px', color: '#d1d5db', textAlign: 'right' }}>{ws.daysActive}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
