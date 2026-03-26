import { useState } from 'react';
import type { CptEntry } from '../../types/cpt';
import type { GpciValues } from '../../utils/gpciLookup';
import { adjustedWorkRvu } from '../../utils/gpciLookup';
import { getBilateralRvu } from '../../utils/cptLookup';

interface Props {
  cpt: string;
  entry: CptEntry;
  entries: Record<string, CptEntry>;
  gpci?: GpciValues;
  onStart: (bilateral: boolean) => void;
  onAdd: (bilateral: boolean) => void;
  onBack: () => void;
  disabled?: boolean;
}

export default function LeafScreen({ cpt, entry, entries, gpci, onStart, onAdd, onBack, disabled }: Props) {
  const [bilateral, setBilateral] = useState(false);

  const baseRvu = gpci ? adjustedWorkRvu(entry, gpci) : (entry.workRvu ?? entry.pcRvu);
  const displayRvu = bilateral
    ? getBilateralRvu(entries, cpt, gpci).rvu
    : baseRvu;

  return (
    <div className="min-h-screen bg-gray-900 flex flex-col">
      <div className="flex-1 pb-4">
        {/* Header */}
        <div className="flex items-center p-3 border-b border-gray-800">
          <button onClick={onBack} className="text-blue-400 mr-3 text-lg">&larr;</button>
          <h1 className="text-lg font-bold text-white">Confirm Exam</h1>
        </div>

        {/* Exam details */}
        <div className="p-4 space-y-4">
          <div className="text-center">
            <h2 className="text-xl font-bold text-white">{entry.description}</h2>
            <p className="text-gray-400 text-sm mt-1">{entry.modality} &middot; {entry.bodyPart}</p>
            <p className="text-gray-500 text-xs mt-0.5">CPT {cpt}</p>
          </div>

          {/* RVU display */}
          <div className="text-center py-3">
            <span className="text-3xl font-bold text-blue-400">{displayRvu}</span>
            <span className="text-blue-300 text-base ml-2">wRVU</span>
            {gpci && (
              <p className="text-cyan-500 text-xs mt-1">GPCI adjusted</p>
            )}
          </div>

          {/* Bilateral toggle */}
          {entry.bilateralEligible && (
            <button
              onClick={() => setBilateral(!bilateral)}
              className={`w-full py-2.5 rounded-lg font-semibold text-sm transition-colors ${
                bilateral
                  ? 'bg-amber-600 text-white'
                  : 'bg-gray-800 text-gray-300 border border-gray-700'
              }`}
            >
              {bilateral ? 'Bilateral (x1.5)' : 'Bilateral'}
            </button>
          )}

          {/* Action buttons */}
          <div className="space-y-2">
            <button
              onClick={() => onStart(bilateral)}
              disabled={disabled}
              className="w-full py-3 bg-green-600 hover:bg-green-700 active:bg-green-800 disabled:bg-gray-600 text-white font-bold text-base rounded-xl transition-colors"
            >
              {disabled ? 'Sending...' : 'START'}
            </button>
            <button
              onClick={() => onAdd(bilateral)}
              className="w-full py-2.5 bg-gray-700 hover:bg-gray-600 active:bg-gray-500 text-white font-semibold text-sm rounded-xl transition-colors"
            >
              ADD TO COMBO
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
