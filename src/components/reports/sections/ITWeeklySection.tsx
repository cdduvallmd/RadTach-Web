// IT Weekly Section
// Network interference count, workstation comparison, interstitial floor
// by workstation, sessions per workstation. Pulls from WorkstationStats.

import { useMemo } from 'react';
import { useWorkstationStats } from '../../../hooks/useWorkstationStats';
import { useGroupStats } from '../../../hooks/useGroupStats';
import type { DateRange } from '../../../types/reports';

interface ITWeeklySectionProps {
  system: string | null;
  dateRange: DateRange;
}

export default function ITWeeklySection({ system, dateRange }: ITWeeklySectionProps) {
  const { wsDays, loading: wsLoading, error: wsError } = useWorkstationStats(system, dateRange);
  const { garDays, loading: garLoading } = useGroupStats(system, dateRange);

  const loading = wsLoading || garLoading;

  // Aggregate workstation metrics
  const workstationMetrics = useMemo(() => {
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
    })).sort((a, b) => b.avgBottom5 - a.avgBottom5);
  }, [wsDays]);

  // Network interference count from GAR tag frequency
  const networkInterference = useMemo(() => {
    let count = 0;
    for (const g of garDays) {
      count += g.tagFrequency['Network & Application Interference'] || 0;
    }
    return count;
  }, [garDays]);

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
        <span style={{ color: '#9ca3af', fontSize: 14, fontWeight: 600 }}>Weekly System Health</span>
      </div>

      {/* Network interference summary */}
      <div className="grid grid-cols-2 gap-4">
        <div className="bg-gray-800 rounded-lg p-4 text-center">
          <div className="text-gray-400 text-xs mb-1">Network Interference Reports</div>
          <div style={{ color: networkInterference > 0 ? '#ef4444' : '#22c55e', fontSize: 28, fontWeight: 700 }}>
            {networkInterference}
          </div>
          <div className="text-xs text-gray-500">this week</div>
        </div>
        <div className="bg-gray-800 rounded-lg p-4 text-center">
          <div className="text-gray-400 text-xs mb-1">Workstations Tracked</div>
          <div className="text-2xl font-bold text-white">{workstationMetrics.length}</div>
          <div className="text-xs text-gray-500">{wsDays.length} day(s) of data</div>
        </div>
      </div>

      {/* Workstation comparison table */}
      {workstationMetrics.length > 0 && (
        <div style={{ backgroundColor: '#1f2937', borderRadius: 8, padding: 16 }}>
          <h3 style={{ color: '#9ca3af', fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 12 }}>
            Workstation Performance
          </h3>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid #374151', color: '#9ca3af' }}>Workstation</th>
                <th style={{ textAlign: 'right', padding: '6px 8px', borderBottom: '1px solid #374151', color: '#9ca3af' }}>Sessions</th>
                <th style={{ textAlign: 'right', padding: '6px 8px', borderBottom: '1px solid #374151', color: '#9ca3af' }}>Days Active</th>
                <th style={{ textAlign: 'right', padding: '6px 8px', borderBottom: '1px solid #374151', color: '#9ca3af' }}>Avg Bottom 5 (s)</th>
                <th style={{ textAlign: 'right', padding: '6px 8px', borderBottom: '1px solid #374151', color: '#9ca3af' }}>Avg Floor (s)</th>
              </tr>
            </thead>
            <tbody>
              {workstationMetrics.map(ws => (
                <tr key={ws.workstation}>
                  <td style={{ padding: '6px 8px', color: '#d1d5db' }}>{ws.workstation}</td>
                  <td style={{ padding: '6px 8px', color: '#d1d5db', textAlign: 'right' }}>{ws.sessionCount}</td>
                  <td style={{ padding: '6px 8px', color: '#d1d5db', textAlign: 'right' }}>{ws.daysActive}</td>
                  <td style={{ padding: '6px 8px', color: ws.avgBottom5 > 10 ? '#ef4444' : '#22c55e', textAlign: 'right' }}>{ws.avgBottom5.toFixed(2)}</td>
                  <td style={{ padding: '6px 8px', color: '#d1d5db', textAlign: 'right' }}>{ws.avgFloor.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ marginTop: 8, fontSize: 11, color: '#6b7280' }}>
            Bottom 5: Average of 5 fastest interstitial times (lower = faster system). Floor: Same-modality minimum interstitial.
          </div>
        </div>
      )}
    </div>
  );
}
