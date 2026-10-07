// The Midnight Protection box on RadTach: asks for an Epic RVU total.
// Clicking anywhere on it acknowledges the alert (stops the flashing) —
// entering a value is not required (owner, 2026-10-06). Not a modal: the rest
// of RadTach keeps working.
export type EpicPanelMode = 'baseline' | 'preMidnight' | 'missed';

const TEXT: Record<EpicPanelMode, { title: string; help: string }> = {
  baseline: {
    title: 'Epic total at session start',
    help: 'A session already ended today, so Epic already counts its RVUs. Enter Epic’s current total; it is subtracted at Stop.',
  },
  preMidnight: {
    title: 'Check Epic before midnight',
    help: 'Epic’s total resets at midnight. Enter its current total before 12:00 AM. Does not end the session.',
  },
  missed: {
    title: 'Pre-12 AM Epic total missed',
    help: 'Midnight has passed. At Stop, enter this session’s combined Epic total instead (e.g. from Epic’s 7-day total).',
  },
};

export function EpicPanel({
  mode, value, onChange, onAcknowledge, onClose,
}: {
  mode: EpicPanelMode;
  value: string;
  onChange: (v: string) => void;
  onAcknowledge: () => void;
  onClose: () => void;
}) {
  const t = TEXT[mode];
  return (
    <div
      onMouseDown={onAcknowledge}
      className="fixed top-4 left-1/2 -translate-x-1/2 z-50 w-[28rem] max-w-[95vw] bg-gray-800 border-2 border-red-500 rounded-xl shadow-2xl p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-white font-semibold">{t.title}</h3>
        <button onClick={onClose} className="text-gray-400 hover:text-white text-xl leading-none" aria-label="Close">×</button>
      </div>
      <p className="text-gray-300 text-sm mt-1 mb-3">{t.help}</p>
      {mode !== 'missed' && (
        <div className="flex gap-2">
          <input
            type="number"
            step="0.01"
            min="0"
            value={value}
            onChange={e => onChange(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') onClose(); }}
            placeholder="Epic RVU total"
            autoFocus
            className="flex-1 bg-gray-700 text-white rounded-lg p-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <button onClick={onClose} className="px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg text-sm font-medium">
            Save
          </button>
        </div>
      )}
    </div>
  );
}
