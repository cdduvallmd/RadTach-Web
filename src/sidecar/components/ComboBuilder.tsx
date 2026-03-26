import type { CptEntry } from '../../types/cpt';
import type { SelectedExam } from '../SidecarMain';
import type { GpciValues } from '../../utils/gpciLookup';
import { calculateComboRvu, getBilateralRvu } from '../../utils/cptLookup';

interface Props {
  exams: SelectedExam[];
  entries: Record<string, CptEntry>;
  gpci?: GpciValues;
  aeTitle?: string;
  onRemove: (index: number) => void;
  onAddMore: () => void;
  onStart: () => void;
  disabled?: boolean;
}

export default function ComboBuilder({ exams, entries, gpci, aeTitle, onRemove, onAddMore, onStart, disabled }: Props) {
  const effectiveCpts = exams.map(e => {
    if (e.bilateral) {
      return getBilateralRvu(entries, e.cpt, gpci).cpt;
    }
    return e.cpt;
  });

  const { total, breakdown } = calculateComboRvu(entries, effectiveCpts, gpci);

  return (
    <div className="min-h-screen bg-gray-900 flex flex-col">
      <div className="flex-1 pb-4">
        {/* Header */}
        <div className="p-3 border-b border-gray-800">
          <h1 className="text-lg font-bold text-white text-center">{aeTitle ?? 'Combo Builder'}</h1>
          {aeTitle && (
            <p className="text-gray-500 text-xs text-center mt-0.5">System Combo</p>
          )}
        </div>

        {/* Exam list */}
        <div className="divide-y divide-gray-800">
          {exams.map((exam, idx) => {
            const bd = breakdown[idx];
            return (
              <div key={idx} className="px-3 py-2 flex items-center justify-between">
                <div className="flex-1 mr-3">
                  <p className="text-white text-sm">{exam.entry.description}</p>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-gray-500 text-xs">{exam.cpt}</span>
                    {exam.bilateral && (
                      <span className="text-amber-400 text-xs font-medium">BILATERAL</span>
                    )}
                    {bd && bd.raw !== bd.adjusted && (
                      <span className="text-gray-500 text-xs">
                        {bd.raw} &rarr; {bd.adjusted} (95%)
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-blue-400 font-semibold text-sm">{bd?.adjusted ?? (exam.entry.workRvu ?? exam.entry.pcRvu)}</span>
                  <button
                    onClick={() => onRemove(idx)}
                    className="w-7 h-7 rounded-full bg-red-900/50 text-red-400 flex items-center justify-center text-base font-bold"
                  >
                    &times;
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        {/* Total RVU */}
        <div className="px-3 py-3 border-t border-gray-700">
          <div className="flex items-center justify-between">
            <span className="text-gray-300 font-semibold text-base">Total</span>
            <div className="text-right">
              <span className="text-blue-400 font-bold text-xl">{total} wRVU</span>
              {gpci && (
                <p className="text-cyan-500 text-xs">GPCI adjusted</p>
              )}
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="p-3 space-y-2">
          <button
            onClick={onStart}
            disabled={disabled}
            className="w-full py-3 bg-green-600 hover:bg-green-700 active:bg-green-800 disabled:bg-gray-600 text-white font-bold text-base rounded-xl transition-colors"
          >
            {disabled ? 'Sending...' : `START (${exams.length} exam${exams.length !== 1 ? 's' : ''})`}
          </button>
          <button
            onClick={onAddMore}
            className="w-full py-2.5 bg-gray-700 hover:bg-gray-600 active:bg-gray-500 text-white font-semibold text-sm rounded-xl transition-colors"
          >
            ADD MORE
          </button>
        </div>
      </div>
    </div>
  );
}
