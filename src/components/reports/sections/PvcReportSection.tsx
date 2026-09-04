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

  // Three-row summary layout. Row 1 = period facts (invariant between
  // RadTach and Epic-verified counting). Row 2 = RadTach-side accumulation
  // and derived comp. Row 3 = Epic-verified counterpart, only shown when at
  // least one session in the period has a verifiedRVU > 0. Row 3's
  // Epic-derived cells render in green; Bonus/Meeting RVU stay default since
  // they don't differ between the two counting bases.
  type Cell = { label: string; value: string; valueClass?: string };
  const currency = (n: number) =>
    n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  const green = 'text-green-400';

  // Row 1 — period facts
  const row1: Cell[] = [];
  if (cols.clockHours) row1.push({ label: 'Clock Hours', value: periodAgg.totalClockHours.toFixed(1) });
  row1.push({ label: `Worked ${shiftHeader}`, value: periodAgg.totalShifts.toFixed(2) });
  if (cols.bonusRvu) row1.push({ label: 'Bonus RVU', value: periodAgg.totalBonusRvu.toFixed(2) });
  if (cols.meetingRvu) row1.push({ label: 'Meeting RVU', value: periodAgg.totalMeetingRvu.toFixed(2) });
  if (cols.bonusShiftsFromRotation) {
    row1.push({ label: 'Bonus Shifts', value: periodAgg.totalBonusShiftsFromRotation.toFixed(2) });
  }
  if (cols.estimatedDollars && pvcConfig.shiftValue != null) {
    row1.push({ label: 'Shift Value', value: currency(pvcConfig.shiftValue) });
  }

  // Flat Rate wRVU is shown on both Rows 2 and 3 whenever any session in the
  // period had a flat-rate override. Kept separate from Worked wRVU so the
  // efficiency numerator (actual reads) doesn't include the flat credit,
  // per the group rule that Fluoro pays a flat 60 regardless of what you read.
  const showFlatRate = periodAgg.totalFlatRateWrvu > 0;

  // Row 2 — RadTach-side
  const row2: Cell[] = [];
  row2.push({ label: 'Worked wRVU', value: periodAgg.totalActualReadWrvu.toFixed(2) });
  if (showFlatRate) row2.push({ label: 'Flat Rate wRVU', value: periodAgg.totalFlatRateWrvu.toFixed(2) });
  if (cols.bonusRvu) row2.push({ label: 'Bonus RVU', value: periodAgg.totalBonusRvu.toFixed(2) });
  if (cols.meetingRvu) row2.push({ label: 'Meeting RVU', value: periodAgg.totalMeetingRvu.toFixed(2) });
  // Total RVU = Worked + Flat + Bonus + Meeting per user spec. In the typical
  // case (no actual reads recorded during flat-rate shifts) this equals the
  // compensation-basis allInWrvu; if reads WERE recorded during Fluoro, they
  // still show in Worked here but don't count toward compensation.
  const displayedTotalRvu =
    periodAgg.totalActualReadWrvu +
    periodAgg.totalFlatRateWrvu +
    periodAgg.totalBonusRvu +
    periodAgg.totalMeetingRvu;
  if (cols.allInRvuPerShift || showFlatRate) {
    row2.push({ label: 'Total RVU', value: displayedTotalRvu.toFixed(2) });
    row2.push({
      label: `All-in ${perShiftSuffix}`,
      value: (periodAgg.totalShifts > 0 ? displayedTotalRvu / periodAgg.totalShifts : 0).toFixed(2),
    });
  } else {
    row2.push({ label: `wRVU ${perShiftSuffix}`, value: periodAgg.wrvuPerShift.toFixed(2) });
  }
  if (cols.bonusShiftsFromRvu) {
    row2.push({ label: 'Productivity Bonus', value: periodAgg.totalBonusShiftsFromRvu.toFixed(2) });
  }
  row2.push({ label: 'Compensation Shifts', value: periodAgg.totalCreditShifts.toFixed(2) });
  if (cols.estimatedDollars) {
    row2.push({ label: 'Compensation Value', value: currency(periodAgg.estimatedDollars) });
  }

  // Row 3 — Epic/Medicalis verified
  const row3: Cell[] = [];
  if (periodAgg.hasVerifiedData) {
    row3.push({ label: 'Worked wRVU', value: periodAgg.totalVerifiedWrvu.toFixed(2), valueClass: green });
    if (showFlatRate) {
      // Same flat-rate value as Row 2 — it's a shift-level credit that
      // applies identically whether counting from RadTach or Epic. Green
      // because on the Epic side it's the primary comp source for that shift.
      row3.push({ label: 'Flat Rate wRVU', value: periodAgg.totalFlatRateWrvu.toFixed(2), valueClass: green });
    }
    // Bonus/Meeting don't differ between the two counting bases.
    if (cols.bonusRvu) row3.push({ label: 'Bonus RVU', value: periodAgg.totalBonusRvu.toFixed(2) });
    if (cols.meetingRvu) row3.push({ label: 'Meeting RVU', value: periodAgg.totalMeetingRvu.toFixed(2) });
    const verifiedDisplayedTotal =
      periodAgg.totalVerifiedWrvu +
      periodAgg.totalFlatRateWrvu +
      periodAgg.totalBonusRvu +
      periodAgg.totalMeetingRvu;
    if (cols.allInRvuPerShift || showFlatRate) {
      row3.push({ label: 'Total RVU', value: verifiedDisplayedTotal.toFixed(2), valueClass: green });
      row3.push({
        label: `All-in ${perShiftSuffix}`,
        value: (periodAgg.totalShifts > 0 ? verifiedDisplayedTotal / periodAgg.totalShifts : 0).toFixed(2),
        valueClass: green,
      });
    } else {
      row3.push({
        label: `wRVU ${perShiftSuffix}`,
        value: (periodAgg.totalShifts > 0 ? periodAgg.totalVerifiedWrvu / periodAgg.totalShifts : 0).toFixed(2),
        valueClass: green,
      });
    }
    if (cols.bonusShiftsFromRvu) {
      row3.push({
        label: 'Productivity Bonus',
        value: periodAgg.verifiedTotalBonusShiftsFromRvu.toFixed(2),
        valueClass: green,
      });
    }
    row3.push({
      label: 'Compensation Shifts',
      value: periodAgg.verifiedTotalCreditShifts.toFixed(2),
      valueClass: green,
    });
    if (cols.estimatedDollars) {
      row3.push({
        label: 'Compensation Value',
        value: currency(periodAgg.verifiedEstimatedDollars),
        valueClass: green,
      });
    }
  }

  const summaryRows: Array<{ tag: string; tagClass: string; cells: Cell[] }> = [
    { tag: 'Period', tagClass: 'text-gray-500', cells: row1 },
    { tag: 'RadTach', tagClass: 'text-gray-400', cells: row2 },
  ];
  if (row3.length > 0) {
    summaryRows.push({ tag: 'Epic', tagClass: green, cells: row3 });
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
      <div className="space-y-2">
        {summaryRows.map(row => (
          <div key={row.tag} className="flex items-stretch gap-3">
            <div className={`self-center w-16 shrink-0 text-[10px] uppercase tracking-wider font-medium ${row.tagClass}`}>
              {row.tag}
            </div>
            <div
              className="flex-1 grid gap-3"
              style={{ gridTemplateColumns: `repeat(${row.cells.length}, minmax(0, 1fr))` }}
            >
              {row.cells.map(c => (
                <div key={c.label} className="bg-gray-900/50 rounded p-2">
                  <div className="text-[10px] uppercase tracking-wider text-gray-400">{c.label}</div>
                  <div className={`text-lg font-medium ${c.valueClass ?? 'text-white'}`}>{c.value}</div>
                </div>
              ))}
            </div>
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
                {cols.bonusShiftsFromRvu && <th className="text-right py-1.5 px-2">Bonus (RVU)</th>}
                {cols.bonusShiftsFromRotation && <th className="text-right py-1.5 px-2">Bonus (Rot)</th>}
                {cols.bonusShiftsTotal && <th className="text-right py-1.5 px-2">Bonus Total</th>}
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
                  {cols.bonusShiftsFromRvu && (
                    <td className="text-right text-white py-1.5 px-2">{row.bonusShiftsFromRvu.toFixed(2)}</td>
                  )}
                  {cols.bonusShiftsFromRotation && (
                    <td className="text-right text-white py-1.5 px-2">{row.bonusShiftsFromRotation.toFixed(2)}</td>
                  )}
                  {cols.bonusShiftsTotal && (
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
        {cols.bonusShiftsFromRvu && ' Productivity bonus uses Adjusted wRVU (wRVU + bonus RVU + meeting RVU) averaged by the configured period.'}
      </p>

    </div>
  );
}
