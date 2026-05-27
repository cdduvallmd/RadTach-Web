// Daily Report Tab — fetches full event data for all sessions in a day,
// combines them into a continuous timeline, and renders the full 21-section
// session report layout.

import { useState, useMemo, useEffect } from 'react';
import { useSessionData } from '../../hooks/useSessionData';
import { useGroupStats } from '../../hooks/useGroupStats';
import { aggregateSessions, getDayRange } from '../../utils/periodAggregation';
import { computeSessionSummary } from '../../utils/sessionSummary';
import { combineSessionEvents } from '../../utils/combineSessionEvents';
import { firestoreService } from '../../services/firestore';
import type { DateRange, DistributionStats, EffectiveRole } from '../../types/reports';
import type { SessionEvent } from './SessionReportSections';
import { addDays, subDays, format } from 'date-fns';
import SessionReportSections from './SessionReportSections';
import GARPercentileGauge from './shared/GARPercentileGauge';
import PresidentWeeklySection from './sections/PresidentWeeklySection';
import HospitalWeeklySection from './sections/HospitalWeeklySection';
import ITWeeklySection from './sections/ITWeeklySection';
import PvcReportSection from './sections/PvcReportSection';

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

  // Period aggregation (for GAR gauges and session table)
  const periodSummary = useMemo(
    () => sessions.length > 0 ? aggregateSessions(sessions, dayRange) : null,
    [sessions, dayRange]
  );

  // Fetch full events for all sessions in the day
  const [eventsLoading, setEventsLoading] = useState(false);
  const [combinedEvents, setCombinedEvents] = useState<SessionEvent[] | null>(null);
  const [combinedSessionData, setCombinedSessionData] = useState<import('./SessionReportSections').SessionData | null>(null);

  useEffect(() => {
    if (!userId || sessions.length === 0) {
      setCombinedEvents(null);
      setCombinedSessionData(null);
      return;
    }

    let cancelled = false;
    setEventsLoading(true);

    Promise.all(
      sessions.map(s => firestoreService.getSessionEvents(userId, s.sessionId))
    ).then(eventsPerSession => {
      if (cancelled) return;
      const { events, sessionData } = combineSessionEvents(
        sessions,
        eventsPerSession as SessionEvent[][]
      );
      setCombinedEvents(events);
      setCombinedSessionData(sessionData);
    }).catch(err => {
      if (!cancelled) console.error('Failed to fetch session events:', err);
    }).finally(() => {
      if (!cancelled) setEventsLoading(false);
    });

    return () => { cancelled = true; };
  }, [userId, sessions]);

  // Compute full session summary from combined events
  const fullSummary = useMemo(() => {
    if (!combinedEvents || !combinedSessionData) return null;
    return computeSessionSummary(combinedEvents, combinedSessionData.totalSessionTime, combinedSessionData.startDateTime);
  }, [combinedEvents, combinedSessionData]);

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

      {!loading && !error && sessions.length > 0 && (
        <div className="space-y-6">
          {/* Sessions breakdown (collapsible) */}
          {sessions.length > 1 && (
            <details className="bg-gray-800 rounded-lg">
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
                            <td className="py-1.5 pr-3 text-right text-white">{s.totalRVU.toFixed(2)}</td>
                            <td className="py-1.5 pr-3 text-right text-white">{rvuHr.toFixed(2)}</td>
                            <td className="py-1.5 text-right text-white">{formatTime(s.totalSessionTime)}</td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              </div>
            </details>
          )}

          {/* Full session report from combined events */}
          {eventsLoading && (
            <div className="flex items-center justify-center py-8">
              <div className="w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
              <span className="ml-3 text-gray-400">Loading event data...</span>
            </div>
          )}

          {!eventsLoading && combinedEvents && combinedSessionData && fullSummary && (
            <SessionReportSections
              sessionEvents={combinedEvents}
              sessionData={combinedSessionData}
              summary={fullSummary}
              formatTime={formatTime}
            />
          )}

          {/* GAR Percentile Gauges */}
          {garAvg && periodSummary && (
            <div className="bg-gray-800 rounded-lg p-4">
              <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">Group Percentile (GAR)</h3>
              <div className="grid grid-cols-2 gap-6">
                <GARPercentileGauge
                  label="RVU/hr"
                  userValue={periodSummary.avgRVUPerHour}
                  distribution={garAvg.rvuPerHour}
                />
                <GARPercentileGauge
                  label="Productive Ratio"
                  userValue={periodSummary.avgProductiveRatio}
                  distribution={garAvg.productiveRatio}
                  formatValue={v => `${(v * 100).toFixed(2)}%`}
                />
              </div>
            </div>
          )}

          {/* PVC section — self-hides if PVC disabled */}
          {userId && userSystem && (
            <PvcReportSection
              userId={userId}
              system={userSystem}
              sessions={sessions}
              dateRange={dayRange}
              periodType="daily"
              periodLabel={format(currentDate, 'EEEE, MMMM d, yyyy')}
            />
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
