// Hospital Admin Quarterly Section
// Quarterly RVU vs annual pace, volume by modality, disruption cost,
// efficiency trend, seasonal patterns.

import { useMemo } from 'react';
import { useGroupStats } from '../../../hooks/useGroupStats';
import type { DateRange, GroupStats } from '../../../types/reports';

interface HospitalQuarterlySectionProps {
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

export default function HospitalQuarterlySection({ system, dateRange }: HospitalQuarterlySectionProps) {
  const { garDays, loading, error } = useGroupStats(system, dateRange);

  const quarterTotals = useMemo(() => {
    if (garDays.length === 0) return null;
    const totalRVU = garDays.reduce((sum, g) => sum + g.groupTotals.totalRVU, 0);
    const totalStudies = garDays.reduce((sum, g) => sum + g.groupTotals.totalStudies, 0);
    const sessionCount = garDays.reduce((sum, g) => sum + g.sessionCount, 0);
    const totalSessionHours = garDays.reduce((sum, g) => sum + g.groupTotals.totalSessionHours, 0);

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

    return { totalRVU, totalStudies, sessionCount, totalSessionHours, byModality, tagFreq, daysReported: garDays.length };
  }, [garDays]);

  // Monthly breakdown within quarter
  const monthlyBreakdown = useMemo(() => {
    const byMonth = groupGarByMonth(garDays);
    const months = [...byMonth.keys()].sort();
    return months.map(m => {
      const days = byMonth.get(m) || [];
      return {
        month: m,
        totalRVU: days.reduce((sum, g) => sum + g.groupTotals.totalRVU, 0),
        totalStudies: days.reduce((sum, g) => sum + g.groupTotals.totalStudies, 0),
        sessions: days.reduce((sum, g) => sum + g.sessionCount, 0),
        days: days.length,
      };
    });
  }, [garDays]);

  if (loading) {
    return <div style={{ color: '#9ca3af', textAlign: 'center', padding: 32 }}>Loading hospital data...</div>;
  }
  if (error) {
    return <div style={{ backgroundColor: 'rgba(127, 29, 29, 0.3)', borderRadius: 8, padding: 16, color: '#fca5a5', fontSize: 14 }}>Error: {error}</div>;
  }
  if (!quarterTotals) return null;

  const networkCount = quarterTotals.tagFreq['Network & Application Interference'] || 0;
  const annualPace = quarterTotals.daysReported > 0
    ? (quarterTotals.totalRVU / quarterTotals.daysReported) * 365
    : 0;

  return (
    <div className="space-y-6" style={{ borderTop: '2px solid #4b5563', paddingTop: 24, marginTop: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ backgroundColor: '#0891b2', color: 'white', fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 9999, textTransform: 'uppercase' }}>
          Hospital Admin
        </span>
        <span style={{ color: '#9ca3af', fontSize: 14, fontWeight: 600 }}>Quarterly Operations Summary</span>
      </div>

      {/* Summary + annual pace */}
      <div className="grid grid-cols-4 gap-4">
        <div className="bg-gray-800 rounded-lg p-4 text-center">
          <div className="text-gray-400 text-xs mb-1">Quarterly RVU</div>
          <div className="text-2xl font-bold text-white">{quarterTotals.totalRVU.toFixed(1)}</div>
        </div>
        <div className="bg-gray-800 rounded-lg p-4 text-center">
          <div className="text-gray-400 text-xs mb-1">Annual Pace</div>
          <div className="text-2xl font-bold text-cyan-400">{annualPace.toFixed(0)}</div>
          <div className="text-xs text-gray-500">projected RVU/yr</div>
        </div>
        <div className="bg-gray-800 rounded-lg p-4 text-center">
          <div className="text-gray-400 text-xs mb-1">Total Studies</div>
          <div className="text-2xl font-bold text-white">{quarterTotals.totalStudies}</div>
        </div>
        <div className="bg-gray-800 rounded-lg p-4 text-center">
          <div className="text-gray-400 text-xs mb-1">Session Hours</div>
          <div className="text-2xl font-bold text-white">{quarterTotals.totalSessionHours.toFixed(1)}</div>
        </div>
      </div>

      {/* Monthly breakdown */}
      {monthlyBreakdown.length > 1 && (
        <div style={{ backgroundColor: '#1f2937', borderRadius: 8, padding: 16 }}>
          <h3 style={{ color: '#9ca3af', fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 12 }}>
            Monthly Breakdown
          </h3>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid #374151', color: '#9ca3af' }}>Month</th>
                <th style={{ textAlign: 'right', padding: '6px 8px', borderBottom: '1px solid #374151', color: '#9ca3af' }}>RVU</th>
                <th style={{ textAlign: 'right', padding: '6px 8px', borderBottom: '1px solid #374151', color: '#9ca3af' }}>Studies</th>
                <th style={{ textAlign: 'right', padding: '6px 8px', borderBottom: '1px solid #374151', color: '#9ca3af' }}>Sessions</th>
                <th style={{ textAlign: 'right', padding: '6px 8px', borderBottom: '1px solid #374151', color: '#9ca3af' }}>Days</th>
              </tr>
            </thead>
            <tbody>
              {monthlyBreakdown.map(m => (
                <tr key={m.month}>
                  <td style={{ padding: '6px 8px', color: '#d1d5db' }}>{m.month}</td>
                  <td style={{ padding: '6px 8px', color: '#d1d5db', textAlign: 'right' }}>{m.totalRVU.toFixed(1)}</td>
                  <td style={{ padding: '6px 8px', color: '#d1d5db', textAlign: 'right' }}>{m.totalStudies}</td>
                  <td style={{ padding: '6px 8px', color: '#d1d5db', textAlign: 'right' }}>{m.sessions}</td>
                  <td style={{ padding: '6px 8px', color: '#d1d5db', textAlign: 'right' }}>{m.days}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Volume by modality */}
      {Object.keys(quarterTotals.byModality).length > 0 && (
        <div style={{ backgroundColor: '#1f2937', borderRadius: 8, padding: 16 }}>
          <h3 style={{ color: '#9ca3af', fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 12 }}>
            Quarterly Volume by Modality
          </h3>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid #374151', color: '#9ca3af' }}>Modality</th>
                <th style={{ textAlign: 'right', padding: '6px 8px', borderBottom: '1px solid #374151', color: '#9ca3af' }}>Studies</th>
                <th style={{ textAlign: 'right', padding: '6px 8px', borderBottom: '1px solid #374151', color: '#9ca3af' }}>RVU</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(quarterTotals.byModality)
                .sort(([, a], [, b]) => b.studies - a.studies)
                .map(([mod, data]) => (
                  <tr key={mod}>
                    <td style={{ padding: '6px 8px', color: '#d1d5db' }}>{mod}</td>
                    <td style={{ padding: '6px 8px', color: '#d1d5db', textAlign: 'right' }}>{data.studies}</td>
                    <td style={{ padding: '6px 8px', color: '#d1d5db', textAlign: 'right' }}>{data.rvu.toFixed(1)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Disruption cost */}
      {networkCount > 0 && (
        <div style={{ backgroundColor: 'rgba(239, 68, 68, 0.1)', borderRadius: 8, padding: 16, border: '1px solid rgba(239, 68, 68, 0.3)' }}>
          <h3 style={{ color: '#fca5a5', fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
            Quarterly Disruption Summary
          </h3>
          <div style={{ color: '#ef4444', fontSize: 20, fontWeight: 700 }}>
            {networkCount} network interference reports
          </div>
          <div style={{ color: '#fca5a5', fontSize: 12, marginTop: 4 }}>
            across {quarterTotals.daysReported} reporting days
          </div>
        </div>
      )}
    </div>
  );
}
