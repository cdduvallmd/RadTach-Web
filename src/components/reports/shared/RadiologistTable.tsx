// RadiologistTable — cross-radiologist comparison table
// Columns vary by period/context. Print-safe with inline styles.

interface Column {
  key: string;
  label: string;
  align?: 'left' | 'right' | 'center';
  format?: (value: number) => string;
  colorFn?: (value: number) => string;  // returns CSS color
}

interface RadiologistRow {
  id: string;
  name: string;
  [key: string]: string | number;
}

interface RadiologistTableProps {
  title: string;
  columns: Column[];
  rows: RadiologistRow[];
  sortBy?: string;
  sortDirection?: 'asc' | 'desc';
}

export default function RadiologistTable({
  title,
  columns,
  rows,
  sortBy,
  sortDirection = 'desc',
}: RadiologistTableProps) {
  const sortedRows = sortBy
    ? [...rows].sort((a, b) => {
        const aVal = a[sortBy] ?? 0;
        const bVal = b[sortBy] ?? 0;
        const cmp = typeof aVal === 'number' && typeof bVal === 'number'
          ? aVal - bVal
          : String(aVal).localeCompare(String(bVal));
        return sortDirection === 'desc' ? -cmp : cmp;
      })
    : rows;

  if (rows.length === 0) {
    return (
      <div style={{ backgroundColor: '#1f2937', borderRadius: 8, padding: 16 }}>
        <h3 style={{ color: '#9ca3af', fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
          {title}
        </h3>
        <p style={{ color: '#6b7280', fontSize: 14 }}>No data available</p>
      </div>
    );
  }

  return (
    <div style={{ backgroundColor: '#1f2937', borderRadius: 8, padding: 16 }}>
      <h3 style={{ color: '#9ca3af', fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 12 }}>
        {title}
      </h3>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid #374151', color: '#9ca3af', fontWeight: 500 }}>
              Radiologist
            </th>
            {columns.map(col => (
              <th
                key={col.key}
                style={{
                  textAlign: col.align || 'right',
                  padding: '6px 8px',
                  borderBottom: '1px solid #374151',
                  color: '#9ca3af',
                  fontWeight: 500,
                }}
              >
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sortedRows.map((row, i) => (
            <tr key={row.id} style={{ borderBottom: i < sortedRows.length - 1 ? '1px solid #1f2937' : undefined }}>
              <td style={{ padding: '6px 8px', color: '#d1d5db' }}>{row.name}</td>
              {columns.map(col => {
                const val = row[col.key];
                const formatted = col.format && typeof val === 'number' ? col.format(val) : String(val ?? '—');
                const color = col.colorFn && typeof val === 'number' ? col.colorFn(val) : '#d1d5db';
                return (
                  <td
                    key={col.key}
                    style={{
                      textAlign: col.align || 'right',
                      padding: '6px 8px',
                      color,
                    }}
                  >
                    {formatted}
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
