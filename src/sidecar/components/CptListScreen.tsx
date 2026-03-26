import type { CptEntry } from '../../types/cpt';
import type { RecentEntry } from '../SidecarMain';

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
  cpts?: string[];
  recentEntries?: RecentEntry[];
  entries: Record<string, CptEntry>;
  onSelect?: (cpt: string) => void;
  onSelectRecent?: (entry: RecentEntry) => void;
  onBack: () => void;
}

function SingleCptButton({ cpt, entry, onClick }: { cpt: string; entry: CptEntry; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="w-full text-left p-2.5 bg-gray-800 hover:bg-gray-700 rounded-lg active:scale-95 transition-all"
    >
      <div className="flex items-center gap-2 mb-0.5">
        <span
          className="text-xs font-bold px-1.5 py-0.5 rounded"
          style={{ backgroundColor: MODALITY_COLORS[entry.modality] || '#6b7280', color: 'white' }}
        >
          {entry.modality}
        </span>
        <span className="text-gray-400 text-xs">{cpt}</span>
        <span className="text-gray-500 text-xs ml-auto">{entry.bodyPart}</span>
      </div>
      <p className="text-white text-sm">{entry.description}</p>
      {entry.variant && (
        <p className="text-gray-400 text-xs mt-0.5">{entry.variant}</p>
      )}
    </button>
  );
}

export default function CptListScreen({ title, cpts, recentEntries, entries, onSelect, onSelectRecent, onBack }: Props) {
  // Recent mode: render from RecentEntry[]
  if (recentEntries && onSelectRecent) {
    const validEntries = recentEntries.filter(re => re.cpts.every(c => entries[c]));

    return (
      <div className="min-h-screen bg-gray-900 flex flex-col">
        <div className="flex-1 p-3 pb-4">
          <div className="flex items-center mb-4 max-w-sm mx-auto">
            <button onClick={onBack} className="text-blue-400 hover:text-blue-300 text-sm mr-3">&larr; Back</button>
            <h1 className="text-lg font-bold text-white">{title}</h1>
          </div>

          {validEntries.length === 0 ? (
            <p className="text-gray-500 text-center text-sm mt-12">No recent exams yet.</p>
          ) : (
            <div className="max-w-sm mx-auto space-y-1.5">
              {validEntries.map((re, idx) => {
                const isCombo = re.cpts.length > 1;

                if (!isCombo) {
                  const cpt = re.cpts[0];
                  const e = entries[cpt];
                  return (
                    <SingleCptButton key={`${idx}-${cpt}`} cpt={cpt} entry={e} onClick={() => onSelectRecent(re)} />
                  );
                }

                // Combo entry — stacked CPTs with left accent border
                return (
                  <button
                    key={`${idx}-combo`}
                    onClick={() => onSelectRecent(re)}
                    className="w-full text-left p-2.5 bg-gray-800 hover:bg-gray-700 rounded-lg active:scale-95 transition-all"
                    style={{ borderLeft: '3px solid #f59e0b' }}
                  >
                    {re.cpts.map((cpt, ci) => {
                      const e = entries[cpt];
                      return (
                        <div key={cpt} className={ci > 0 ? 'mt-1.5 pt-1.5 border-t border-gray-700' : ''}>
                          <div className="flex items-center gap-2 mb-0.5">
                            <span
                              className="text-xs font-bold px-1.5 py-0.5 rounded"
                              style={{ backgroundColor: MODALITY_COLORS[e.modality] || '#6b7280', color: 'white' }}
                            >
                              {e.modality}
                            </span>
                            <span className="text-gray-400 text-xs">{cpt}</span>
                            {ci === 0 && (
                              <span className="text-xs font-bold px-1.5 py-0.5 rounded ml-auto"
                                style={{ backgroundColor: '#f59e0b', color: '#000' }}>
                                COMBO ({re.cpts.length})
                              </span>
                            )}
                            {ci > 0 && (
                              <span className="text-gray-500 text-xs ml-auto">{e.bodyPart}</span>
                            )}
                          </div>
                          <p className="text-white text-sm">{e.description}</p>
                          {e.variant && (
                            <p className="text-gray-400 text-xs mt-0.5">{e.variant}</p>
                          )}
                        </div>
                      );
                    })}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    );
  }

  // Common mode: render from string[]
  const valid = (cpts || []).filter(c => entries[c]);

  return (
    <div className="min-h-screen bg-gray-900 flex flex-col">
      <div className="flex-1 p-3 pb-4">
        <div className="flex items-center mb-4 max-w-sm mx-auto">
          <button onClick={onBack} className="text-blue-400 hover:text-blue-300 text-sm mr-3">&larr; Back</button>
          <h1 className="text-lg font-bold text-white">{title}</h1>
        </div>

        {valid.length === 0 ? (
          <p className="text-gray-500 text-center text-sm mt-12">No exams configured.</p>
        ) : (
          <div className="max-w-sm mx-auto space-y-1.5">
            {valid.map(cpt => {
              const e = entries[cpt];
              return (
                <SingleCptButton key={cpt} cpt={cpt} entry={e} onClick={() => onSelect?.(cpt)} />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
