interface Props {
  examDesc: string;
  onSignReport: () => void;
  disabled?: boolean;
}

export default function ActiveStudy({ examDesc, onSignReport, disabled }: Props) {
  return (
    <div className="min-h-screen bg-gray-900 flex flex-col items-center justify-center p-4">
      <div className="text-center space-y-4 mb-12">
        <div className="w-16 h-16 rounded-full bg-green-600/20 border-2 border-green-500 flex items-center justify-center mx-auto animate-pulse">
          <div className="w-4 h-4 rounded-full bg-green-500" />
        </div>
        <p className="text-gray-400 text-sm uppercase tracking-wide">Study in progress</p>
        <h2 className="text-xl font-bold text-white">{examDesc}</h2>
        <p className="text-gray-500 text-sm">Tap SIGN REPORT when done</p>
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
