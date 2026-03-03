import { useState, useCallback } from 'react';

export type HealthStatus = 'green' | 'yellow' | 'red';
export type ErrorCode = null | 101 | 102;

export interface FirestoreHealth {
  status: HealthStatus;
  pendingCount: number;
  consecutiveFailures: number;
  errorCode: ErrorCode;
  hasPendingOnExit: boolean;
  reportSuccess(): void;
  reportFailure(canRead: boolean): void;
  dismissError(): void;
  setHasPendingOnExit(val: boolean): void;
  setPendingCount(count: number): void;
}

export function useFirestoreHealth(): FirestoreHealth {
  const [status, setStatus] = useState<HealthStatus>('green');
  const [pendingCount, setPendingCount] = useState(0);
  const [consecutiveFailures, setConsecutiveFailures] = useState(0);
  const [errorCode, setErrorCode] = useState<ErrorCode>(null);
  const [hasPendingOnExit, setHasPendingOnExit] = useState(false);

  const reportSuccess = useCallback(() => {
    setConsecutiveFailures(0);
    setErrorCode(null);
    setPendingCount(prev => {
      // Caller may also call setPendingCount separately; this just trends toward green
      if (prev <= 0) setStatus('green');
      else setStatus('yellow');
      return prev;
    });
  }, []);

  const reportFailure = useCallback((canRead: boolean) => {
    setConsecutiveFailures(prev => {
      const next = prev + 1;
      if (next >= 2) {
        setStatus('red');
        // Only set error code once (on the 2nd consecutive failure)
        setErrorCode(current => current ?? (canRead ? 102 : 101));
      }
      return next;
    });
  }, []);

  const dismissError = useCallback(() => {
    setErrorCode(null);
  }, []);

  return {
    status,
    pendingCount,
    consecutiveFailures,
    errorCode,
    hasPendingOnExit,
    reportSuccess,
    reportFailure,
    dismissError,
    setHasPendingOnExit,
    setPendingCount,
  };
}
