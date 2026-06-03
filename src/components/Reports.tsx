import { useState, useRef, useMemo, useEffect, lazy, Suspense } from 'react';
import { useUserRole } from '../hooks/useUserRole';
import type { SessionSummary } from '../utils/sessionSummary';
import type { EffectiveRole } from '../types/reports';
import ReportControlPanel from './reports/ReportControlPanel';
import type { ReportSelection, ReportType } from './reports/ReportControlPanel';
import ReportSettings from './reports/ReportSettings';
import PvcSettings from './pvc/PvcSettings';
import SessionReportSections from './reports/SessionReportSections';
import { firestoreService } from '../services/firestore';

const WeeklyReportTab = lazy(() => import('./reports/WeeklyReportTab'));
const MonthlyReportTab = lazy(() => import('./reports/MonthlyReportTab'));
const QuarterlyReportTab = lazy(() => import('./reports/QuarterlyReportTab'));
const YearlyReportTab = lazy(() => import('./reports/YearlyReportTab'));
const GroupComparisonTab = lazy(() => import('./reports/GroupComparisonTab'));
const DailyReportTab = lazy(() => import('./reports/DailyReportTab'));

// ── Types ─────────────────────────────────────────────────────────────────────

interface StudyEvent {
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
}

interface InterstitialEvent {
  type: 'INTERSTITIAL';
  startTimeSession: number;
  startTimeSystem: string;
  endTimeSession: number;
  endTimeSystem: string;
  duration: number;
}

interface TimerEvent {
  type: 'ADMIN' | 'COMMS' | 'BREAK' | 'DOUBLE_TAP';
  startTimeSession: number;
  startTimeSystem: string;
  endTimeSession: number;
  endTimeSystem: string;
  duration: number;
  associatedModality?: string | null;
}

type SessionEvent = StudyEvent | InterstitialEvent | TimerEvent;

interface SessionNotes {
  tags: string[];
  description: string;
}

interface SessionData {
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

export interface ReportsProps {
  entryPoint: 'login' | 'postSession' | 'settings';
  sessionEvents: SessionEvent[];
  sessionData: SessionData | null;
  summary: SessionSummary | null;
  formatTime: (seconds: number) => string;
  onExit: () => void;
  userId?: string | null;
  userSystem?: string | null;
  isAdmin?: boolean;
}

// ── Tab definitions ───────────────────────────────────────────────────────────

type TabId = 'session' | 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'yearly' | 'group';

// ── Component ─────────────────────────────────────────────────────────────────

export default function Reports({
  sessionEvents,
  sessionData,
  summary,
  formatTime,
  onExit,
  userId,
  userSystem,
  isAdmin: _isAdmin,
}: ReportsProps) {
  const { role, hospitalAdminIndividualAccess, adminIndividualAccess } = useUserRole(userId || null, userSystem);
  const [activeTab, setActiveTab] = useState<TabId>('session');
  const printAllRef = useRef<HTMLDivElement>(null);

  // Compute effective role from base role + per-system toggles.
  const effectiveRole: EffectiveRole = (() => {
    if (role === 'globalAdmin' || role === 'president') return 'president';
    if (role === 'admin') return adminIndividualAccess ? 'president' : 'admin';
    if (role === 'hospitalAdmin') return hospitalAdminIndividualAccess ? 'president' : 'hospitalAdmin';
    if (role === 'it') return 'it';
    return 'radiologist';
  })();

  // ── RCP State ────────────────────────────────────────────────────────────
  const [rcpSelection, setRcpSelection] = useState<ReportSelection | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showPvcSettings, setShowPvcSettings] = useState(false);
  const [allSystems, setAllSystems] = useState<string[]>([]);
  const [reportAccess, setReportAccess] = useState<Record<string, string[]> | null>(null);

  // Fetch systems list for globalAdmin
  useEffect(() => {
    if (role !== 'globalAdmin') return;
    firestoreService.listSystems().then(setAllSystems).catch(() => {});
  }, [role]);

  // Fetch report access config for the current system
  useEffect(() => {
    const sys = rcpSelection?.system || userSystem;
    if (!sys) return;
    firestoreService.getReportAccess(sys).then(setReportAccess).catch(() => {});
  }, [rcpSelection?.system, userSystem]);

  // Compute allowed report types based on role + config
  const allowedReportTypes: ReportType[] = useMemo(() => {
    const allTypes: ReportType[] = ['session', 'daily', 'weekly', 'monthly', 'quarterly', 'yearly', 'custom'];
    // globalAdmin/president always get all
    if (role === 'globalAdmin' || role === 'president') return allTypes;
    // Check config; default = all types
    if (!reportAccess) return allTypes;
    const roleKey = role === 'admin' ? 'admin'
      : role === 'hospitalAdmin' ? 'hospitalAdmin'
      : role === 'it' ? 'it'
      : 'radiologist';
    const allowed = reportAccess[roleKey];
    return allowed ? allTypes.filter(t => allowed.includes(t)) : allTypes;
  }, [role, reportAccess]);

  // Sync RCP report type → activeTab for rendering
  useEffect(() => {
    if (!rcpSelection) return;
    const rt = rcpSelection.reportType;
    // Map RCP report types to tab IDs. 'custom' renders via the weekly/monthly tab pattern.
    if (rt === 'custom') {
      // Custom uses the weekly tab component with the custom date range
      setActiveTab('weekly');
    } else if (rt === 'daily') {
      setActiveTab('daily');
    } else {
      setActiveTab(rt as TabId);
    }
  }, [rcpSelection?.reportType]);

  // Determine which userId and system to pass to tabs
  const tabUserId = rcpSelection?.targetUserId ?? (userId || null);
  const tabSystem = rcpSelection?.system ?? (userSystem || null);
  const tabDateRange = rcpSelection?.dateRange ?? null;
  // User display name (from session data or RCP selection)
  const userDisplayName = useMemo(() => {
    if (sessionData) return `${(sessionData as any).firstName || ''} ${(sessionData as any).lastName || ''}`.trim() || null;
    return null;
  }, [sessionData]);

  // Compute who can see this user's individual performance data
  const visibleTo = useMemo(() => {
    const viewers: string[] = ['You'];
    viewers.push('Group Presidents');
    if (adminIndividualAccess) viewers.push('System Admins');
    if (hospitalAdminIndividualAccess) viewers.push('Hospital Admins');
    return viewers;
  }, [adminIndividualAccess, hospitalAdminIndividualAccess]);

  // ── Print handlers ──────────────────────────────────────────────────────

  const handlePrint = () => {
    window.print();
  };

  const handlePrintAll = () => {
    // Temporarily show all content for print
    if (printAllRef.current) {
      printAllRef.current.style.display = 'block';
    }
    window.print();
    if (printAllRef.current) {
      printAllRef.current.style.display = 'none';
    }
  };

  // ── Main render ─────────────────────────────────────────────────────────
  // NOTE: Session report rendering (header + 21 sections) is now in SessionReportSections.tsx

  return (
    <div className="reports-container min-h-screen bg-gray-900 p-4">
      {/* Print CSS */}
      <style>{`
        @media print {
          body { background: white !important; color: black !important; }
          .reports-container { background: white !important; padding: 0 !important; }
          .report-header { background: #f3f4f6 !important; color: black !important; border: 1px solid #d1d5db; }
          .report-header .text-white, .report-header .font-medium { color: black !important; }
          .report-header .text-gray-400 { color: #6b7280 !important; }
          .report-header .text-yellow-400 { color: #b45309 !important; }
          .rvu-disclaimer { background: #fef3c7 !important; border-color: #f59e0b !important; color: #92400e !important; }
          .rvu-disclaimer strong { color: #78350f !important; }
          .no-print { display: none !important; }
          .report-section { page-break-inside: avoid; margin-bottom: 1rem; }
          .report-section h3 { color: black !important; }
          .text-white { color: black !important; }
          .text-gray-300, .text-gray-400, .text-gray-500 { color: #4b5563 !important; }
          .text-green-400 { color: #059669 !important; }
          .text-red-400 { color: #dc2626 !important; }
          .text-yellow-400 { color: #b45309 !important; }
          .bg-gray-800 { background: #f9fafb !important; border: 1px solid #e5e7eb; }
          table { border-collapse: collapse; }
          th, td { border-bottom: 1px solid #d1d5db; }
          /* Filmstrip: scale SVG to fit page width, invert colors for print */
          .filmstrip-container svg { width: 100% !important; height: auto !important; }
          .filmstrip-container rect[fill="#111827"] { fill: #f3f4f6 !important; }
          .filmstrip-container line[stroke="#374151"] { stroke: #d1d5db !important; }
          .filmstrip-container line[stroke="#9ca3af"] { stroke: #4b5563 !important; }
          .filmstrip-container text[fill="#9ca3af"] { fill: #374151 !important; }
}
      `}</style>

      <div className="max-w-6xl mx-auto">
        {/* Action buttons */}
        <div className="no-print flex items-center justify-end gap-2 mb-2">
          <button
            onClick={handlePrint}
            className="px-4 py-2 bg-gray-600 hover:bg-gray-500 text-white text-sm rounded transition-colors"
          >
            Print
          </button>
          <button
            onClick={handlePrintAll}
            className="px-4 py-2 bg-gray-600 hover:bg-gray-500 text-white text-sm rounded transition-colors"
          >
            Print All
          </button>
          <button
            onClick={onExit}
            className="px-6 py-2 bg-red-600 hover:bg-red-700 text-white text-sm font-bold rounded transition-colors"
          >
            EXIT REPORTS
          </button>
        </div>

        {/* Report Control Panel */}
        <div className="no-print">
          <ReportControlPanel
            role={role}
            effectiveRole={effectiveRole}
            userId={userId || null}
            userSystem={userSystem || null}
            userDisplayName={userDisplayName}
            systems={allSystems}
            allowedReportTypes={allowedReportTypes}
            onSelectionChange={setRcpSelection}
            onOpenSettings={() => setShowSettings(true)}
            onOpenPvcSettings={() => setShowPvcSettings(true)}
          />
        </div>

        {/* Report Settings (president-only, shown on demand) */}
        {showSettings && effectiveRole === 'president' && (
          <div className="no-print">
            <ReportSettings
              system={rcpSelection?.system || userSystem || null}
              onClose={() => setShowSettings(false)}
            />
          </div>
        )}

        {/* PVC panel (everyone — admin/president edit, radiologists view + backfill) */}
        {showPvcSettings && userId && (
          <div className="no-print">
            <PvcSettings
              system={rcpSelection?.system || userSystem || null}
              userId={userId}
              canEdit={effectiveRole === 'admin' || effectiveRole === 'president'}
              onClose={() => setShowPvcSettings(false)}
            />
          </div>
        )}

        {/* Visibility indicator */}
        <div className="no-print px-4 py-1.5 text-xs text-gray-500 border-b border-gray-700/50">
          Your individual performance data is visible to: {visibleTo.join(' \u00b7 ')}
        </div>

        {/* Active tab content */}
        {activeTab === 'session' && (
          <SessionReportSections
            sessionEvents={sessionEvents}
            sessionData={sessionData}
            summary={summary}
            formatTime={formatTime}
          />
        )}
        {activeTab === 'daily' && (
          <Suspense fallback={<div className="text-gray-400 text-center py-12">Loading...</div>}>
            <DailyReportTab
              userId={tabUserId}
              userSystem={tabSystem}
              formatTime={formatTime}
              role={effectiveRole}
              dateRange={tabDateRange ?? undefined}
            />
          </Suspense>
        )}
        {activeTab === 'weekly' && (
          <Suspense fallback={<div className="text-gray-400 text-center py-12">Loading...</div>}>
            <WeeklyReportTab
              userId={tabUserId}
              userSystem={tabSystem}
              formatTime={formatTime}
              role={effectiveRole}
              dateRange={tabDateRange ?? undefined}
            />
          </Suspense>
        )}
        {activeTab === 'monthly' && (
          <Suspense fallback={<div className="text-gray-400 text-center py-12">Loading...</div>}>
            <MonthlyReportTab
              userId={tabUserId}
              userSystem={tabSystem}
              formatTime={formatTime}
              role={effectiveRole}
              dateRange={tabDateRange ?? undefined}
            />
          </Suspense>
        )}
        {activeTab === 'quarterly' && (
          <Suspense fallback={<div className="text-gray-400 text-center py-12">Loading...</div>}>
            <QuarterlyReportTab
              userId={tabUserId}
              userSystem={tabSystem}
              formatTime={formatTime}
              role={effectiveRole}
              dateRange={tabDateRange ?? undefined}
            />
          </Suspense>
        )}
        {activeTab === 'yearly' && (
          <Suspense fallback={<div className="text-gray-400 text-center py-12">Loading...</div>}>
            <YearlyReportTab
              userId={tabUserId}
              userSystem={tabSystem}
              formatTime={formatTime}
              role={effectiveRole}
              dateRange={tabDateRange ?? undefined}
            />
          </Suspense>
        )}
        {activeTab === 'group' && effectiveRole === 'president' && (
          <Suspense fallback={<div className="text-gray-400 text-center py-12">Loading...</div>}>
            <GroupComparisonTab userSystem={tabSystem || null} formatTime={formatTime} />
          </Suspense>
        )}

        {/* Hidden container for Print All */}
        <div ref={printAllRef} className="print-all-container" style={{ display: 'none' }}>
          <h2 className="text-xl font-bold text-white mb-4">Full Session Report</h2>
          <SessionReportSections
            sessionEvents={sessionEvents}
            sessionData={sessionData}
            summary={summary}
            formatTime={formatTime}
          />
        </div>
      </div>
    </div>
  );
}
