// Admin Block Classification Dialog
// Shared by the session-end flow (called from RadTach main file after End Session)
// and the retroactive backfill flow (called from PvcSettings on a picked past
// session). Same UI in both cases — only the trigger and persistence differ.

import { useState } from 'react';

export interface AdminBlock {
  // index in the session's ADMIN events array, or -1 for an in-progress block
  // that hasn't been recorded yet at the moment classification runs.
  index: number;
  startTimeSession: number;  // seconds from session start
  startTimeSystem?: string;  // ISO timestamp if known (display friendly)
  durationSec: number;
  // Current classification — 'unset' means not yet classified.
  classification: 'unset' | 'meeting' | 'outage' | 'other';
  meetingMinutes: number;    // 0 unless classification === 'meeting'
}

interface Props {
  blocks: AdminBlock[];
  title?: string;
  primaryActionLabel?: string;
  onSave: (classified: AdminBlock[]) => void;
  onSkip: () => void;
  onCancel?: () => void;
}

function formatTime(seconds: number): string {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatClockTime(iso: string | undefined): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleTimeString('en-US', {
      hour: 'numeric', minute: '2-digit', hour12: true,
    });
  } catch { return ''; }
}

export default function AdminBlockClassifier({
  blocks: initialBlocks,
  title = 'Classify Admin Blocks',
  primaryActionLabel = 'Save & End Session',
  onSave,
  onSkip,
  onCancel,
}: Props) {
  const [blocks, setBlocks] = useState<AdminBlock[]>(initialBlocks);

  const update = (idx: number, patch: Partial<AdminBlock>) => {
    setBlocks(prev => prev.map((b, i) => i === idx ? { ...b, ...patch } : b));
  };

  const totalMeetingMinutes = blocks
    .filter(b => b.classification === 'meeting')
    .reduce((s, b) => s + b.meetingMinutes, 0);
  const totalMeetingHours = +(totalMeetingMinutes / 60).toFixed(2);

  const anyUnset = blocks.some(b => b.classification === 'unset');

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-800 rounded-xl p-5 max-w-2xl w-full max-h-[90vh] overflow-y-auto">
        <h2 className="text-white text-lg font-bold mb-1">{title}</h2>
        <p className="text-gray-400 text-sm mb-4">
          You logged {blocks.length} admin {blocks.length === 1 ? 'block' : 'blocks'} of 30+ minutes.
          Classify each so meeting time can get the correct RVU credit. Default is "Other" — only
          mark a block as Meeting if you were actually in a meeting.
          {' '}Meeting time can't exceed the block's length (no double-dipping).
        </p>

        <div className="space-y-3">
          {blocks.map((b, idx) => (
            <div key={idx} className="bg-gray-900/60 rounded-lg p-3">
              <div className="flex items-center justify-between mb-2">
                <div className="text-sm">
                  <span className="text-white font-medium">
                    {b.startTimeSystem ? formatClockTime(b.startTimeSystem) : `+${formatTime(b.startTimeSession)} into session`}
                  </span>
                  <span className="text-gray-500 ml-2">— {formatTime(b.durationSec)} long</span>
                </div>
                {b.classification === 'unset' && (
                  <span className="text-amber-400 text-xs">unclassified</span>
                )}
              </div>
              <div className="flex gap-3 text-sm">
                {(['meeting', 'outage', 'other'] as const).map(kind => {
                  const label = kind === 'meeting' ? 'Meeting' : kind === 'outage' ? 'Network Outage' : 'Other';
                  return (
                    <label key={kind} className="flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="radio"
                        name={`block-${idx}`}
                        checked={b.classification === kind}
                        onChange={() => update(idx, {
                          classification: kind,
                          // Default meeting minutes to the block duration when first selected
                          meetingMinutes: kind === 'meeting'
                            ? (b.meetingMinutes > 0 ? b.meetingMinutes : Math.round(b.durationSec / 60))
                            : 0,
                        })}
                        className="w-3.5 h-3.5"
                      />
                      <span className={b.classification === kind ? 'text-white font-medium' : 'text-gray-400'}>
                        {label}
                      </span>
                    </label>
                  );
                })}
              </div>
              {b.classification === 'meeting' && (
                <div className="mt-2 flex items-center gap-2 text-sm">
                  <span className="text-gray-400">Meeting duration:</span>
                  <input
                    type="number"
                    min={1}
                    max={Math.ceil(b.durationSec / 60)}
                    value={b.meetingMinutes}
                    onChange={e => {
                      const raw = Number(e.target.value) || 0;
                      const capped = Math.min(raw, Math.ceil(b.durationSec / 60));
                      update(idx, { meetingMinutes: Math.max(0, capped) });
                    }}
                    className="w-20 px-2 py-0.5 bg-gray-700 text-white rounded border border-gray-600 text-right"
                  />
                  <span className="text-gray-500">min (max {Math.ceil(b.durationSec / 60)})</span>
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="mt-4 pt-3 border-t border-gray-700 flex items-center justify-between">
          <div className="text-sm text-gray-300">
            Meeting total:{' '}
            <span className="text-white font-medium">{totalMeetingHours.toFixed(2)} hours</span>
          </div>
          {anyUnset && (
            <div className="text-xs text-amber-400">
              {blocks.filter(b => b.classification === 'unset').length} block(s) still unclassified
            </div>
          )}
        </div>

        <div className="flex gap-2 mt-4">
          <button
            onClick={() => onSave(blocks.map(b =>
              b.classification === 'unset' ? { ...b, classification: 'other' } : b
            ))}
            disabled={false}
            className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded font-medium"
          >
            {primaryActionLabel}
          </button>
          <button
            onClick={onSkip}
            className="px-4 py-2 text-sm bg-gray-700 hover:bg-gray-600 text-gray-300 rounded"
            title="Mark as pending — classify later via PVC > Retroactive Entry"
          >
            Skip for now
          </button>
          {onCancel && (
            <button
              onClick={onCancel}
              className="px-4 py-2 text-sm bg-gray-700 hover:bg-gray-600 text-gray-300 rounded ml-auto"
            >
              Cancel
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
