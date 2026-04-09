// Report Control Panel — header component that drives all report generation
// Manages system, user, report type, and date selection.
// Role-based visibility: globalAdmin sees all; radiologist sees own data only.

import { useState, useMemo, useCallback, useEffect } from 'react';
import { useSystemUsers } from '../../hooks/useSystemUsers';
import type { SystemUser } from '../../hooks/useSystemUsers';
import type { DateRange, UserRole, EffectiveRole } from '../../types/reports';
import {
  getDayRange, getWeekRange, getMonthRange, getQuarterRange, getYearRange,
} from '../../utils/periodAggregation';
import {
  format, addDays, subDays, addWeeks, subWeeks,
  addMonths, subMonths, addQuarters, subQuarters,
} from 'date-fns';

// ── Types ───────────────────────────────────────────────────────────────────

export type ReportType = 'session' | 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'yearly' | 'custom';

export interface ReportSelection {
  system: string | null;
  targetUserId: string | null;   // Firebase UID; null = group/all users
  targetUserName: string | null;
  reportType: ReportType;
  dateRange: DateRange;
}

const ALL_REPORT_TYPES: ReportType[] = ['session', 'daily', 'weekly', 'monthly', 'quarterly', 'yearly', 'custom'];

const REPORT_TYPE_LABELS: Record<ReportType, string> = {
  session: 'Session',
  daily: 'Daily',
  weekly: 'Weekly',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  yearly: 'Yearly',
  custom: 'Custom',
};

interface ReportControlPanelProps {
  role: UserRole;
  effectiveRole: EffectiveRole;
  userId: string | null;        // current user's Firebase UID
  userSystem: string | null;    // current user's system
  userDisplayName: string | null;
  systems: string[];            // all systems (for globalAdmin picker)
  allowedReportTypes: ReportType[];
  onSelectionChange: (selection: ReportSelection) => void;
  onOpenSettings: () => void;
}

// ── Component ───────────────────────────────────────────────────────────────

export default function ReportControlPanel({
  role,
  effectiveRole,
  userId,
  userSystem,
  userDisplayName,
  systems,
  allowedReportTypes,
  onSelectionChange,
  onOpenSettings,
}: ReportControlPanelProps) {
  // System selection — globalAdmin can switch; others locked to their system
  const canPickSystem = role === 'globalAdmin';
  const [selectedSystem, setSelectedSystem] = useState<string | null>(userSystem);

  // User selection — president can pick users; others see self
  const canPickUser = effectiveRole === 'president';
  const { users: systemUsers, loading: usersLoading } = useSystemUsers(
    canPickUser ? selectedSystem : null
  );
  // null = group/all, string = specific user UID
  const [selectedUserUid, setSelectedUserUid] = useState<string | null>(userId);
  const [selectedUserName, setSelectedUserName] = useState<string | null>(userDisplayName);

  // Report type
  const visibleTypes = useMemo(() => {
    return ALL_REPORT_TYPES.filter(t => allowedReportTypes.includes(t));
  }, [allowedReportTypes]);
  const [reportType, setReportType] = useState<ReportType>(() => {
    // Default to 'session' if available, else first allowed
    if (allowedReportTypes.includes('session')) return 'session';
    return allowedReportTypes[0] || 'weekly';
  });

  // Date navigation state
  const [currentDate, setCurrentDate] = useState(new Date());
  const [customStart, setCustomStart] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() - 7); return d;
  });
  const [customEnd, setCustomEnd] = useState(new Date());

  // Compute date range from report type + currentDate
  const dateRange: DateRange = useMemo(() => {
    switch (reportType) {
      case 'session': return getDayRange(currentDate); // session uses day range as container
      case 'daily': return getDayRange(currentDate);
      case 'weekly': return getWeekRange(currentDate, 'monday');
      case 'monthly': return getMonthRange(currentDate.getFullYear(), currentDate.getMonth() + 1);
      case 'quarterly': {
        const q = (Math.floor(currentDate.getMonth() / 3) + 1) as 1 | 2 | 3 | 4;
        return getQuarterRange(currentDate.getFullYear(), q);
      }
      case 'yearly': return getYearRange(currentDate.getFullYear());
      case 'custom': return { start: customStart, end: customEnd };
    }
  }, [reportType, currentDate, customStart, customEnd]);

  // Period label for display
  const periodLabel = useMemo(() => {
    switch (reportType) {
      case 'session': return format(currentDate, 'EEEE, MMM d, yyyy');
      case 'daily': return format(currentDate, 'EEEE, MMM d, yyyy');
      case 'weekly': return `${format(dateRange.start, 'MMM d')} – ${format(dateRange.end, 'MMM d, yyyy')}`;
      case 'monthly': return format(currentDate, 'MMMM yyyy');
      case 'quarterly': {
        const q = Math.floor(currentDate.getMonth() / 3) + 1;
        return `Q${q} ${currentDate.getFullYear()}`;
      }
      case 'yearly': return `${currentDate.getFullYear()}`;
      case 'custom': return `${format(customStart, 'MMM d, yyyy')} – ${format(customEnd, 'MMM d, yyyy')}`;
    }
  }, [reportType, currentDate, dateRange, customStart, customEnd]);

  // Emit selection changes
  useEffect(() => {
    onSelectionChange({
      system: selectedSystem,
      targetUserId: selectedUserUid,
      targetUserName: selectedUserName,
      reportType,
      dateRange,
    });
  }, [selectedSystem, selectedUserUid, selectedUserName, reportType, dateRange]);

  // When system changes, reset user selection
  useEffect(() => {
    if (canPickUser) {
      setSelectedUserUid(null);
      setSelectedUserName(null);
    }
  }, [selectedSystem]);

  // ── Navigation handlers ─────────────────────────────────────────────────

  const navigatePeriod = useCallback((direction: -1 | 1) => {
    setCurrentDate(prev => {
      switch (reportType) {
        case 'session':
        case 'daily': return direction === -1 ? subDays(prev, 1) : addDays(prev, 1);
        case 'weekly': return direction === -1 ? subWeeks(prev, 1) : addWeeks(prev, 1);
        case 'monthly': return direction === -1 ? subMonths(prev, 1) : addMonths(prev, 1);
        case 'quarterly': return direction === -1 ? subQuarters(prev, 1) : addQuarters(prev, 1);
        case 'yearly': return new Date(prev.getFullYear() + direction, 0, 1);
        default: return prev;
      }
    });
  }, [reportType]);

  const resetToNow = useCallback(() => {
    setCurrentDate(new Date());
    setCustomStart(() => { const d = new Date(); d.setDate(d.getDate() - 7); return d; });
    setCustomEnd(new Date());
  }, []);

  const handleUserChange = useCallback((uid: string | null) => {
    if (uid === null) {
      setSelectedUserUid(null);
      setSelectedUserName(null);
    } else if (uid === userId) {
      setSelectedUserUid(userId);
      setSelectedUserName(userDisplayName);
    } else {
      const user = systemUsers.find((u: SystemUser) => u.uid === uid);
      setSelectedUserUid(uid);
      setSelectedUserName(user?.displayName || null);
    }
  }, [userId, userDisplayName, systemUsers]);

  // ── Render ──────────────────────────────────────────────────────────────

  return (
    <div className="bg-gray-800/50 border border-gray-700 rounded-lg mb-4 p-3 space-y-2">
      {/* Row 1: System + User + Settings gear */}
      <div className="flex items-center gap-3 flex-wrap">
        {/* System picker (globalAdmin only) */}
        {canPickSystem && (
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-400 uppercase tracking-wider">System</label>
            <select
              value={selectedSystem || ''}
              onChange={e => setSelectedSystem(e.target.value || null)}
              className="bg-gray-700 text-white text-sm rounded px-2 py-1 border border-gray-600 focus:border-blue-500 focus:outline-none"
            >
              <option value="">Select system...</option>
              {systems.map(s => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
        )}

        {/* User picker (president+ only) */}
        {canPickUser ? (
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-400 uppercase tracking-wider">User</label>
            <select
              value={selectedUserUid || '__group__'}
              onChange={e => handleUserChange(e.target.value === '__group__' ? null : e.target.value)}
              className="bg-gray-700 text-white text-sm rounded px-2 py-1 border border-gray-600 focus:border-blue-500 focus:outline-none"
              disabled={usersLoading}
            >
              <option value="__group__">All Users (Group)</option>
              {systemUsers.map((u: SystemUser) => (
                <option key={u.uid} value={u.uid}>{u.displayName}</option>
              ))}
            </select>
            {usersLoading && <span className="text-xs text-gray-500">Loading...</span>}
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-400 uppercase tracking-wider">User</label>
            <span className="text-sm text-white">{userDisplayName || 'You'}</span>
          </div>
        )}

        {/* Settings gear (president-level only) */}
        {effectiveRole === 'president' && (
          <button
            onClick={onOpenSettings}
            className="ml-auto p-1.5 text-gray-400 hover:text-white transition-colors"
            title="Report Settings"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </button>
        )}
      </div>

      {/* Row 2: Report type buttons */}
      <div className="flex gap-1 flex-wrap">
        {visibleTypes.map(type => (
          <button
            key={type}
            onClick={() => setReportType(type)}
            className={`px-3 py-1.5 text-sm font-medium rounded transition-colors ${
              reportType === type
                ? 'bg-blue-600 text-white'
                : 'bg-gray-700 text-gray-400 hover:text-gray-200 hover:bg-gray-600'
            }`}
          >
            {REPORT_TYPE_LABELS[type]}
          </button>
        ))}
      </div>

      {/* Row 3: Period navigation */}
      {reportType !== 'custom' ? (
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigatePeriod(-1)}
            className="p-1.5 text-gray-400 hover:text-white transition-colors"
            title="Previous period"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>

          <span className="text-sm text-white font-medium min-w-[180px] text-center">
            {periodLabel}
          </span>

          <button
            onClick={() => navigatePeriod(1)}
            className="p-1.5 text-gray-400 hover:text-white transition-colors"
            title="Next period"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </button>

          {/* Date picker (jump to arbitrary date) */}
          <input
            type="date"
            value={format(currentDate, 'yyyy-MM-dd')}
            onChange={e => {
              const d = new Date(e.target.value + 'T12:00:00');
              if (!isNaN(d.getTime())) setCurrentDate(d);
            }}
            className="bg-gray-700 text-white text-sm rounded px-2 py-1 border border-gray-600 focus:border-blue-500 focus:outline-none"
          />

          <button
            onClick={resetToNow}
            className="px-3 py-1 text-xs bg-gray-700 text-gray-300 hover:text-white rounded transition-colors"
          >
            Current
          </button>
        </div>
      ) : (
        /* Custom date range inputs */
        <div className="flex items-center gap-3">
          <label className="text-xs text-gray-400">From</label>
          <input
            type="date"
            value={format(customStart, 'yyyy-MM-dd')}
            onChange={e => {
              const d = new Date(e.target.value + 'T00:00:00');
              if (!isNaN(d.getTime())) setCustomStart(d);
            }}
            className="bg-gray-700 text-white text-sm rounded px-2 py-1 border border-gray-600 focus:border-blue-500 focus:outline-none"
          />
          <label className="text-xs text-gray-400">To</label>
          <input
            type="date"
            value={format(customEnd, 'yyyy-MM-dd')}
            onChange={e => {
              const d = new Date(e.target.value + 'T23:59:59');
              if (!isNaN(d.getTime())) setCustomEnd(d);
            }}
            className="bg-gray-700 text-white text-sm rounded px-2 py-1 border border-gray-600 focus:border-blue-500 focus:outline-none"
          />
          <button
            onClick={resetToNow}
            className="px-3 py-1 text-xs bg-gray-700 text-gray-300 hover:text-white rounded transition-colors"
          >
            Reset
          </button>
        </div>
      )}
    </div>
  );
}
