// GAR Percentile Gauge — visual gauge showing user's position within group distribution
// Shows p25/p50/p75 boundaries with user's value marked.
// Print-safe: uses inline styles only, no Tailwind dynamic classes.

import { estimatePercentile, formatPercentileOrdinal } from '../../../utils/percentileEstimation';
import type { DistributionStats } from '../../../types/reports';

interface GARPercentileGaugeProps {
  label: string;                    // e.g., "RVU/hr", "Productive Ratio"
  userValue: number;
  distribution: DistributionStats;
  formatValue?: (v: number) => string;
  higherIsBetter?: boolean;         // default true — green for high percentile
}

export default function GARPercentileGauge({
  label,
  userValue,
  distribution,
  formatValue = (v) => v.toFixed(2),
  higherIsBetter = true,
}: GARPercentileGaugeProps) {
  const pctile = estimatePercentile(userValue, distribution);
  const ordinal = formatPercentileOrdinal(pctile);

  // Color based on percentile position
  const getColor = (p: number): string => {
    if (higherIsBetter) {
      if (p >= 75) return '#22c55e';  // green
      if (p >= 50) return '#3b82f6';  // blue
      if (p >= 25) return '#f59e0b';  // yellow
      return '#ef4444';               // red
    } else {
      // Lower is better (e.g., variance)
      if (p <= 25) return '#22c55e';
      if (p <= 50) return '#3b82f6';
      if (p <= 75) return '#f59e0b';
      return '#ef4444';
    }
  };

  const color = getColor(pctile);

  // Map user value to position on gauge (0-100% width)
  // Gauge shows from distribution min to max
  const gaugeMin = Math.min(distribution.p25 - (distribution.p75 - distribution.p25), userValue);
  const gaugeMax = Math.max(distribution.p75 + (distribution.p75 - distribution.p25), userValue);
  const range = gaugeMax - gaugeMin;
  const userPosition = range > 0 ? ((userValue - gaugeMin) / range) * 100 : 50;
  const p25Position = range > 0 ? ((distribution.p25 - gaugeMin) / range) * 100 : 25;
  const p50Position = range > 0 ? ((distribution.p50 - gaugeMin) / range) * 100 : 50;
  const p75Position = range > 0 ? ((distribution.p75 - gaugeMin) / range) * 100 : 75;

  return (
    <div style={{ backgroundColor: '#1f2937', borderRadius: 8, padding: 16 }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 }}>
        <span style={{ color: '#9ca3af', fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          GAR: {label}
        </span>
        <span style={{ color: '#9ca3af', fontSize: 11 }}>
          n={distribution.n} radiologists
        </span>
      </div>

      {/* Main value + percentile */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 16 }}>
        <span style={{ fontSize: 28, fontWeight: 700, color }}>
          {formatValue(userValue)}
        </span>
        <span style={{ fontSize: 16, fontWeight: 600, color }}>
          {ordinal} percentile
        </span>
      </div>

      {/* Gauge bar */}
      <div style={{ position: 'relative', height: 24, marginBottom: 8 }}>
        {/* Background track */}
        <div style={{
          position: 'absolute', top: 8, left: 0, right: 0, height: 8,
          backgroundColor: '#374151', borderRadius: 4,
        }} />

        {/* IQR highlight (p25 to p75) */}
        <div style={{
          position: 'absolute', top: 8, height: 8,
          left: `${p25Position}%`, width: `${p75Position - p25Position}%`,
          backgroundColor: '#4b5563', borderRadius: 4,
        }} />

        {/* P25 marker */}
        <div style={{
          position: 'absolute', top: 4, left: `${p25Position}%`,
          width: 2, height: 16, backgroundColor: '#6b7280',
          transform: 'translateX(-1px)',
        }} />

        {/* P50 marker (median) */}
        <div style={{
          position: 'absolute', top: 4, left: `${p50Position}%`,
          width: 2, height: 16, backgroundColor: '#9ca3af',
          transform: 'translateX(-1px)',
        }} />

        {/* P75 marker */}
        <div style={{
          position: 'absolute', top: 4, left: `${p75Position}%`,
          width: 2, height: 16, backgroundColor: '#6b7280',
          transform: 'translateX(-1px)',
        }} />

        {/* User marker */}
        <div style={{
          position: 'absolute', top: 2, left: `${userPosition}%`,
          width: 12, height: 20, borderRadius: 3,
          backgroundColor: color, border: '2px solid white',
          transform: 'translateX(-6px)',
          zIndex: 1,
        }} />
      </div>

      {/* Gauge labels */}
      <div style={{ position: 'relative', height: 16, fontSize: 10, color: '#6b7280' }}>
        <span style={{ position: 'absolute', left: `${p25Position}%`, transform: 'translateX(-50%)' }}>
          P25: {formatValue(distribution.p25)}
        </span>
        <span style={{ position: 'absolute', left: `${p50Position}%`, transform: 'translateX(-50%)' }}>
          P50: {formatValue(distribution.p50)}
        </span>
        <span style={{ position: 'absolute', left: `${p75Position}%`, transform: 'translateX(-50%)' }}>
          P75: {formatValue(distribution.p75)}
        </span>
      </div>

      {/* Distribution details */}
      <div style={{ display: 'flex', gap: 16, marginTop: 12, fontSize: 11, color: '#6b7280' }}>
        <span>Mean: {formatValue(distribution.mean)}</span>
        <span>StdDev: {formatValue(distribution.stdDev)}</span>
      </div>
    </div>
  );
}
