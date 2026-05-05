// HeatmapChart — HTML table with colored cells (inline styles for print safety)
// Used for rotation coverage, radiologist-modality efficiency, etc.

interface HeatmapCell {
  value: number;
  label?: string;
}

interface HeatmapChartProps {
  title: string;
  rowLabels: string[];
  colLabels: string[];
  data: HeatmapCell[][];   // data[row][col]
  colorScale?: (value: number) => string;
  formatValue?: (value: number) => string;
  emptyColor?: string;
}

function defaultColorScale(value: number): string {
  if (value === 0) return '#1f2937';
  // Green intensity scale
  const clamped = Math.min(Math.max(value, 0), 1);
  const r = Math.round(31 + (34 - 31) * (1 - clamped));
  const g = Math.round(41 + (197 - 41) * clamped);
  const b = Math.round(55 + (94 - 55) * (1 - clamped));
  return `rgb(${r}, ${g}, ${b})`;
}

export default function HeatmapChart({
  title,
  rowLabels,
  colLabels,
  data,
  colorScale = defaultColorScale,
  formatValue = (v) => v > 0 ? v.toFixed(2) : '',
  emptyColor = '#1f2937',
}: HeatmapChartProps) {
  if (rowLabels.length === 0 || colLabels.length === 0) {
    return null;
  }

  return (
    <div style={{ backgroundColor: '#1f2937', borderRadius: 8, padding: 16 }}>
      <h3 style={{ color: '#9ca3af', fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 12 }}>
        {title}
      </h3>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', fontSize: 11 }}>
          <thead>
            <tr>
              <th style={{ padding: '4px 8px' }} />
              {colLabels.map(col => (
                <th key={col} style={{ padding: '4px 6px', color: '#9ca3af', fontWeight: 500, textAlign: 'center', minWidth: 40 }}>
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rowLabels.map((row, ri) => (
              <tr key={row}>
                <td style={{ padding: '4px 8px', color: '#d1d5db', fontWeight: 500, whiteSpace: 'nowrap' }}>
                  {row}
                </td>
                {colLabels.map((col, ci) => {
                  const cell = data[ri]?.[ci];
                  const value = cell?.value ?? 0;
                  const bg = value > 0 ? colorScale(value) : emptyColor;
                  return (
                    <td
                      key={col}
                      style={{
                        padding: '4px 6px',
                        backgroundColor: bg,
                        color: value > 0 ? '#ffffff' : '#4b5563',
                        textAlign: 'center',
                        borderRadius: 2,
                        minWidth: 40,
                      }}
                      title={cell?.label || `${row} / ${col}: ${value}`}
                    >
                      {formatValue(value)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
