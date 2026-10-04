// Recent Cases tab (October 2026 UI Refresh). Display only: three columns,
// no headers — markers, exam name, RVU. Text color, not background.
import { memo } from 'react';
import type { RecentRow, RecentState } from '../utils/recentCases';

const COLOR: Record<RecentState, string> = {
  inProgress: 'text-white italic',
  normal: 'text-green-400',
  bilateral: 'text-blue-400',
  doubleTap: 'text-yellow-300',
  undone: 'text-red-400 line-through',
};
// Stealth mode is gray throughout; the markers, italics and strikethrough
// still carry the state.
const STEALTH: Record<RecentState, string> = {
  inProgress: 'text-gray-200 italic',
  normal: 'text-gray-300',
  bilateral: 'text-gray-300',
  doubleTap: 'text-gray-300',
  undone: 'text-gray-500 line-through',
};

// memo: redraws only when its rows change (a completion, undo or double tap),
// not on the session clock's tick.
export const RecentCases = memo(function RecentCases({ rows, stealthMode }: { rows: RecentRow[]; stealthMode: boolean }) {
  if (rows.length === 0) {
    return <div className="text-gray-500 text-sm py-3 text-center">No studies yet this session</div>;
  }
  return (
    <div className="font-mono text-base">
      {rows.map(r => {
        const color = (stealthMode ? STEALTH : COLOR)[r.state];
        return (
          <div key={r.key} className="flex items-center gap-3 py-1 border-b border-gray-700 last:border-b-0">
            <span className={`w-10 shrink-0 text-center ${color}`}>{r.markers}</span>
            <span className={`flex-1 min-w-0 truncate ${color}`} title={r.name}>{r.name}</span>
            <span className={`w-14 shrink-0 text-right tabular-nums ${color}`}>{r.rvu.toFixed(2)}</span>
          </div>
        );
      })}
    </div>
  );
});
