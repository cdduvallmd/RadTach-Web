interface Props {
  onSignReport: () => void;
  disabled?: boolean;
}

export default function SignReportButton({ onSignReport, disabled }: Props) {
  return (
    <div className="fixed bottom-0 left-0 right-0 p-3 bg-gray-900 border-t border-gray-800">
      <button
        onClick={onSignReport}
        disabled={disabled}
        className="w-full py-4 bg-red-600 hover:bg-red-700 active:bg-red-800 disabled:bg-gray-600 text-white font-bold text-lg rounded-xl transition-colors"
      >
        {disabled ? 'Sending...' : 'SIGN REPORT'}
      </button>
    </div>
  );
}
