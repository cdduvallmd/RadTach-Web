import type { SearchResult } from '../utils/cptSearch';
import { MODALITY_COLORS, comboColor } from '../utils/modalityColors';

interface Props {
  modalities: string[];
  onSelectModality: (mod: string) => void;
  comboCount: number;
  onOpenCombo: () => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  searchResults: SearchResult[];
  onSearchSelect: (result: SearchResult) => void;
  gooseConnected: boolean;
  pendingStop?: boolean;
  favNames?: Map<string, string>;
  syncLog?: string[];
  onOpenRecent: () => void;
  onOpenCommon: () => void;
  onOpenFavorites: () => void;
  favoritesCount: number;
  savedComboCount: number;
  onOpenSavedCombos: () => void;
}

export default function HomeScreen({
  modalities, onSelectModality,
  comboCount, onOpenCombo,
  searchQuery, onSearchChange, searchResults, onSearchSelect,
  gooseConnected, pendingStop, favNames, syncLog,
  onOpenRecent, onOpenCommon, onOpenFavorites, favoritesCount,
  savedComboCount, onOpenSavedCombos,
}: Props) {
  const showResults = searchQuery.trim().length > 0;

  return (
    <div className="min-h-screen bg-gray-900 flex flex-col">
      <div className="flex-1 p-3 pb-4">
        {/* Network lag indicator */}
        {pendingStop && (
          <div className="flex items-center justify-center gap-2 mb-2 py-1.5 bg-amber-900/40 rounded-lg">
            <div className="w-4 h-4 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
            <span className="text-amber-400 text-xs">Syncing...</span>
          </div>
        )}

        {/* Header with Goose indicator */}
        <div className="flex items-center justify-between mb-3">
          <h1 className="text-lg font-bold text-white flex-1 text-center">Select Modality</h1>
          {gooseConnected && (
            <div className="flex items-center gap-1.5 absolute right-4">
              <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
              <span className="text-green-400 text-xs font-medium">Goose</span>
            </div>
          )}
        </div>

        {/* Search input */}
        <div className="relative max-w-sm mx-auto mb-3">
          <input
            type="text"
            value={searchQuery}
            onChange={e => onSearchChange(e.target.value)}
            placeholder="Search exams or dictate..."
            className="w-full px-3 py-2.5 bg-gray-800 border border-gray-600 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:border-blue-500 text-sm"
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
          <div className="max-w-sm mx-auto space-y-1.5">
            {searchResults.length === 0 ? (
              <p className="text-gray-500 text-center text-sm mt-8">No results</p>
            ) : (
              searchResults.map((r, i) => (
                <button
                  key={r.cpt}
                  onClick={() => onSearchSelect(r)}
                  className={`w-full text-left p-2.5 rounded-lg transition-all active:scale-95 ${
                    i === 0
                      ? 'bg-gray-700 ring-2 ring-blue-500'
                      : 'bg-gray-800 hover:bg-gray-700'
                  }`}
                >
                  <div className="flex items-center gap-2 mb-0.5">
                    <span
                      className="text-xs font-bold px-1.5 py-0.5 rounded"
                      style={{ backgroundColor: MODALITY_COLORS[r.entry.modality] || '#6b7280', color: 'white' }}
                    >
                      {r.entry.modality}
                    </span>
                    <span className="text-gray-400 text-xs">{r.comboCpts ? r.comboCpts.join(', ') : r.cpt}</span>
                    {r.comboCpts && (
                      <span className="text-xs font-bold" style={{ color: comboColor(r.entry.modality) }}>COMBO</span>
                    )}
                    <span className="text-gray-500 text-xs ml-auto">{r.entry.bodyPart}</span>
                  </div>
                  <p className="text-white text-sm">{r.aeTitle ?? favNames?.get(r.cpt) ?? r.entry.description}</p>
                  {!r.aeTitle && r.entry.variant && (
                    <p className="text-gray-400 text-xs mt-0.5">{r.entry.variant}</p>
                  )}
                </button>
              ))
            )}
          </div>
        ) : (
          /* Default view: Recent, Common buttons + Modality grid */
          <>
            <div className="max-w-sm mx-auto space-y-2 mb-3">
              <button
                onClick={onOpenRecent}
                className="w-full py-3 bg-gray-700 hover:bg-gray-600 text-white font-bold text-base rounded-xl active:scale-95 transition-transform"
              >
                RECENT
              </button>
              <button
                onClick={onOpenCommon}
                className="w-full py-3 bg-gray-700 hover:bg-gray-600 text-white font-bold text-base rounded-xl active:scale-95 transition-transform"
              >
                COMMON
              </button>
              {favoritesCount > 0 && (
                <button
                  onClick={onOpenFavorites}
                  className="w-full py-3 bg-indigo-700 hover:bg-indigo-600 text-white font-bold text-base rounded-xl active:scale-95 transition-transform"
                >
                  FAVORITES ({favoritesCount})
                </button>
              )}
              {savedComboCount > 0 && (
                <button
                  onClick={onOpenSavedCombos}
                  className="w-full py-3 bg-amber-700 hover:bg-amber-600 text-white font-bold text-base rounded-xl active:scale-95 transition-transform"
                >
                  COMBOS ({savedComboCount})
                </button>
              )}
            </div>

            <div className="grid grid-cols-2 gap-2.5 max-w-sm mx-auto">
              {modalities.map(mod => (
                <button
                  key={mod}
                  onClick={() => onSelectModality(mod)}
                  className="py-4 rounded-xl text-white font-bold text-base active:scale-95 transition-transform"
                  style={{ backgroundColor: MODALITY_COLORS[mod] || '#6b7280' }}
                >
                  {mod}
                </button>
              ))}
            </div>

            {comboCount > 0 && (
              <button
                onClick={onOpenCombo}
                className="mt-4 w-full max-w-sm mx-auto block py-2.5 bg-amber-600 hover:bg-amber-700 text-white font-semibold rounded-lg text-center text-sm"
              >
                View Combo ({comboCount} exam{comboCount !== 1 ? 's' : ''})
              </button>
            )}
          </>
        )}
      </div>
      {/* Sync log */}
      {syncLog && syncLog.length > 0 && (
        <details className="p-2 border-t border-gray-800">
          <summary className="text-gray-600 text-xs cursor-pointer select-none">Sync Log ({syncLog.length})</summary>
          <div className="mt-1 max-h-32 overflow-y-auto text-xs font-mono space-y-0.5">
            {syncLog.map((line, i) => (
              <div key={i} className={`${line.includes('FAIL') ? 'text-red-400' : line.includes('OK') ? 'text-green-400' : 'text-gray-500'}`}>
                {line}
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
