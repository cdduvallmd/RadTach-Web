// Phase 3: Monthly Report Tab — User (Radiologist) view
// Introduces weekly sub-aggregation, rotation analysis, day-of-week analysis

import { useState, useMemo } from 'react';
import { useSessionData } from '../../hooks/useSessionData';
import { useGroupStats } from '../../hooks/useGroupStats';
import { aggregateSessions, getMonthRange, computeWeeklyTrend } from '../../utils/periodAggregation';
import type { DateRange, DistributionStats, EffectiveRole } from '../../types/reports';
import { addMonths, subMonths, format } from 'date-fns';
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import GARPercentileGauge from './shared/GARPercentileGauge';
import ModalityPerformance from './shared/ModalityPerformance';
import { estimatePercentile } from '../../utils/percentileEstimation';
import PresidentMonthlySection from './sections/PresidentMonthlySection';
import HospitalMonthlySection from './sections/HospitalMonthlySection';
import ITMonthlySection from './sections/ITMonthlySection';
import PvcReportSection from './sections/PvcReportSection';

interface MonthlyReportTabProps {
  userId: string | null;
  userSystem: string | null;
  formatTime: (seconds: number) => string;
  role?: EffectiveRole;
  dateRange?: DateRange;
}

export default function MonthlyReportTab({ userId, userSystem, formatTime, role = 'radiologist', dateRange: externalRange }: MonthlyReportTabProps) {
  const [currentDate, setCurrentDate] = useState(new Date());
  const internalRange: DateRange = useMemo(() => {
    return getMonthRange(currentDate.getFullYear(), currentDate.getMonth() + 1);
  }, [currentDate]);
  const monthRange = externalRange ?? internalRange;
  const externallyControlled = !!externalRange;
  const { sessions, loading, error } = useSessionData(userId, monthRange);
  const { garDays } = useGroupStats(userSystem, monthRange);
  const summary = useMemo(
    () => sessions.length > 0 ? aggregateSessions(sessions, monthRange) : null,
    [sessions, monthRange]
  );
  const weeklyTrend = useMemo(
    () => sessions.length > 0 ? computeWeeklyTrend(sessions) : [],
    [sessions]
  );

  // Average GAR distributions across all days in the period
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

  // Weekly percentile trend (monthly tab unique feature)
  const weeklyPercentileTrend = useMemo(() => {
    if (!garAvg || weeklyTrend.length === 0) return null;
    return weeklyTrend.map(w => ({
      weekLabel: w.weekLabel,
      rvuPerHourPctile: estimatePercentile(w.avgRVUPerHour, garAvg.rvuPerHour),
    }));
  }, [garAvg, weeklyTrend]);

  const navigateMonth = (direction: -1 | 1) => {
    setCurrentDate(prev => direction === -1 ? subMonths(prev, 1) : addMonths(prev, 1));
  };

  return (
    <div className="space-y-6">
      {/* Period navigation (hidden when RCP controls the date) */}
      {!externallyControlled && (
        <div className="flex items-center justify-between bg-gray-800 rounded-lg p-4">
          <button onClick={() => navigateMonth(-1)} className="text-gray-400 hover:text-white text-xl px-3">&#8592;</button>
          <div className="text-center">
            <div className="text-sm text-gray-400">Monthly Report</div>
            <div className="text-white font-medium">{format(currentDate, 'MMMM yyyy')}</div>
            {userSystem && <div className="text-xs text-gray-500">{userSystem}</div>}
          </div>
          <button onClick={() => navigateMonth(1)} className="text-gray-400 hover:text-white text-xl px-3">&#8594;</button>
        </div>
      )}

      {loading && (
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
            <p className="text-gray-500 text-lg">No sessions found for this month</p>
            <p className="text-gray-600 text-sm mt-1">Navigate to a different month or complete some sessions first</p>
          </div>
        </div>
      )}

      {!loading && !error && summary && (
        <div className="space-y-6">
          {/* Summary cards */}
          <div className="grid grid-cols-4 gap-4">
            <div className="bg-gray-800 rounded-lg p-4 text-center">
              <div className="text-gray-400 text-xs mb-1">Sessions</div>
              <div className="text-2xl font-bold text-white">{summary.totalSessions}</div>
              <div className="text-xs text-gray-500">{summary.fullDaySessions} full / {summary.halfDaySessions} half</div>
            </div>
            <div className="bg-gray-800 rounded-lg p-4 text-center">
              <div className="text-gray-400 text-xs mb-1">Total Studies</div>
              <div className="text-2xl font-bold text-white">{summary.totalStudies}</div>
            </div>
            <div className="bg-gray-800 rounded-lg p-4 text-center">
              <div className="text-gray-400 text-xs mb-1">Total RVU</div>
              <div className="text-2xl font-bold text-white">{summary.totalRVU.toFixed(2)}</div>
            </div>
            {summary.sessionsWithVerifiedRVU > 0 && (
              <div className="bg-gray-800 rounded-lg p-4 text-center">
                <div className="text-gray-400 text-xs mb-1">Verified RVU</div>
                <div className="text-2xl font-bold text-green-400">{summary.totalVerifiedRVU.toFixed(2)}</div>
              </div>
            )}
            <div className="bg-gray-800 rounded-lg p-4 text-center">
              <div className="text-gray-400 text-xs mb-1">Avg RVU/hr</div>
              <div className="text-2xl font-bold text-white">{summary.avgRVUPerHour.toFixed(2)}</div>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div className="bg-gray-800 rounded-lg p-4 text-center">
              <div className="text-gray-400 text-xs mb-1">Avg Variance</div>
              <div className={`text-2xl font-bold ${summary.avgVariance <= 0 ? 'text-green-400' : 'text-red-400'}`}>
                {summary.avgVariance > 0 ? '+' : ''}{Math.round(summary.avgVariance)}s
              </div>
            </div>
            <div className="bg-gray-800 rounded-lg p-4 text-center">
              <div className="text-gray-400 text-xs mb-1">Productive Ratio</div>
              <div className="text-2xl font-bold text-white">{(summary.avgProductiveRatio * 100).toFixed(2)}%</div>
            </div>
            <div className="bg-gray-800 rounded-lg p-4 text-center">
              <div className="text-gray-400 text-xs mb-1">Avg Interstitial/Study</div>
              <div className="text-2xl font-bold text-white">{Math.round(summary.avgInterstitialPerStudy)}s</div>
            </div>
          </div>

          {/* Weekly trend within month */}
          {weeklyTrend.length > 1 && (
            <div className="bg-gray-800 rounded-lg p-4">
              <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">Weekly RVU/hr Trend</h3>
              <div className="flex items-end gap-2 h-32">
                {weeklyTrend.map((w, i) => {
                  const maxRVU = Math.max(...weeklyTrend.map(p => p.avgRVUPerHour), 1);
                  const height = (w.avgRVUPerHour / maxRVU) * 100;
                  return (
                    <div key={i} className="flex-1 flex flex-col items-center">
                      <div className="text-xs text-gray-400 mb-1">{w.avgRVUPerHour.toFixed(2)}</div>
                      <div
                        className="w-full rounded-t"
                        style={{ height: `${height}%`, backgroundColor: '#3b82f6', minHeight: 4 }}
                      />
                      <div className="text-xs text-gray-500 mt-1">{w.weekLabel}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* RVU/hr by Modality Trend (weekly data points) */}
          {weeklyTrend.length > 1 && (() => {
            const MODALITY_COLORS: Record<string, string> = {
              'XR': '#3b82f6', 'FL': '#8b5cf6', 'CT': '#22c55e', 'US': '#06b6d4',
              'MR': '#f97316', 'NM': '#ec4899', 'MA': '#eab308', 'PET-CT': '#ef4444',
            };
            // Collect all modalities that appear in any week
            const allMods = new Set<string>();
            weeklyTrend.forEach(w => Object.keys(w.rvuPerHourByModality).forEach(m => allMods.add(m)));
            const mods = [...allMods].sort();
            if (mods.length === 0) return null;
            // Build chart data: each point = one week, with a key per modality
            const chartData = weeklyTrend.map(w => ({
              week: w.weekLabel,
              ...Object.fromEntries(mods.map(m => [m, w.rvuPerHourByModality[m] ?? null])),
            }));
            return (
              <div className="bg-gray-800 rounded-lg p-4">
                <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">RVU/hr by Modality — Weekly Trend</h3>
                <ResponsiveContainer width="100%" height={250}>
                  <LineChart data={chartData} margin={{ top: 5, right: 20, bottom: 20, left: 20 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                    <XAxis dataKey="week" stroke="#9ca3af" fontSize={11} />
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

          {/* Productive Ratio + Interstitial Trend */}
          {weeklyTrend.length > 1 && (() => {
            const trendData = weeklyTrend.map(w => ({
              week: w.weekLabel,
              productiveRatio: Math.round(w.avgProductiveRatio * 1000) / 10,
              interstitial: Math.round(w.avgInterstitialTime),
            }));
            return (
              <div className="bg-gray-800 rounded-lg p-4">
                <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">Productive Ratio & Interstitial Trend</h3>
                <ResponsiveContainer width="100%" height={200}>
                  <LineChart data={trendData} margin={{ top: 5, right: 20, bottom: 20, left: 20 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                    <XAxis dataKey="week" stroke="#9ca3af" fontSize={11} />
                    <YAxis yAxisId="left" stroke="#22c55e" fontSize={11} unit="%" />
                    <YAxis yAxisId="right" orientation="right" stroke="#f97316" fontSize={11} unit="s" />
                    <Tooltip contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', color: '#fff' }} />
                    <Legend />
                    <Line yAxisId="left" type="monotone" dataKey="productiveRatio" stroke="#22c55e" strokeWidth={2} dot={{ r: 4 }} name="Productive %" />
                    <Line yAxisId="right" type="monotone" dataKey="interstitial" stroke="#f97316" strokeWidth={2} dot={{ r: 4 }} name="Avg Interstitial (s)" />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            );
          })()}

          {/* Deck Quality Trend */}
          {weeklyTrend.length > 1 && (() => {
            const deckData = weeklyTrend.map(w => ({
              week: w.weekLabel,
              rvuPerStudy: Math.round(w.avgRvuPerStudy * 100) / 100,
              studiesPerHour: Math.round(w.studiesPerHour * 10) / 10,
            }));
            return (
              <div className="bg-gray-800 rounded-lg p-4">
                <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">Deck Quality vs Throughput — Weekly Trend</h3>
                <p className="text-gray-500 text-xs mb-3">Separates "the deck was thin" from "I was slow."</p>
                <ResponsiveContainer width="100%" height={200}>
                  <LineChart data={deckData} margin={{ top: 5, right: 20, bottom: 20, left: 20 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                    <XAxis dataKey="week" stroke="#9ca3af" fontSize={11} />
                    <YAxis yAxisId="left" stroke="#3b82f6" fontSize={11} />
                    <YAxis yAxisId="right" orientation="right" stroke="#8b5cf6" fontSize={11} />
                    <Tooltip contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', color: '#fff' }} />
                    <Legend />
                    <Line yAxisId="left" type="monotone" dataKey="rvuPerStudy" stroke="#3b82f6" strokeWidth={2} dot={{ r: 4 }} name="wRVU/Study" />
                    <Line yAxisId="right" type="monotone" dataKey="studiesPerHour" stroke="#8b5cf6" strokeWidth={2} dot={{ r: 4 }} name="Studies/hr" />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            );
          })()}

          {/* Hourly Productivity Heatmap */}
          {Object.keys(summary.hourlyProfile).length > 0 && (() => {
            const hours = Object.entries(summary.hourlyProfile)
              .map(([hour, data]) => ({
                hour: `${Number(hour) % 12 || 12}${Number(hour) < 12 ? 'a' : 'p'}`,
                hourNum: Number(hour),
                studies: data.avgStudies,
                rvuPerStudy: data.avgStudies > 0 ? data.avgRvu / data.avgStudies : 0,
                sessions: data.sessionCount,
              }))
              .sort((a, b) => a.hourNum - b.hourNum);
            if (hours.length < 2) return null;
            return (
              <div className="bg-gray-800 rounded-lg p-4">
                <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">Hourly Productivity Profile</h3>
                <p className="text-gray-500 text-xs mb-3">Average across {summary.totalSessions} sessions. Identifies your peak and valley hours.</p>
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={hours} margin={{ top: 5, right: 20, bottom: 20, left: 20 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                    <XAxis dataKey="hour" stroke="#9ca3af" fontSize={11} />
                    <YAxis stroke="#9ca3af" fontSize={11} />
                    <Tooltip contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', color: '#fff' }} />
                    <Bar dataKey="studies" fill="#3b82f6" name="Avg Studies" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            );
          })()}

          {/* Day of week analysis */}
          {Object.keys(summary.sessionsByDayOfWeek).length > 0 && (
            <div className="bg-gray-800 rounded-lg p-4">
              <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">Day of Week Analysis</h3>
              <div className="grid grid-cols-7 gap-2 text-center text-xs">
                {['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map(day => {
                  const sessions = summary.sessionsByDayOfWeek[day] || 0;
                  const rvuHr = summary.avgRVUPerHourByDayOfWeek[day] || 0;
                  return (
                    <div key={day} className="bg-gray-700 rounded p-2">
                      <div className="text-gray-400 font-medium">{day.slice(0, 3)}</div>
                      <div className="text-white font-bold mt-1">{sessions}</div>
                      <div className="text-gray-500">sessions</div>
                      {rvuHr > 0 && <div className="text-blue-400 mt-1">{rvuHr.toFixed(2)} RVU/hr</div>}
                    </div>
                  );
                })}
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
            trendPoints={weeklyTrend.map(w => ({ label: w.weekLabel, rvuPerHourByModality: w.rvuPerHourByModality }))}
            trendLabel="Week"
            formatTime={formatTime}
          />

          {/* Rotation comparison */}
          {Object.keys(summary.sessionsByRotation).length > 1 && (
            <div className="bg-gray-800 rounded-lg p-4">
              <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">Rotation Comparison</h3>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-gray-400 border-b border-gray-700">
                    <th className="text-left py-2">Rotation</th>
                    <th className="text-right py-2">Sessions</th>
                    <th className="text-right py-2">Studies</th>
                    <th className="text-right py-2">RVU/hr</th>
                    <th className="text-right py-2">wRVU/Study</th>
                    <th className="text-right py-2">Studies/hr</th>
                    <th className="text-right py-2">Variance</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(summary.sessionsByRotation)
                    .sort(([, a], [, b]) => b - a)
                    .map(([rot, count]) => (
                      <tr key={rot} className="border-b border-gray-800 text-gray-300">
                        <td className="py-2">{rot}</td>
                        <td className="py-2 text-right">{count}</td>
                        <td className="py-2 text-right">{summary.studiesByRotation[rot] || 0}</td>
                        <td className="py-2 text-right">{(summary.rvuPerHourByRotation[rot] || 0).toFixed(2)}</td>
                        <td className="py-2 text-right">{(summary.avgRvuPerStudyByRotation[rot] || 0).toFixed(2)}</td>
                        <td className="py-2 text-right">{(summary.studiesPerHourByRotation[rot] || 0).toFixed(1)}</td>
                        <td className={`py-2 text-right ${(summary.avgVarianceByRotation[rot] || 0) <= 0 ? 'text-green-400' : 'text-red-400'}`}>
                          {Math.round(summary.avgVarianceByRotation[rot] || 0)}s
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}

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

          {/* Complication cost aggregated */}
          {Object.keys(summary.complicationCostAggregated).length > 0 && (
            <div className="bg-gray-800 rounded-lg p-4">
              <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">Complication Cost (Aggregated)</h3>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-gray-400 border-b border-gray-700">
                    <th className="text-left py-2">Complication</th>
                    <th className="text-right py-2">Avg Added</th>
                    <th className="text-right py-2">Par Allotment</th>
                    <th className="text-right py-2">Occurrences</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(summary.complicationCostAggregated).map(([comp, data]) => (
                    <tr key={comp} className="border-b border-gray-800 text-gray-300">
                      <td className="py-2">{comp}</td>
                      <td className="py-2 text-right">{Math.round(data.avgActualTimeAdded)}s</td>
                      <td className="py-2 text-right">{Math.round(data.parTimeAllotment)}s</td>
                      <td className="py-2 text-right">{data.totalOccurrences}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Tag frequency + correlated metrics */}
          {Object.keys(summary.tagFrequency).length > 0 && (
            <div className="bg-gray-800 rounded-lg p-4">
              <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">Tag Impact Analysis</h3>
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
                        <td className="py-2 text-right">{data.avgRVUPerHour.toFixed(2)}</td>
                        <td className={`py-2 text-right ${data.avgVariance <= 0 ? 'text-green-400' : 'text-red-400'}`}>
                          {Math.round(data.avgVariance)}s
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

          {/* Best session */}
          {summary.bestSession && (
            <div className="bg-gray-800 rounded-lg p-4">
              <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">Best Session</h3>
              <div className="grid grid-cols-3 gap-4 text-center">
                <div>
                  <div className="text-gray-400 text-xs">RVU/hr</div>
                  <div className="text-xl font-bold text-green-400">{summary.bestSession.rvuPerHour.toFixed(2)}</div>
                </div>
                <div>
                  <div className="text-gray-400 text-xs">Studies</div>
                  <div className="text-xl font-bold text-white">{summary.bestSession.studies}</div>
                </div>
                <div>
                  <div className="text-gray-400 text-xs">Productive %</div>
                  <div className="text-xl font-bold text-white">{(summary.bestSession.productiveRatio * 100).toFixed(2)}%</div>
                </div>
              </div>
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
                formatValue={(v) => `${(v * 100).toFixed(2)}%`}
              />
              {/* Weekly percentile trend (unique to monthly) */}
              {weeklyPercentileTrend && weeklyPercentileTrend.length > 1 && (
                <div style={{ backgroundColor: '#1f2937', borderRadius: 8, padding: 16 }}>
                  <div style={{ color: '#9ca3af', fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 12 }}>
                    Weekly GAR Percentile Trend
                  </div>
                  <div className="flex items-end gap-2 h-24">
                    {weeklyPercentileTrend.map((w, i) => (
                      <div key={i} className="flex-1 flex flex-col items-center">
                        <div className="text-xs mb-1" style={{ color: w.rvuPerHourPctile >= 50 ? '#22c55e' : '#f59e0b' }}>
                          {Math.round(w.rvuPerHourPctile)}%
                        </div>
                        <div
                          className="w-full rounded-t"
                          style={{
                            height: `${w.rvuPerHourPctile}%`,
                            backgroundColor: w.rvuPerHourPctile >= 75 ? '#22c55e' : w.rvuPerHourPctile >= 50 ? '#3b82f6' : w.rvuPerHourPctile >= 25 ? '#f59e0b' : '#ef4444',
                            minHeight: 4,
                          }}
                        />
                        <div className="text-xs text-gray-500 mt-1">{w.weekLabel}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="bg-gray-800 rounded-lg p-4 opacity-50">
              <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-2">GAR Percentile Trend</h3>
              <p className="text-gray-500 text-sm">Minimum 3 daily users required for group comparison</p>
            </div>
          )}
        </div>
      )}

      {/* PVC section — self-hides if PVC disabled for this system */}
      {userId && userSystem && (
        <PvcReportSection
          userId={userId}
          system={userSystem}
          sessions={sessions}
          dateRange={monthRange}
          periodType="monthly"
          periodLabel={format(currentDate, 'MMMM yyyy')}
        />
      )}

      {/* President section */}
      {role === 'president' && (
        <PresidentMonthlySection system={userSystem} dateRange={monthRange} formatTime={formatTime} />
      )}

      {/* Hospital Admin section */}
      {(role === 'hospitalAdmin' || role === 'president') && (
        <HospitalMonthlySection system={userSystem} dateRange={monthRange} />
      )}

      {/* IT section */}
      {(role === 'it' || role === 'president') && (
        <ITMonthlySection system={userSystem} dateRange={monthRange} />
      )}
    </div>
  );
}
