// RadTach Cloud Functions — Phase 1 deploy.
// See /Users/charlesduvall/Documents/RadTach/cloud-functions-plan.md for the
// full design rationale and per-function rollout sequence.
//
// Functions ship in three states:
//   - orphanSessionSweep: ACTIVE at deploy (no flag dependency, no cohort gate)
//   - onStaleGarCreated + garNightlyBackstop: DORMANT (gated by useCloudGAR
//     feature flag + minimum-cohort-3 floor)
//   - generateCoachingBrief + disableCoachingOnBudget: DORMANT (gated by
//     coachingEnabled feature flag + per-user daily quota + Pub/Sub budget
//     killswitch)

import { initializeApp } from 'firebase-admin/app';

initializeApp();

export { orphanSessionSweep } from './orphanSweep';
export { onStaleGarCreated, garNightlyBackstop } from './garAggregation';
export { generateCoachingBrief, disableCoachingOnBudget } from './coaching';
