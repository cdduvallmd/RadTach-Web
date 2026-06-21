// Mirror of the types we need from src/types/reports.ts and src/types/pvc.ts.
// Functions/ runs in a separate runtime so we can't import from src/ directly.
// Keep these in sync manually; if drift becomes a problem, codegen from a
// shared schema later.

export interface StoredSession {
  sessionId: string;
  userId?: string;
  userAbbrev?: string;
  displayName?: string;
  system: string;
  rotation?: string;
  workstationId?: string;
  halfDay?: boolean;

  // Time fields (mix of ISO strings and Firestore Timestamps).
  startDateTime: string;
  stopDateTime?: string;
  startTime?: FirebaseFirestore.Timestamp;
  endTime?: FirebaseFirestore.Timestamp;

  // Counts and aggregates.
  totalSessionTime?: number;
  studiesCompleted?: number;
  deletedStudies?: number;
  cumulativeParTime?: number;
  interstitialTime?: number;
  adminTime?: number;
  adminEvents?: number;
  commsTime?: number;
  commsEvents?: number;
  breakTime?: number;
  breakEvents?: number;
  doubleTapTime?: number;
  doubleTapEvents?: number;
  swapEvents?: number;

  // RVU.
  totalRVU?: number;
  verifiedRVU?: number;

  // PVC fields.
  pvcShiftCredit?: number;
  pvcBonusRvu?: number;
  pvcRotationAtStart?: string;
  pvcWrvuOverride?: number;
  pvcMeetingHours?: number;
  pvcPendingClassification?: boolean;

  // Mode-enum cutover.
  _modeEnumPrimary?: boolean;

  // Orphan sweep marker (set by Function 3).
  _autoFinalized?: boolean;

  // Free-form.
  notes?: { tags?: string[]; text?: string };
  summary?: Record<string, unknown>;
}

export interface StaleMarker {
  id: string;
  system: string;
  date: string;
  reportedBy?: string;
  reportedAt?: FirebaseFirestore.Timestamp;
  claimedBy?: string;
  claimedAt?: FirebaseFirestore.Timestamp;
}
