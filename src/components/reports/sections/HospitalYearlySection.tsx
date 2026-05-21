// Hospital Admin Yearly Section
// Annual RVU, volume by modality, throughput trend, annual disruption report,
// seasonal volume model.

import { useMemo } from 'react';
import { useGroupStats } from '../../../hooks/useGroupStats';
import type { DateRange, GroupStats } from '../../../types/reports';

interface HospitalYearlySectionProps {
  system: string | null;
  dateRange: DateRange;
}

function groupGarByMonth(garDays: GroupStats[]): Map<string, GroupStats[]> {
  const map = new Map<string, GroupStats[]>();
  for (const g of garDays) {
    const month = g.date.slice(0, 7);
    const existing = map.get(month) || [];
    existing.push(g);
    map.set(month, existing);
  }
  return map;
}

export default function HospitalYearlySection({ system, dateRange }: HospitalYearlySectionProps) {
  const { garDays, loading, error } = useGroupStats(system, dateRange);

  const yearTotals = useMemo(() => {
    if (garDays.length === 0) return null;
    const totalRVU = garDays.reduce((sum, g) => sum + g.groupTotals.totalRVU, 0);
    const totalStudies = garDays.reduce((sum, g) => sum + g.groupTotals.totalStudies, 0);
    const totalSessionHours = garDays.reduce((sum, g) => sum + g.groupTotals.totalSessionHours, 0);
    const totalBreakHours = garDays.reduce((sum, g) => sum + g.groupTotals.totalBreakHours, 0);
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

    const totalAdminHours = garDays.reduce((sum, g) => sum + g.groupTotals.totalAdminHours, 0);
    const totalCommsHours = garDays.reduce((sum, g) => sum + g.groupTotals.totalCommsHours, 0);

    return { totalRVU, totalStudies, totalSessionHours, totalBreakHours, totalAdminHours, totalCommsHours, sessionCount, byModality, tagFreq, daysReported: garDays.length };
  }, [garDays]);

  // Monthly RVU trend (seasonal view)
  const monthlyTrend = useMemo(() => {
    const byMonth = groupGarByMonth(garDays);
    const months = [...byMonth.keys()].sort();
    return months.map(m => {
      const days = byMonth.get(m) || [];
      return {
        month: m,
        totalRVU: days.reduce((sum, g) => sum + g.groupTotals.totalRVU, 0),
        totalStudies: days.reduce((sum, g) => sum + g.groupTotals.totalStudies, 0),
        sessions: days.reduce((sum, g) => sum + g.sessionCount, 0),
      };
    });
  }, [garDays]);

  if (loading) {
    return <div style={{ color: '#9ca3af', textAlign: 'center', padding: 32 }}>Loading hospital data...</div>;
  }
  if (error) {
    return <div style={{ backgroundColor: 'rgba(127, 29, 29, 0.3)', borderRadius: 8, padding: 16, color: '#fca5a5', fontSize: 14 }}>Error: {error}</div>;
  }
  if (!yearTotals) return null;

  const networkCount = yearTotals.tagFreq['Network & Application Interference'] || 0;

  return (
    <div className="space-y-6" style={{ borderTop: '2px solid #4b5563', paddingTop: 24, marginTop: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ backgroundColor: '#0891b2', color: 'white', fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 9999, textTransform: 'uppercase' }}>
          Hospital Admin
        </span>
        <span style={{ color: '#9ca3af', fontSize: 14, fontWeight: 600 }}>Annual Operations Summary</span>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-4 gap-4">
        <div className="bg-gray-800 rounded-lg p-4 text-center">
          <div className="text-gray-400 text-xs mb-1">Annual RVU</div>
          <div className="text-2xl font-bold text-white">{yearTotals.totalRVU.toFixed(2)}</div>
        </div>
        <div className="bg-gray-800 rounded-lg p-4 text-center">
          <div className="text-gray-400 text-xs mb-1">Annual Studies</div>
          <div className="text-2xl font-bold text-white">{yearTotals.totalStudies}</div>
        </div>
        <div className="bg-gray-800 rounded-lg p-4 text-center">
          <div className="text-gray-400 text-xs mb-1">Total Sessions</div>
          <div className="text-2xl font-bold text-white">{yearTotals.sessionCount}</div>
        </div>
        <div className="bg-gray-800 rounded-lg p-4 text-center">
          <div className="text-gray-400 text-xs mb-1">Session Hours</div>
          <div className="text-2xl font-bold text-white">{yearTotals.totalSessionHours.toFixed(2)}</div>
        </div>
      </div>

      {/* Monthly RVU trend (seasonal) */}
      {monthlyTrend.length > 1 && (
        <div style={{ backgroundColor: '#1f2937', borderRadius: 8, padding: 16 }}>
          <h3 style={{ color: '#9ca3af', fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 12 }}>
            Monthly RVU Trend
          </h3>
          <div className="flex items-end gap-1 h-32">
            {monthlyTrend.map((m, i) => {
              const max = Math.max(...monthlyTrend.map(x => x.totalRVU), 1);
              const height = (m.totalRVU / max) * 100;
              return (
                <div key={i} className="flex-1 flex flex-col items-center">
                  <div style={{ fontSize: 8, color: '#9ca3af', marginBottom: 1 }}>{m.totalRVU.toFixed(0)}</div>
                  <div style={{ width: '100%', borderRadius: '3px 3px 0 0', height: `${height}%`, backgroundColor: '#0891b2', minHeight: 2 }} />
                  <div style={{ fontSize: 8, color: '#6b7280', marginTop: 1 }}>{m.month.slice(5)}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Annual volume by modality */}
      {Object.keys(yearTotals.byModality).length > 0 && (
        <div style={{ backgroundColor: '#1f2937', borderRadius: 8, padding: 16 }}>
          <h3 style={{ color: '#9ca3af', fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 12 }}>
            Annual Volume by Modality
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
              {Object.entries(yearTotals.byModality)
                .sort(([, a], [, b]) => b.studies - a.studies)
                .map(([mod, data]) => (
                  <tr key={mod}>
                    <td style={{ padding: '6px 8px', color: '#d1d5db' }}>{mod}</td>
                    <td style={{ padding: '6px 8px', color: '#d1d5db', textAlign: 'right' }}>{data.studies}</td>
                    <td style={{ padding: '6px 8px', color: '#d1d5db', textAlign: 'right' }}>{data.rvu.toFixed(2)}</td>
                    <td style={{ padding: '6px 8px', color: '#d1d5db', textAlign: 'right' }}>
                      {yearTotals.totalStudies > 0 ? ((data.studies / yearTotals.totalStudies) * 100).toFixed(2) : 0}%
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Value-Added Services */}
      {yearTotals && (yearTotals.totalCommsHours > 0 || yearTotals.totalAdminHours > 0) && (
        <div style={{ backgroundColor: '#064e3b', borderRadius: 8, padding: 16, border: '1px solid #065f46' }}>
          <h3 style={{ color: '#6ee7b7', fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 12 }}>
            Value-Added Services This Year
          </h3>
          <div className="grid grid-cols-3 gap-4 text-center">
            <div style={{ backgroundColor: 'rgba(0,0,0,0.2)', borderRadius: 6, padding: 12 }}>
              <div style={{ color: '#6ee7b7', fontSize: 11 }}>Phone Consultations</div>
              <div style={{ color: 'white', fontSize: 20, fontWeight: 700 }}>{yearTotals.totalCommsHours.toFixed(1)} hrs</div>
            </div>
            <div style={{ backgroundColor: 'rgba(0,0,0,0.2)', borderRadius: 6, padding: 12 }}>
              <div style={{ color: '#6ee7b7', fontSize: 11 }}>Administrative</div>
              <div style={{ color: 'white', fontSize: 20, fontWeight: 700 }}>{yearTotals.totalAdminHours.toFixed(1)} hrs</div>
            </div>
            <div style={{ backgroundColor: 'rgba(0,0,0,0.2)', borderRadius: 6, padding: 12 }}>
              <div style={{ color: '#6ee7b7', fontSize: 11 }}>Total Service Hours</div>
              <div style={{ color: 'white', fontSize: 20, fontWeight: 700 }}>{(yearTotals.totalCommsHours + yearTotals.totalAdminHours).toFixed(1)} hrs</div>
            </div>
          </div>
        </div>
      )}

      {/* Annual disruption report */}
      {networkCount > 0 && (
        <div style={{ backgroundColor: 'rgba(239, 68, 68, 0.1)', borderRadius: 8, padding: 16, border: '1px solid rgba(239, 68, 68, 0.3)' }}>
          <h3 style={{ color: '#fca5a5', fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
            Annual Disruption Report
          </h3>
          <div className="grid grid-cols-3 gap-4 text-center">
            <div>
              <div style={{ color: '#fca5a5', fontSize: 11 }}>Total Incidents</div>
              <div style={{ color: '#ef4444', fontSize: 24, fontWeight: 700 }}>{networkCount}</div>
            </div>
            <div>
              <div style={{ color: '#fca5a5', fontSize: 11 }}>% Sessions Affected</div>
              <div style={{ color: '#ef4444', fontSize: 24, fontWeight: 700 }}>
                {yearTotals.sessionCount > 0 ? ((networkCount / yearTotals.sessionCount) * 100).toFixed(2) : 0}%
              </div>
            </div>
            <div>
              <div style={{ color: '#fca5a5', fontSize: 11 }}>Reporting Days</div>
              <div style={{ color: '#d1d5db', fontSize: 24, fontWeight: 700 }}>{yearTotals.daysReported}</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
