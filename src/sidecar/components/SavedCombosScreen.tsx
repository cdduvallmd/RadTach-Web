import { useState } from 'react';
import type { SavedCombo } from '../SidecarMain';
import type { CptEntry } from '../../types/cpt';
import { comboColor } from '../utils/modalityColors';

interface Props {
  combos: SavedCombo[];
  entries: Record<string, CptEntry>;
  onSelect: (combo: SavedCombo) => void;
  onRename: (index: number, aeTitle: string) => void;
  onBack: () => void;
}

export default function SavedCombosScreen({ combos, entries, onSelect, onRename, onBack }: Props) {
  const [renameIdx, setRenameIdx] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const valid = combos
    .map((c, i) => ({ combo: c, idx: i }))
    .filter(({ combo }) => combo.cpts.every(cpt => entries[cpt]));

  return (
    <div className="min-h-screen bg-gray-900 flex flex-col">
      <div className="flex-1 p-3 pb-4">
        <div className="flex items-center mb-4 max-w-sm mx-auto">
          <button onClick={onBack} className="text-blue-400 hover:text-blue-300 text-sm mr-3">&larr; Back</button>
          <h1 className="text-lg font-bold text-white">Saved Combos</h1>
        </div>
        {valid.length === 0 ? (
          <p className="text-gray-500 text-center text-sm mt-12">No saved combos yet.</p>
        ) : (
          <div className="max-w-sm mx-auto space-y-1.5">
            {valid.map(({ combo, idx }) => {
              const cc = comboColor(combo.modality);
              return (
                <div key={idx} className="flex items-stretch gap-1.5">
                  <button
                    onClick={() => onSelect(combo)}
                    className="flex-1 text-left p-2.5 bg-gray-800 hover:bg-gray-700 rounded-lg active:scale-95 transition-all"
                    style={{ borderLeft: `3px solid ${cc}` }}
                  >
                    {combo.aeTitle ? (
                      /* Compact titled view */
                      <>
                        <div className="flex items-center gap-2 mb-0.5">
                          <span className="text-xs font-bold px-1.5 py-0.5 rounded"
                            style={{ backgroundColor: cc, color: '#000' }}>
                            {combo.modality}
                          </span>
                          <span className="text-xs font-bold" style={{ color: cc }}>
                            COMBO ({combo.cpts.length})
                          </span>
                        </div>
                        <p className="text-white text-sm font-medium">{combo.aeTitle}</p>
                        <p className="text-gray-500 text-xs mt-0.5">{combo.cpts.join(', ')}</p>
                      </>
                    ) : (
                      /* Original stacked view for untitled combos */
                      combo.cpts.map((cpt, ci) => {
                        const e = entries[cpt];
                        return (
                          <div key={cpt} className={ci > 0 ? 'mt-1.5 pt-1.5 border-t border-gray-700' : ''}>
                            <div className="flex items-center gap-2 mb-0.5">
                              <span className="text-gray-400 text-xs">{cpt}</span>
                              {ci === 0 && (
                                <span className="text-xs font-bold px-1.5 py-0.5 rounded ml-auto"
                                  style={{ backgroundColor: cc, color: '#000' }}>
                                  COMBO ({combo.cpts.length})
                                </span>
                              )}
                            </div>
                            <p className="text-white text-sm">{e?.description ?? cpt}</p>
                          </div>
                        );
                      })
                    )}
                  </button>
                  {/* Rename button */}
                  <button
                    onClick={() => { setRenameIdx(idx); setRenameValue(combo.aeTitle || ''); }}
                    className="px-2.5 bg-gray-800 hover:bg-gray-700 rounded-lg text-gray-500 hover:text-white text-sm transition-colors"
                    title="Rename combo"
                  >
                    &#9998;
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Rename dialog */}
      {renameIdx !== null && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-800 rounded-xl p-4 w-full max-w-sm space-y-3">
            <h3 className="text-white font-bold text-sm">Name this combo</h3>
            <p className="text-gray-400 text-xs">
              {combos[renameIdx]?.cpts.join(', ')}
            </p>
            <input
              type="text"
              value={renameValue}
              onChange={e => setRenameValue(e.target.value)}
              placeholder="e.g., CT Chest/Abd/Pelvis With"
              autoFocus
              className="w-full px-3 py-2.5 bg-gray-700 border border-gray-600 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:border-amber-500 text-sm"
            />
            <div className="flex gap-2">
              <button
                onClick={() => setRenameIdx(null)}
                className="flex-1 py-2 bg-gray-700 hover:bg-gray-600 text-gray-300 rounded-lg text-sm"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  onRename(renameIdx, renameValue.trim());
                  setRenameIdx(null);
                }}
                className="flex-1 py-2 bg-amber-600 hover:bg-amber-500 text-white font-semibold rounded-lg text-sm"
              >
                {renameValue.trim() ? 'Save' : 'Clear Name'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
