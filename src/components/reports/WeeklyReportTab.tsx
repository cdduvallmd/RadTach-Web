// Phase 2: Weekly Report Tab — User (Radiologist) view
// Will be built with full metrics in Phase 2

import { useState, useMemo } from 'react';
import { useSessionData } from '../../hooks/useSessionData';
import { useGroupStats } from '../../hooks/useGroupStats';
import { aggregateSessions, getWeekRange } from '../../utils/periodAggregation';
import type { DateRange, DistributionStats, EffectiveRole } from '../../types/reports';
import { addWeeks, subWeeks, format } from 'date-fns';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import GARPercentileGauge from './shared/GARPercentileGauge';
import PresidentWeeklySection from './sections/PresidentWeeklySection';
import HospitalWeeklySection from './sections/HospitalWeeklySection';
import ITWeeklySection from './sections/ITWeeklySection';

interface WeeklyReportTabProps {
  userId: string | null;
  userSystem: string | null;
  formatTime: (seconds: number) => string;
  role?: EffectiveRole;
  dateRange?: DateRange;  // When provided externally (by RCP), overrides internal nav
}

export default function WeeklyReportTab({ userId, userSystem, formatTime, role = 'radiologist', dateRange: externalRange }: WeeklyReportTabProps) {
  const [currentDate, setCurrentDate] = useState(new Date());
  const internalRange: DateRange = useMemo(() => getWeekRange(currentDate, 'monday'), [currentDate]);
  const weekRange = externalRange ?? internalRange;
  const externallyControlled = !!externalRange;
  const { sessions, loading, error } = useSessionData(userId, weekRange);
  const { garDays } = useGroupStats(userSystem, weekRange);
  const summary = useMemo(
    () => sessions.length > 0 ? aggregateSessions(sessions, weekRange) : null,
    [sessions, weekRange]
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

  const navigateWeek = (direction: -1 | 1) => {
    setCurrentDate(prev => direction === -1 ? subWeeks(prev, 1) : addWeeks(prev, 1));
  };

  return (
    <div className="space-y-6">
      {/* Period navigation (hidden when RCP controls the date) */}
      {!externallyControlled && (
        <div className="flex items-center justify-between bg-gray-800 rounded-lg p-4">
          <button onClick={() => navigateWeek(-1)} className="text-gray-400 hover:text-white text-xl px-3">&#8592;</button>
          <div className="text-center">
            <div className="text-sm text-gray-400">Weekly Report</div>
            <div className="text-white font-medium">
              {format(weekRange.start, 'MMM d')} &ndash; {format(weekRange.end, 'MMM d, yyyy')}
            </div>
            {userSystem && <div className="text-xs text-gray-500">{userSystem}</div>}
          </div>
          <button onClick={() => navigateWeek(1)} className="text-gray-400 hover:text-white text-xl px-3">&#8594;</button>
        </div>
      )}

      {/* Loading / Error / Empty states */}
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
            <p className="text-gray-500 text-lg">No sessions found for this week</p>
            <p className="text-gray-600 text-sm mt-1">Navigate to a different week or complete some sessions first</p>
          </div>
        </div>
      )}

      {!loading && !error && summary && (
        <div className="space-y-6">
          {/* Diagnostic: Sessions Included (collapsible) */}
          <details className="bg-gray-800 rounded-lg">
            <summary className="cursor-pointer p-4 text-sm font-semibold text-gray-400 uppercase tracking-wider hover:text-gray-300 select-none">
              Sessions Included ({sessions.length})
            </summary>
            <div className="px-4 pb-4">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-gray-500 text-xs uppercase tracking-wider border-b border-gray-700">
                    <th className="text-left py-2 pr-3">Session ID</th>
                    <th className="text-left py-2 pr-3">Date</th>
                    <th className="text-left py-2 pr-3">System / Office</th>
                    <th className="text-right py-2 pr-3">Studies</th>
                    <th className="text-right py-2 pr-3">RVU</th>
                    <th className="text-right py-2">Verified</th>
                  </tr>
                </thead>
                <tbody>
                  {sessions
                    .slice()
                    .sort((a, b) => new Date(a.startDateTime).getTime() - new Date(b.startDateTime).getTime())
                    .map((s) => {
                      const dt = new Date(s.startDateTime);
                      const dateStr = dt.toLocaleDateString('en-US', {
                        weekday: 'short', month: 'numeric', day: 'numeric',
                      });
                      const timeStr = dt.toLocaleTimeString('en-US', {
                        hour: 'numeric', minute: '2-digit', hour12: true,
                      });
                      return (
                        <tr key={s.id} className="border-b border-gray-700/50 text-gray-300">
                          <td className="py-1.5 pr-3 font-mono text-xs text-gray-500">{s.sessionId}</td>
                          <td className="py-1.5 pr-3">{dateStr} {timeStr}</td>
                          <td className="py-1.5 pr-3">{s.system}{s.workstationId ? ` / ${s.workstationId}` : ''}</td>
                          <td className="py-1.5 pr-3 text-right text-white">{s.studiesCompleted}</td>
                          <td className="py-1.5 pr-3 text-right text-white">{s.totalRVU.toFixed(2)}</td>
                          <td className="py-1.5 text-right text-white">{s.verifiedRVU != null ? s.verifiedRVU.toFixed(2) : '—'}</td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          </details>

          {/* Summary cards */}
          <div className="grid grid-cols-4 gap-4">
            <div className="bg-gray-800 rounded-lg p-4 text-center">
              <div className="text-gray-400 text-xs mb-1">Sessions</div>
              <div className="text-2xl font-bold text-white">{summary.totalSessions}</div>
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
              <div className="text-gray-400 text-xs mb-1">Avg Breaks/Session</div>
              <div className="text-2xl font-bold text-white">{summary.avgBreaksPerSession.toFixed(2)}</div>
            </div>
          </div>

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

          {/* Modality mix */}
          {Object.keys(summary.studiesByModality).length > 0 && (
            <div className="bg-gray-800 rounded-lg p-4">
              <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">Studies by Modality</h3>
              <div className="space-y-2">
                {Object.entries(summary.studiesByModality)
                  .sort(([, a], [, b]) => b - a)
                  .map(([mod, count]) => (
                    <div key={mod} className="flex items-center gap-3">
                      <div className="w-12 text-gray-400 text-sm">{mod}</div>
                      <div className="flex-1 bg-gray-700 rounded h-4 overflow-hidden">
                        <div
                          className="h-full rounded"
                          style={{
                            width: `${(count / summary.totalStudies) * 100}%`,
                            backgroundColor: '#3b82f6',
                          }}
                        />
                      </div>
                      <div className="text-white text-sm w-8 text-right">{count}</div>
                    </div>
                  ))}
              </div>
            </div>
          )}

          {/* RVU/hr by Modality */}
          {Object.keys(summary.rvuPerHourByModality).length > 0 && (
            <div className="bg-gray-800 rounded-lg p-4">
              <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">RVU/hr by Modality</h3>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-gray-500 text-xs uppercase tracking-wider border-b border-gray-700">
                    <th className="text-left py-2">Modality</th>
                    <th className="text-right py-2">Studies</th>
                    <th className="text-right py-2">RVU/hr</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(summary.rvuPerHourByModality)
                    .sort(([, a], [, b]) => b - a)
                    .map(([mod, rate]) => (
                      <tr key={mod} className="border-b border-gray-700/50 text-gray-300">
                        <td className="py-1.5">{mod}</td>
                        <td className="py-1.5 text-right">{summary.studiesByModality[mod] || 0}</td>
                        <td className="py-1.5 text-right text-white font-medium">{rate.toFixed(2)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Deck Quality Decomposition */}
          <div className="bg-gray-800 rounded-lg p-4">
            <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">Deck Quality vs Throughput</h3>
            <p className="text-gray-500 text-xs mb-3">RVU/hr = (wRVU/Study) × (Studies/hr). Separates deck quality from reading speed.</p>
            <div className="grid grid-cols-2 gap-4 text-center">
              <div className="bg-gray-700/50 rounded-lg p-3">
                <div className="text-gray-400 text-xs mb-1">wRVU/Study (Deck Quality)</div>
                <div className="text-2xl font-bold text-white">{summary.avgRvuPerStudy.toFixed(2)}</div>
              </div>
              <div className="bg-gray-700/50 rounded-lg p-3">
                <div className="text-gray-400 text-xs mb-1">Studies/hr (Throughput)</div>
                <div className="text-2xl font-bold text-white">{summary.avgStudiesPerHour.toFixed(1)}</div>
              </div>
            </div>
          </div>

          {/* Fastest/Slowest CPTs */}
          {(summary.fastestCpts.length > 0 || summary.slowestCpts.length > 0) && (
            <div className="bg-gray-800 rounded-lg p-4">
              <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">Fastest & Slowest Studies</h3>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <h4 className="text-green-400 text-xs font-semibold mb-2">Fastest (vs Par)</h4>
                  {summary.fastestCpts.map(c => (
                    <div key={c.cpt} className="flex justify-between text-sm py-0.5">
                      <span className="text-gray-300">{c.cpt} <span className="text-gray-500 text-xs">({c.totalCount})</span></span>
                      <span className="text-green-400">{Math.round(c.avgVariance)}s</span>
                    </div>
                  ))}
                </div>
                <div>
                  <h4 className="text-red-400 text-xs font-semibold mb-2">Slowest (vs Par)</h4>
                  {summary.slowestCpts.map(c => (
                    <div key={c.cpt} className="flex justify-between text-sm py-0.5">
                      <span className="text-gray-300">{c.cpt} <span className="text-gray-500 text-xs">({c.totalCount})</span></span>
                      <span className="text-red-400">+{Math.round(c.avgVariance)}s</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Hourly Productivity Profile */}
          {Object.keys(summary.hourlyProfile).length > 0 && (() => {
            const hours = Object.entries(summary.hourlyProfile)
              .map(([hour, data]) => ({ hour: `${Number(hour) % 12 || 12}${Number(hour) < 12 ? 'a' : 'p'}`, studies: data.avgStudies, rvuPerStudy: data.avgStudies > 0 ? data.avgRvu / data.avgStudies : 0, sessions: data.sessionCount }))
              .sort((a, b) => a.hour.localeCompare(b.hour));
            if (hours.length < 2) return null;
            return (
              <div className="bg-gray-800 rounded-lg p-4">
                <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">Hourly Productivity Profile</h3>
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

          {/* Warmup Cost */}
          {summary.avgWarmupCost !== null && (
            <div className="bg-gray-800 rounded-lg p-4">
              <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">First-Study Warmup</h3>
              <div className="text-center">
                <div className={`text-2xl font-bold ${summary.avgWarmupCost > 0 ? 'text-yellow-400' : 'text-green-400'}`}>
                  {summary.avgWarmupCost > 0 ? '+' : ''}{Math.round(summary.avgWarmupCost)}s
                </div>
                <div className="text-gray-500 text-xs mt-1">First study vs average of studies #2-5</div>
              </div>
            </div>
          )}

          {/* Tag frequency */}
          {Object.keys(summary.tagFrequency).length > 0 && (
            <div className="bg-gray-800 rounded-lg p-4">
              <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">Session Tags</h3>
              <div className="flex flex-wrap gap-2">
                {Object.entries(summary.tagFrequency)
                  .sort(([, a], [, b]) => b - a)
                  .map(([tag, count]) => {
                    const TAG_COLORS: Record<string, string> = {
                      'Good Day': '#22c55e',
                      'Not Feeling It Today': '#f59e0b',
                      'Network & Application Interference': '#ef4444',
                      'Low Volume = Low Productivity': '#8b5cf6',
                      'Real World Intrusion': '#f97316',
                      'High Volume': '#3b82f6',
                      'Short Staffed': '#ec4899',
                    };
                    return (
                      <span
                        key={tag}
                        className="px-3 py-1 rounded-full text-xs font-medium text-white"
                        style={{ backgroundColor: TAG_COLORS[tag] || '#6b7280' }}
                      >
                        {tag} ({count})
                      </span>
                    );
                  })}
              </div>
            </div>
          )}

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

          {/* RVU/hr by session trend */}
          {summary.sessionDataPoints.length > 1 && (
            <div className="bg-gray-800 rounded-lg p-4">
              <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">RVU/hr by Session</h3>
              <div className="flex items-end gap-1 h-24">
                {summary.sessionDataPoints.map((dp, i) => {
                  const maxRVU = Math.max(...summary.sessionDataPoints.map(d => d.rvuPerHour), 1);
                  const height = (dp.rvuPerHour / maxRVU) * 100;
                  const dateStr = (() => { try { const d = new Date(dp.date); return d.toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' }) + ' ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }); } catch { return ''; } })();
                  return (
                    <div
                      key={i}
                      className="flex-1 rounded-t"
                      style={{ height: `${height}%`, backgroundColor: '#3b82f6', minWidth: 4 }}
                      title={`${dp.rvuPerHour.toFixed(2)} RVU/hr\n${dateStr}\n${dp.rotation} · ${dp.office}\n${dp.studies} studies · ${dp.totalRVU.toFixed(2)} RVU`}
                    />
                  );
                })}
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
        <PresidentWeeklySection system={userSystem} dateRange={weekRange} formatTime={formatTime} />
      )}

      {/* Hospital Admin section */}
      {(role === 'hospitalAdmin' || role === 'president') && (
        <HospitalWeeklySection system={userSystem} dateRange={weekRange} />
      )}

      {/* IT section */}
      {(role === 'it' || role === 'president') && (
        <ITWeeklySection system={userSystem} dateRange={weekRange} />
      )}
    </div>
  );
}
