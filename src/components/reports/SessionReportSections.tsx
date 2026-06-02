/**
 * SessionReportSections — Renders all 21 session report sections.
 * Extracted from Reports.tsx so it can be reused in DailyReportTab (combined events).
 */
import { useState } from 'react';
import {
  Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, BarChart, PieChart, Pie, Cell, LineChart,
  ReferenceLine
} from 'recharts';
import type { SessionSummary } from '../../utils/sessionSummary';

// ── Types (mirrored from Reports.tsx) ────────────────────────────────────────

export interface StudyEvent {
  type: 'STUDY';
  studyNumber: number;
  startTimeSession: number;
  startTimeSystem: string;
  modality: string;
  complications: string[];
  parTime: number;
  elapsedTime: number;
  variance: number;
  rvu: number;
  pauseTime: number;
  pauseUsed: boolean;
  drafted: boolean;
  swapped?: boolean;
  rvuDerivedMode?: boolean;
  targetRvuPerHour?: number;
}

export interface InterstitialEvent {
  type: 'INTERSTITIAL';
  startTimeSession: number;
  startTimeSystem: string;
  endTimeSession: number;
  endTimeSystem: string;
  duration: number;
}

export interface TimerEvent {
  type: 'ADMIN' | 'COMMS' | 'BREAK' | 'DOUBLE_TAP';
  startTimeSession: number;
  startTimeSystem: string;
  endTimeSession: number;
  endTimeSystem: string;
  duration: number;
  associatedModality?: string | null;
}

export type SessionEvent = StudyEvent | InterstitialEvent | TimerEvent;

export interface SessionNotes {
  tags: string[];
  description: string;
}

export interface SessionData {
  sessionId: string;
  userAbbrev: string;
  workstationId: string;
  system: string;
  rotation: string;
  halfDay: boolean;
  startDateTime: string;
  stopDateTime: string;
  totalSessionTime: number;
  studiesCompleted: number;
  deletedStudies: number;
  cumulativeParTime: number;
  interstitialTime: number;
  adminTime: number;
  adminEvents: number;
  commsTime: number;
  commsEvents: number;
  breakTime: number;
  breakEvents: number;
  doubleTapTime: number;
  doubleTapEvents: number;
  swapEvents?: number;
  totalRVU: number;
  verifiedRVU?: number | null;
  notes?: SessionNotes;
}

// ── Props ────────────────────────────────────────────────────────────────────

interface Props {
  sessionEvents: SessionEvent[];
  sessionData: SessionData | null;
  summary: SessionSummary | null;
  formatTime: (seconds: number) => string;
}

// ── Constants ────────────────────────────────────────────────────────────────

const PIE_COLORS = ['#22c55e', '#6b7280', '#f97316', '#06b6d4', '#ec4899', '#eab308'];

const MODALITY_COLORS: Record<string, string> = {
  'XR': '#3b82f6',
  'FL': '#8b5cf6',
  'CT': '#22c55e',
  'US': '#06b6d4',
  'MR': '#f97316',
  'NM': '#ec4899',
  'MA': '#eab308',
  'PET-CT': '#ef4444',
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatMinSec(seconds: number): string {
  const absS = Math.abs(seconds);
  const m = Math.floor(absS / 60);
  const s = Math.round(absS % 60);
  const sign = seconds < 0 ? '-' : seconds > 0 ? '+' : '';
  return `${sign}${m}:${String(s).padStart(2, '0')}`;
}

function formatDayFromISO(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-US', { weekday: 'long' });
  } catch { return ''; }
}

function formatDateFromISO(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
  } catch { return ''; }
}

function formatTimeFromISO(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  } catch { return ''; }
}

// ── Component ────────────────────────────────────────────────────────────────

export default function SessionReportSections({ sessionEvents, sessionData, summary, formatTime }: Props) {
  const studies = sessionEvents.filter((e): e is StudyEvent => e.type === 'STUDY');
  const nonStudyEvents = sessionEvents.filter(
    (e): e is TimerEvent | InterstitialEvent => e.type !== 'STUDY'
  );

  const eventCounts = sessionEvents.reduce<Record<string, number>>((acc, e) => {
    acc[e.type] = (acc[e.type] || 0) + 1;
    return acc;
  }, {});

  // Filmstrip state
  const [hoveredBar, setHoveredBar] = useState<{ x: number; y: number; lines: string[] } | null>(null);
  const [filmstripExpanded, setFilmstripExpanded] = useState(false);

  // ── Header ──────────────────────────────────────────────────────────────

  const renderHeader = () => {
    if (!sessionData) return null;
    return (
      <div className="report-header mb-6 bg-gray-800 rounded-lg p-4">
        <div className="grid grid-cols-4 gap-x-6 gap-y-2 text-sm">
          <div>
            <span className="text-gray-400">Day: </span>
            <span className="text-white font-medium">{formatDayFromISO(sessionData.startDateTime)}</span>
          </div>
          <div>
            <span className="text-gray-400">Date: </span>
            <span className="text-white font-medium">{formatDateFromISO(sessionData.startDateTime)}</span>
          </div>
          <div>
            <span className="text-gray-400">System: </span>
            <span className="text-white font-medium">{sessionData.system}</span>
          </div>
          <div>
            <span className="text-gray-400">Rotation: </span>
            <span className="text-white font-medium">{sessionData.rotation}</span>
          </div>
          <div>
            <span className="text-gray-400">Location: </span>
            <span className="text-white font-medium">{sessionData.workstationId}</span>
          </div>
          <div>
            <span className="text-gray-400">Start: </span>
            <span className="text-white font-medium">{formatTimeFromISO(sessionData.startDateTime)}</span>
          </div>
          <div>
            <span className="text-gray-400">Stop: </span>
            <span className="text-white font-medium">{formatTimeFromISO(sessionData.stopDateTime)}</span>
          </div>
          <div>
            <span className="text-gray-400">Total: </span>
            <span className="text-white font-medium">{formatTime(sessionData.totalSessionTime)}</span>
          </div>
          {sessionData.halfDay && (
            <div className="col-span-4">
              <span className="text-yellow-400 font-medium">Half Day</span>
            </div>
          )}
        </div>

        {/* Par Time Mode */}
        {summary && (() => {
          const ds = summary.rvuDerivedSummary;
          if (ds && ds.studiesInDerivedMode > 0) {
            const isMixed = ds.studiesInDerivedMode < ds.totalStudies;
            return (
              <div className="mt-2 px-1 text-sm">
                <span className="text-gray-400">Par Mode: </span>
                <span className="text-cyan-400 font-medium">
                  RVU/hr{isMixed ? ` (${ds.studiesInDerivedMode}/${ds.totalStudies} studies)` : ''}
                </span>
                <span className="text-gray-500 mx-2">|</span>
                <span className="text-gray-400">Target: </span>
                <span className="text-white font-medium">{ds.targetRvuPerHour} RVU/hr</span>
                <span className="text-gray-500 mx-2">|</span>
                <span className="text-gray-400">Achieved: </span>
                <span className={`font-medium ${ds.achievedRvuPerHour >= ds.targetRvuPerHour ? 'text-green-400' : 'text-yellow-400'}`}>
                  {ds.achievedRvuPerHour.toFixed(2)} RVU/hr
                </span>
              </div>
            );
          }
          return (
            <div className="mt-2 px-1 text-sm">
              <span className="text-gray-400">Par Mode: </span>
              <span className="text-white font-medium">Default</span>
            </div>
          );
        })()}

        {/* Event diagnostic */}
        <div className="mt-3 px-1 text-xs text-gray-500 font-mono">
          Events: {eventCounts['STUDY'] || 0} study, {eventCounts['INTERSTITIAL'] || 0} interstitial, {eventCounts['ADMIN'] || 0} admin, {eventCounts['COMMS'] || 0} comms, {eventCounts['BREAK'] || 0} break, {eventCounts['DOUBLE_TAP'] || 0} dbl-tap, {studies.filter(s => s.swapped).length} swap
        </div>

        {/* Session Summary Stats */}
        {(() => {
          const interstitials = sessionEvents
            .filter((e): e is InterstitialEvent => e.type === 'INTERSTITIAL')
            .map(e => e.duration);
          const avgInterstitial = interstitials.length > 0
            ? interstitials.reduce((a, b) => a + b, 0) / interstitials.length
            : 0;
          const sorted = interstitials.slice().sort((a, b) => a - b);
          const lowest5 = sorted.slice(0, Math.min(5, sorted.length));
          const avgLowest5 = lowest5.length > 0
            ? lowest5.reduce((a, b) => a + b, 0) / lowest5.length
            : 0;
          return (
            <div className={`mt-4 grid gap-3 ${sessionData.verifiedRVU != null ? 'grid-cols-6' : 'grid-cols-5'}`}>
              <div className="bg-gray-700/50 rounded-lg p-3 text-center">
                <div className="text-gray-400 text-xs mb-1">Total Studies</div>
                <div className="text-xl font-bold text-white">{sessionData.studiesCompleted}</div>
              </div>
              <div className="bg-gray-700/50 rounded-lg p-3 text-center">
                <div className="text-gray-400 text-xs mb-1">Total Time</div>
                <div className="text-xl font-bold text-white">{formatTime(sessionData.totalSessionTime)}</div>
              </div>
              <div className="bg-gray-700/50 rounded-lg p-3 text-center">
                <div className="text-gray-400 text-xs mb-1">Total RVU</div>
                <div className="text-xl font-bold text-white">{sessionData.totalRVU.toFixed(2)}</div>
              </div>
              {sessionData.verifiedRVU != null && (
                <div className="bg-gray-700/50 rounded-lg p-3 text-center">
                  <div className="text-gray-400 text-xs mb-1">Verified RVU</div>
                  <div className="text-xl font-bold text-green-400">{sessionData.verifiedRVU.toFixed(2)}</div>
                </div>
              )}
              <div className="bg-gray-700/50 rounded-lg p-3 text-center">
                <div className="text-gray-400 text-xs mb-1">Avg Interstitial</div>
                <div className="text-xl font-bold text-white">{formatTime(Math.round(avgInterstitial))}</div>
              </div>
              <div className="bg-gray-700/50 rounded-lg p-3 text-center">
                <div className="text-gray-400 text-xs mb-1">Avg Fastest 5</div>
                <div className="text-xl font-bold text-white">{lowest5.length > 0 ? formatTime(Math.round(avgLowest5)) : '—'}</div>
              </div>
            </div>
          );
        })()}

        {/* RVU Disclaimer */}
        <div className="rvu-disclaimer mt-4 p-3 bg-yellow-900/30 border border-yellow-700/50 rounded text-xs text-yellow-200">
          {sessionData.verifiedRVU != null ? (
            <>
              <strong>RadTach RVU: {sessionData.totalRVU.toFixed(2)} | Verified RVU: {sessionData.verifiedRVU.toFixed(2)}</strong> (from Epic/Medicalis). RadTach RVU values are estimates based on modality and complication selections. Use for trend analysis and relative comparison only.
            </>
          ) : (
            <>
              <strong>RVU values are estimates</strong> based on modality and complication selections. Actual RVUs (per Epic/Medicalis) are typically 10-20% higher. Use for trend analysis and relative comparison only, not for financial reporting or contract compliance.
            </>
          )}
        </div>
      </div>
    );
  };

  // ── Session Notes ───────────────────────────────────────────────────────

  const renderSessionNotes = () => {
    if (!sessionData?.notes) return null;
    const { tags, description } = sessionData.notes;
    const hasContent = (tags.length > 0 && !(tags.length === 1 && tags[0] === 'No Comment')) || description;
    if (!hasContent) return null;

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
      <div className="session-notes bg-gray-800 rounded-lg p-4 mb-6">
        <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">Session Notes</h3>
        <div className="flex flex-wrap gap-2 mb-2">
          {tags.filter(t => t !== 'No Comment').map(tag => (
            <span key={tag} className="px-3 py-1 rounded-full text-xs font-medium text-white" style={{ backgroundColor: TAG_COLORS[tag] || '#6b7280' }}>
              {tag}
            </span>
          ))}
        </div>
        {description && description !== '(none)' && (
          <p className="text-gray-300 text-sm mt-2 whitespace-pre-wrap">{description}</p>
        )}
      </div>
    );
  };

  // ── 6A: Filmstrip Timeline ──────────────────────────────────────────────

  const renderFilmstrip = () => {
    if (studies.length === 0) return <div className="text-gray-500 text-center py-4">No studies recorded</div>;

    const BELOW_AXIS_HEIGHT = 28;
    const PAR_TICK_HEIGHT = 6;
    const SVG_HEIGHT = 300;
    const MARGIN = { top: 20, right: 20, bottom: 40, left: 60 };
    const chartHeight = SVG_HEIGHT - MARGIN.top - MARGIN.bottom;

    const totalSessionMin = sessionData
      ? sessionData.totalSessionTime / 60
      : Math.max(...studies.map(s => (s.startTimeSession + s.elapsedTime) / 60), 1);

    const CONTAINER_WIDTH = 900;
    const pxPerMin = filmstripExpanded ? 12 : Math.max(CONTAINER_WIDTH / totalSessionMin, 1);
    const svgWidth = Math.max(MARGIN.left + MARGIN.right + totalSessionMin * pxPerMin, 400);
    const chartWidth = svgWidth - MARGIN.left - MARGIN.right;

    const xScale = (min: number) => MARGIN.left + (min / totalSessionMin) * chartWidth;
    const maxRvu = Math.max(...studies.map(s => s.rvu), 0.2) * 1.15;
    const belowFraction = (BELOW_AXIS_HEIGHT + PAR_TICK_HEIGHT) / chartHeight;
    const aboveFraction = 1 - belowFraction;
    const zeroY = MARGIN.top + chartHeight * aboveFraction;
    const yScaleRvu = (rvu: number) => zeroY - (rvu / maxRvu) * (chartHeight * aboveFraction);

    const eventColor: Record<string, string> = {
      INTERSTITIAL: '#eab308', BREAK: '#ef4444', ADMIN: '#d97706', COMMS: '#3b82f6', DOUBLE_TAP: '#fde68a',
    };

    const xTicks: number[] = [];
    const xTickStep = totalSessionMin <= 30 ? 5 : totalSessionMin <= 120 ? 10 : 30;
    for (let m = 0; m <= totalSessionMin; m += xTickStep) xTicks.push(m);

    const yTicks: number[] = [];
    const rawStep = maxRvu / 5;
    const yTickStep = rawStep <= 0.25 ? 0.2 : rawStep <= 0.6 ? 0.5 : 1.0;
    for (let r = yTickStep; r <= maxRvu; r += yTickStep) yTicks.push(Math.round(r * 10) / 10);

    const studyRects = studies.map((s, i) => {
      const x1 = xScale(s.startTimeSession / 60);
      const x2 = xScale((s.startTimeSession + s.elapsedTime) / 60);
      const w = Math.max(x2 - x1, 4);
      const overPar = s.elapsedTime > s.parTime;
      const fill = overPar ? '#ef4444' : '#22c55e';
      const h = zeroY - yScaleRvu(s.rvu);
      let parTickX: number | null = null;
      if (overPar && filmstripExpanded) parTickX = xScale((s.startTimeSession + s.parTime) / 60);
      return {
        key: `study-${i}`, x: x1, w, h, y: zeroY - h, fill, parTickX, swapped: !!s.swapped,
        tooltip: [
          `#${s.studyNumber} ${s.modality}${s.complications.length ? ` (${s.complications.join(', ')})` : ''}`,
          `Elapsed: ${formatMinSec(s.elapsedTime)} / Par: ${formatMinSec(s.parTime)}`,
          `Variance: ${formatMinSec(s.variance)}`,
          `RVU: ${s.rvu.toFixed(2)}`,
          s.pauseUsed ? 'Pause: Yes' : '',
          s.swapped ? 'Swapped' : '',
        ].filter(Boolean),
      };
    });

    const eventRects = nonStudyEvents
      .filter(e => 'duration' in e && (e as { duration: number }).duration > 0)
      .map((e, i) => {
        const dur = (e as { duration: number }).duration;
        const startMin = e.startTimeSession / 60;
        const durMin = dur / 60;
        const x1 = xScale(startMin);
        const x2 = xScale(startMin + durMin);
        const w = Math.max(x2 - x1, 3);
        return {
          key: `event-${i}`, x: x1, w, y: zeroY + PAR_TICK_HEIGHT + 2, h: BELOW_AXIS_HEIGHT - 4,
          fill: eventColor[e.type] || '#6b7280',
          tooltip: [`${e.type}`, `Duration: ${formatMinSec(dur)}`],
        };
      });

    const legendItems: Array<{ label: string; color: string; border?: boolean; hash?: boolean; tick?: boolean }> = [
      { label: 'Under/At Par', color: '#22c55e' },
      { label: 'Over Par', color: '#ef4444' },
      ...(filmstripExpanded ? [{ label: 'Par Tick', color: '#ef4444', tick: true }] : []),
      { label: 'Interstitial', color: '#eab308' },
      { label: 'Break', color: '#ef4444', border: true },
      { label: 'Admin', color: '#d97706' },
      { label: 'Comms', color: '#3b82f6' },
      { label: 'Double-tap', color: '#fde68a' },
      { label: 'Swapped', color: '#f59e0b', hash: true },
    ];

    return (
      <div className="report-section">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-lg font-semibold text-white">6A. Filmstrip Timeline</h3>
          <button onClick={() => setFilmstripExpanded(prev => !prev)} className="px-3 py-1 text-xs font-medium rounded border border-gray-600 text-gray-300 hover:bg-gray-700 transition-colors print:hidden">
            {filmstripExpanded ? 'Standard' : 'Expanded'}
          </button>
        </div>
        <div className={`filmstrip-container${filmstripExpanded ? ' print:hidden' : ''}`} style={{ overflowX: filmstripExpanded ? 'auto' : 'hidden', position: 'relative' }}>
          <svg width={svgWidth} height={SVG_HEIGHT} viewBox={`0 0 ${svgWidth} ${SVG_HEIGHT}`} style={{ display: 'block' }}>
            <defs>
              <pattern id="swap-hash" width={6} height={6} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <line x1={0} y1={0} x2={0} y2={6} stroke="#f59e0b" strokeWidth={2} opacity={0.6} />
              </pattern>
            </defs>
            <rect x={MARGIN.left} y={MARGIN.top} width={chartWidth} height={chartHeight} fill="#111827" />
            {xTicks.map(m => (<line key={`xg-${m}`} x1={xScale(m)} x2={xScale(m)} y1={MARGIN.top} y2={SVG_HEIGHT - MARGIN.bottom} stroke="#374151" strokeDasharray="3 3" />))}
            {yTicks.map(r => (<line key={`yg-${r}`} x1={MARGIN.left} x2={svgWidth - MARGIN.right} y1={yScaleRvu(r)} y2={yScaleRvu(r)} stroke="#374151" strokeDasharray="3 3" />))}
            <line x1={MARGIN.left} x2={svgWidth - MARGIN.right} y1={zeroY} y2={zeroY} stroke="#9ca3af" strokeWidth={1.5} />
            {xTicks.map(m => (<text key={`xt-${m}`} x={xScale(m)} y={SVG_HEIGHT - MARGIN.bottom + 16} textAnchor="middle" fill="#9ca3af" fontSize={10}>{m}m</text>))}
            <text x={MARGIN.left + chartWidth / 2} y={SVG_HEIGHT - 4} textAnchor="middle" fill="#9ca3af" fontSize={11}>Session Time (min)</text>
            {yTicks.map(r => (<text key={`yt-${r}`} x={MARGIN.left - 6} y={yScaleRvu(r) + 3} textAnchor="end" fill="#9ca3af" fontSize={10}>{r.toFixed(1)}</text>))}
            <text x={14} y={MARGIN.top + (zeroY - MARGIN.top) / 2} textAnchor="middle" fill="#9ca3af" fontSize={11} transform={`rotate(-90, 14, ${MARGIN.top + (zeroY - MARGIN.top) / 2})`}>RVU</text>
            {eventRects.map(r => (
              <rect key={r.key} x={r.x} y={r.y} width={r.w} height={r.h} fill={r.fill} opacity={0.7} rx={1}
                onMouseEnter={(ev) => setHoveredBar({ x: ev.clientX, y: ev.clientY, lines: r.tooltip })}
                onMouseMove={(ev) => setHoveredBar(prev => prev ? { ...prev, x: ev.clientX, y: ev.clientY } : null)}
                onMouseLeave={() => setHoveredBar(null)} />
            ))}
            {studyRects.map(r => (
              <g key={r.key}
                onMouseEnter={(ev) => setHoveredBar({ x: ev.clientX, y: ev.clientY, lines: r.tooltip })}
                onMouseMove={(ev) => setHoveredBar(prev => prev ? { ...prev, x: ev.clientX, y: ev.clientY } : null)}
                onMouseLeave={() => setHoveredBar(null)}>
                <rect x={r.x} y={r.y} width={r.w} height={r.h} fill={r.fill} opacity={0.85} rx={1} />
                {r.parTickX !== null && (<line x1={r.parTickX} y1={zeroY} x2={r.parTickX} y2={zeroY + PAR_TICK_HEIGHT} stroke="#ef4444" strokeWidth={2} />)}
                {r.swapped && (<rect x={r.x} y={r.y} width={r.w} height={r.h} fill="url(#swap-hash)" rx={1} />)}
              </g>
            ))}
          </svg>
          {hoveredBar && (
            <div style={{ position: 'fixed', left: hoveredBar.x + 12, top: hoveredBar.y - 10, pointerEvents: 'none', zIndex: 50 }}
              className="bg-gray-800 border border-gray-600 rounded px-2 py-1.5 text-xs text-white whitespace-pre-line shadow-lg">
              {hoveredBar.lines.map((line, i) => <div key={i}>{line}</div>)}
            </div>
          )}
        </div>
        <div className="flex flex-wrap gap-4 text-xs text-gray-400 mt-2 ml-1">
          {legendItems.map(item => (
            <div key={item.label} className="flex items-center gap-1">
              {item.hash ? (
                <svg width={12} height={12} className="rounded">
                  <rect width={12} height={12} fill="#374151" />
                  <line x1={0} y1={12} x2={12} y2={0} stroke="#f59e0b" strokeWidth={2} opacity={0.6} />
                  <line x1={-4} y1={8} x2={8} y2={-4} stroke="#f59e0b" strokeWidth={2} opacity={0.6} />
                  <line x1={4} y1={16} x2={16} y2={4} stroke="#f59e0b" strokeWidth={2} opacity={0.6} />
                </svg>
              ) : item.tick ? (
                <svg width={12} height={12} className="rounded">
                  <line x1={6} y1={2} x2={6} y2={10} stroke="#ef4444" strokeWidth={2} />
                </svg>
              ) : (
                <div className="w-3 h-3 rounded" style={{ backgroundColor: item.color, opacity: 0.85, border: item.border ? '1px solid #ef4444' : undefined }} />
              )}
              <span>{item.label}</span>
            </div>
          ))}
        </div>
      </div>
    );
  };

  // ── 6B: Studies by Modality ─────────────────────────────────────────────

  const renderStudiesByModality = () => {
    if (!summary) return null;
    const data = Object.entries(summary.studiesByModality).map(([mod, count]) => ({ modality: mod, count })).sort((a, b) => b.count - a.count);
    if (data.length === 0) return null;
    return (
      <div className="report-section">
        <h3 className="text-lg font-semibold text-white mb-3">6B. Studies by Modality</h3>
        <ResponsiveContainer width="100%" height={Math.max(data.length * 40, 100)}>
          <BarChart data={data} layout="vertical" margin={{ top: 5, right: 30, bottom: 5, left: 50 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
            <XAxis type="number" stroke="#9ca3af" />
            <YAxis dataKey="modality" type="category" stroke="#9ca3af" width={60} />
            <Tooltip contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', color: '#fff' }} />
            <Bar dataKey="count" fill="#3b82f6" name="Studies" />
          </BarChart>
        </ResponsiveContainer>
      </div>
    );
  };

  // ── Modality Pie Charts ─────────────────────────────────────────────────

  const renderModalityPieCharts = () => {
    if (studies.length === 0) return null;
    const studyCountMap: Record<string, number> = {};
    const timeMap: Record<string, number> = {};
    const rvuMap: Record<string, number> = {};
    for (const s of studies) {
      studyCountMap[s.modality] = (studyCountMap[s.modality] || 0) + 1;
      timeMap[s.modality] = (timeMap[s.modality] || 0) + s.elapsedTime;
      rvuMap[s.modality] = (rvuMap[s.modality] || 0) + s.rvu;
    }
    const studyData = Object.entries(studyCountMap).map(([mod, count]) => ({ name: mod, value: count })).sort((a, b) => b.value - a.value);
    const timeData = Object.entries(timeMap).map(([mod, sec]) => ({ name: mod, value: Math.round(sec) })).sort((a, b) => b.value - a.value);
    const rvuData = Object.entries(rvuMap).map(([mod, rvu]) => ({ name: mod, value: Math.round(rvu * 10) / 10 })).sort((a, b) => b.value - a.value);
    const fallbackColors = ['#6366f1', '#a855f7', '#14b8a6', '#f43f5e'];
    const getColor = (mod: string, idx: number) => MODALITY_COLORS[mod] || fallbackColors[idx % fallbackColors.length];

    const renderPie = (title: string, data: Array<{ name: string; value: number }>, labelFn: (v: number) => string) => (
      <div className="flex-1 min-w-0">
        <h4 className="text-sm font-medium text-gray-400 text-center mb-2">{title}</h4>
        <ResponsiveContainer width="100%" height={200}>
          <PieChart>
            <Pie data={data} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={70}
              label={({ name, percent }) => `${name} ${((percent ?? 0) * 100).toFixed(0)}%`} labelLine={false} fontSize={11} fill="#8884d8">
              {data.map((entry, i) => (<Cell key={entry.name} fill={getColor(entry.name, i)} />))}
            </Pie>
            <Tooltip contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', color: '#fff' }} formatter={(value: number | undefined) => labelFn(value ?? 0)} />
          </PieChart>
        </ResponsiveContainer>
      </div>
    );

    return (
      <div className="report-section">
        <h3 className="text-lg font-semibold text-white mb-3">Modality Distribution</h3>
        <div className="flex gap-4">
          {renderPie('Studies', studyData, (v) => `${v} studies`)}
          {renderPie('Time', timeData, (v) => formatTime(v))}
          {renderPie('RVU', rvuData, (v) => `${v.toFixed(2)} RVU`)}
        </div>
        <div className="flex flex-wrap justify-center gap-4 mt-3 text-xs text-gray-400">
          {studyData.map((d, i) => (
            <div key={d.name} className="flex items-center gap-1">
              <div className="w-3 h-3 rounded" style={{ backgroundColor: getColor(d.name, i) }} />
              <span>{d.name}</span>
            </div>
          ))}
        </div>
      </div>
    );
  };

  // ── 6C: RVU/hr by Modality ─────────────────────────────────────────────

  const renderRVUPerHourByModality = () => {
    if (!summary) return null;
    const data = Object.entries(summary.rvuPerHourByModality).map(([mod, rate]) => ({ modality: mod, rvuPerHour: Math.round(rate * 10) / 10 })).sort((a, b) => b.rvuPerHour - a.rvuPerHour);
    if (data.length === 0) return null;
    return (
      <div className="report-section">
        <h3 className="text-lg font-semibold text-white mb-3">6C. RVU/hr by Modality</h3>
        <ResponsiveContainer width="100%" height={Math.max(data.length * 40, 100)}>
          <BarChart data={data} layout="vertical" margin={{ top: 5, right: 30, bottom: 5, left: 50 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
            <XAxis type="number" stroke="#9ca3af" />
            <YAxis dataKey="modality" type="category" stroke="#9ca3af" width={60} />
            <Tooltip contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', color: '#fff' }} />
            <Bar dataKey="rvuPerHour" fill="#8b5cf6" name="RVU/hr" />
          </BarChart>
        </ResponsiveContainer>
      </div>
    );
  };

  // ── 6D: Avg Variance by Modality ───────────────────────────────────────

  const renderAvgVarianceByModality = () => {
    if (!summary) return null;
    const data = Object.entries(summary.avgVarianceByModality).map(([mod, v]) => ({ modality: mod, variance: Math.round(v), fill: v > 0 ? '#ef4444' : '#22c55e' }));
    if (data.length === 0) return null;
    return (
      <div className="report-section">
        <h3 className="text-lg font-semibold text-white mb-3">6D. Average Variance by Modality</h3>
        <ResponsiveContainer width="100%" height={Math.max(data.length * 40, 100)}>
          <BarChart data={data} layout="vertical" margin={{ top: 5, right: 30, bottom: 5, left: 50 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
            <XAxis type="number" stroke="#9ca3af" tickFormatter={(v: number) => formatMinSec(v)} />
            <YAxis dataKey="modality" type="category" stroke="#9ca3af" width={60} />
            <Tooltip contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', color: '#fff' }} itemStyle={{ color: '#fff' }} formatter={(value: number | undefined) => [formatMinSec(value ?? 0), 'Avg Variance']} />
            <ReferenceLine x={0} stroke="#9ca3af" />
            <Bar dataKey="variance" name="Variance">
              {data.map((entry, i) => (<Cell key={i} fill={entry.fill} />))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    );
  };

  // ── 6E: Top 5 Over/Under Par ───────────────────────────────────────────

  const renderTop5Studies = () => {
    if (!summary) return null;
    const { top5OverPar, top5UnderPar } = summary;
    if (top5OverPar.length === 0 && top5UnderPar.length === 0) return null;
    const renderTable = (title: string, items: typeof top5OverPar, colorClass: string) => (
      <div className="flex-1">
        <h4 className={`text-sm font-semibold ${colorClass} mb-2`}>{title}</h4>
        {items.length === 0 ? (<p className="text-gray-500 text-xs">None</p>) : (
          <table className="w-full text-xs">
            <thead><tr className="text-gray-400 border-b border-gray-700"><th className="text-left py-1">#</th><th className="text-left py-1">Modality</th><th className="text-left py-1">Complications</th><th className="text-right py-1">Elapsed</th><th className="text-right py-1">Par</th><th className="text-right py-1">Variance</th></tr></thead>
            <tbody>{items.map((s, i) => (
              <tr key={i} className="border-b border-gray-800 text-gray-300">
                <td className="py-1">{s.studyNumber}</td><td className="py-1">{s.modality}</td><td className="py-1">{s.complications.join(', ') || '-'}</td>
                <td className="py-1 text-right">{formatMinSec(s.elapsedTime)}</td><td className="py-1 text-right">{formatMinSec(s.parTime)}</td>
                <td className={`py-1 text-right ${s.variance > 0 ? 'text-red-400' : 'text-green-400'}`}>{formatMinSec(s.variance)}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
    );
    return (
      <div className="report-section">
        <h3 className="text-lg font-semibold text-white mb-3">6E. Top 5 Over/Under Par</h3>
        <div className="flex gap-6">
          {renderTable('Top 5 Over Par (Worst)', top5OverPar, 'text-red-400')}
          {renderTable('Top 5 Under Par (Best)', top5UnderPar, 'text-green-400')}
        </div>
      </div>
    );
  };

  // ── 6F: Time Allocation ─────────────────────────────────────────────────

  const renderTimeAllocation = () => {
    if (!summary) return null;
    const { timeAllocation } = summary;
    const total = Object.values(timeAllocation).reduce((a, b) => a + b, 0);
    if (total === 0) return null;
    const data = [
      { name: 'Study', value: timeAllocation.study, color: PIE_COLORS[0] },
      { name: 'Interstitial', value: timeAllocation.interstitial, color: PIE_COLORS[1] },
      { name: 'Admin', value: timeAllocation.admin, color: PIE_COLORS[2] },
      { name: 'Comms', value: timeAllocation.comms, color: PIE_COLORS[3] },
      { name: 'Break', value: timeAllocation.break, color: PIE_COLORS[4] },
      { name: 'Double Tap', value: timeAllocation.doubleTap, color: PIE_COLORS[5] },
    ].filter(d => d.value > 0);
    return (
      <div className="report-section">
        <h3 className="text-lg font-semibold text-white mb-3">6F. Time Allocation</h3>
        <div className="flex items-center gap-8">
          <ResponsiveContainer width={300} height={250}>
            <PieChart><Pie data={data} cx="50%" cy="50%" outerRadius={90} dataKey="value" label={({ name, percent }) => `${name} ${((percent ?? 0) * 100).toFixed(0)}%`} labelLine={false}>
              {data.map((entry, i) => (<Cell key={i} fill={entry.color} />))}
            </Pie><Tooltip contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', color: '#fff' }} formatter={(value: number | undefined) => [formatTime(value ?? 0), 'Time']} /></PieChart>
          </ResponsiveContainer>
          <div className="text-sm space-y-1">
            {data.map((d, i) => (
              <div key={i} className="flex items-center gap-2">
                <div className="w-3 h-3 rounded" style={{ backgroundColor: d.color }} />
                <span className="text-gray-300">{d.name}:</span>
                <span className="text-white font-medium">{formatTime(d.value)}</span>
                <span className="text-gray-500">({total > 0 ? ((d.value / total) * 100).toFixed(2) : 0}%)</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  };

  // ── 6G: Hourly Profile (wRVU + studies by clock hour) ──────────────────
  // Tests the intuitive "I work better in the morning" hypothesis. Bars are
  // bucketed by local wall-clock hour (browser local time). Best hours by
  // wRVU and studies are surfaced separately — they often peak in different
  // hours.

  const renderHourlyProfile = () => {
    if (!summary?.hourlyProfile) return null;
    const profile = summary.hourlyProfile;
    const hours = Object.keys(profile).sort();
    if (hours.length === 0) return null;

    // Build a contiguous range from min hour → max hour, including any zero
    // hours in between so the chart isn't deceptively gappy.
    const minH = Number(hours[0]);
    const maxH = Number(hours[hours.length - 1]);
    const fmtHour = (h: number) => {
      const period = h < 12 ? 'AM' : 'PM';
      const display = h % 12 === 0 ? 12 : h % 12;
      return `${display} ${period}`;
    };
    const data: Array<{ hour: string; label: string; rvu: number; studies: number }> = [];
    for (let h = minH; h <= maxH; h++) {
      const key = String(h).padStart(2, '0');
      const bucket = profile[key];
      data.push({
        hour: key,
        label: fmtHour(h),
        rvu: bucket ? +bucket.rvu.toFixed(2) : 0,
        studies: bucket ? bucket.studies : 0,
      });
    }

    const bestRvu = summary.bestHourByRvu ?? null;
    const bestStudies = summary.bestHourByStudies ?? null;
    const RVU_COLOR = '#22c55e';
    const STUDIES_COLOR = '#3b82f6';

    return (
      <div className="report-section">
        <h3 className="text-lg font-semibold text-white mb-1">6G. Hourly Profile (wRVU &amp; Studies)</h3>
        <p className="text-gray-500 text-xs mb-3">By wall-clock hour at your local time. Tests the "I work better in the morning" hypothesis with actual data.</p>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={data} margin={{ top: 10, right: 20, bottom: 20, left: 10 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
            <XAxis dataKey="label" stroke="#9ca3af" fontSize={11} />
            <YAxis
              yAxisId="left"
              stroke={RVU_COLOR}
              fontSize={11}
              tickFormatter={(v: number) => v.toFixed(0)}
              label={{ value: 'wRVU', angle: -90, position: 'insideLeft', fill: RVU_COLOR, fontSize: 11 }}
            />
            <YAxis
              yAxisId="right"
              orientation="right"
              stroke={STUDIES_COLOR}
              fontSize={11}
              allowDecimals={false}
              label={{ value: 'Studies', angle: 90, position: 'insideRight', fill: STUDIES_COLOR, fontSize: 11 }}
            />
            <Tooltip
              contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', color: '#fff' }}
              formatter={(value, name) => {
                const v = typeof value === 'number' ? value : Number(value ?? 0);
                if (name === 'wRVU') return [v.toFixed(2), name];
                return [String(v), String(name ?? '')];
              }}
            />
            <Bar yAxisId="left" dataKey="rvu" name="wRVU" fill={RVU_COLOR} />
            <Bar yAxisId="right" dataKey="studies" name="Studies" fill={STUDIES_COLOR} />
          </BarChart>
        </ResponsiveContainer>
        {(bestRvu || bestStudies) && (
          <div className="grid grid-cols-2 gap-3 mt-3">
            <div className="bg-gray-700/50 rounded-lg p-3">
              <div className="text-gray-400 text-xs mb-1">Best Hour — wRVU</div>
              <div className="text-2xl font-bold" style={{ color: RVU_COLOR }}>
                {bestRvu ? `${fmtHour(Number(bestRvu.hour))}` : '—'}
              </div>
              <div className="text-xs text-gray-400 mt-1">
                {bestRvu ? `${bestRvu.rvu.toFixed(2)} wRVU on ${bestRvu.studies} studies` : ''}
              </div>
            </div>
            <div className="bg-gray-700/50 rounded-lg p-3">
              <div className="text-gray-400 text-xs mb-1">Best Hour — Studies</div>
              <div className="text-2xl font-bold" style={{ color: STUDIES_COLOR }}>
                {bestStudies ? `${fmtHour(Number(bestStudies.hour))}` : '—'}
              </div>
              <div className="text-xs text-gray-400 mt-1">
                {bestStudies ? `${bestStudies.studies} studies for ${bestStudies.rvu.toFixed(2)} wRVU` : ''}
              </div>
            </div>
          </div>
        )}
      </div>
    );
  };

  // ── 7A: Stamina Curve ───────────────────────────────────────────────────

  const renderStaminaCurve = () => {
    if (!summary || summary.staminaCurve.length === 0) return null;
    const data = summary.staminaCurve.map((v, i) => ({ study: i + 1, variance: v }));
    return (
      <div className="report-section">
        <h3 className="text-lg font-semibold text-white mb-3">7A. Stamina Curve</h3>
        <p className="text-gray-400 text-xs mb-3">Variance per study over the session. Below zero (faster than par) is good.</p>
        <ResponsiveContainer width="100%" height={200}>
          <LineChart data={data} margin={{ top: 5, right: 30, bottom: 20, left: 30 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
            <XAxis dataKey="study" stroke="#9ca3af" label={{ value: 'Study #', position: 'insideBottom', offset: -10, fill: '#9ca3af' }} />
            <YAxis stroke="#9ca3af" tickFormatter={(v: number) => formatMinSec(v)} />
            <Tooltip contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', color: '#fff' }} formatter={(value: number | undefined) => [formatMinSec(value ?? 0), 'Variance']} />
            <ReferenceLine y={0} stroke="#9ca3af" strokeDasharray="3 3" />
            <Line type="monotone" dataKey="variance" stroke="#3b82f6" dot={{ r: 3 }} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    );
  };

  // ── 7B-7L: Remaining sections ───────────────────────────────────────────

  const renderBreakROI = () => {
    if (!summary) return null;
    const { breakROI } = summary;
    if (breakROI.breakCount === 0) return <div className="report-section"><h3 className="text-lg font-semibold text-white mb-3">7B. Break ROI</h3><p className="text-gray-500 text-sm">No breaks taken</p></div>;
    return (
      <div className="report-section">
        <h3 className="text-lg font-semibold text-white mb-3">7B. Break ROI</h3>
        <div className="grid grid-cols-3 gap-4 text-center">
          <div className="bg-gray-800 rounded-lg p-4"><div className="text-gray-400 text-xs mb-1">Avg Variance Before Break</div><div className="text-xl font-bold text-white">{breakROI.avgVarianceBefore !== null ? formatMinSec(breakROI.avgVarianceBefore) : 'N/A'}</div></div>
          <div className="bg-gray-800 rounded-lg p-4"><div className="text-gray-400 text-xs mb-1">Avg Variance After Break</div><div className="text-xl font-bold text-white">{breakROI.avgVarianceAfter !== null ? formatMinSec(breakROI.avgVarianceAfter) : 'N/A'}</div></div>
          <div className="bg-gray-800 rounded-lg p-4"><div className="text-gray-400 text-xs mb-1">Breaks Taken</div><div className="text-xl font-bold text-white">{breakROI.breakCount}</div></div>
        </div>
        {breakROI.avgVarianceBefore !== null && breakROI.avgVarianceAfter !== null && (
          <div className="mt-2 text-sm text-center">
            {breakROI.avgVarianceAfter < breakROI.avgVarianceBefore ? (<span className="text-green-400">Breaks improved performance by {formatMinSec(breakROI.avgVarianceBefore - breakROI.avgVarianceAfter)}</span>)
              : breakROI.avgVarianceAfter > breakROI.avgVarianceBefore ? (<span className="text-yellow-400">Post-break variance was {formatMinSec(breakROI.avgVarianceAfter - breakROI.avgVarianceBefore)} worse</span>)
              : (<span className="text-gray-400">No measurable difference</span>)}
          </div>
        )}
      </div>
    );
  };

  const renderComplicationCost = () => {
    if (!summary) return null;
    const entries = Object.entries(summary.complicationCost);
    if (entries.length === 0) return null;
    return (
      <div className="report-section">
        <h3 className="text-lg font-semibold text-white mb-3">7C. Complication Cost</h3>
        <table className="w-full text-sm"><thead><tr className="text-gray-400 border-b border-gray-700"><th className="text-left py-2">Complication</th><th className="text-right py-2">Actual Avg Added</th><th className="text-right py-2">Par Allotment</th><th className="text-right py-2">Difference</th><th className="text-right py-2">Occurrences</th></tr></thead>
          <tbody>{entries.map(([comp, data]) => { const diff = data.avgActualTimeAdded - data.parTimeAllotment; return (
            <tr key={comp} className="border-b border-gray-800 text-gray-300"><td className="py-2">{comp}</td><td className="py-2 text-right">{formatMinSec(Math.round(data.avgActualTimeAdded))}</td><td className="py-2 text-right">{formatMinSec(Math.round(data.parTimeAllotment))}</td><td className={`py-2 text-right ${diff > 0 ? 'text-red-400' : 'text-green-400'}`}>{formatMinSec(Math.round(diff))}</td><td className="py-2 text-right">{data.occurrences}</td></tr>
          ); })}</tbody>
        </table>
      </div>
    );
  };

  const renderInterstitialTrend = () => {
    if (!summary || summary.interstitialTrend.length === 0) return null;
    const data = summary.interstitialTrend.map((v, i) => ({ event: i + 1, interstitial: v }));
    return (
      <div className="report-section">
        <h3 className="text-lg font-semibold text-white mb-3">7D. Interstitial Trend</h3>
        <p className="text-gray-500 text-xs mb-2">Each point is one recorded INTERSTITIAL event in time order (natural or swap-adjusted). ABC time is no longer included.</p>
        <ResponsiveContainer width="100%" height={200}>
          <LineChart data={data} margin={{ top: 5, right: 30, bottom: 20, left: 30 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#374151" /><XAxis dataKey="event" stroke="#9ca3af" label={{ value: 'Interstitial #', position: 'insideBottom', offset: -10, fill: '#9ca3af' }} />
            <YAxis stroke="#9ca3af" domain={[0, 300]} tickFormatter={(v: number) => `${v}s`} /><Tooltip contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', color: '#fff' }} formatter={(value: number | undefined) => [`${value ?? 0}s`, 'Interstitial']} />
            <Line type="monotone" dataKey="interstitial" stroke="#f97316" dot={{ r: 3 }} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    );
  };

  const renderDoubleTapRate = () => {
    if (!summary) return null;
    const { doubleTapsByModality, studiesByModality } = summary;
    const mods = Object.keys(studiesByModality);
    if (mods.length === 0) return null;
    const totalDT = Object.values(doubleTapsByModality).reduce((a, b) => a + b, 0);
    if (totalDT === 0) return (<div className="report-section"><h3 className="text-lg font-semibold text-white mb-3">7E. Double Tap Rate</h3><p className="text-gray-500 text-sm">No double taps recorded</p></div>);
    const rows = mods.map(mod => ({ modality: mod, studies: studiesByModality[mod] || 0, doubleTaps: doubleTapsByModality[mod] || 0, rate: (studiesByModality[mod] || 0) > 0 ? ((doubleTapsByModality[mod] || 0) / studiesByModality[mod] * 100).toFixed(2) : '0.0' }));
    return (
      <div className="report-section">
        <h3 className="text-lg font-semibold text-white mb-3">7E. Double Tap Rate by Modality</h3>
        <table className="w-full text-sm"><thead><tr className="text-gray-400 border-b border-gray-700"><th className="text-left py-2">Modality</th><th className="text-right py-2">Studies</th><th className="text-right py-2">Double Taps</th><th className="text-right py-2">Rate</th></tr></thead>
          <tbody>{rows.filter(r => r.doubleTaps > 0).map(r => (<tr key={r.modality} className="border-b border-gray-800 text-gray-300"><td className="py-2">{r.modality}</td><td className="py-2 text-right">{r.studies}</td><td className="py-2 text-right">{r.doubleTaps}</td><td className="py-2 text-right">{r.rate}%</td></tr>))}</tbody>
        </table>
      </div>
    );
  };

  // Pause analysis removed — Pause functionality replaced by Admin/Comms/Break

  const renderDraftEffectiveness = () => {
    if (!summary) return null;
    const { draftAnalysis } = summary;
    return (
      <div className="report-section">
        <h3 className="text-lg font-semibold text-white mb-3">7G. Draft Effectiveness</h3>
        <div className="grid grid-cols-2 gap-4 text-center">
          <div className="bg-gray-800 rounded-lg p-4"><div className="text-gray-400 text-xs mb-1">Avg Variance (Drafted)</div><div className="text-xl font-bold text-white">{draftAnalysis.avgVarianceDrafted !== null ? formatMinSec(draftAnalysis.avgVarianceDrafted) : 'N/A'}</div></div>
          <div className="bg-gray-800 rounded-lg p-4"><div className="text-gray-400 text-xs mb-1">Avg Variance (Not Drafted)</div><div className="text-xl font-bold text-white">{draftAnalysis.avgVarianceNotDrafted !== null ? formatMinSec(draftAnalysis.avgVarianceNotDrafted) : 'N/A'}</div></div>
        </div>
      </div>
    );
  };

  const renderProductiveTimeRatio = () => {
    if (!summary) return null;
    return (
      <div className="report-section">
        <h3 className="text-lg font-semibold text-white mb-3">7H. Productive Time Ratio</h3>
        <div className="text-center py-4"><div className="text-6xl font-bold text-white">{(summary.productiveTimeRatio * 100).toFixed(2)}%</div><div className="text-gray-400 text-sm mt-2">(Study + Double Tap) / Total Session Time</div></div>
      </div>
    );
  };

  const renderPeakRVUWindow = () => {
    if (!summary || summary.peakRVUWindow.rvu === 0) return null;
    const { peakRVUWindow } = summary;
    return (
      <div className="report-section">
        <h3 className="text-lg font-semibold text-white mb-3">7I. Peak RVU Window (60 min)</h3>
        <div className="bg-gray-800 rounded-lg p-6 text-center"><div className="text-4xl font-bold text-white">{peakRVUWindow.rvu.toFixed(2)} RVU</div><div className="text-gray-400 text-sm mt-2">Best 60-min window: {peakRVUWindow.startMinute}min - {peakRVUWindow.endMinute}min into session</div></div>
      </div>
    );
  };

  const renderInterruptionRecovery = () => {
    if (!summary) return null;
    const { interruptionRecoveryCost } = summary;
    return (
      <div className="report-section">
        <h3 className="text-lg font-semibold text-white mb-3">7J. Interruption Recovery Cost</h3>
        <div className="grid grid-cols-2 gap-4 text-center">
          <div className="bg-gray-800 rounded-lg p-4"><div className="text-gray-400 text-xs mb-1">Avg Interstitial After Interruption</div><div className="text-xl font-bold text-white">{interruptionRecoveryCost.avgInterstitialAfterInterruption !== null ? `${interruptionRecoveryCost.avgInterstitialAfterInterruption.toFixed(0)}s` : 'N/A'}</div></div>
          <div className="bg-gray-800 rounded-lg p-4"><div className="text-gray-400 text-xs mb-1">Avg Normal Interstitial</div><div className="text-xl font-bold text-white">{interruptionRecoveryCost.avgInterstitialNormal !== null ? `${interruptionRecoveryCost.avgInterstitialNormal.toFixed(0)}s` : 'N/A'}</div></div>
        </div>
        {interruptionRecoveryCost.avgInterstitialAfterInterruption !== null && interruptionRecoveryCost.avgInterstitialNormal !== null && (
          <div className="mt-2 text-sm text-center">
            {interruptionRecoveryCost.avgInterstitialAfterInterruption > interruptionRecoveryCost.avgInterstitialNormal
              ? (<span className="text-yellow-400">Interruptions add {(interruptionRecoveryCost.avgInterstitialAfterInterruption - interruptionRecoveryCost.avgInterstitialNormal).toFixed(0)}s recovery time</span>)
              : (<span className="text-green-400">No measurable recovery penalty</span>)}
          </div>
        )}
      </div>
    );
  };

  const renderComplicationStacking = () => {
    if (!summary) return null;
    const entries = Object.entries(summary.complicationStacking);
    if (entries.length === 0) return null;
    const data = entries.map(([count, { avgVariance, count: n }]) => ({ complications: Number(count) >= 3 ? '3+' : String(count), avgVariance: Math.round(avgVariance), count: n }))
      .sort((a, b) => { const numA = a.complications === '3+' ? 3 : Number(a.complications); const numB = b.complications === '3+' ? 3 : Number(b.complications); return numA - numB; });
    return (
      <div className="report-section">
        <h3 className="text-lg font-semibold text-white mb-3">7K. Complication Stacking</h3>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={data} margin={{ top: 5, right: 30, bottom: 20, left: 30 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#374151" /><XAxis dataKey="complications" stroke="#9ca3af" label={{ value: '# Complications', position: 'insideBottom', offset: -10, fill: '#9ca3af' }} />
            <YAxis stroke="#9ca3af" tickFormatter={(v: number) => formatMinSec(v)} />
            <Tooltip contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', color: '#fff' }} formatter={(value: number | undefined, _name: string | undefined, entry: unknown) => [`${formatMinSec(value ?? 0)} (n=${(entry as { payload?: { count?: number } })?.payload?.count ?? 0})`, 'Avg Variance']} />
            <ReferenceLine y={0} stroke="#9ca3af" strokeDasharray="3 3" />
            <Bar dataKey="avgVariance" name="Avg Variance">{data.map((entry, i) => (<Cell key={i} fill={entry.avgVariance > 0 ? '#ef4444' : '#22c55e'} />))}</Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    );
  };

  const renderModalityTransitionPenalty = () => {
    if (!summary) return null;
    const { modalityTransitionPenalty } = summary;
    return (
      <div className="report-section">
        <h3 className="text-lg font-semibold text-white mb-3">7L. Modality Transition Penalty</h3>
        <div className="grid grid-cols-2 gap-4 text-center">
          <div className="bg-gray-800 rounded-lg p-4"><div className="text-gray-400 text-xs mb-1">Same Modality Transition</div><div className="text-xl font-bold text-white">{modalityTransitionPenalty.avgInterstitialSameModality !== null ? `${modalityTransitionPenalty.avgInterstitialSameModality.toFixed(0)}s` : 'N/A'}</div></div>
          <div className="bg-gray-800 rounded-lg p-4"><div className="text-gray-400 text-xs mb-1">Different Modality Transition</div><div className="text-xl font-bold text-white">{modalityTransitionPenalty.avgInterstitialDifferentModality !== null ? `${modalityTransitionPenalty.avgInterstitialDifferentModality.toFixed(0)}s` : 'N/A'}</div></div>
        </div>
        {modalityTransitionPenalty.avgInterstitialSameModality !== null && modalityTransitionPenalty.avgInterstitialDifferentModality !== null && (
          <div className="mt-2 text-sm text-center">
            {modalityTransitionPenalty.avgInterstitialDifferentModality > modalityTransitionPenalty.avgInterstitialSameModality
              ? (<span className="text-yellow-400">Switching modalities costs {(modalityTransitionPenalty.avgInterstitialDifferentModality - modalityTransitionPenalty.avgInterstitialSameModality).toFixed(0)}s extra</span>)
              : (<span className="text-green-400">No measurable transition penalty</span>)}
          </div>
        )}
      </div>
    );
  };

  const renderDeckQualityThroughput = () => {
    if (!summary) return null;
    const avgRvuPerStudy = summary.avgRvuPerStudy;
    const studiesPerHour = summary.studiesPerHour;
    if (avgRvuPerStudy === undefined && studiesPerHour === undefined) return null;
    return (
      <div className="report-section">
        <h3 className="text-lg font-semibold text-white mb-3">7M. Deck Quality & Throughput</h3>
        <p className="text-gray-500 text-xs mb-3">RVU/hr = (wRVU/Study) × (Studies/hr). Separates deck quality from reading speed.</p>
        <div className="grid grid-cols-2 gap-4 text-center">
          <div className="bg-gray-700/50 rounded-lg p-3">
            <div className="text-gray-400 text-xs mb-1">wRVU/Study (Deck Quality)</div>
            <div className="text-2xl font-bold text-white">{(avgRvuPerStudy ?? 0).toFixed(2)}</div>
          </div>
          <div className="bg-gray-700/50 rounded-lg p-3">
            <div className="text-gray-400 text-xs mb-1">Studies/hr (Throughput)</div>
            <div className="text-2xl font-bold text-white">{(studiesPerHour ?? 0).toFixed(1)}</div>
          </div>
        </div>
      </div>
    );
  };

  // ── Main render ─────────────────────────────────────────────────────────

  return (
    <div className="session-report-sections">
      {renderHeader()}
      <div className="space-y-6">
        {renderSessionNotes()}
        {renderFilmstrip()}
        {renderStudiesByModality()}
        {renderModalityPieCharts()}
        {renderRVUPerHourByModality()}
        {renderAvgVarianceByModality()}
        {renderTop5Studies()}
        {renderTimeAllocation()}
        {renderHourlyProfile()}
        {renderStaminaCurve()}
        {renderBreakROI()}
        {renderComplicationCost()}
        {renderInterstitialTrend()}
        {renderDoubleTapRate()}
        {/* Pause analysis removed — ABC handles interruptions */}
        {renderDraftEffectiveness()}
        {renderProductiveTimeRatio()}
        {renderPeakRVUWindow()}
        {renderInterruptionRecovery()}
        {renderComplicationStacking()}
        {renderModalityTransitionPenalty()}
        {renderDeckQualityThroughput()}
      </div>
    </div>
  );
}
