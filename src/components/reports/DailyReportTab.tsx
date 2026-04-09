// Daily Report Tab — aggregates all sessions from a single calendar day
// Similar structure to WeeklyReportTab with per-session breakdown + daily totals

import { useState, useMemo } from 'react';
import { useSessionData } from '../../hooks/useSessionData';
import { useGroupStats } from '../../hooks/useGroupStats';
import { aggregateSessions, getDayRange } from '../../utils/periodAggregation';
import type { DateRange, DistributionStats, EffectiveRole } from '../../types/reports';
import { addDays, subDays, format } from 'date-fns';
import GARPercentileGauge from './shared/GARPercentileGauge';
import PresidentWeeklySection from './sections/PresidentWeeklySection';
import HospitalWeeklySection from './sections/HospitalWeeklySection';
import ITWeeklySection from './sections/ITWeeklySection';

interface DailyReportTabProps {
  userId: string | null;
  userSystem: string | null;
  formatTime: (seconds: number) => string;
  role?: EffectiveRole;
  dateRange?: DateRange;
}

export default function DailyReportTab({ userId, userSystem, formatTime, role = 'radiologist', dateRange: externalRange }: DailyReportTabProps) {
  const [currentDate, setCurrentDate] = useState(new Date());
  const internalRange: DateRange = useMemo(() => getDayRange(currentDate), [currentDate]);
  const dayRange = externalRange ?? internalRange;
  const externallyControlled = !!externalRange;
  const { sessions, loading, error } = useSessionData(userId, dayRange);
  const { garDays } = useGroupStats(userSystem, dayRange);
  const summary = useMemo(
    () => sessions.length > 0 ? aggregateSessions(sessions, dayRange) : null,
    [sessions, dayRange]
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

  const navigateDay = (direction: -1 | 1) => {
    setCurrentDate(prev => direction === -1 ? subDays(prev, 1) : addDays(prev, 1));
  };

  return (
    <div className="space-y-6">
      {/* Period navigation (hidden when RCP controls the date) */}
      {!externallyControlled && (
        <div className="flex items-center justify-between bg-gray-800 rounded-lg p-4">
          <button onClick={() => navigateDay(-1)} className="text-gray-400 hover:text-white text-xl px-3">&#8592;</button>
          <div className="text-center">
            <div className="text-sm text-gray-400">Daily Report</div>
            <div className="text-white font-medium">{format(currentDate, 'EEEE, MMMM d, yyyy')}</div>
            {userSystem && <div className="text-xs text-gray-500">{userSystem}</div>}
          </div>
          <button onClick={() => navigateDay(1)} className="text-gray-400 hover:text-white text-xl px-3">&#8594;</button>
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
            <p className="text-gray-500 text-lg">No sessions found for this day</p>
            <p className="text-gray-600 text-sm mt-1">Navigate to a different day or complete some sessions first</p>
          </div>
        </div>
      )}

      {!loading && !error && summary && (
        <div className="space-y-6">
          {/* Sessions breakdown */}
          <details className="bg-gray-800 rounded-lg" open>
            <summary className="cursor-pointer p-4 text-sm font-semibold text-gray-400 uppercase tracking-wider hover:text-gray-300 select-none">
              Sessions ({sessions.length})
            </summary>
            <div className="px-4 pb-4">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-gray-500 text-xs uppercase tracking-wider border-b border-gray-700">
                    <th className="text-left py-2 pr-3">Session ID</th>
                    <th className="text-left py-2 pr-3">Time</th>
                    <th className="text-left py-2 pr-3">Rotation</th>
                    <th className="text-right py-2 pr-3">Studies</th>
                    <th className="text-right py-2 pr-3">RVU</th>
                    <th className="text-right py-2 pr-3">RVU/hr</th>
                    <th className="text-right py-2">Duration</th>
                  </tr>
                </thead>
                <tbody>
                  {sessions
                    .slice()
                    .sort((a, b) => new Date(a.startDateTime).getTime() - new Date(b.startDateTime).getTime())
                    .map(s => {
                      const start = new Date(s.startDateTime);
                      const hours = (s.totalSessionTime - s.breakTime) / 3600;
                      const rvuHr = hours > 0 ? s.totalRVU / hours : 0;
                      return (
                        <tr key={s.id} className="border-b border-gray-700/50 text-gray-300">
                          <td className="py-1.5 pr-3 font-mono text-xs text-gray-500">{s.sessionId}</td>
                          <td className="py-1.5 pr-3">
                            {start.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}
                          </td>
                          <td className="py-1.5 pr-3">{s.rotation || '—'}</td>
                          <td className="py-1.5 pr-3 text-right text-white">{s.studiesCompleted}</td>
                          <td className="py-1.5 pr-3 text-right text-white">{s.totalRVU.toFixed(1)}</td>
                          <td className="py-1.5 pr-3 text-right text-white">{rvuHr.toFixed(1)}</td>
                          <td className="py-1.5 text-right text-white">{formatTime(s.totalSessionTime)}</td>
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
              <div className="text-2xl font-bold text-white">{summary.totalRVU.toFixed(1)}</div>
            </div>
            <div className="bg-gray-800 rounded-lg p-4 text-center">
              <div className="text-gray-400 text-xs mb-1">Avg RVU/hr</div>
              <div className="text-2xl font-bold text-white">{summary.avgRVUPerHour.toFixed(1)}</div>
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
              <div className="text-2xl font-bold text-white">{(summary.avgProductiveRatio * 100).toFixed(1)}%</div>
            </div>
            <div className="bg-gray-800 rounded-lg p-4 text-center">
              <div className="text-gray-400 text-xs mb-1">Total Time</div>
              <div className="text-2xl font-bold text-white">{formatTime(summary.totalStudyTime + summary.totalInterstitialTime + summary.totalAdminTime + summary.totalCommsTime + summary.totalBreakTime + summary.totalDoubleTapTime)}</div>
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

          {/* Session tags */}
          {Object.keys(summary.tagFrequency).length > 0 && (
            <div className="bg-gray-800 rounded-lg p-4">
              <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">Session Tags</h3>
              <div className="flex flex-wrap gap-2">
                {Object.entries(summary.tagFrequency)
                  .sort(([, a], [, b]) => b - a)
                  .map(([tag, count]) => (
                    <span key={tag} className="px-2 py-1 bg-gray-700 text-gray-300 rounded text-xs">
                      {tag} ({count})
                    </span>
                  ))}
              </div>
            </div>
          )}

          {/* GAR Percentile Gauges */}
          {garAvg && summary && (
            <div className="bg-gray-800 rounded-lg p-4">
              <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">Group Percentile (GAR)</h3>
              <div className="grid grid-cols-2 gap-6">
                <GARPercentileGauge
                  label="RVU/hr"
                  userValue={summary.avgRVUPerHour}
                  distribution={garAvg.rvuPerHour}
                />
                <GARPercentileGauge
                  label="Productive Ratio"
                  userValue={summary.avgProductiveRatio}
                  distribution={garAvg.productiveRatio}
                  formatValue={v => `${(v * 100).toFixed(1)}%`}
                />
              </div>
            </div>
          )}

          {/* Role-specific sections */}
          {(role === 'president') && userSystem && (
            <PresidentWeeklySection system={userSystem} dateRange={dayRange} formatTime={formatTime} />
          )}
          {(role === 'hospitalAdmin' || role === 'president') && userSystem && (
            <HospitalWeeklySection system={userSystem} dateRange={dayRange} />
          )}
          {(role === 'it' || role === 'president') && userSystem && (
            <ITWeeklySection system={userSystem} dateRange={dayRange} />
          )}
        </div>
      )}
    </div>
  );
}
