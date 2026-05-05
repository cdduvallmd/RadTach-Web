// BoxPlotChart — custom HTML/CSS rendering with p25/p50/p75 markers
// Recharts has no native box plot. HTML/CSS is print-safe.

import type { DistributionStats } from '../../../types/reports';

interface BoxPlotItem {
  label: string;
  distribution: DistributionStats;
  highlight?: number;   // optional user value to mark on the plot
}

interface BoxPlotChartProps {
  title: string;
  items: BoxPlotItem[];
  formatValue?: (v: number) => string;
  highlightLabel?: string;
}

export default function BoxPlotChart({
  title,
  items,
  formatValue = (v) => v.toFixed(2),
  highlightLabel = 'You',
}: BoxPlotChartProps) {
  if (items.length === 0) return null;

  // Compute global min/max for scale
  const allValues = items.flatMap(item => {
    const d = item.distribution;
    const vals = [d.p25, d.p75, d.mean - d.stdDev, d.mean + d.stdDev];
    if (item.highlight !== undefined) vals.push(item.highlight);
    return vals;
  });
  const globalMin = Math.min(...allValues);
  const globalMax = Math.max(...allValues);
  const range = globalMax - globalMin || 1;
  const padMin = globalMin - range * 0.1;
  const padMax = globalMax + range * 0.1;
  const padRange = padMax - padMin;

  const toPercent = (v: number) => ((v - padMin) / padRange) * 100;

  return (
    <div style={{ backgroundColor: '#1f2937', borderRadius: 8, padding: 16 }}>
      <h3 style={{ color: '#9ca3af', fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 16 }}>
        {title}
      </h3>

      {items.map((item, i) => {
        const d = item.distribution;
        const p25Pct = toPercent(d.p25);
        const p50Pct = toPercent(d.p50);
        const p75Pct = toPercent(d.p75);
        const whiskerLow = toPercent(Math.max(d.mean - 1.5 * d.stdDev, d.p25 - 1.5 * (d.p75 - d.p25)));
        const whiskerHigh = toPercent(Math.min(d.mean + 1.5 * d.stdDev, d.p75 + 1.5 * (d.p75 - d.p25)));
        const highlightPct = item.highlight !== undefined ? toPercent(item.highlight) : null;

        return (
          <div key={i} style={{ display: 'flex', alignItems: 'center', marginBottom: 16, gap: 12 }}>
            {/* Label */}
            <div style={{ width: 80, color: '#d1d5db', fontSize: 12, textAlign: 'right', flexShrink: 0 }}>
              {item.label}
            </div>

            {/* Plot area */}
            <div style={{ flex: 1, position: 'relative', height: 28 }}>
              {/* Whisker line */}
              <div style={{
                position: 'absolute', top: 12, height: 2,
                left: `${Math.max(whiskerLow, 0)}%`,
                width: `${Math.min(whiskerHigh, 100) - Math.max(whiskerLow, 0)}%`,
                backgroundColor: '#4b5563',
              }} />

              {/* IQR box (p25 to p75) */}
              <div style={{
                position: 'absolute', top: 4, height: 18,
                left: `${p25Pct}%`,
                width: `${p75Pct - p25Pct}%`,
                backgroundColor: '#374151',
                border: '1px solid #4b5563',
                borderRadius: 2,
              }} />

              {/* Median line */}
              <div style={{
                position: 'absolute', top: 2, height: 22,
                left: `${p50Pct}%`,
                width: 2,
                backgroundColor: '#9ca3af',
                transform: 'translateX(-1px)',
              }} />

              {/* Highlight marker */}
              {highlightPct !== null && (
                <div
                  title={`${highlightLabel}: ${formatValue(item.highlight!)}`}
                  style={{
                    position: 'absolute', top: 2,
                    left: `${highlightPct}%`,
                    width: 10, height: 22,
                    backgroundColor: '#3b82f6',
                    border: '2px solid white',
                    borderRadius: 3,
                    transform: 'translateX(-5px)',
                    zIndex: 1,
                  }}
                />
              )}
            </div>

            {/* Value labels */}
            <div style={{ width: 100, fontSize: 10, color: '#6b7280', flexShrink: 0 }}>
              <div>P25: {formatValue(d.p25)}</div>
              <div>P50: {formatValue(d.p50)}</div>
              <div>P75: {formatValue(d.p75)}</div>
            </div>
          </div>
        );
      })}

      {/* Legend */}
      <div style={{ display: 'flex', gap: 16, fontSize: 10, color: '#6b7280', marginTop: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <div style={{ width: 12, height: 12, backgroundColor: '#374151', border: '1px solid #4b5563', borderRadius: 2 }} />
          <span>IQR (P25–P75)</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <div style={{ width: 2, height: 12, backgroundColor: '#9ca3af' }} />
          <span>Median</span>
        </div>
        {items.some(i => i.highlight !== undefined) && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <div style={{ width: 8, height: 12, backgroundColor: '#3b82f6', border: '1px solid white', borderRadius: 2 }} />
            <span>{highlightLabel}</span>
          </div>
        )}
      </div>
    </div>
  );
}
