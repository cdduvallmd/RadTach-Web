// Per-function feature flag reads. All flags live at Config/featureFlags.
// Defaults to off on read failure — never throw out of a flag check, since
// flag reads gate the entire function body.

import { getFirestore } from 'firebase-admin/firestore';

export interface FeatureFlags {
  useModeEnumAsPrimary: boolean;  // mode-enum cutover Phase 1
  useCloudGAR: boolean;            // gates GAR functions (1+2)
  coachingEnabled: boolean;        // gates coaching brief (function 4)
  cloudOrphanSweepEnabled: boolean; // gates orphan sweep (function 3); default true
}

const DEFAULTS: FeatureFlags = {
  useModeEnumAsPrimary: false,
  useCloudGAR: false,
  coachingEnabled: false,
  cloudOrphanSweepEnabled: true,
};

export async function readFlags(): Promise<FeatureFlags> {
  try {
    const snap = await getFirestore().collection('Config').doc('featureFlags').get();
    if (!snap.exists) return DEFAULTS;
    const data = snap.data() ?? {};
    return {
      useModeEnumAsPrimary: data.useModeEnumAsPrimary === true,
      useCloudGAR: data.useCloudGAR === true,
      coachingEnabled: data.coachingEnabled === true,
      // Default true unless explicitly disabled — orphan sweep ships active
      cloudOrphanSweepEnabled: data.cloudOrphanSweepEnabled !== false,
    };
  } catch (err) {
    console.warn('Feature flag read failed; using defaults:', err);
    return DEFAULTS;
  }
}
