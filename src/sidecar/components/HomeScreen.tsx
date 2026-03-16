import SignReportButton from './SignReportButton';
import type { SearchResult } from '../utils/cptSearch';

const MODALITY_COLORS: Record<string, string> = {
  CT: '#3b82f6',    // blue
  MR: '#8b5cf6',    // purple
  XR: '#10b981',    // green
  US: '#f59e0b',    // amber
  FL: '#ec4899',    // pink
  NM: '#06b6d4',    // cyan
  MA: '#f97316',    // orange
  'PET-CT': '#ef4444', // red
};

interface Props {
  modalities: string[];
  onSelectModality: (mod: string) => void;
  onSignReport: () => void;
  comboCount: number;
  onOpenCombo: () => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  searchResults: SearchResult[];
  onSearchSelect: (cpt: string) => void;
  gooseConnected: boolean;
}

export default function HomeScreen({
  modalities, onSelectModality, onSignReport,
  comboCount, onOpenCombo,
  searchQuery, onSearchChange, searchResults, onSearchSelect,
  gooseConnected,
}: Props) {
  const showResults = searchQuery.trim().length > 0;

  return (
    <div className="min-h-screen bg-gray-900 flex flex-col">
      <div className="flex-1 p-4 pb-24">
        {/* Header with Goose indicator */}
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-xl font-bold text-white flex-1 text-center">Select Modality</h1>
          {gooseConnected && (
            <div className="flex items-center gap-1.5 absolute right-4">
              <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
              <span className="text-green-400 text-xs font-medium">Goose</span>
            </div>
          )}
        </div>

        {/* Search input */}
        <div className="relative max-w-sm mx-auto mb-4">
          <input
            type="text"
            value={searchQuery}
            onChange={e => onSearchChange(e.target.value)}
            placeholder="Search exams or dictate..."
            className="w-full px-4 py-3 bg-gray-800 border border-gray-600 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:border-blue-500 text-base"
          />
          {searchQuery && (
            <button
              onClick={() => onSearchChange('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-white text-lg"
            >
              &times;
            </button>
          )}
        </div>

        {showResults ? (
          /* Search results list */
          <div className="max-w-sm mx-auto space-y-2">
            {searchResults.length === 0 ? (
              <p className="text-gray-500 text-center text-sm mt-8">No results</p>
            ) : (
              searchResults.map((r, i) => (
                <button
                  key={r.cpt}
                  onClick={() => onSearchSelect(r.cpt)}
                  className={`w-full text-left p-3 rounded-lg transition-all active:scale-95 ${
                    i === 0
                      ? 'bg-gray-700 ring-2 ring-blue-500'
                      : 'bg-gray-800 hover:bg-gray-700'
                  }`}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <span
                      className="text-xs font-bold px-1.5 py-0.5 rounded"
                      style={{ backgroundColor: MODALITY_COLORS[r.entry.modality] || '#6b7280', color: 'white' }}
                    >
                      {r.entry.modality}
                    </span>
                    <span className="text-gray-400 text-xs">{r.cpt}</span>
                    <span className="text-gray-500 text-xs ml-auto">{r.entry.bodyPart}</span>
                  </div>
                  <p className="text-white text-sm">{r.entry.description}</p>
                  {r.entry.variant && (
                    <p className="text-gray-400 text-xs mt-0.5">{r.entry.variant}</p>
                  )}
                </button>
              ))
            )}
          </div>
        ) : (
          /* Modality grid (default view) */
          <>
            <div className="grid grid-cols-2 gap-3 max-w-sm mx-auto">
              {modalities.map(mod => (
                <button
                  key={mod}
                  onClick={() => onSelectModality(mod)}
                  className="py-6 rounded-xl text-white font-bold text-lg active:scale-95 transition-transform"
                  style={{ backgroundColor: MODALITY_COLORS[mod] || '#6b7280' }}
                >
                  {mod}
                </button>
              ))}
            </div>

            {comboCount > 0 && (
              <button
                onClick={onOpenCombo}
                className="mt-6 w-full max-w-sm mx-auto block py-3 bg-amber-600 hover:bg-amber-700 text-white font-semibold rounded-lg text-center"
              >
                View Combo ({comboCount} exam{comboCount !== 1 ? 's' : ''})
              </button>
            )}
          </>
        )}
      </div>

      <SignReportButton onSignReport={onSignReport} />
    </div>
  );
}
