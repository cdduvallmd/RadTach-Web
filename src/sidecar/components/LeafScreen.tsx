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
  aeTitle?: string;
  onStart: (bilateral: boolean, swap?: boolean) => void;
  onAdd: (bilateral: boolean) => void;
  onAddFavorite?: (cpt: string, aeTitle: string) => void;
  isFavorite?: boolean;
  onBack: () => void;
  disabled?: boolean;
}

export default function LeafScreen({ cpt, entry, entries, gpci, aeTitle, onStart, onAdd, onAddFavorite, isFavorite, onBack, disabled }: Props) {
  const [bilateral, setBilateral] = useState(false);
  const [showFavDialog, setShowFavDialog] = useState(false);
  const [favName, setFavName] = useState('');

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
            <h2 className="text-xl font-bold text-white">{aeTitle ?? entry.description}</h2>
            {aeTitle && (
              <p className="text-gray-500 text-xs mt-0.5">{entry.description}</p>
            )}
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
            {/* START + SWAP — timing-independent swap correction. Distinct
                amber outline styling so this isn't the muscle-memory default.
                See RadTach/swap-subsystem-plan.md. */}
            <button
              onClick={() => onStart(bilateral, true)}
              disabled={disabled}
              className="w-full py-3 bg-transparent border-2 border-amber-500 hover:bg-amber-950 active:bg-amber-900 disabled:border-gray-600 disabled:text-gray-500 text-amber-300 font-bold text-base rounded-xl transition-colors"
              title="Use when the previous study was actually a swap (e.g., a wrong exam popped up on PACS and you dictated the right one anyway). Corrects the previous study's timing without requiring you to hit STOP within 5 seconds."
            >
              ⇄ START + SWAP
            </button>
            <button
              onClick={() => onAdd(bilateral)}
              className="w-full py-2.5 bg-gray-700 hover:bg-gray-600 active:bg-gray-500 text-white font-semibold text-sm rounded-xl transition-colors"
            >
              ADD TO COMBO
            </button>
            {onAddFavorite && !isFavorite && (
              <button
                onClick={() => { setFavName(aeTitle || ''); setShowFavDialog(true); }}
                className="w-full py-2.5 bg-indigo-800 hover:bg-indigo-700 active:bg-indigo-600 text-indigo-200 font-semibold text-sm rounded-xl transition-colors"
              >
                ADD TO FAVORITES
              </button>
            )}
            {isFavorite && (
              <div className="text-center text-indigo-400 text-xs py-1">In Favorites</div>
            )}
          </div>

          {/* Favorite name dialog */}
          {showFavDialog && (
            <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
              <div className="bg-gray-800 rounded-xl p-4 w-full max-w-sm space-y-3">
                <h3 className="text-white font-bold text-sm">Name this favorite</h3>
                <input
                  type="text"
                  value={favName}
                  onChange={e => setFavName(e.target.value)}
                  placeholder="e.g., CT Chest PE Protocol"
                  autoFocus
                  className="w-full px-3 py-2.5 bg-gray-700 border border-gray-600 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:border-indigo-500 text-sm"
                />
                <div className="flex gap-2">
                  <button
                    onClick={() => setShowFavDialog(false)}
                    className="flex-1 py-2 bg-gray-700 hover:bg-gray-600 text-gray-300 rounded-lg text-sm"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => { if (favName.trim()) { onAddFavorite!(cpt, favName.trim()); setShowFavDialog(false); } }}
                    disabled={!favName.trim()}
                    className="flex-1 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:bg-gray-600 text-white font-semibold rounded-lg text-sm"
                  >
                    Save
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
