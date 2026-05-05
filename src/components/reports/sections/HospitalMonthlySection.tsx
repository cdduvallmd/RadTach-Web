// Hospital Admin Monthly Section
// Monthly RVU totals, volume by modality, throughput trend,
// disruption summary, session length trend, break utilization.

import { useMemo } from 'react';
import { useGroupStats } from '../../../hooks/useGroupStats';
import type { DateRange } from '../../../types/reports';

interface HospitalMonthlySectionProps {
  system: string | null;
  dateRange: DateRange;
}

export default function HospitalMonthlySection({ system, dateRange }: HospitalMonthlySectionProps) {
  const { garDays, loading, error } = useGroupStats(system, dateRange);

  const monthTotals = useMemo(() => {
    if (garDays.length === 0) return null;
    const totalRVU = garDays.reduce((sum, g) => sum + g.groupTotals.totalRVU, 0);
    const totalStudies = garDays.reduce((sum, g) => sum + g.groupTotals.totalStudies, 0);
    const totalSessionHours = garDays.reduce((sum, g) => sum + g.groupTotals.totalSessionHours, 0);
    const totalBreakHours = garDays.reduce((sum, g) => sum + g.groupTotals.totalBreakHours, 0);
    const totalAdminHours = garDays.reduce((sum, g) => sum + g.groupTotals.totalAdminHours, 0);
    const totalCommsHours = garDays.reduce((sum, g) => sum + g.groupTotals.totalCommsHours, 0);
    const sessionCount = garDays.reduce((sum, g) => sum + g.sessionCount, 0);

    const byModality: Record<string, { studies: number; rvu: number }> = {};
    for (const g of garDays) {
      for (const [mod, data] of Object.entries(g.groupTotalsByModality)) {
        if (!byModality[mod]) byModality[mod] = { studies: 0, rvu: 0 };
        byModality[mod].studies += data.studies;
        byModality[mod].rvu += data.rvu;
      }
    }

    const tagFreq: Record<string, number> = {};
    for (const g of garDays) {
      for (const [tag, count] of Object.entries(g.tagFrequency)) {
        tagFreq[tag] = (tagFreq[tag] || 0) + count;
      }
    }

    return {
      totalRVU, totalStudies, totalSessionHours, totalBreakHours,
      totalAdminHours, totalCommsHours, sessionCount, byModality, tagFreq,
      daysReported: garDays.length,
      avgRVUPerDay: garDays.length > 0 ? totalRVU / garDays.length : 0,
    };
  }, [garDays]);

  // Daily throughput trend
  const dailyThroughput = useMemo(() => {
    return garDays.map(g => ({
      date: g.date,
      studies: g.groupTotals.totalStudies,
      rvu: g.groupTotals.totalRVU,
    }));
  }, [garDays]);

  if (loading) {
    return <div style={{ color: '#9ca3af', textAlign: 'center', padding: 32 }}>Loading hospital data...</div>;
  }
  if (error) {
    return <div style={{ backgroundColor: 'rgba(127, 29, 29, 0.3)', borderRadius: 8, padding: 16, color: '#fca5a5', fontSize: 14 }}>Error: {error}</div>;
  }
  if (!monthTotals) return null;

  const networkCount = monthTotals.tagFreq['Network & Application Interference'] || 0;

  return (
    <div className="space-y-6" style={{ borderTop: '2px solid #4b5563', paddingTop: 24, marginTop: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ backgroundColor: '#0891b2', color: 'white', fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 9999, textTransform: 'uppercase' }}>
          Hospital Admin
        </span>
        <span style={{ color: '#9ca3af', fontSize: 14, fontWeight: 600 }}>Monthly Operations Summary</span>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-4 gap-4">
        <div className="bg-gray-800 rounded-lg p-4 text-center">
          <div className="text-gray-400 text-xs mb-1">Monthly RVU</div>
          <div className="text-2xl font-bold text-white">{monthTotals.totalRVU.toFixed(2)}</div>
          <div className="text-xs text-gray-500">{monthTotals.avgRVUPerDay.toFixed(2)} avg/day</div>
        </div>
        <div className="bg-gray-800 rounded-lg p-4 text-center">
          <div className="text-gray-400 text-xs mb-1">Total Studies</div>
          <div className="text-2xl font-bold text-white">{monthTotals.totalStudies}</div>
        </div>
        <div className="bg-gray-800 rounded-lg p-4 text-center">
          <div className="text-gray-400 text-xs mb-1">Sessions</div>
          <div className="text-2xl font-bold text-white">{monthTotals.sessionCount}</div>
        </div>
        <div className="bg-gray-800 rounded-lg p-4 text-center">
          <div className="text-gray-400 text-xs mb-1">Days Reported</div>
          <div className="text-2xl font-bold text-white">{monthTotals.daysReported}</div>
        </div>
      </div>

      {/* Daily throughput trend */}
      {dailyThroughput.length > 1 && (
        <div style={{ backgroundColor: '#1f2937', borderRadius: 8, padding: 16 }}>
          <h3 style={{ color: '#9ca3af', fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 12 }}>
            Daily RVU Throughput
          </h3>
          <div className="flex items-end gap-1 h-24">
            {dailyThroughput.map((d, i) => {
              const max = Math.max(...dailyThroughput.map(x => x.rvu), 1);
              const height = (d.rvu / max) * 100;
              return (
                <div key={i} className="flex-1 flex flex-col items-center">
                  <div style={{ fontSize: 8, color: '#9ca3af', marginBottom: 1 }}>{d.rvu.toFixed(0)}</div>
                  <div style={{ width: '100%', borderRadius: '3px 3px 0 0', height: `${height}%`, backgroundColor: '#0891b2', minHeight: 2 }} />
                  <div style={{ fontSize: 8, color: '#6b7280', marginTop: 1 }}>{d.date.slice(8)}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Volume by modality */}
      {Object.keys(monthTotals.byModality).length > 0 && (
        <div style={{ backgroundColor: '#1f2937', borderRadius: 8, padding: 16 }}>
          <h3 style={{ color: '#9ca3af', fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 12 }}>
            Volume by Modality
          </h3>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid #374151', color: '#9ca3af' }}>Modality</th>
                <th style={{ textAlign: 'right', padding: '6px 8px', borderBottom: '1px solid #374151', color: '#9ca3af' }}>Studies</th>
                <th style={{ textAlign: 'right', padding: '6px 8px', borderBottom: '1px solid #374151', color: '#9ca3af' }}>RVU</th>
                <th style={{ textAlign: 'right', padding: '6px 8px', borderBottom: '1px solid #374151', color: '#9ca3af' }}>% Volume</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(monthTotals.byModality)
                .sort(([, a], [, b]) => b.studies - a.studies)
                .map(([mod, data]) => (
                  <tr key={mod}>
                    <td style={{ padding: '6px 8px', color: '#d1d5db' }}>{mod}</td>
                    <td style={{ padding: '6px 8px', color: '#d1d5db', textAlign: 'right' }}>{data.studies}</td>
                    <td style={{ padding: '6px 8px', color: '#d1d5db', textAlign: 'right' }}>{data.rvu.toFixed(2)}</td>
                    <td style={{ padding: '6px 8px', color: '#d1d5db', textAlign: 'right' }}>
                      {monthTotals.totalStudies > 0 ? ((data.studies / monthTotals.totalStudies) * 100).toFixed(2) : 0}%
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Time utilization breakdown */}
      <div style={{ backgroundColor: '#1f2937', borderRadius: 8, padding: 16 }}>
        <h3 style={{ color: '#9ca3af', fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 12 }}>
          Time Utilization (Hours)
        </h3>
        <div className="grid grid-cols-4 gap-4 text-center">
          <div style={{ backgroundColor: '#111827', borderRadius: 6, padding: 12 }}>
            <div style={{ color: '#9ca3af', fontSize: 11 }}>Session</div>
            <div style={{ color: 'white', fontSize: 18, fontWeight: 700 }}>{monthTotals.totalSessionHours.toFixed(2)}</div>
          </div>
          <div style={{ backgroundColor: '#111827', borderRadius: 6, padding: 12 }}>
            <div style={{ color: '#9ca3af', fontSize: 11 }}>Break</div>
            <div style={{ color: '#ec4899', fontSize: 18, fontWeight: 700 }}>{monthTotals.totalBreakHours.toFixed(2)}</div>
          </div>
          <div style={{ backgroundColor: '#111827', borderRadius: 6, padding: 12 }}>
            <div style={{ color: '#9ca3af', fontSize: 11 }}>Admin</div>
            <div style={{ color: '#f97316', fontSize: 18, fontWeight: 700 }}>{monthTotals.totalAdminHours.toFixed(2)}</div>
          </div>
          <div style={{ backgroundColor: '#111827', borderRadius: 6, padding: 12 }}>
            <div style={{ color: '#9ca3af', fontSize: 11 }}>Comms</div>
            <div style={{ color: '#06b6d4', fontSize: 18, fontWeight: 700 }}>{monthTotals.totalCommsHours.toFixed(2)}</div>
          </div>
        </div>
      </div>

      {/* Disruption summary */}
      {networkCount > 0 && (
        <div style={{ backgroundColor: 'rgba(239, 68, 68, 0.1)', borderRadius: 8, padding: 16, border: '1px solid rgba(239, 68, 68, 0.3)' }}>
          <h3 style={{ color: '#fca5a5', fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
            Disruption Summary
          </h3>
          <div className="grid grid-cols-2 gap-4 text-center">
            <div>
              <div style={{ color: '#fca5a5', fontSize: 11 }}>Network Interference Reports</div>
              <div style={{ color: '#ef4444', fontSize: 24, fontWeight: 700 }}>{networkCount}</div>
            </div>
            <div>
              <div style={{ color: '#fca5a5', fontSize: 11 }}>% Sessions Affected</div>
              <div style={{ color: '#ef4444', fontSize: 24, fontWeight: 700 }}>
                {monthTotals.sessionCount > 0 ? ((networkCount / monthTotals.sessionCount) * 100).toFixed(2) : 0}%
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
