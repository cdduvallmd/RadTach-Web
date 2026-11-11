// The personally-performed question on RadTach (owner, 2026-11-10): shown after
// a study is completed without the mark when a PVC rule with
// requiresPersonallyPerformed would credit more (e.g. FL at South, arthrograms
// at I-35). Yes adds the procedure bonus to the session's Bonus RVU (the
// study's wRVU stays as recorded, matching Epic); No adds nothing. Sits above the Stop dialog, which can't end the
// session until it's answered. Not shown on Sidecar.
import { useEffect, useState } from 'react';

export interface PpQuestion {
  studyId: string;
  name: string;   // exam name, in memory only (never persisted)
  rvu: number;    // wRVU as credited
  bonus: number;  // Bonus RVU if personally performed
}

export function PersonallyPerformedPrompt({
  question, remaining, belowEpicPanel, onAnswer,
}: {
  question: PpQuestion;
  remaining: number;
  belowEpicPanel: boolean; // the Midnight Protection box is up: sit below it (Clyde 261110 #2)
  onAnswer: (yes: boolean) => void;
}) {
  // Buttons wake after a moment, so a click meant for the previous question
  // can't answer this one (Clyde 261110 #1).
  const [ready, setReady] = useState(false);
  useEffect(() => { const t = setTimeout(() => setReady(true), 400); return () => clearTimeout(t); }, []);
  return (
    <div className={`fixed ${belowEpicPanel ? 'top-72' : 'top-24'} left-1/2 -translate-x-1/2 z-[60] w-[28rem] max-w-[95vw] bg-gray-800 border-2 border-emerald-500 rounded-xl shadow-2xl p-4`}>
      <h3 className="text-white font-semibold">Did you personally perform this procedure?</h3>
      <p className="text-gray-300 text-sm mt-1">
        {question.name || 'Last study'} ({question.rvu.toFixed(2)} wRVU).{' '}
        <span className="text-emerald-300">Yes adds {question.bonus.toFixed(2)} Bonus RVU.</span>
      </p>
      {remaining > 1 && <p className="text-gray-500 text-xs mt-1">{remaining - 1} more after this one.</p>}
      <div className="flex gap-2 mt-3">
        <button disabled={!ready} onClick={() => onAnswer(true)} className="flex-1 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-lg text-sm font-semibold">
          Yes, I performed it
        </button>
        <button disabled={!ready} onClick={() => onAnswer(false)} className="flex-1 py-2 bg-gray-600 hover:bg-gray-500 disabled:opacity-50 text-white rounded-lg text-sm font-semibold">
          No
        </button>
      </div>
    </div>
  );
}
