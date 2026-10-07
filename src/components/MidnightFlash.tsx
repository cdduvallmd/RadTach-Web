// A full-window flashing red layer that clicks pass through (Midnight
// Protection). Shown on RadTach and Sidecar so any visible part of either
// window catches the eye; acknowledged on RadTach's Epic box.
export function MidnightFlash({ active }: { active: boolean }) {
  if (!active) return null;
  return (
    <>
      <style>{`
        @keyframes midnight-flash { 0%, 100% { opacity: 0; } 50% { opacity: 0.45; } }
      `}</style>
      <div
        aria-hidden
        style={{
          position: 'fixed', inset: 0, zIndex: 40, pointerEvents: 'none',
          background: '#dc2626', animation: 'midnight-flash 1.2s ease-in-out infinite',
        }}
      />
    </>
  );
}
