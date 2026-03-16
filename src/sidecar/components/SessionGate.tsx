import { useState, useEffect } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { listenToSessionStatus, listenToCommandDoc } from '../services/sidecarFirestore';
import { connectToGoose, type GooseMessage } from '../services/gooseWebSocket';
import SidecarMain from '../SidecarMain';

type SessionState = 'loading' | 'waiting' | 'active' | 'ended';

export default function SessionGate() {
  const { currentUser, logout } = useAuth();
  const [state, setState] = useState<SessionState>('loading');
  const [connectionError, setConnectionError] = useState(false);
  const [gooseConnected, setGooseConnected] = useState(false);

  useEffect(() => {
    if (!currentUser) return;

    const handleError = () => setConnectionError(true);

    const unsubStatus = listenToSessionStatus(currentUser.uid, (active) => {
      setConnectionError(false);
      if (active) {
        setState('active');
      } else {
        // Only show waiting if we haven't received session_ended
        setState(prev => prev === 'ended' ? 'ended' : 'waiting');
      }
    }, handleError);

    // Listen for session_ended command (arrives before status change to avoid waiting→ended flash)
    const unsubCmd = listenToCommandDoc(currentUser.uid, (cmd) => {
      setConnectionError(false);
      if (cmd?.action === 'session_ended') {
        setState('ended');
      }
    }, handleError);

    return () => {
      unsubStatus();
      unsubCmd();
    };
  }, [currentUser]);

  // Goose WebSocket connection
  useEffect(() => {
    const cleanup = connectToGoose(
      (msg: GooseMessage) => {
        // Route stop commands directly (works from any screen state)
        if (msg.action === 'stop' && currentUser) {
          // Let SidecarMain handle via window handler if active, otherwise handle here
          const handler = (window as unknown as Record<string, unknown>).__gooseHandler as
            ((msg: GooseMessage) => void) | undefined;
          if (handler) {
            handler(msg);
          }
        } else if (msg.action === 'search') {
          // Route search to SidecarMain via window handler
          const handler = (window as unknown as Record<string, unknown>).__gooseHandler as
            ((msg: GooseMessage) => void) | undefined;
          if (handler) {
            handler(msg);
          }
        }
      },
      setGooseConnected,
    );
    return cleanup;
  }, [currentUser]);

  if (state === 'loading') {
    return <div className="min-h-screen bg-gray-900" />;
  }

  if (state === 'waiting') {
    return (
      <div className="min-h-screen bg-gray-900 flex flex-col items-center justify-center p-4">
        <div className="text-center space-y-4">
          {connectionError ? (
            <>
              <div className="w-12 h-12 rounded-full bg-red-600/20 border-2 border-red-500 flex items-center justify-center mx-auto">
                <span className="text-red-400 text-xl">!</span>
              </div>
              <p className="text-red-400 text-lg">Connection lost</p>
              <p className="text-gray-500 text-sm">Check your network and try refreshing</p>
            </>
          ) : (
            <>
              <div className="w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto" />
              <p className="text-white text-lg">Waiting for RadTach session...</p>
              <p className="text-gray-500 text-sm">Start a session on your desktop to begin</p>
            </>
          )}
        </div>
        {gooseConnected && (
          <div className="mt-4 flex items-center gap-1.5">
            <div className="w-2 h-2 rounded-full bg-green-400" />
            <span className="text-green-400 text-xs">Goose connected</span>
          </div>
        )}
        <button
          onClick={() => setState('active')}
          className="mt-8 px-5 py-2 border border-gray-600 text-gray-400 hover:text-white hover:border-gray-400 rounded-lg text-sm"
        >
          Test Mode
        </button>
        <button
          onClick={logout}
          className="mt-4 text-gray-500 hover:text-gray-300 text-sm underline"
        >
          Sign out
        </button>
      </div>
    );
  }

  if (state === 'ended') {
    return (
      <div className="min-h-screen bg-gray-900 flex flex-col items-center justify-center p-4">
        <div className="text-center space-y-4">
          <div className="w-12 h-12 rounded-full bg-green-600 flex items-center justify-center mx-auto">
            <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <p className="text-white text-lg">Session completed</p>
          <p className="text-gray-400 text-sm">Start a new session in RadTach to resume</p>
        </div>
        <button
          onClick={() => { setState('waiting'); }}
          className="mt-8 px-6 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm"
        >
          Wait for next session
        </button>
        <button
          onClick={logout}
          className="mt-4 text-gray-500 hover:text-gray-300 text-sm underline"
        >
          Sign out
        </button>
      </div>
    );
  }

  // state === 'active'
  return <SidecarMain gooseConnected={gooseConnected} />;
}
