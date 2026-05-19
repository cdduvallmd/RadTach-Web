// Phase 4: Quarterly Report Tab — User (Radiologist) view
// Delta comparisons, monthly datapoints, personal bests, complication mastery

import { useState, useMemo } from 'react';
import { useSessionData } from '../../hooks/useSessionData';
import { useGroupStats } from '../../hooks/useGroupStats';
import { aggregateSessions, getQuarterRange, computeMonthlyTrend, computeDelta, findPersonalBests } from '../../utils/periodAggregation';
import type { DateRange, DistributionStats, EffectiveRole } from '../../types/reports';
import { format, subQuarters, addQuarters } from 'date-fns';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import GARPercentileGauge from './shared/GARPercentileGauge';
import ModalityPerformance from './shared/ModalityPerformance';
import PresidentQuarterlySection from './sections/PresidentQuarterlySection';
import HospitalQuarterlySection from './sections/HospitalQuarterlySection';
import ITQuarterlySection from './sections/ITQuarterlySection';

interface QuarterlyReportTabProps {
  userId: string | null;
  userSystem: string | null;
  formatTime: (seconds: number) => string;
  role?: EffectiveRole;
  dateRange?: DateRange;
}

export default function QuarterlyReportTab({ userId, userSystem, formatTime, role = 'radiologist', dateRange: externalRange }: QuarterlyReportTabProps) {
  const [currentDate, setCurrentDate] = useState(new Date());
  const quarter = (Math.floor(currentDate.getMonth() / 3) + 1) as 1 | 2 | 3 | 4;
  const year = currentDate.getFullYear();

  const internalRange: DateRange = useMemo(() => getQuarterRange(year, quarter), [year, quarter]);
  const quarterRange = externalRange ?? internalRange;
  const externallyControlled = !!externalRange;
  const priorQuarterDate = useMemo(() => subQuarters(currentDate, 1), [currentDate]);
  const priorQuarter = (Math.floor(priorQuarterDate.getMonth() / 3) + 1) as 1 | 2 | 3 | 4;
  const priorYear = priorQuarterDate.getFullYear();
  const priorRange: DateRange = useMemo(() => getQuarterRange(priorYear, priorQuarter), [priorYear, priorQuarter]);

  const { sessions, loading, error } = useSessionData(userId, quarterRange);
  const { sessions: priorSessions, loading: priorLoading } = useSessionData(userId, priorRange);
  const { garDays } = useGroupStats(userSystem, quarterRange);

  const summary = useMemo(
    () => sessions.length > 0 ? aggregateSessions(sessions, quarterRange) : null,
    [sessions, quarterRange]
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

  const navigate = (direction: -1 | 1) => {
    setCurrentDate(prev => direction === -1 ? subQuarters(prev, 1) : addQuarters(prev, 1));
  };

  const formatDelta = (value: number, suffix = '') => {
    const sign = value > 0 ? '+' : '';
    return `${sign}${value.toFixed(2)}${suffix}`;
  };

  return (
    <div className="space-y-6">
      {/* Period navigation (hidden when RCP controls the date) */}
      {!externallyControlled && (
        <div className="flex items-center justify-between bg-gray-800 rounded-lg p-4">
          <button onClick={() => navigate(-1)} className="text-gray-400 hover:text-white text-xl px-3">&#8592;</button>
          <div className="text-center">
            <div className="text-sm text-gray-400">Quarterly Report</div>
            <div className="text-white font-medium">Q{quarter} {year}</div>
            <div className="text-xs text-gray-500">
              {format(quarterRange.start, 'MMM d')} &ndash; {format(quarterRange.end, 'MMM d, yyyy')}
            </div>
            {userSystem && <div className="text-xs text-gray-500">{userSystem}</div>}
          </div>
          <button onClick={() => navigate(1)} className="text-gray-400 hover:text-white text-xl px-3">&#8594;</button>
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
            <p className="text-gray-500 text-lg">No sessions found for Q{quarter} {year}</p>
            <p className="text-gray-600 text-sm mt-1">Navigate to a different quarter or complete some sessions first</p>
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
              { label: 'Total RVU', value: summary.totalRVU.toFixed(2), delta: delta?.rvuDelta },
              ...(summary.sessionsWithVerifiedRVU > 0 ? [{ label: 'Verified RVU', value: summary.totalVerifiedRVU.toFixed(2), delta: undefined as number | undefined }] : []),
              { label: 'Avg RVU/hr', value: summary.avgRVUPerHour.toFixed(2), delta: delta?.rvuPerHourDelta, pctChange: delta?.rvuPerHourPctChange },
            ].map(card => (
              <div key={card.label} className="bg-gray-800 rounded-lg p-4 text-center">
                <div className="text-gray-400 text-xs mb-1">{card.label}</div>
                <div className="text-2xl font-bold text-white">{card.value}</div>
                {card.delta !== undefined && card.delta !== null && priorSummary && (
                  <div className={`text-xs mt-1 ${card.delta > 0 ? 'text-green-400' : card.delta < 0 ? 'text-red-400' : 'text-gray-500'}`}>
                    {formatDelta(card.delta)} vs Q{priorQuarter}
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
                  {formatDelta(delta.varianceDelta)}s vs Q{priorQuarter}
                </div>
              )}
            </div>
            <div className="bg-gray-800 rounded-lg p-4 text-center">
              <div className="text-gray-400 text-xs mb-1">Productive Ratio</div>
              <div className="text-2xl font-bold text-white">{(summary.avgProductiveRatio * 100).toFixed(2)}%</div>
              {delta && priorSummary && (
                <div className={`text-xs mt-1 ${delta.productiveRatioDelta > 0 ? 'text-green-400' : delta.productiveRatioDelta < 0 ? 'text-red-400' : 'text-gray-500'}`}>
                  {formatDelta(delta.productiveRatioDelta * 100, '%')} vs Q{priorQuarter}
                </div>
              )}
            </div>
            <div className="bg-gray-800 rounded-lg p-4 text-center">
              <div className="text-gray-400 text-xs mb-1">Avg Breaks/Session</div>
              <div className="text-2xl font-bold text-white">{summary.avgBreaksPerSession.toFixed(2)}</div>
            </div>
          </div>

          {/* Monthly trend (3 datapoints per quarter) */}
          {monthlyTrend.length > 0 && (
            <div className="bg-gray-800 rounded-lg p-4">
              <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">Monthly Trajectory</h3>
              <div className="flex items-end gap-4 h-32">
                {monthlyTrend.map((m, i) => {
                  const maxRVU = Math.max(...monthlyTrend.map(p => p.avgRVUPerHour), 1);
                  const height = (m.avgRVUPerHour / maxRVU) * 100;
                  return (
                    <div key={i} className="flex-1 flex flex-col items-center">
                      <div className="text-xs text-gray-400 mb-1">{m.avgRVUPerHour.toFixed(2)}</div>
                      <div
                        className="w-full rounded-t"
                        style={{ height: `${height}%`, backgroundColor: '#3b82f6', minHeight: 4 }}
                      />
                      <div className="text-xs text-gray-500 mt-1">{m.monthLabel}</div>
                      <div className="text-xs text-gray-600">{m.sessions} sessions</div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* RVU/hr by Modality Trend (monthly data points) */}
          {monthlyTrend.length > 1 && (() => {
            const MODALITY_COLORS: Record<string, string> = {
              'XR': '#3b82f6', 'FL': '#8b5cf6', 'CT': '#22c55e', 'US': '#06b6d4',
              'MR': '#f97316', 'NM': '#ec4899', 'MA': '#eab308', 'PET-CT': '#ef4444',
            };
            const allMods = new Set<string>();
            monthlyTrend.forEach(m => Object.keys(m.rvuPerHourByModality).forEach(mod => allMods.add(mod)));
            const mods = [...allMods].sort();
            if (mods.length === 0) return null;
            const chartData = monthlyTrend.map(m => ({
              month: m.monthLabel,
              ...Object.fromEntries(mods.map(mod => [mod, m.rvuPerHourByModality[mod] ?? null])),
            }));
            return (
              <div className="bg-gray-800 rounded-lg p-4">
                <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">RVU/hr by Modality — Monthly Trend</h3>
                <ResponsiveContainer width="100%" height={250}>
                  <LineChart data={chartData} margin={{ top: 5, right: 20, bottom: 20, left: 20 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                    <XAxis dataKey="month" stroke="#9ca3af" fontSize={11} />
                    <YAxis stroke="#9ca3af" fontSize={11} />
                    <Tooltip contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', color: '#fff' }} />
                    <Legend />
                    {mods.map(mod => (
                      <Line key={mod} type="monotone" dataKey={mod} stroke={MODALITY_COLORS[mod] || '#6b7280'} strokeWidth={2} dot={{ r: 4 }} connectNulls />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            );
          })()}

          {/* Deck Quality vs Throughput Trend */}
          {monthlyTrend.length > 1 && (() => {
            const deckData = monthlyTrend.map(m => ({
              month: m.monthLabel,
              rvuPerStudy: Math.round(m.avgRvuPerStudy * 100) / 100,
              studiesPerHour: Math.round(m.studiesPerHour * 10) / 10,
              productiveRatio: Math.round(m.avgProductiveRatio * 1000) / 10,
              interstitial: Math.round(m.avgInterstitialTime),
            }));
            return (
              <>
                <div className="bg-gray-800 rounded-lg p-4">
                  <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">Deck Quality vs Throughput — Monthly Trend</h3>
                  <ResponsiveContainer width="100%" height={200}>
                    <LineChart data={deckData} margin={{ top: 5, right: 20, bottom: 20, left: 20 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                      <XAxis dataKey="month" stroke="#9ca3af" fontSize={11} />
                      <YAxis yAxisId="left" stroke="#3b82f6" fontSize={11} />
                      <YAxis yAxisId="right" orientation="right" stroke="#8b5cf6" fontSize={11} />
                      <Tooltip contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', color: '#fff' }} />
                      <Legend />
                      <Line yAxisId="left" type="monotone" dataKey="rvuPerStudy" stroke="#3b82f6" strokeWidth={2} dot={{ r: 4 }} name="wRVU/Study" />
                      <Line yAxisId="right" type="monotone" dataKey="studiesPerHour" stroke="#8b5cf6" strokeWidth={2} dot={{ r: 4 }} name="Studies/hr" />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
                <div className="bg-gray-800 rounded-lg p-4">
                  <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">Productive Ratio & Interstitial — Monthly Trend</h3>
                  <ResponsiveContainer width="100%" height={200}>
                    <LineChart data={deckData} margin={{ top: 5, right: 20, bottom: 20, left: 20 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                      <XAxis dataKey="month" stroke="#9ca3af" fontSize={11} />
                      <YAxis yAxisId="left" stroke="#22c55e" fontSize={11} unit="%" />
                      <YAxis yAxisId="right" orientation="right" stroke="#f97316" fontSize={11} unit="s" />
                      <Tooltip contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', color: '#fff' }} />
                      <Legend />
                      <Line yAxisId="left" type="monotone" dataKey="productiveRatio" stroke="#22c55e" strokeWidth={2} dot={{ r: 4 }} name="Productive %" />
                      <Line yAxisId="right" type="monotone" dataKey="interstitial" stroke="#f97316" strokeWidth={2} dot={{ r: 4 }} name="Avg Interstitial (s)" />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </>
            );
          })()}

          {/* Personal bests */}
          {personalBests && (
            <div className="bg-gray-800 rounded-lg p-4">
              <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">Personal Bests (This Quarter)</h3>
              <div className="grid grid-cols-2 gap-4">
                {personalBests.bestSession && (
                  <div className="bg-gray-700 rounded-lg p-3 text-center">
                    <div className="text-gray-400 text-xs">Best Session RVU/hr</div>
                    <div className="text-xl font-bold text-green-400">{personalBests.bestSession.rvuPerHour.toFixed(2)}</div>
                    <div className="text-xs text-gray-500">{personalBests.bestSession.studies} studies</div>
                  </div>
                )}
                {personalBests.bestWeek && (
                  <div className="bg-gray-700 rounded-lg p-3 text-center">
                    <div className="text-gray-400 text-xs">Best Week RVU/hr</div>
                    <div className="text-xl font-bold text-green-400">{personalBests.bestWeek.avgRVUPerHour.toFixed(2)}</div>
                    <div className="text-xs text-gray-500">Week of {personalBests.bestWeek.weekLabel}</div>
                  </div>
                )}
                <div className="bg-gray-700 rounded-lg p-3 text-center">
                  <div className="text-gray-400 text-xs">Longest Under-Par Streak</div>
                  <div className="text-xl font-bold text-green-400">{personalBests.longestUnderParStreak}</div>
                  <div className="text-xs text-gray-500">consecutive sessions</div>
                </div>
                <div className="bg-gray-700 rounded-lg p-3 text-center">
                  <div className="text-gray-400 text-xs">Total RVU</div>
                  <div className="text-xl font-bold text-white">{summary.totalRVU.toFixed(2)}</div>
                  <div className="text-xs text-gray-500">this quarter</div>
                </div>
              </div>
            </div>
          )}

          {/* Performance by Modality — tabbed view */}
          <ModalityPerformance
            studiesByModality={summary.studiesByModality}
            rvuPerHourByModality={summary.rvuPerHourByModality}
            avgVarianceByModality={summary.avgVarianceByModality}
            rvuByModality={summary.rvuByModality}
            totalStudies={summary.totalStudies}
            trendPoints={monthlyTrend.map(m => ({ label: m.monthLabel, rvuPerHourByModality: m.rvuPerHourByModality }))}
            trendLabel="Month"
            formatTime={formatTime}
          />

          {/* Modality efficiency table */}
          {Object.keys(summary.studiesByModality).length > 0 && (
            <div className="bg-gray-800 rounded-lg p-4">
              <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">Modality Efficiency</h3>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-gray-400 border-b border-gray-700">
                    <th className="text-left py-2">Modality</th>
                    <th className="text-right py-2">Studies</th>
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
                        <td className="py-2 text-right">{(summary.rvuPerHourByModality[mod] || 0).toFixed(2)}</td>
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
              <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">Rotation Comparison</h3>
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
                        <td className="py-2 text-right">{(summary.rvuPerHourByRotation[rot] || 0).toFixed(2)}</td>
                        <td className={`py-2 text-right ${(summary.avgVarianceByRotation[rot] || 0) <= 0 ? 'text-green-400' : 'text-red-400'}`}>
                          {Math.round(summary.avgVarianceByRotation[rot] || 0)}s
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Time allocation */}
          <div className="bg-gray-800 rounded-lg p-4">
            <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">Time Allocation</h3>
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
                    title={`${t.label}: ${formatTime(t.value)} (${pct.toFixed(2)}%)`}
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
                formatValue={(v) => `${(v * 100).toFixed(2)}%`}
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
        <PresidentQuarterlySection system={userSystem} dateRange={quarterRange} formatTime={formatTime} />
      )}

      {/* Hospital Admin section */}
      {(role === 'hospitalAdmin' || role === 'president') && (
        <HospitalQuarterlySection system={userSystem} dateRange={quarterRange} />
      )}

      {/* IT section */}
      {(role === 'it' || role === 'president') && (
        <ITQuarterlySection system={userSystem} dateRange={quarterRange} />
      )}
    </div>
  );
}
