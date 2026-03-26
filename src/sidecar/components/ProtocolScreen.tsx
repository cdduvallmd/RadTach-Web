import type { ProtocolGroup, TreeLeaf } from '../utils/buildCptTree';
import type { GpciValues } from '../../utils/gpciLookup';
import { adjustedWorkRvu } from '../../utils/gpciLookup';
import SignReportButton from './SignReportButton';

interface Props {
  modality: string;
  bodyPart: string;
  protocols: ProtocolGroup[];
  gpci?: GpciValues;
  onSelectLeaf: (leaf: TreeLeaf) => void;
  onBack: () => void;
  onSignReport: () => void;
}

export default function ProtocolScreen({ modality, bodyPart, protocols, gpci, onSelectLeaf, onBack, onSignReport }: Props) {
  return (
    <div className="min-h-screen bg-gray-900 flex flex-col">
      <div className="flex-1 pb-24">
        {/* Header */}
        <div className="flex items-center p-4 border-b border-gray-800">
          <button onClick={onBack} className="text-blue-400 mr-3 text-lg">&larr;</button>
          <div>
            <h1 className="text-xl font-bold text-white">{bodyPart}</h1>
            <p className="text-gray-500 text-sm">{modality}</p>
          </div>
        </div>

        {/* Protocols and their leaves */}
        <div className="divide-y divide-gray-800">
          {protocols.map(proto => (
            <div key={proto.protocol}>
              {/* Protocol header (only show if multiple protocols or protocol name differs from leaves) */}
              {protocols.length > 1 && (
                <div className="px-4 py-2 bg-gray-800/50">
                  <span className="text-gray-400 text-sm font-medium">{proto.protocol}</span>
                </div>
              )}

              {/* Leaves within protocol */}
              {proto.leaves.map(leaf => {
                const rvu = gpci ? adjustedWorkRvu(leaf.entry, gpci) : (leaf.entry.workRvu ?? leaf.entry.pcRvu);
                return (
                  <button
                    key={leaf.cpt}
                    onClick={() => onSelectLeaf(leaf)}
                    className="w-full px-4 py-4 flex items-center justify-between text-left active:bg-gray-800 transition-colors"
                  >
                    <div className="flex-1 mr-3">
                      <span className="text-white text-base">{leaf.entry.description}</span>
                      {leaf.entry.variant && (
                        <span className="text-gray-400 text-sm ml-2">({leaf.entry.variant})</span>
                      )}
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-gray-400 text-sm">{leaf.cpt}</div>
                      <div className="text-blue-400 text-sm">{rvu} wRVU</div>
                    </div>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      <SignReportButton onSignReport={onSignReport} />
    </div>
  );
}
