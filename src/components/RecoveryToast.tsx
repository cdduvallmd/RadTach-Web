// Bottom-center toast for lost-session auto-recovery results.
//
// Displays after AuthContext's checkOrphans finishes running. Two shapes:
//
//   - Success list: one line per recovered session (date, studies, duration).
//     Small "Discard instead" link per line for the rare oh-crap case where
//     the rad actually wanted to reject the recovery. 5-second auto-dismiss
//     for the whole toast; hover keeps it open. Manual "Dismiss" too.
//   - Failure list: shown persistently (no auto-dismiss) with a Retry button
//     per failed session. A failed recovery must not silently drop out of
//     the user's attention — the session stays orphaned until retry succeeds
//     or is manually discarded.
//
// Both are rendered simultaneously if a mixed batch resolves that way.

import { useEffect, useState } from 'react';

export interface RecoveredSession {
  sessionId: string;
  date: string;              // e.g., "Mon, Jul 8"
  studies: number;
  duration: string;          // e.g., "8h 32m"
}

export interface FailedRecovery {
  sessionId: string;
  date: string;
  reason: string;
}

interface Props {
  recovered: RecoveredSession[];
  failed: FailedRecovery[];
  onDismiss: () => void;
  onDiscard: (sessionId: string) => void;
  onRetry: (sessionId: string) => void;
}

const SUCCESS_AUTO_DISMISS_MS = 5000;

export function RecoveryToast({ recovered, failed, onDismiss, onDiscard, onRetry }: Props) {
  const [hovered, setHovered] = useState(false);

  // Auto-dismiss on success-only path. Suppressed while hovered so a rad who
  // needs an extra beat to read or click Discard doesn't lose their chance.
  // Failure list disables auto-dismiss entirely — failure needs to persist
  // until acknowledged.
  useEffect(() => {
    if (failed.length > 0 || hovered) return;
    if (recovered.length === 0) return;
    const t = setTimeout(onDismiss, SUCCESS_AUTO_DISMISS_MS);
    return () => clearTimeout(t);
  }, [recovered.length, failed.length, hovered, onDismiss]);

  if (recovered.length === 0 && failed.length === 0) return null;

  return (
    <div
      className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[100] w-full max-w-md px-4 pointer-events-none"
    >
      <div
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        className="bg-gray-800 border border-gray-700 rounded-lg shadow-xl p-4 space-y-2 pointer-events-auto"
        role="status"
        aria-live="polite"
      >
        {recovered.length > 0 && (
          <div className="space-y-1.5">
            <div className="text-xs uppercase tracking-wider text-green-400 font-semibold">
              {recovered.length === 1 ? 'Lost Session Recovered' : `${recovered.length} Lost Sessions Recovered`}
            </div>
            {recovered.map((s) => (
              <div key={s.sessionId} className="flex items-baseline justify-between gap-2 text-sm">
                <div className="text-white">
                  {s.date} — {s.studies} stud{s.studies === 1 ? 'y' : 'ies'}, {s.duration}
                </div>
                <button
                  onClick={() => onDiscard(s.sessionId)}
                  className="text-xs text-gray-500 hover:text-red-400 underline decoration-dotted underline-offset-2 transition-colors"
                  title="Reject this recovery — writes zeroed data over the session"
                >
                  Discard instead
                </button>
              </div>
            ))}
          </div>
        )}
        {failed.length > 0 && (
          <div className={`space-y-1.5 ${recovered.length > 0 ? 'pt-2 border-t border-gray-700' : ''}`}>
            <div className="text-xs uppercase tracking-wider text-red-400 font-semibold">
              {failed.length === 1 ? 'Lost Session Recovery Failed' : `${failed.length} Recoveries Failed`}
            </div>
            {failed.map((s) => (
              <div key={s.sessionId} className="flex items-baseline justify-between gap-2 text-sm">
                <div className="text-white truncate">
                  <span className="text-gray-400">{s.date}: </span>{s.reason}
                </div>
                <button
                  onClick={() => onRetry(s.sessionId)}
                  className="text-xs px-2 py-0.5 rounded bg-red-900/40 hover:bg-red-800 text-red-300 hover:text-white transition-colors shrink-0"
                >
                  Retry
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="pt-2 border-t border-gray-700 flex justify-end">
          <button
            onClick={onDismiss}
            className="text-xs text-gray-500 hover:text-white uppercase tracking-wider transition-colors"
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}
