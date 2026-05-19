/**
 * ModalityPerformance — Tabbed modality view showing per-modality
 * performance metrics and trends. Used in Monthly, Quarterly, Yearly reports.
 */
import { useState } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

const MODALITY_COLORS: Record<string, string> = {
  'XR': '#3b82f6', 'FL': '#8b5cf6', 'CT': '#22c55e', 'US': '#06b6d4',
  'MR': '#f97316', 'NM': '#ec4899', 'MA': '#eab308', 'PET-CT': '#ef4444',
};

interface TrendPoint {
  label: string;
  rvuPerHourByModality: Record<string, number>;
}

interface Props {
  studiesByModality: Record<string, number>;
  rvuPerHourByModality: Record<string, number>;
  avgVarianceByModality: Record<string, number>;
  rvuByModality?: Record<string, number>;
  totalStudies: number;
  trendPoints: TrendPoint[];
  trendLabel: string; // "Week" or "Month"
  formatTime: (seconds: number) => string;
}

export default function ModalityPerformance({
  studiesByModality, rvuPerHourByModality, avgVarianceByModality,
  rvuByModality, totalStudies, trendPoints, trendLabel,
}: Props) {
  const modalities = Object.keys(studiesByModality).sort((a, b) => (studiesByModality[b] || 0) - (studiesByModality[a] || 0));
  const [activeMod, setActiveMod] = useState(modalities[0] || '');

  if (modalities.length === 0) return null;

  const studies = studiesByModality[activeMod] || 0;
  const rvuHr = rvuPerHourByModality[activeMod] || 0;
  const avgVar = avgVarianceByModality[activeMod] || 0;
  const totalRvu = rvuByModality?.[activeMod] || 0;
  const rvuPerStudy = studies > 0 ? totalRvu / studies : 0;

  // Trend data for selected modality
  const trendData = trendPoints
    .filter(tp => tp.rvuPerHourByModality[activeMod] !== undefined)
    .map(tp => ({ label: tp.label, rvuPerHour: tp.rvuPerHourByModality[activeMod] }));

  return (
    <div className="bg-gray-800 rounded-lg p-4">
      <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">Performance by Modality</h3>

      {/* Modality tabs */}
      <div className="flex flex-wrap gap-1.5 mb-4">
        {modalities.map(mod => (
          <button
            key={mod}
            onClick={() => setActiveMod(mod)}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${
              activeMod === mod
                ? 'text-white'
                : 'text-gray-400 bg-gray-700 hover:bg-gray-600'
            }`}
            style={activeMod === mod ? { backgroundColor: MODALITY_COLORS[mod] || '#6b7280' } : undefined}
          >
            {mod} ({studiesByModality[mod]})
          </button>
        ))}
      </div>

      {/* Metrics for selected modality */}
      <div className="grid grid-cols-4 gap-3 mb-4">
        <div className="bg-gray-700/50 rounded-lg p-2.5 text-center">
          <div className="text-gray-400 text-xs mb-0.5">Studies</div>
          <div className="text-lg font-bold text-white">{studies}</div>
          <div className="text-gray-500 text-xs">{totalStudies > 0 ? `${((studies / totalStudies) * 100).toFixed(0)}%` : ''}</div>
        </div>
        <div className="bg-gray-700/50 rounded-lg p-2.5 text-center">
          <div className="text-gray-400 text-xs mb-0.5">RVU/hr</div>
          <div className="text-lg font-bold text-white">{rvuHr.toFixed(2)}</div>
        </div>
        <div className="bg-gray-700/50 rounded-lg p-2.5 text-center">
          <div className="text-gray-400 text-xs mb-0.5">wRVU/Study</div>
          <div className="text-lg font-bold text-white">{rvuPerStudy.toFixed(2)}</div>
        </div>
        <div className="bg-gray-700/50 rounded-lg p-2.5 text-center">
          <div className="text-gray-400 text-xs mb-0.5">Avg Variance</div>
          <div className={`text-lg font-bold ${avgVar <= 0 ? 'text-green-400' : 'text-red-400'}`}>
            {avgVar > 0 ? '+' : ''}{Math.round(avgVar)}s
          </div>
        </div>
      </div>

      {/* Trend chart for selected modality */}
      {trendData.length > 1 && (
        <>
          <h4 className="text-gray-500 text-xs uppercase tracking-wider mb-2">{activeMod} RVU/hr — {trendLabel}ly Trend</h4>
          <ResponsiveContainer width="100%" height={150}>
            <LineChart data={trendData} margin={{ top: 5, right: 10, bottom: 15, left: 10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
              <XAxis dataKey="label" stroke="#9ca3af" fontSize={10} />
              <YAxis stroke="#9ca3af" fontSize={10} />
              <Tooltip contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', color: '#fff' }} />
              <Line type="monotone" dataKey="rvuPerHour" stroke={MODALITY_COLORS[activeMod] || '#6b7280'} strokeWidth={2} dot={{ r: 4 }} />
            </LineChart>
          </ResponsiveContainer>
        </>
      )}
    </div>
  );
}
