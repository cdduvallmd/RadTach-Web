// Phase 4: Yearly Report Tab — User (Radiologist) view
// Delta vs prior year, 12 monthly datapoints, annual breakdown, personal bests

import { useState, useMemo } from 'react';
import { useSessionData } from '../../hooks/useSessionData';
import { useGroupStats } from '../../hooks/useGroupStats';
import { aggregateSessions, getYearRange, computeMonthlyTrend, computeDelta, findPersonalBests } from '../../utils/periodAggregation';
import type { DateRange, DistributionStats, EffectiveRole } from '../../types/reports';
import GARPercentileGauge from './shared/GARPercentileGauge';
import PresidentYearlySection from './sections/PresidentYearlySection';
import HospitalYearlySection from './sections/HospitalYearlySection';
import ITYearlySection from './sections/ITYearlySection';

interface YearlyReportTabProps {
  userId: string | null;
  userSystem: string | null;
  formatTime: (seconds: number) => string;
  role?: EffectiveRole;
  dateRange?: DateRange;
}

export default function YearlyReportTab({ userId, userSystem, formatTime, role = 'radiologist', dateRange: externalRange }: YearlyReportTabProps) {
  const [currentYear, setCurrentYear] = useState(new Date().getFullYear());

  const internalRange: DateRange = useMemo(() => getYearRange(currentYear), [currentYear]);
  const yearRange = externalRange ?? internalRange;
  const externallyControlled = !!externalRange;
  const priorRange: DateRange = useMemo(() => getYearRange(currentYear - 1), [currentYear]);

  const { sessions, loading, error } = useSessionData(userId, yearRange);
  const { sessions: priorSessions, loading: priorLoading } = useSessionData(userId, priorRange);
  const { garDays } = useGroupStats(userSystem, yearRange);

  const summary = useMemo(
    () => sessions.length > 0 ? aggregateSessions(sessions, yearRange) : null,
    [sessions, yearRange]
  );
  const priorSummary = useMemo(
    () => priorSessions.length > 0 ? aggregateSessions(priorSessions, priorRange) : null,
    [priorSessions, priorRange]
  );
  const delta = useMemo(
    () => summary && priorSummary ? computeDelta(summary, priorSummary) : null,
    [summary, priorSummary]
  );
  const monthlyTrend = useMemo(
    () => sessions.length > 0 ? computeMonthlyTrend(sessions) : [],
    [sessions]
  );
  const personalBests = useMemo(
    () => sessions.length > 0 ? findPersonalBests(sessions) : null,
    [sessions]
  );

  const garAvg = useMemo(() => {
    if (garDays.length === 0) return null;
    const avgDist = (accessor: (g: typeof garDays[0]) => DistributionStats): DistributionStats => {
      const dists = garDays.map(accessor);
      const n = dists.reduce((s, d) => s + d.n, 0);
      return {
        mean: dists.reduce((s, d) => s + d.mean * d.n, 0) / (n || 1),
        median: dists.reduce((s, d) => s + d.median, 0) / dists.length,
        p25: dists.reduce((s, d) => s + d.p25, 0) / dists.length,
        p50: dists.reduce((s, d) => s + d.p50, 0) / dists.length,
        p75: dists.reduce((s, d) => s + d.p75, 0) / dists.length,
        stdDev: dists.reduce((s, d) => s + d.stdDev, 0) / dists.length,
        n,
      };
    };
    return {
      rvuPerHour: avgDist(g => g.rvuPerHour),
      productiveRatio: avgDist(g => g.productiveRatio),
    };
  }, [garDays]);

  const formatDelta = (value: number, suffix = '') => {
    const sign = value > 0 ? '+' : '';
    return `${sign}${value.toFixed(1)}${suffix}`;
  };

  return (
    <div className="space-y-6">
      {/* Period navigation (hidden when RCP controls the date) */}
      {!externallyControlled && (
        <div className="flex items-center justify-between bg-gray-800 rounded-lg p-4">
          <button onClick={() => setCurrentYear(y => y - 1)} className="text-gray-400 hover:text-white text-xl px-3">&#8592;</button>
          <div className="text-center">
            <div className="text-sm text-gray-400">Yearly Report</div>
            <div className="text-white font-medium">{currentYear}</div>
            {userSystem && <div className="text-xs text-gray-500">{userSystem}</div>}
          </div>
          <button onClick={() => setCurrentYear(y => y + 1)} className="text-gray-400 hover:text-white text-xl px-3">&#8594;</button>
        </div>
      )}

      {(loading || priorLoading) && (
        <div className="flex items-center justify-center h-48">
          <div className="text-gray-400">Loading sessions...</div>
        </div>
      )}

      {error && (
        <div className="bg-red-900/30 border border-red-700/50 rounded-lg p-4 text-red-300 text-sm">
          Error loading data: {error}
        </div>
      )}

      {!loading && !error && sessions.length === 0 && (
        <div className="flex items-center justify-center h-48">
          <div className="text-center">
            <p className="text-gray-500 text-lg">No sessions found for {currentYear}</p>
            <p className="text-gray-600 text-sm mt-1">Navigate to a different year or complete some sessions first</p>
          </div>
        </div>
      )}

      {!loading && !error && summary && (
        <div className="space-y-6">
          {/* Summary cards with deltas */}
          <div className="grid grid-cols-4 gap-4">
            {[
              { label: 'Sessions', value: String(summary.totalSessions), delta: delta?.sessionsDelta },
              { label: 'Total Studies', value: String(summary.totalStudies), delta: delta?.studiesDelta },
              { label: 'Total RVU', value: summary.totalRVU.toFixed(1), delta: delta?.rvuDelta },
              ...(summary.sessionsWithVerifiedRVU > 0 ? [{ label: 'Verified RVU', value: summary.totalVerifiedRVU.toFixed(1), delta: undefined as number | undefined }] : []),
              { label: 'Avg RVU/hr', value: summary.avgRVUPerHour.toFixed(1), delta: delta?.rvuPerHourDelta, pctChange: delta?.rvuPerHourPctChange },
            ].map(card => (
              <div key={card.label} className="bg-gray-800 rounded-lg p-4 text-center">
                <div className="text-gray-400 text-xs mb-1">{card.label}</div>
                <div className="text-2xl font-bold text-white">{card.value}</div>
                {card.delta !== undefined && card.delta !== null && priorSummary && (
                  <div className={`text-xs mt-1 ${card.delta > 0 ? 'text-green-400' : card.delta < 0 ? 'text-red-400' : 'text-gray-500'}`}>
                    {formatDelta(card.delta)} vs {currentYear - 1}
                    {card.pctChange !== undefined && ` (${formatDelta(card.pctChange, '%')})`}
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div className="bg-gray-800 rounded-lg p-4 text-center">
              <div className="text-gray-400 text-xs mb-1">Avg Variance</div>
              <div className={`text-2xl font-bold ${summary.avgVariance <= 0 ? 'text-green-400' : 'text-red-400'}`}>
                {summary.avgVariance > 0 ? '+' : ''}{Math.round(summary.avgVariance)}s
              </div>
              {delta && priorSummary && (
                <div className={`text-xs mt-1 ${delta.varianceDelta < 0 ? 'text-green-400' : delta.varianceDelta > 0 ? 'text-red-400' : 'text-gray-500'}`}>
                  {formatDelta(delta.varianceDelta)}s vs {currentYear - 1}
                </div>
              )}
            </div>
            <div className="bg-gray-800 rounded-lg p-4 text-center">
              <div className="text-gray-400 text-xs mb-1">Productive Ratio</div>
              <div className="text-2xl font-bold text-white">{(summary.avgProductiveRatio * 100).toFixed(1)}%</div>
            </div>
            <div className="bg-gray-800 rounded-lg p-4 text-center">
              <div className="text-gray-400 text-xs mb-1">Sessions Split</div>
              <div className="text-lg font-bold text-white">{summary.fullDaySessions} full / {summary.halfDaySessions} half</div>
            </div>
          </div>

          {/* Monthly trend (up to 12 datapoints) */}
          {monthlyTrend.length > 0 && (
            <div className="bg-gray-800 rounded-lg p-4">
              <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">Monthly RVU/hr Trend</h3>
              <div className="flex items-end gap-1 h-32">
                {monthlyTrend.map((m, i) => {
                  const maxRVU = Math.max(...monthlyTrend.map(p => p.avgRVUPerHour), 1);
                  const height = (m.avgRVUPerHour / maxRVU) * 100;
                  return (
                    <div key={i} className="flex-1 flex flex-col items-center">
                      <div className="text-xs text-gray-400 mb-1">{m.avgRVUPerHour.toFixed(1)}</div>
                      <div
                        className="w-full rounded-t"
                        style={{ height: `${height}%`, backgroundColor: '#3b82f6', minHeight: 4 }}
                      />
                      <div className="text-xs text-gray-500 mt-1">{m.monthLabel.split(' ')[0]}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Personal bests */}
          {personalBests && (
            <div className="bg-gray-800 rounded-lg p-4">
              <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">Personal Bests ({currentYear})</h3>
              <div className="grid grid-cols-4 gap-4">
                {personalBests.bestSession && (
                  <div className="bg-gray-700 rounded-lg p-3 text-center">
                    <div className="text-gray-400 text-xs">Best Session</div>
                    <div className="text-xl font-bold text-green-400">{personalBests.bestSession.rvuPerHour.toFixed(1)}</div>
                    <div className="text-xs text-gray-500">RVU/hr</div>
                  </div>
                )}
                {personalBests.bestWeek && (
                  <div className="bg-gray-700 rounded-lg p-3 text-center">
                    <div className="text-gray-400 text-xs">Best Week</div>
                    <div className="text-xl font-bold text-green-400">{personalBests.bestWeek.avgRVUPerHour.toFixed(1)}</div>
                    <div className="text-xs text-gray-500">RVU/hr</div>
                  </div>
                )}
                {personalBests.bestMonth && (
                  <div className="bg-gray-700 rounded-lg p-3 text-center">
                    <div className="text-gray-400 text-xs">Best Month</div>
                    <div className="text-xl font-bold text-green-400">{personalBests.bestMonth.avgRVUPerHour.toFixed(1)}</div>
                    <div className="text-xs text-gray-500">{personalBests.bestMonth.monthLabel}</div>
                  </div>
                )}
                <div className="bg-gray-700 rounded-lg p-3 text-center">
                  <div className="text-gray-400 text-xs">Under-Par Streak</div>
                  <div className="text-xl font-bold text-green-400">{personalBests.longestUnderParStreak}</div>
                  <div className="text-xs text-gray-500">sessions</div>
                </div>
              </div>
            </div>
          )}

          {/* Annual modality breakdown */}
          {Object.keys(summary.studiesByModality).length > 0 && (
            <div className="bg-gray-800 rounded-lg p-4">
              <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">Modality Breakdown</h3>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-gray-400 border-b border-gray-700">
                    <th className="text-left py-2">Modality</th>
                    <th className="text-right py-2">Studies</th>
                    <th className="text-right py-2">% of Total</th>
                    <th className="text-right py-2">RVU/hr</th>
                    <th className="text-right py-2">Avg Variance</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(summary.studiesByModality)
                    .sort(([, a], [, b]) => b - a)
                    .map(([mod, count]) => (
                      <tr key={mod} className="border-b border-gray-800 text-gray-300">
                        <td className="py-2">{mod}</td>
                        <td className="py-2 text-right">{count}</td>
                        <td className="py-2 text-right">{((count / summary.totalStudies) * 100).toFixed(1)}%</td>
                        <td className="py-2 text-right">{(summary.rvuPerHourByModality[mod] || 0).toFixed(1)}</td>
                        <td className={`py-2 text-right ${(summary.avgVarianceByModality[mod] || 0) <= 0 ? 'text-green-400' : 'text-red-400'}`}>
                          {Math.round(summary.avgVarianceByModality[mod] || 0)}s
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Rotation comparison */}
          {Object.keys(summary.sessionsByRotation).length > 1 && (
            <div className="bg-gray-800 rounded-lg p-4">
              <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">Rotation Performance</h3>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-gray-400 border-b border-gray-700">
                    <th className="text-left py-2">Rotation</th>
                    <th className="text-right py-2">Sessions</th>
                    <th className="text-right py-2">RVU/hr</th>
                    <th className="text-right py-2">Avg Variance</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(summary.sessionsByRotation)
                    .sort(([, a], [, b]) => b - a)
                    .map(([rot, count]) => (
                      <tr key={rot} className="border-b border-gray-800 text-gray-300">
                        <td className="py-2">{rot}</td>
                        <td className="py-2 text-right">{count}</td>
                        <td className="py-2 text-right">{(summary.rvuPerHourByRotation[rot] || 0).toFixed(1)}</td>
                        <td className={`py-2 text-right ${(summary.avgVarianceByRotation[rot] || 0) <= 0 ? 'text-green-400' : 'text-red-400'}`}>
                          {Math.round(summary.avgVarianceByRotation[rot] || 0)}s
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Day of week */}
          {Object.keys(summary.sessionsByDayOfWeek).length > 0 && (
            <div className="bg-gray-800 rounded-lg p-4">
              <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">Day of Week Analysis</h3>
              <div className="grid grid-cols-7 gap-2 text-center text-xs">
                {['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map(day => {
                  const count = summary.sessionsByDayOfWeek[day] || 0;
                  const rvuHr = summary.avgRVUPerHourByDayOfWeek[day] || 0;
                  return (
                    <div key={day} className="bg-gray-700 rounded p-2">
                      <div className="text-gray-400 font-medium">{day.slice(0, 3)}</div>
                      <div className="text-white font-bold mt-1">{count}</div>
                      <div className="text-gray-500">sessions</div>
                      {rvuHr > 0 && <div className="text-blue-400 mt-1">{rvuHr.toFixed(1)} RVU/hr</div>}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Time allocation */}
          <div className="bg-gray-800 rounded-lg p-4">
            <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">Annual Time Allocation</h3>
            <div className="flex h-6 rounded overflow-hidden">
              {[
                { label: 'Study', value: summary.totalStudyTime, color: '#22c55e' },
                { label: 'Interstitial', value: summary.totalInterstitialTime, color: '#6b7280' },
                { label: 'Admin', value: summary.totalAdminTime, color: '#f97316' },
                { label: 'Comms', value: summary.totalCommsTime, color: '#06b6d4' },
                { label: 'Break', value: summary.totalBreakTime, color: '#ec4899' },
                { label: 'Double Tap', value: summary.totalDoubleTapTime, color: '#eab308' },
              ].filter(t => t.value > 0).map(t => {
                const total = summary.totalStudyTime + summary.totalInterstitialTime + summary.totalAdminTime + summary.totalCommsTime + summary.totalBreakTime + summary.totalDoubleTapTime;
                const pct = total > 0 ? (t.value / total) * 100 : 0;
                return (
                  <div
                    key={t.label}
                    style={{ width: `${pct}%`, backgroundColor: t.color }}
                    title={`${t.label}: ${formatTime(t.value)} (${pct.toFixed(1)}%)`}
                  />
                );
              })}
            </div>
            <div className="flex flex-wrap gap-3 mt-2 text-xs text-gray-400">
              {[
                { label: 'Study', value: summary.totalStudyTime, color: '#22c55e' },
                { label: 'Interstitial', value: summary.totalInterstitialTime, color: '#6b7280' },
                { label: 'Admin', value: summary.totalAdminTime, color: '#f97316' },
                { label: 'Comms', value: summary.totalCommsTime, color: '#06b6d4' },
                { label: 'Break', value: summary.totalBreakTime, color: '#ec4899' },
                { label: 'Double Tap', value: summary.totalDoubleTapTime, color: '#eab308' },
              ].filter(t => t.value > 0).map(t => (
                <div key={t.label} className="flex items-center gap-1">
                  <div className="w-2 h-2 rounded" style={{ backgroundColor: t.color }} />
                  <span>{t.label}: {formatTime(t.value)}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Tag frequency */}
          {Object.keys(summary.tagFrequency).length > 0 && (
            <div className="bg-gray-800 rounded-lg p-4">
              <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">Annual Tag Summary</h3>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-gray-400 border-b border-gray-700">
                    <th className="text-left py-2">Tag</th>
                    <th className="text-right py-2">Sessions</th>
                    <th className="text-right py-2">Avg RVU/hr</th>
                    <th className="text-right py-2">Avg Variance</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(summary.tagCorrelatedMetrics)
                    .sort(([, a], [, b]) => b.sessionCount - a.sessionCount)
                    .map(([tag, data]) => (
                      <tr key={tag} className="border-b border-gray-800 text-gray-300">
                        <td className="py-2">{tag}</td>
                        <td className="py-2 text-right">{data.sessionCount}</td>
                        <td className="py-2 text-right">{data.avgRVUPerHour.toFixed(1)}</td>
                        <td className={`py-2 text-right ${data.avgVariance <= 0 ? 'text-green-400' : 'text-red-400'}`}>
                          {Math.round(data.avgVariance)}s
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}

          {/* GAR Percentile Gauges */}
          {garAvg ? (
            <div className="space-y-4">
              <GARPercentileGauge
                label="RVU/hr"
                userValue={summary.avgRVUPerHour}
                distribution={garAvg.rvuPerHour}
              />
              <GARPercentileGauge
                label="Productive Ratio"
                userValue={summary.avgProductiveRatio}
                distribution={garAvg.productiveRatio}
                formatValue={(v) => `${(v * 100).toFixed(1)}%`}
              />
            </div>
          ) : (
            <div className="bg-gray-800 rounded-lg p-4 opacity-50">
              <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-2">GAR Percentile</h3>
              <p className="text-gray-500 text-sm">Minimum 3 daily users required for group comparison</p>
            </div>
          )}
        </div>
      )}

      {/* President section */}
      {role === 'president' && (
        <PresidentYearlySection system={userSystem} dateRange={yearRange} formatTime={formatTime} />
      )}

      {/* Hospital Admin section */}
      {(role === 'hospitalAdmin' || role === 'president') && (
        <HospitalYearlySection system={userSystem} dateRange={yearRange} />
      )}

      {/* IT section */}
      {(role === 'it' || role === 'president') && (
        <ITYearlySection system={userSystem} dateRange={yearRange} />
      )}
    </div>
  );
}
