import type { ProtocolGroup, TreeLeaf } from '../utils/buildCptTree';
import type { GpciValues } from '../../utils/gpciLookup';
import type { SavedCombo } from '../SidecarMain';
import type { CptEntry } from '../../types/cpt';
import { adjustedWorkRvu } from '../../utils/gpciLookup';
import { comboColor } from '../utils/modalityColors';

interface Props {
  modality: string;
  bodyPart: string;
  protocols: ProtocolGroup[];
  gpci?: GpciValues;
  savedCombos?: SavedCombo[];
  entries?: Record<string, CptEntry>;
  favNames?: Map<string, string>;
  onSelectLeaf: (leaf: TreeLeaf) => void;
  onSelectCombo?: (combo: SavedCombo) => void;
  onBack: () => void;
}

export default function ProtocolScreen({ modality, bodyPart, protocols, gpci, savedCombos, entries, favNames, onSelectLeaf, onSelectCombo, onBack }: Props) {
  const combos = savedCombos?.filter(c => entries && c.cpts.every(cpt => entries[cpt])) ?? [];

  return (
    <div className="min-h-screen bg-gray-900 flex flex-col">
      <div className="flex-1 pb-4">
        {/* Header */}
        <div className="flex items-center p-3 border-b border-gray-800">
          <button onClick={onBack} className="text-blue-400 mr-3 text-lg">&larr;</button>
          <div>
            <h1 className="text-lg font-bold text-white">{bodyPart}</h1>
            <p className="text-gray-500 text-xs">{modality}</p>
          </div>
        </div>

        {/* Saved combos (shown only for single-body-part modalities) */}
        {combos.length > 0 && entries && (
          <div className="px-3 py-2 border-b border-gray-700">
            <p className="text-gray-500 text-xs uppercase tracking-wider mb-1.5">Saved Combos</p>
            {combos.map((combo, idx) => (
              <button
                key={idx}
                onClick={() => onSelectCombo?.(combo)}
                className="w-full text-left px-3 py-2 mb-1 bg-gray-800 hover:bg-gray-700 rounded-lg active:scale-95 transition-all"
                style={{ borderLeft: `3px solid ${comboColor(combo.modality)}` }}
              >
                <div className="flex items-center justify-between">
                  <span className="text-white text-sm truncate mr-2">
                    {combo.aeTitle ?? combo.cpts.map(c => entries[c]?.description || c).join(' + ')}
                  </span>
                  <span className="text-xs font-bold shrink-0" style={{ color: comboColor(combo.modality) }}>COMBO ({combo.cpts.length})</span>
                </div>
              </button>
            ))}
          </div>
        )}

        {/* Protocols and their leaves */}
        <div className="divide-y divide-gray-800">
          {protocols.map(proto => (
            <div key={proto.protocol}>
              {protocols.length > 1 && (
                <div className="px-3 py-1.5 bg-gray-800/50">
                  <span className="text-gray-400 text-xs font-medium">{proto.protocol}</span>
                </div>
              )}

              {proto.leaves.map(leaf => {
                const rvu = gpci ? adjustedWorkRvu(leaf.entry, gpci) : (leaf.entry.workRvu ?? leaf.entry.pcRvu);
                const isCombo = leaf.comboCpts && leaf.comboCpts.length > 1;
                return (
                  <button
                    key={leaf.aeTitle ?? leaf.cpt}
                    onClick={() => onSelectLeaf(leaf)}
                    className="w-full px-3 py-3 flex items-center justify-between text-left active:bg-gray-800 transition-colors"
                  >
                    <div className="flex-1 mr-3">
                      <span className="text-white text-sm">{leaf.aeTitle ?? favNames?.get(leaf.cpt) ?? leaf.entry.description}</span>
                      {!leaf.aeTitle && !favNames?.get(leaf.cpt) && leaf.entry.variant && (
                        <span className="text-gray-400 text-xs ml-2">({leaf.entry.variant})</span>
                      )}
                    </div>
                    <div className="text-right shrink-0">
                      {isCombo ? (
                        <>
                          <div className="text-xs font-bold" style={{ color: comboColor(modality) }}>COMBO ({leaf.comboCpts!.length})</div>
                          <div className="text-gray-500 text-xs">{leaf.comboCpts!.join(', ')}</div>
                        </>
                      ) : (
                        <>
                          <div className="text-gray-400 text-xs">{leaf.cpt}</div>
                          <div className="text-blue-400 text-xs">{rvu} wRVU</div>
                        </>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
