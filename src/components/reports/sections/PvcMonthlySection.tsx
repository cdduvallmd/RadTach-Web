// Practice Value Customization — Monthly report section
// Plan: /Users/charlesduvall/.claude/plans/vast-snuggling-kernighan.md
//
// Self-loading PVC report section. Renders adaptive columns based on the
// practice's configuration: Shifts/Working Days, wRVU, Bonus RVU, Meeting RVU,
// All-in RVU/shift, Estimated $. Hidden when PVC is disabled.

import { useState, useEffect, useMemo } from 'react';
import { firestoreService } from '../../../services/firestore';
import { aggregatePvc, isCompletedPeriod } from '../../../utils/periodAggregation';
import type { PvcConfig, UserPvcSettings } from '../../../types/pvc';
import type { StoredSession, DateRange } from '../../../types/reports';

interface PvcMonthlySectionProps {
  userId: string;
  system: string;
  sessions: StoredSession[];
  dateRange: DateRange;
  periodLabel?: string;  // e.g., "March 2026"
}

export default function PvcMonthlySection({
  userId,
  system,
  sessions,
  dateRange,
  periodLabel,
}: PvcMonthlySectionProps) {
  const [pvcConfig, setPvcConfig] = useState<PvcConfig | null>(null);
  const [userPvc, setUserPvc] = useState<UserPvcSettings | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      firestoreService.getPvcConfig(system),
      firestoreService.getUserPvcSettings(userId),
    ]).then(([cfg, user]) => {
      if (cancelled) return;
      setPvcConfig(cfg);
      setUserPvc(user);
      setLoading(false);
    }).catch(() => {
      if (cancelled) return;
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [system, userId]);

  const pvc = useMemo(() => {
    if (!pvcConfig) return null;
    return aggregatePvc(sessions, pvcConfig, userPvc ?? undefined);
  }, [sessions, pvcConfig, userPvc]);

  if (loading) return null;
  if (!pvcConfig?.enabled || !pvc?.enabled) return null;

  const completed = isCompletedPeriod(dateRange);
  const heading = completed
    ? (periodLabel ? `${periodLabel} — PVC Totals` : 'Monthly PVC Totals')
    : 'So far this month — PVC';

  const shiftHeader = pvc.shiftLabel === 'shift' ? 'Shifts' : 'Working Days';
  const columns = pvc.columnsToShow;

  // Cells assembled in order so adaptive display can hide any. Each cell carries
  // its own header so we don't need a separate columns-config array.
  const cells: Array<{ label: string; value: string }> = [
    { label: shiftHeader, value: pvc.totalShifts.toFixed(2) },
    { label: 'wRVU', value: pvc.totalWrvu.toFixed(2) },
  ];
  if (columns.bonusRvu) {
    cells.push({ label: 'Bonus RVU', value: pvc.totalBonusRvu.toFixed(2) });
  }
  if (columns.meetingRvu) {
    cells.push({ label: 'Meeting RVU', value: pvc.totalMeetingRvu.toFixed(2) });
  }
  if (columns.allInRvuPerShift) {
    const perShiftLabel = pvc.shiftLabel === 'shift' ? 'All-in RVU / Shift' : 'All-in RVU / Day';
    cells.push({ label: perShiftLabel, value: pvc.allInRvuPerShift.toFixed(2) });
  } else {
    const perShiftLabel = pvc.shiftLabel === 'shift' ? 'wRVU / Shift' : 'wRVU / Day';
    cells.push({ label: perShiftLabel, value: pvc.wrvuPerShift.toFixed(2) });
  }
  if (columns.estimatedDollars) {
    cells.push({
      label: 'Estimated $',
      value: pvc.estimatedDollars.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }),
    });
  }

  return (
    <div className="bg-gray-800 border border-gray-700 rounded-lg p-4">
      <h3 className="text-white font-medium mb-3">{heading}</h3>
      <div className={`grid gap-3`} style={{ gridTemplateColumns: `repeat(${cells.length}, minmax(0, 1fr))` }}>
        {cells.map(c => (
          <div key={c.label} className="bg-gray-900/50 rounded p-2">
            <div className="text-[10px] uppercase tracking-wider text-gray-400">{c.label}</div>
            <div className="text-lg text-white font-medium">{c.value}</div>
          </div>
        ))}
      </div>
      <p className="text-[10px] text-gray-500 mt-2">
        Compensation estimate only. Practice-wide CPT adjustments applied to wRVU at study completion.
      </p>
    </div>
  );
}
