// Practice Value Customization — generic report section
// Used by Session / Daily / Weekly / Monthly / Quarterly / Yearly reports.
//
// Renders adaptive columns based on what the practice has configured, plus a
// per-period breakdown table (rows determined by config.productivityTierPeriod).
// Fetches monthly-context sessions so even short reports (Daily/Weekly) can
// show the current calendar-month Adjusted wRVU average.

import { useState, useEffect, useMemo } from 'react';
import { firestoreService } from '../../../services/firestore';
import { aggregatePvc, isCompletedPeriod } from '../../../utils/periodAggregation';
import type { PvcConfig, UserPvcSettings } from '../../../types/pvc';
import type { StoredSession, DateRange } from '../../../types/reports';
import { startOfMonth, endOfMonth, addMonths, startOfQuarter, endOfQuarter } from 'date-fns';

export type PvcPeriodType = 'session' | 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'yearly';

interface PvcReportSectionProps {
  userId: string;
  system: string;
  sessions: StoredSession[];
  dateRange: DateRange;
  periodType: PvcPeriodType;
  periodLabel?: string;     // e.g., "May 2026", "Week of May 26", "Session 20260527-01"
}

const PERIOD_NOUNS: Record<PvcPeriodType, string> = {
  session: 'session',
  daily: 'day',
  weekly: 'week',
  monthly: 'month',
  quarterly: 'quarter',
  yearly: 'year',
};

// Compute the months spanned by a date range (always at least one).
function monthsInRange(range: DateRange): Array<{ start: Date; end: Date }> {
  const out: Array<{ start: Date; end: Date }> = [];
  let cursor = startOfMonth(range.start);
  const limit = endOfMonth(range.end);
  while (cursor <= limit) {
    out.push({ start: cursor, end: endOfMonth(cursor) });
    cursor = startOfMonth(addMonths(cursor, 1));
  }
  return out;
}

export default function PvcReportSection({
  userId,
  system,
  sessions,
  dateRange,
  periodType,
  periodLabel,
}: PvcReportSectionProps) {
  const [pvcConfig, setPvcConfig] = useState<PvcConfig | null>(null);
  const [userPvc, setUserPvc] = useState<UserPvcSettings | null>(null);
  const [monthContextSessions, setMonthContextSessions] = useState<StoredSession[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      firestoreService.getPvcConfig(system),
      firestoreService.getUserPvcSettings(userId),
    ]).then(async ([cfg, user]) => {
      if (cancelled) return;
      setPvcConfig(cfg);
      setUserPvc(user);

      if (!cfg?.enabled) {
        setMonthContextSessions([]);
        setLoading(false);
        return;
      }

      // Fetch sessions for ALL calendar months / quarters touched by the report
      // range. Used to compute the Adjusted wRVU monthly average even when the
      // report is shorter than a month.
      const contextRanges = cfg.productivityTierPeriod === 'quarterly'
        ? [{ start: startOfQuarter(dateRange.start), end: endOfQuarter(dateRange.end) }]
        : monthsInRange(dateRange);
      try {
        const results = await Promise.all(
          contextRanges.map(r => firestoreService.getSessionsInRange(userId, r.start, r.end)),
        );
        if (cancelled) return;
        const merged: StoredSession[] = [];
        const seen = new Set<string>();
        for (const list of results) {
          for (const s of list) {
            if (!seen.has(s.id)) {
              seen.add(s.id);
              merged.push(s);
            }
          }
        }
        setMonthContextSessions(merged);
      } catch (err) {
        console.warn('PVC monthly-context fetch failed:', err);
        setMonthContextSessions([]);
      }
      setLoading(false);
    }).catch(() => {
      if (cancelled) return;
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [userId, system, dateRange.start.getTime(), dateRange.end.getTime()]);

  const periodAgg = useMemo(() => {
    if (!pvcConfig) return null;
    return aggregatePvc(sessions, pvcConfig, userPvc ?? undefined);
  }, [sessions, pvcConfig, userPvc]);

  // Verified wRVU (from Epic/Medicalis) is stored per-session and shown in
  // the other report tabs' totals. Surface it here too when any session in
  // the period has been verified, so the rad can compare in-program totals
  // against the source-of-truth billed values without leaving the PVC view.
  const verifiedTotals = useMemo(() => {
    let total = 0;
    let sessionsWithVerified = 0;
    for (const s of sessions) {
      if (s.verifiedRVU != null && s.verifiedRVU > 0) {
        total += s.verifiedRVU;
        sessionsWithVerified += 1;
      }
    }
    return { total, sessionsWithVerified };
  }, [sessions]);

  const contextAgg = useMemo(() => {
    if (!pvcConfig) return null;
    return aggregatePvc(monthContextSessions, pvcConfig, userPvc ?? undefined);
  }, [monthContextSessions, pvcConfig, userPvc]);

  if (loading) return null;
  if (!pvcConfig?.enabled || !periodAgg?.enabled) return null;

  const noun = PERIOD_NOUNS[periodType];
  const completed = isCompletedPeriod(dateRange);
  const heading = completed
    ? (periodLabel ? `${periodLabel} — PVC Totals` : `${noun.charAt(0).toUpperCase() + noun.slice(1)} PVC Totals`)
    : `So far this ${noun} — PVC`;

  const cols = periodAgg.columnsToShow;
  const shiftHeader = periodAgg.shiftLabel === 'shift' ? 'Shifts' : 'Working Days';
  const perShiftSuffix = periodAgg.shiftLabel === 'shift' ? '/ Shift' : '/ Day';

  // Period totals cells (top row). Adaptive ordering.
  const cells: Array<{ label: string; value: string; valueClass?: string }> = [];
  if (cols.clockHours) cells.push({ label: 'Clock Hours', value: periodAgg.totalClockHours.toFixed(1) });
  cells.push({ label: shiftHeader, value: periodAgg.totalShifts.toFixed(2) });
  cells.push({ label: 'wRVU', value: periodAgg.totalWrvu.toFixed(2) });
  if (verifiedTotals.sessionsWithVerified > 0) {
    cells.push({ label: 'Verified wRVU', value: verifiedTotals.total.toFixed(2), valueClass: 'text-green-400' });
  }
  if (cols.bonusRvu) cells.push({ label: 'Bonus RVU', value: periodAgg.totalBonusRvu.toFixed(2) });
  if (cols.meetingRvu) cells.push({ label: 'Meeting RVU', value: periodAgg.totalMeetingRvu.toFixed(2) });
  if (cols.allInRvuPerShift) {
    cells.push({ label: `All-in RVU ${perShiftSuffix}`, value: periodAgg.allInRvuPerShift.toFixed(2) });
    // Verified counterpart: for direct comparison against All-in RVU / Shift,
    // Verified must include Bonus + Meeting (practice overlays that get paid
    // regardless of billing source). Without those the average understates
    // the actual compensation-basis rate.
    if (verifiedTotals.sessionsWithVerified > 0 && periodAgg.totalShifts > 0) {
      const verifiedAllIn = verifiedTotals.total + periodAgg.totalBonusRvu + periodAgg.totalMeetingRvu;
      cells.push({
        label: `Verified All-in ${perShiftSuffix}`,
        value: (verifiedAllIn / periodAgg.totalShifts).toFixed(2),
        valueClass: 'text-green-400',
      });
    }
  } else {
    cells.push({ label: `wRVU ${perShiftSuffix}`, value: periodAgg.wrvuPerShift.toFixed(2) });
    if (verifiedTotals.sessionsWithVerified > 0 && periodAgg.totalShifts > 0) {
      cells.push({
        label: `Verified ${perShiftSuffix}`,
        value: (verifiedTotals.total / periodAgg.totalShifts).toFixed(2),
        valueClass: 'text-green-400',
      });
    }
  }
  if (cols.productivityBonus) {
    cells.push({ label: 'Bonus Shifts', value: periodAgg.totalBonusShifts.toFixed(2) });
    cells.push({ label: 'Total Credit', value: periodAgg.totalCreditShifts.toFixed(2) });
  }
  if (cols.estimatedDollars) {
    cells.push({
      label: 'Estimated $',
      value: periodAgg.estimatedDollars.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }),
    });
  }

  // Breakdown rows from the context agg (full month/quarter touched by report).
  // Skip if the breakdown is just one row that equals the period totals
  // (Monthly report viewing a single complete month).
  const breakdownRows = contextAgg?.periodBreakdown ?? [];
  const showBreakdown = breakdownRows.length > 0 && (
    periodType !== 'monthly' || breakdownRows.length > 1
  );

  return (
    <div className="bg-gray-800 border border-gray-700 rounded-lg p-4">
      <h3 className="text-white font-medium mb-3">{heading}</h3>
      <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${cells.length}, minmax(0, 1fr))` }}>
        {cells.map(c => (
          <div key={c.label} className="bg-gray-900/50 rounded p-2">
            <div className="text-[10px] uppercase tracking-wider text-gray-400">{c.label}</div>
            <div className={`text-lg font-medium ${c.valueClass ?? 'text-white'}`}>{c.value}</div>
          </div>
        ))}
      </div>

      {showBreakdown && (
        <div className="mt-4">
          <div className="text-[10px] uppercase tracking-wider text-gray-400 mb-1.5">
            Adjusted wRVU by {pvcConfig.productivityTierPeriod === 'quarterly' ? 'quarter' : pvcConfig.productivityTierPeriod === 'daily' ? 'day' : 'calendar month'}
            {' '}(used for productivity bonus)
          </div>
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-gray-700 text-gray-400">
                <th className="text-left py-1.5 pr-3">Period</th>
                <th className="text-right py-1.5 px-2">Shifts</th>
                <th className="text-right py-1.5 px-2">Adjusted wRVU</th>
                <th className="text-right py-1.5 px-2">Avg / Shift</th>
                {cols.productivityBonus && <th className="text-right py-1.5 px-2">Bonus Shifts</th>}
                <th className="text-center py-1.5 pl-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {breakdownRows.map(row => (
                <tr key={row.key} className="border-b border-gray-700/50">
                  <td className="text-white py-1.5 pr-3">{row.label}</td>
                  <td className="text-right text-white py-1.5 px-2">{row.shifts.toFixed(2)}</td>
                  <td className="text-right text-white py-1.5 px-2">{row.totalAdjustedRvu.toFixed(2)}</td>
                  <td className="text-right text-white py-1.5 px-2">{row.avgAdjustedRvuPerShift.toFixed(2)}</td>
                  {cols.productivityBonus && (
                    <td className="text-right text-white py-1.5 px-2">{row.bonusShifts.toFixed(2)}</td>
                  )}
                  <td className="text-center py-1.5 pl-2">
                    <span className={row.isComplete ? 'text-gray-500' : 'text-amber-400'}>
                      {row.isComplete ? 'closed' : 'in progress'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-[10px] text-gray-500 mt-2">
        Compensation estimate only. CPT adjustments applied silently at the wRVU read path; raw CMS values preserved for audit.
        {cols.productivityBonus && ' Productivity bonus uses Adjusted wRVU (wRVU + bonus RVU + meeting RVU) averaged by the configured period.'}
      </p>

    </div>
  );
}
