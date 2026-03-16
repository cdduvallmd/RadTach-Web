import type { CptEntry } from '../../types/cpt';
import SignReportButton from './SignReportButton';

const MODALITY_COLORS: Record<string, string> = {
  CT: '#3b82f6',
  MR: '#8b5cf6',
  XR: '#10b981',
  US: '#f59e0b',
  FL: '#ec4899',
  NM: '#06b6d4',
  MA: '#f97316',
  'PET-CT': '#ef4444',
};

interface Props {
  title: string;
  cpts: string[];
  entries: Record<string, CptEntry>;
  onSelect: (cpt: string) => void;
  onBack: () => void;
  onSignReport: () => void;
}

export default function CptListScreen({ title, cpts, entries, onSelect, onBack, onSignReport }: Props) {
  const valid = cpts.filter(c => entries[c]);

  return (
    <div className="min-h-screen bg-gray-900 flex flex-col">
      <div className="flex-1 p-4 pb-24">
        <div className="flex items-center mb-6 max-w-sm mx-auto">
          <button onClick={onBack} className="text-blue-400 hover:text-blue-300 text-sm mr-3">&larr; Back</button>
          <h1 className="text-xl font-bold text-white">{title}</h1>
        </div>

        {valid.length === 0 ? (
          <p className="text-gray-500 text-center text-sm mt-12">
            {title === 'Recent' ? 'No recent exams yet.' : 'No exams configured.'}
          </p>
        ) : (
          <div className="max-w-sm mx-auto space-y-2">
            {valid.map(cpt => {
              const e = entries[cpt];
              return (
                <button
                  key={cpt}
                  onClick={() => onSelect(cpt)}
                  className="w-full text-left p-3 bg-gray-800 hover:bg-gray-700 rounded-lg active:scale-95 transition-all"
                >
                  <div className="flex items-center gap-2 mb-1">
                    <span
                      className="text-xs font-bold px-1.5 py-0.5 rounded"
                      style={{ backgroundColor: MODALITY_COLORS[e.modality] || '#6b7280', color: 'white' }}
                    >
                      {e.modality}
                    </span>
                    <span className="text-gray-400 text-xs">{cpt}</span>
                    <span className="text-gray-500 text-xs ml-auto">{e.bodyPart}</span>
                  </div>
                  <p className="text-white text-sm">{e.description}</p>
                  {e.variant && (
                    <p className="text-gray-400 text-xs mt-0.5">{e.variant}</p>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <SignReportButton onSignReport={onSignReport} />
    </div>
  );
}
