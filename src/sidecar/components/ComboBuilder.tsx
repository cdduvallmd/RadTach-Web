import { useState } from 'react';
import type { CptEntry } from '../../types/cpt';
import type { SelectedExam } from '../SidecarMain';
import type { GpciValues } from '../../utils/gpciLookup';
import { calculateComboRvu, getBilateralRvu } from '../../utils/cptLookup';

interface Props {
  exams: SelectedExam[];
  entries: Record<string, CptEntry>;
  gpci?: GpciValues;
  aeTitle?: string;
  comboModality?: string;
  onRemove: (index: number) => void;
  onAddSameModality: () => void;
  onAddDifferentModality: () => void;
  onStart: (userTitle?: string, swap?: boolean) => void;
  disabled?: boolean;
}

export default function ComboBuilder({ exams, entries, gpci, aeTitle, comboModality, onRemove, onAddSameModality, onAddDifferentModality, onStart, disabled }: Props) {
  const [userTitle, setUserTitle] = useState('');
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

        {/* Combo title (user-built only, not chargemaster) */}
        {!aeTitle && exams.length > 1 && (
          <div className="px-3 py-2">
            <input
              type="text"
              value={userTitle}
              onChange={e => setUserTitle(e.target.value)}
              placeholder="Name this combo (optional)"
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-amber-500 text-sm"
            />
          </div>
        )}

        {/* Actions */}
        <div className="p-3 space-y-2">
          <button
            onClick={() => onStart(userTitle.trim() || undefined)}
            disabled={disabled}
            className="w-full py-3 bg-green-600 hover:bg-green-700 active:bg-green-800 disabled:bg-gray-600 text-white font-bold text-base rounded-xl transition-colors"
          >
            {disabled ? 'Sending...' : `START (${exams.length} exam${exams.length !== 1 ? 's' : ''})`}
          </button>
          {/* START + SWAP — timing-independent swap correction. Distinct
              amber outline styling so this isn't the muscle-memory default.
              See RadTach/swap-subsystem-plan.md. */}
          <button
            onClick={() => onStart(userTitle.trim() || undefined, true)}
            disabled={disabled}
            className="w-full py-3 bg-transparent border-2 border-amber-500 hover:bg-amber-950 active:bg-amber-900 disabled:border-gray-600 disabled:text-gray-500 text-amber-300 font-bold text-base rounded-xl transition-colors"
            title="Use when the previous study was actually a swap. Corrects the previous study's timing without requiring you to hit STOP within 5 seconds."
          >
            ⇄ START + SWAP
          </button>
          <div className="flex gap-2">
            {comboModality && (
              <button
                onClick={onAddSameModality}
                className="flex-1 py-2.5 bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white font-semibold text-sm rounded-xl transition-colors"
              >
                + {comboModality} EXAM
              </button>
            )}
            <button
              onClick={onAddDifferentModality}
              className={`${comboModality ? 'flex-1' : 'w-full'} py-2.5 bg-gray-700 hover:bg-gray-600 active:bg-gray-500 text-white font-semibold text-sm rounded-xl transition-colors`}
            >
              {comboModality ? '+ DIFFERENT MODALITY' : 'ADD MORE'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
