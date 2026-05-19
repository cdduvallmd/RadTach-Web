import { useState, useEffect, useRef } from 'react';

interface Props {
  examDesc: string;
  onSignReport: () => void;
  disabled?: boolean;
}

export default function ActiveStudy({ examDesc, onSignReport, disabled }: Props) {
  const [elapsed, setElapsed] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    setElapsed(0);
    intervalRef.current = setInterval(() => setElapsed(prev => prev + 1), 1000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [examDesc]);

  const min = Math.floor(elapsed / 60);
  const sec = elapsed % 60;

  return (
    <div className="min-h-screen bg-gray-900 flex flex-col items-center justify-center p-4">
      <div className="text-center space-y-4 mb-12">
        <div className="w-16 h-16 rounded-full bg-green-600/20 border-2 border-green-500 flex items-center justify-center mx-auto animate-pulse">
          <div className="w-4 h-4 rounded-full bg-green-500" />
        </div>
        <p className="text-gray-400 text-sm uppercase tracking-wide">Study in progress</p>
        <h2 className="text-xl font-bold text-white">{examDesc}</h2>
        <div className="text-4xl font-mono font-bold text-green-400">
          {min}:{String(sec).padStart(2, '0')}
        </div>
      </div>

      <button
        onClick={onSignReport}
        disabled={disabled}
        className="w-full max-w-sm py-5 bg-red-600 hover:bg-red-700 active:bg-red-800 disabled:bg-gray-600 text-white font-bold text-xl rounded-xl transition-colors"
      >
        {disabled ? 'Sending...' : 'SIGN REPORT'}
      </button>
    </div>
  );
}
