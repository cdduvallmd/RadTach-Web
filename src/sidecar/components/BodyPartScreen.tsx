import type { ModalityGroup, TreeLeaf } from '../utils/buildCptTree';
import type { SavedCombo } from '../SidecarMain';
import type { CptEntry } from '../../types/cpt';
import { comboColor } from '../utils/modalityColors';

interface Props {
  modality: string;
  group: ModalityGroup;
  savedCombos?: SavedCombo[];
  entries?: Record<string, CptEntry>;
  onSelectBodyPart: (bp: string, leaf: TreeLeaf | null) => void;
  onSelectCombo?: (combo: SavedCombo) => void;
  onBack: () => void;
}

export default function BodyPartScreen({ modality, group, savedCombos, entries, onSelectBodyPart, onSelectCombo, onBack }: Props) {
  const combos = savedCombos?.filter(c => entries && c.cpts.every(cpt => entries[cpt])) ?? [];

  return (
    <div className="min-h-screen bg-gray-900 flex flex-col">
      <div className="flex-1 pb-4">
        {/* Header */}
        <div className="flex items-center p-3 border-b border-gray-800">
          <button onClick={onBack} className="text-blue-400 mr-3 text-lg">&larr;</button>
          <h1 className="text-lg font-bold text-white">{modality}</h1>
        </div>

        {/* Saved combos */}
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
                    {combo.cpts.map(c => entries[c]?.description || c).join(' + ')}
                  </span>
                  <span className="text-xs font-bold shrink-0" style={{ color: comboColor(combo.modality) }}>COMBO ({combo.cpts.length})</span>
                </div>
              </button>
            ))}
          </div>
        )}

        {/* Body part list */}
        <div className="divide-y divide-gray-800">
          {group.bodyParts.map(bp => (
            <button
              key={bp.bodyPart}
              onClick={() => onSelectBodyPart(bp.bodyPart, bp.isLeaf ? bp.leafEntry! : null)}
              className="w-full px-4 py-3 flex items-center justify-between text-left active:bg-gray-800 transition-colors"
            >
              <span className="text-white text-sm">{bp.bodyPart}</span>
              {bp.isLeaf ? (
                <span className="text-gray-500 text-xs">{bp.leafEntry!.cpt}</span>
              ) : (
                <span className="text-gray-500">&rsaquo;</span>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
