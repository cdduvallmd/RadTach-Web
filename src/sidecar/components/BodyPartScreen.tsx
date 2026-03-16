import type { ModalityGroup, TreeLeaf } from '../utils/buildCptTree';
import SignReportButton from './SignReportButton';

interface Props {
  modality: string;
  group: ModalityGroup;
  onSelectBodyPart: (bp: string, leaf: TreeLeaf | null) => void;
  onBack: () => void;
  onSignReport: () => void;
}

export default function BodyPartScreen({ modality, group, onSelectBodyPart, onBack, onSignReport }: Props) {
  return (
    <div className="min-h-screen bg-gray-900 flex flex-col">
      <div className="flex-1 pb-24">
        {/* Header */}
        <div className="flex items-center p-4 border-b border-gray-800">
          <button onClick={onBack} className="text-blue-400 mr-3 text-lg">&larr;</button>
          <h1 className="text-xl font-bold text-white">{modality}</h1>
        </div>

        {/* Body part list */}
        <div className="divide-y divide-gray-800">
          {group.bodyParts.map(bp => (
            <button
              key={bp.bodyPart}
              onClick={() => onSelectBodyPart(bp.bodyPart, bp.isLeaf ? bp.leafEntry! : null)}
              className="w-full px-4 py-4 flex items-center justify-between text-left active:bg-gray-800 transition-colors"
            >
              <span className="text-white text-base">{bp.bodyPart}</span>
              {bp.isLeaf ? (
                <span className="text-gray-500 text-sm">{bp.leafEntry!.cpt}</span>
              ) : (
                <span className="text-gray-500">&rsaquo;</span>
              )}
            </button>
          ))}
        </div>
      </div>

      <SignReportButton onSignReport={onSignReport} />
    </div>
  );
}
