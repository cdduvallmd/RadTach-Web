// CalendarHeatmap — GitHub contribution-graph style for staffing/session coverage
// Print-safe with inline styles. Shows day-of-month cells colored by value.

import { format, getDaysInMonth, getDay, startOfMonth } from 'date-fns';

interface CalendarHeatmapProps {
  title: string;
  year: number;
  month: number;          // 1-12
  dayValues: Record<number, number>;   // day-of-month → value
  colorScale?: (value: number, max: number) => string;
  formatTooltip?: (day: number, value: number) => string;
}

function defaultColorScale(value: number, max: number): string {
  if (value === 0 || max === 0) return '#1f2937';
  const intensity = Math.min(value / max, 1);
  // Green gradient
  const r = Math.round(31 + (34 - 31) * (1 - intensity));
  const g = Math.round(41 + (197 - 41) * intensity);
  const b = Math.round(55 + (94 - 55) * (1 - intensity));
  return `rgb(${r}, ${g}, ${b})`;
}

export default function CalendarHeatmap({
  title,
  year,
  month,
  dayValues,
  colorScale = defaultColorScale,
  formatTooltip = (day, value) => `Day ${day}: ${value} sessions`,
}: CalendarHeatmapProps) {
  const daysInMonth = getDaysInMonth(new Date(year, month - 1));
  const firstDayOfWeek = getDay(startOfMonth(new Date(year, month - 1))); // 0=Sun
  const monthLabel = format(new Date(year, month - 1), 'MMMM yyyy');

  const maxValue = Math.max(...Object.values(dayValues), 0);

  // Build grid: 7 cols (Sun-Sat), up to 6 rows
  const grid: (number | null)[][] = [];
  let currentRow: (number | null)[] = [];

  // Pad initial empty days
  for (let i = 0; i < firstDayOfWeek; i++) {
    currentRow.push(null);
  }

  for (let day = 1; day <= daysInMonth; day++) {
    currentRow.push(day);
    if (currentRow.length === 7) {
      grid.push(currentRow);
      currentRow = [];
    }
  }

  // Pad trailing empty days
  if (currentRow.length > 0) {
    while (currentRow.length < 7) currentRow.push(null);
    grid.push(currentRow);
  }

  const dayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  return (
    <div style={{ backgroundColor: '#1f2937', borderRadius: 8, padding: 16 }}>
      <h3 style={{ color: '#9ca3af', fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>
        {title}
      </h3>
      <div style={{ color: '#6b7280', fontSize: 11, marginBottom: 12 }}>{monthLabel}</div>
      <table style={{ borderCollapse: 'separate', borderSpacing: 3 }}>
        <thead>
          <tr>
            {dayLabels.map(d => (
              <th key={d} style={{ color: '#6b7280', fontSize: 10, fontWeight: 500, width: 28, textAlign: 'center' }}>
                {d}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {grid.map((row, ri) => (
            <tr key={ri}>
              {row.map((day, ci) => {
                if (day === null) {
                  return <td key={ci} style={{ width: 28, height: 28 }} />;
                }
                const value = dayValues[day] || 0;
                const bg = colorScale(value, maxValue);
                return (
                  <td
                    key={ci}
                    title={formatTooltip(day, value)}
                    style={{
                      width: 28,
                      height: 28,
                      backgroundColor: bg,
                      borderRadius: 3,
                      textAlign: 'center',
                      color: value > 0 ? '#ffffff' : '#4b5563',
                      fontSize: 10,
                      fontWeight: value > 0 ? 600 : 400,
                      cursor: 'default',
                    }}
                  >
                    {day}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
