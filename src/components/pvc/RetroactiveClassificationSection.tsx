// Retroactive admin-block classification section.
// Lets a rad open a past session, see its ≥30 min admin blocks, and classify
// them. The session doc gets pvcMeetingHours updated and pvcPendingClassification
// cleared. Each classification carries an audit pair (uid + timestamp).
//
// Visible to all roles — every rad can backfill their own meeting time.
// The Firestore rules already restrict a rad to writing their own session docs.

import { useEffect, useMemo, useState } from 'react';
import { firestoreService } from '../../services/firestore';
import type { StoredSession } from '../../types/reports';
import AdminBlockClassifier, { type AdminBlock } from './AdminBlockClassifier';
import { subDays } from 'date-fns';

interface Props {
  userId: string;
}

const LOOKBACK_DAYS = 30;
const ADMIN_BLOCK_MIN_SEC = 30 * 60;

interface SessionWithFlags {
  session: StoredSession;
  // True if the session has ≥30 min admin time accumulated (rough proxy — we
  // don't know individual block durations without fetching events).
  potentiallyHasBlocks: boolean;
  pendingClassification: boolean;
}

export default function RetroactiveClassificationSection({ userId }: Props) {
  const [sessions, setSessions] = useState<StoredSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Selected session being classified — null when no dialog is open.
  const [activeSession, setActiveSession] = useState<{
    session: StoredSession;
    blocks: AdminBlock[];
  } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const end = new Date();
    const start = subDays(end, LOOKBACK_DAYS);
    setLoading(true);
    firestoreService.getSessionsInRange(userId, start, end)
      .then(result => {
        if (cancelled) return;
        setSessions(result);
        setLoading(false);
      })
      .catch(err => {
        if (cancelled) return;
        console.error('retroactive fetch failed:', err);
        setError('Could not load recent sessions');
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [userId]);

  const candidates: SessionWithFlags[] = useMemo(() => {
    return sessions
      .map(s => ({
        session: s,
        potentiallyHasBlocks: (s.adminTime ?? 0) >= ADMIN_BLOCK_MIN_SEC,
        pendingClassification: !!s.pvcPendingClassification,
      }))
      .filter(c => c.potentiallyHasBlocks || c.pendingClassification)
      .sort((a, b) => b.session.startDateTime.localeCompare(a.session.startDateTime));
  }, [sessions]);

  const openClassifier = async (s: StoredSession) => {
    try {
      const eventDocs = await firestoreService.getSessionEvents(userId, s.sessionId);
      const blocks: AdminBlock[] = [];
      for (const e of eventDocs) {
        if (e.type === 'ADMIN' && (e.duration ?? 0) >= ADMIN_BLOCK_MIN_SEC) {
          blocks.push({
            index: blocks.length,
            startTimeSession: e.startTimeSession ?? 0,
            startTimeSystem: e.startTimeSystem,
            durationSec: e.duration ?? 0,
            classification: 'unset',
            meetingMinutes: 0,
          });
        }
      }
      if (blocks.length === 0) {
        // Session was eligible by the rough adminTime proxy but actually has
        // no individual ≥30min blocks. Just clear pending flag.
        if (s.pvcPendingClassification) {
          await firestoreService.updateSession(userId, s.sessionId, {
            pvcPendingClassification: false,
          });
          setSessions(prev => prev.map(x =>
            x.sessionId === s.sessionId ? { ...x, pvcPendingClassification: false } : x
          ));
        }
        return;
      }
      setActiveSession({ session: s, blocks });
    } catch (err) {
      console.error('openClassifier failed:', err);
      setError('Could not load admin events for that session — press F12 for details.');
    }
  };

  const handleSave = async (classified: AdminBlock[]) => {
    if (!activeSession) return;
    setSaving(true);
    try {
      const totalMin = classified
        .filter(b => b.classification === 'meeting')
        .reduce((s, b) => s + b.meetingMinutes, 0);
      const hours = +(totalMin / 60).toFixed(2);
      await firestoreService.updateSession(userId, activeSession.session.sessionId, {
        pvcMeetingHours: hours,
        pvcPendingClassification: false,
        pvcMeetingHoursClassifiedAt: new Date().toISOString(),
        pvcMeetingHoursClassifiedBy: userId,
      });
      // Mirror the change locally so the row updates without a refetch.
      setSessions(prev => prev.map(x =>
        x.sessionId === activeSession.session.sessionId
          ? { ...x, pvcMeetingHours: hours, pvcPendingClassification: false }
          : x
      ));
      setActiveSession(null);
    } catch (err) {
      console.error('retroactive save failed:', err);
      setError('Save failed — press F12 to inspect the error.');
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => setActiveSession(null);

  const formatDay = (iso: string) => {
    try {
      return new Date(iso).toLocaleDateString('en-US', {
        weekday: 'short', month: 'short', day: 'numeric',
      });
    } catch { return iso.slice(0, 10); }
  };
  const formatStartTime = (iso: string) => {
    try {
      return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
    } catch { return ''; }
  };
  const formatAdminTime = (sec: number) => {
    const m = Math.floor(sec / 60);
    if (m < 60) return `${m}m`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
  };

  if (loading) {
    return (
      <section>
        <h4 className="text-gray-300 font-medium mb-2">Retroactive Meeting Time Entry</h4>
        <p className="text-gray-500 text-xs">Loading recent sessions…</p>
      </section>
    );
  }

  return (
    <section>
      <h4 className="text-gray-300 font-medium mb-1">Retroactive Meeting Time Entry</h4>
      <p className="text-[11px] text-gray-500 mb-2">
        Backfill meeting hours for sessions that had admin blocks of 30+ minutes.
        You can only classify time you actually logged as Admin — no double-dipping. Last {LOOKBACK_DAYS} days.
      </p>
      {error && <p className="text-red-400 text-xs mb-2">{error}</p>}
      {candidates.length === 0 ? (
        <p className="text-gray-500 text-xs">No recent sessions with classifiable admin blocks.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-gray-700 text-gray-400">
                <th className="text-left py-1.5 pr-3">Day</th>
                <th className="text-left py-1.5 pr-3">Start</th>
                <th className="text-left py-1.5 pr-3">Rotation</th>
                <th className="text-right py-1.5 px-2">Admin time</th>
                <th className="text-right py-1.5 px-2">Meeting RVU credit (hrs)</th>
                <th className="text-center py-1.5 pl-2">Status</th>
                <th className="text-right py-1.5 pl-2"></th>
              </tr>
            </thead>
            <tbody>
              {candidates.map(({ session: s, pendingClassification }) => (
                <tr key={s.id} className="border-b border-gray-700/50">
                  <td className="text-white py-1.5 pr-3">{formatDay(s.startDateTime)}</td>
                  <td className="text-gray-300 py-1.5 pr-3">{formatStartTime(s.startDateTime)}</td>
                  <td className="text-gray-300 py-1.5 pr-3">{s.rotation || '—'}</td>
                  <td className="text-right text-white py-1.5 px-2">{formatAdminTime(s.adminTime ?? 0)}</td>
                  <td className="text-right text-white py-1.5 px-2">
                    {s.pvcMeetingHours != null ? s.pvcMeetingHours.toFixed(2) : '—'}
                  </td>
                  <td className="text-center py-1.5 pl-2">
                    {pendingClassification ? (
                      <span className="text-amber-400">pending</span>
                    ) : s.pvcMeetingHours != null ? (
                      <span className="text-gray-500">classified</span>
                    ) : (
                      <span className="text-gray-500">unclassified</span>
                    )}
                  </td>
                  <td className="text-right py-1.5 pl-2">
                    <button
                      onClick={() => openClassifier(s)}
                      className="px-2 py-0.5 text-[11px] bg-blue-700 hover:bg-blue-600 text-white rounded"
                    >
                      {s.pvcMeetingHours != null ? 'Re-classify' : 'Classify'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {activeSession && (
        <AdminBlockClassifier
          blocks={activeSession.blocks}
          title={`Classify Admin Blocks — ${formatDay(activeSession.session.startDateTime)} ${formatStartTime(activeSession.session.startDateTime)}`}
          primaryActionLabel={saving ? 'Saving…' : 'Save Classification'}
          onSave={handleSave}
          onSkip={handleCancel}
          onCancel={handleCancel}
        />
      )}
    </section>
  );
}
