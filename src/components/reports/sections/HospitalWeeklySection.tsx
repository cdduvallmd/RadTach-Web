// Hospital Admin Weekly Section
// Total RVU, studies completed, RVU by modality, service disruption count,
// break compliance. Pulls from GroupStats groupTotals — no individual data.

import { useMemo } from 'react';
import { useGroupStats } from '../../../hooks/useGroupStats';
import type { DateRange } from '../../../types/reports';

interface HospitalWeeklySectionProps {
  system: string | null;
  dateRange: DateRange;
}

export default function HospitalWeeklySection({ system, dateRange }: HospitalWeeklySectionProps) {
  const { garDays, loading, error } = useGroupStats(system, dateRange);

  // Aggregate across all days in the week
  const weekTotals = useMemo(() => {
    if (garDays.length === 0) return null;
    const totalRVU = garDays.reduce((sum, g) => sum + g.groupTotals.totalRVU, 0);
    const totalTcRVU = garDays.reduce((sum, g) => sum + (g.groupTotals.totalTcRVU || 0), 0);
    const totalStudies = garDays.reduce((sum, g) => sum + g.groupTotals.totalStudies, 0);
    const totalSessionHours = garDays.reduce((sum, g) => sum + g.groupTotals.totalSessionHours, 0);
    const totalBreakHours = garDays.reduce((sum, g) => sum + g.groupTotals.totalBreakHours, 0);
    const totalAdminHours = garDays.reduce((sum, g) => sum + g.groupTotals.totalAdminHours, 0);
    const totalCommsHours = garDays.reduce((sum, g) => sum + g.groupTotals.totalCommsHours, 0);
    const sessionCount = garDays.reduce((sum, g) => sum + g.sessionCount, 0);

    // Modality totals
    const byModality: Record<string, { studies: number; rvu: number }> = {};
    for (const g of garDays) {
      for (const [mod, data] of Object.entries(g.groupTotalsByModality)) {
        if (!byModality[mod]) byModality[mod] = { studies: 0, rvu: 0 };
        byModality[mod].studies += data.studies;
        byModality[mod].rvu += data.rvu;
      }
    }

    // Tag frequency aggregated
    const tagFreq: Record<string, number> = {};
    for (const g of garDays) {
      for (const [tag, count] of Object.entries(g.tagFrequency)) {
        tagFreq[tag] = (tagFreq[tag] || 0) + count;
      }
    }

    const networkInterference = tagFreq['Network & Application Interference'] || 0;

    return {
      totalRVU, totalTcRVU, totalStudies, totalSessionHours, totalBreakHours,
      totalAdminHours, totalCommsHours, sessionCount, byModality, tagFreq, networkInterference,
      daysReported: garDays.length,
    };
  }, [garDays]);

  if (loading) {
    return <div style={{ color: '#9ca3af', textAlign: 'center', padding: 32 }}>Loading hospital data...</div>;
  }
  if (error) {
    return <div style={{ backgroundColor: 'rgba(127, 29, 29, 0.3)', borderRadius: 8, padding: 16, color: '#fca5a5', fontSize: 14 }}>Error: {error}</div>;
  }
  if (!weekTotals) return null;

  return (
    <div className="space-y-6" style={{ borderTop: '2px solid #4b5563', paddingTop: 24, marginTop: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ backgroundColor: '#0891b2', color: 'white', fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 9999, textTransform: 'uppercase' }}>
          Hospital Admin
        </span>
        <span style={{ color: '#9ca3af', fontSize: 14, fontWeight: 600 }}>Weekly Operations Summary</span>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-5 gap-4">
        <div className="bg-gray-800 rounded-lg p-4 text-center">
          <div className="text-gray-400 text-xs mb-1">Total tcRVU</div>
          <div className="text-2xl font-bold text-cyan-400">{weekTotals.totalTcRVU.toFixed(2)}</div>
        </div>
        <div className="bg-gray-800 rounded-lg p-4 text-center">
          <div className="text-gray-400 text-xs mb-1">Total wRVU</div>
          <div className="text-2xl font-bold text-white">{weekTotals.totalRVU.toFixed(2)}</div>
        </div>
        <div className="bg-gray-800 rounded-lg p-4 text-center">
          <div className="text-gray-400 text-xs mb-1">Total Studies</div>
          <div className="text-2xl font-bold text-white">{weekTotals.totalStudies}</div>
        </div>
        <div className="bg-gray-800 rounded-lg p-4 text-center">
          <div className="text-gray-400 text-xs mb-1">Sessions</div>
          <div className="text-2xl font-bold text-white">{weekTotals.sessionCount}</div>
        </div>
        <div className="bg-gray-800 rounded-lg p-4 text-center">
          <div className="text-gray-400 text-xs mb-1">Days Reported</div>
          <div className="text-2xl font-bold text-white">{weekTotals.daysReported}</div>
        </div>
      </div>

      {/* Value-Added Services */}
      {(weekTotals.totalCommsHours > 0 || weekTotals.totalAdminHours > 0) && (
        <div style={{ backgroundColor: '#064e3b', borderRadius: 8, padding: 16, border: '1px solid #065f46' }}>
          <h3 style={{ color: '#6ee7b7', fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 12 }}>
            Value-Added Services This Week
          </h3>
          <div className="grid grid-cols-3 gap-4 text-center">
            <div style={{ backgroundColor: 'rgba(0,0,0,0.2)', borderRadius: 6, padding: 12 }}>
              <div style={{ color: '#6ee7b7', fontSize: 11 }}>Phone Consultations</div>
              <div style={{ color: 'white', fontSize: 20, fontWeight: 700 }}>{weekTotals.totalCommsHours.toFixed(1)} hrs</div>
            </div>
            <div style={{ backgroundColor: 'rgba(0,0,0,0.2)', borderRadius: 6, padding: 12 }}>
              <div style={{ color: '#6ee7b7', fontSize: 11 }}>Administrative</div>
              <div style={{ color: 'white', fontSize: 20, fontWeight: 700 }}>{weekTotals.totalAdminHours.toFixed(1)} hrs</div>
            </div>
            <div style={{ backgroundColor: 'rgba(0,0,0,0.2)', borderRadius: 6, padding: 12 }}>
              <div style={{ color: '#6ee7b7', fontSize: 11 }}>Total Service Hours</div>
              <div style={{ color: 'white', fontSize: 20, fontWeight: 700 }}>{(weekTotals.totalCommsHours + weekTotals.totalAdminHours).toFixed(1)} hrs</div>
            </div>
          </div>
          {weekTotals.daysReported > 0 && (
            <div style={{ color: '#a7f3d0', fontSize: 12, marginTop: 8, textAlign: 'center' }}>
              Average {((weekTotals.totalCommsHours + weekTotals.totalAdminHours) / weekTotals.daysReported).toFixed(1)} hrs/day communication + administrative support
            </div>
          )}
        </div>
      )}

      {/* RVU by modality */}
      {Object.keys(weekTotals.byModality).length > 0 && (
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
                <th style={{ textAlign: 'right', padding: '6px 8px', borderBottom: '1px solid #374151', color: '#9ca3af' }}>% of Volume</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(weekTotals.byModality)
                .sort(([, a], [, b]) => b.studies - a.studies)
                .map(([mod, data]) => (
                  <tr key={mod}>
                    <td style={{ padding: '6px 8px', color: '#d1d5db' }}>{mod}</td>
                    <td style={{ padding: '6px 8px', color: '#d1d5db', textAlign: 'right' }}>{data.studies}</td>
                    <td style={{ padding: '6px 8px', color: '#d1d5db', textAlign: 'right' }}>{data.rvu.toFixed(2)}</td>
                    <td style={{ padding: '6px 8px', color: '#d1d5db', textAlign: 'right' }}>
                      {weekTotals.totalStudies > 0 ? ((data.studies / weekTotals.totalStudies) * 100).toFixed(2) : 0}%
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Time utilization */}
      <div style={{ backgroundColor: '#1f2937', borderRadius: 8, padding: 16 }}>
        <h3 style={{ color: '#9ca3af', fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 12 }}>
          Time Utilization (Hours)
        </h3>
        <div className="grid grid-cols-4 gap-4 text-center">
          <div style={{ backgroundColor: '#111827', borderRadius: 6, padding: 12 }}>
            <div style={{ color: '#9ca3af', fontSize: 11 }}>Session Hours</div>
            <div style={{ color: 'white', fontSize: 20, fontWeight: 700 }}>{weekTotals.totalSessionHours.toFixed(1)}</div>
          </div>
          <div style={{ backgroundColor: '#111827', borderRadius: 6, padding: 12 }}>
            <div style={{ color: '#9ca3af', fontSize: 11 }}>Break Hours</div>
            <div style={{ color: '#ec4899', fontSize: 20, fontWeight: 700 }}>{weekTotals.totalBreakHours.toFixed(1)}</div>
          </div>
          <div style={{ backgroundColor: '#111827', borderRadius: 6, padding: 12 }}>
            <div style={{ color: '#9ca3af', fontSize: 11 }}>Admin Hours</div>
            <div style={{ color: '#f97316', fontSize: 20, fontWeight: 700 }}>{weekTotals.totalAdminHours.toFixed(1)}</div>
          </div>
          <div style={{ backgroundColor: '#111827', borderRadius: 6, padding: 12 }}>
            <div style={{ color: '#9ca3af', fontSize: 11 }}>Comms Hours</div>
            <div style={{ color: '#06b6d4', fontSize: 20, fontWeight: 700 }}>{weekTotals.totalCommsHours.toFixed(1)}</div>
          </div>
        </div>
      </div>

      {/* Service disruption */}
      {weekTotals.networkInterference > 0 && (
        <div style={{ backgroundColor: 'rgba(239, 68, 68, 0.1)', borderRadius: 8, padding: 16, border: '1px solid rgba(239, 68, 68, 0.3)' }}>
          <h3 style={{ color: '#fca5a5', fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
            Service Disruption
          </h3>
          <div style={{ color: '#ef4444', fontSize: 20, fontWeight: 700 }}>
            {weekTotals.networkInterference} network interference reports
          </div>
          <div style={{ color: '#fca5a5', fontSize: 12, marginTop: 4 }}>
            {weekTotals.sessionCount > 0
              ? `${((weekTotals.networkInterference / weekTotals.sessionCount) * 100).toFixed(2)}% of sessions affected`
              : ''}
          </div>
        </div>
      )}
    </div>
  );
}
