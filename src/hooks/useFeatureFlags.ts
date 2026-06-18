// Phase 1 of the mode-enum cutover (see mode-enum-cutover-plan.md).
// Reads Config/featureFlags via real-time snapshot and returns current flag state.
// Defaults to all-flags-off when the doc is missing or unreadable.

import { useEffect, useState } from 'react';
import { firestoreService } from '../services/firestore';

export interface FeatureFlags {
  useModeEnumAsPrimary: boolean;
}

const DEFAULT_FLAGS: FeatureFlags = {
  useModeEnumAsPrimary: false,
};

export function useFeatureFlags(): FeatureFlags {
  const [flags, setFlags] = useState<FeatureFlags>(DEFAULT_FLAGS);

  useEffect(() => {
    const unsub = firestoreService.subscribeFeatureFlags((next) => {
      setFlags(next);
    });
    return () => unsub();
  }, []);

  return flags;
}
