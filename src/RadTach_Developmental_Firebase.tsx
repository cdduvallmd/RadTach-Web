import { useState, useEffect, useRef } from "react";
import { updateProfile } from 'firebase/auth';
import { firestoreService } from './services/firestore';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { migrateLocalStorageToFirestore } from './utils/migration';
import { computeSessionSummary } from './utils/sessionSummary';
import type { SessionSummary } from './utils/sessionSummary';
import Reports from './components/Reports';
import { triggerGARAggregation } from './utils/garTrigger';
import { calculateComboRvu, getBilateralRvu } from './utils/cptLookup';
import { lookupGpci } from './utils/gpciLookup';
import type { GpciValues } from './utils/gpciLookup';
import type { SidecarCommand, RvuSource } from './types/sidecar';
import type { CptDatabase } from './types/cpt';
import { bufferedCreateSession, bufferedFlushEvents, bufferedEndSession, bufferedSaveUserSettings, flushBuffer, hasPendingEndSession, addLocalEvent, getLocalEvents, clearLocalEvents } from './services/offlineBuffer';
import { reconstructSessionData } from './utils/sessionRecovery';
import { useFirestoreHealth } from './hooks/useFirestoreHealth';
import { useTimerMode } from './hooks/useTimerMode';
import { BUILD_ID } from './buildId';

// ============================================================================
// EXTERNAL INTEGRATION CONTRACT — HL7 / Middleware Interface
// See RadTach/HL7_PARSER.md for full design, reference implementation,
// architecture rationale, security audit checklist, and IT pitch strategy.
//
// Hook points in this file:
//   setSelectedModality()  — modality selection
//   toggleTimer()          — start/pause study timer
//   completeStudy()        — finish study, record event
//   toggleDoubleTap()      — reopened study tracking
// ============================================================================

// Type definitions
type Modality = 'XR' | 'FL' | 'CT' | 'US' | 'MR' | 'NM' | 'MA' | 'PET-CT';
type Complication = 'Cancer Follow' | '+1 Section' | '+2 Section' | 'Multiple Priors' |
  'Age >70' | 'Complex Hx' | 'Prior Surg Hx' | 'CTA' | 'Bilateral' | 'Vascular';

interface ParTimesConfig {
  [key: string]: number;
}

interface RVUConfig {
  [key: string]: number | { [modality: string]: number };
}

interface LastStudyData {
  variance: number;
  rvu: number;
  streakBefore: number;
  elapsedTime: number;
}

interface DraftStudyData {
  modality: Modality | null;
  complications: Complication[];
  currentTime: number;
  parTime: number;
}

// Event types for session recording (Issue #1)
interface StudyEvent {
  type: 'STUDY';
  studyNumber: number;
  startTimeSession: number;
  startTimeSystem: string;
  modality: Modality;
  complications: Complication[];
  parTime: number;
  elapsedTime: number;
  variance: number;
  rvu: number;
  pauseTime: number;
  pauseUsed: boolean;
  drafted: boolean;
  swapped?: boolean;
  rvuSource?: RvuSource;
  cpts?: string[];
  rvuDerivedMode?: boolean;
  targetRvuPerHour?: number;
}

interface InterstitialEvent {
  type: 'INTERSTITIAL';
  startTimeSession: number;
  startTimeSystem: string;
  endTimeSession: number;
  endTimeSystem: string;
  duration: number;
}

interface TimerEvent {
  type: 'ADMIN' | 'COMMS' | 'BREAK' | 'DOUBLE_TAP';
  startTimeSession: number;
  startTimeSystem: string;
  endTimeSession: number;
  endTimeSystem: string;
  duration: number;
  associatedModality?: Modality | null; // For DOUBLE_TAP events
}

type SessionEvent = StudyEvent | InterstitialEvent | TimerEvent;

type SessionTag = 'No Comment' | 'Good Day' | 'Not Feeling It Today' | 'Network & Application Interference' |
  'Low Volume = Low Productivity' | 'Real World Intrusion' | 'High Volume' | 'Short Staffed';

interface SessionNotes {
  tags: SessionTag[];
  description: string;
}

interface SessionData {
  sessionId: string;
  userAbbrev: string;
  workstationId: string;
  system: string;
  rotation: string;
  halfDay: boolean;
  startDateTime: string;
  stopDateTime: string;
  totalSessionTime: number;
  studiesCompleted: number;
  deletedStudies: number;
  cumulativeParTime: number;
  interstitialTime: number;
  adminTime: number;
  adminEvents: number;
  commsTime: number;
  commsEvents: number;
  breakTime: number;
  breakEvents: number;
  doubleTapTime: number;
  doubleTapEvents: number;
  swapEvents: number;
  totalRVU: number;
  verifiedRVU?: number | null;
  displayName?: string;
  notes: SessionNotes;
}

function RadTachInner() {
  // Default settings
  const defaultParTimes: ParTimesConfig = {
    'XR': 90,
    'FL': 120,
    'CT': 240,
    'US': 120,
    'MR': 240,
    'NM': 240,
    'MA': 240,
    'PET-CT': 600,
    'Cancer Follow': 240,
    '+1 Section': 120,
    '+2 Section': 240,
    'Multiple Priors': 120,
    'Age >70': 120,
    'Complex Hx': 120,
    'Prior Surg Hx': 120,
    'CTA': 180,
    'Bilateral': 0, // Special: multiplies par time and RVU by 1.5
    'Vascular': 120 // +2 minutes
  };

  const defaultRVUValues: RVUConfig = {
    'XR': 0.2,
    'FL': 0.4,
    'CT': 1.0,
    'US': 0.5,
    'MR': 1.3,
    'NM': 0.6,
    'MA': 1.3,
    'PET-CT': 2.4,
    '+1 Section': { 'CT': 0.5, 'US': 0.5 },
    '+2 Section': { 'CT': 1.0 },
    'CTA': { 'CT': 0.4 }
  };
  
  // Timer states
  const [isRunning, setIsRunning] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [cumulativeVariance, setCumulativeVariance] = useState(0);
  const [studiesCompleted, setStudiesCompleted] = useState(0);

  // Pause timer tracking (Issue #2) - tracks pause duration per study
  // const [pauseTime, setPauseTime] = useState(0); // TODO: FIREBASE - Uncomment for Phase 3 (Issue #2). Tracks pause time per study for SESSION recording
  // Pause removed (2026-05-18) — use Admin/Comms/Break instead

  // Double Tap tracking (Issue #3) - tracks when reopening recently-completed studies
  const [doubleTapTime, setDoubleTapTime] = useState(0);
  const [isDoubleTapRunning, setIsDoubleTapRunning] = useState(false);
  const [doubleTapEvents, setDoubleTapEvents] = useState(0);
  // const [lastStudyModality, setLastStudyModality] = useState<Modality | null>(null); // TODO: FIREBASE - Uncomment for Phase 3 (Issue #3). Associates Double Tap events with modality for analytics

  // Track if Admin/Comms auto-paused a study (so we can resume it when they stop)
  // studyWasAutoPaused removed — ABC buttons stop study timer, study_start resumes

  // Total and Interstitial time tracking
  const [sessionTime, setSessionTime] = useState(0);
  const [interstitialTime, setInterstitialTime] = useState(0);
  const [isInterstitialRunning, setIsInterstitialRunning] = useState(false);
  const [isSessionTimeRunning, setIsSessionTimeRunning] = useState(false);
  
  // Admin and Comms time tracking
  const [adminTime, setAdminTime] = useState(0);
  const [commsTime, setCommsTime] = useState(0);
  const [isAdminTimeRunning, setIsAdminTimeRunning] = useState(false);
  const [isCommsTimeRunning, setIsCommsTimeRunning] = useState(false);
  const [adminEvents, setAdminEvents] = useState(0); // Issue #4: Admin event counter
  const [commsEvents, setCommsEvents] = useState(0); // Issue #4: Comms event counter

  // Hover states for secondary timers (UI test for Issue #5)
  const [isHoveringAdmin, setIsHoveringAdmin] = useState(false);
  const [isHoveringComms, setIsHoveringComms] = useState(false);
  const [isHoveringRVU, setIsHoveringRVU] = useState(false); // Issue #6: toggle RVU/hr vs Rolling RVU

  // Study selection states
  const [selectedModality, setSelectedModality] = useState<Modality | null>(null);
  const [selectedComplications, setSelectedComplications] = useState<Complication[]>([]);
  
  // Settings state
  const [showSettings, setShowSettings] = useState(false);
  const [showRVUSettings, setShowRVUSettings] = useState(false);
  const [showGuide, setShowGuide] = useState(false);
  const [parTimes, setParTimes] = useState<ParTimesConfig>(defaultParTimes);
  const [rvuValues, setRVUValues] = useState<RVUConfig>(defaultRVUValues);
  const [stealthMode, setStealthMode] = useState(false);
  const [useHMSFormat, setUseHMSFormat] = useState(false);
  const [rvuDerivedMode, setRvuDerivedMode] = useState(false);
  const [targetRvuPerHour, setTargetRvuPerHour] = useState(8);
  const [gpciZip, setGpciZip] = useState('');
  const [gpciValues, setGpciValues] = useState<GpciValues | null>(null);

  const [totalRVU, setTotalRVU] = useState(0);
  const [rvuPerHour, setRvuPerHour] = useState(0);

  // Rolling RVU tracking (Issue #6) - track studies with timestamps
  const [completedStudies, setCompletedStudies] = useState<Array<{timestamp: number, rvu: number}>>([]);
  const [rollingRVU, setRollingRVU] = useState(0);

  // Undo tracking
  const [lastStudy, setLastStudy] = useState<LastStudyData | null>(null);

  // Streak tracking
  const [currentStreak, setCurrentStreak] = useState(0);

  // Draft mode tracking
  const [isDraftMode, setIsDraftMode] = useState(false);
  const [draftStudy, setDraftStudy] = useState<DraftStudyData | null>(null);
  const [wasDrafted, setWasDrafted] = useState(false);

  // Break tracking
  const [isBreakTimeRunning, setIsBreakTimeRunning] = useState(false);
  const [breakTime, setBreakTime] = useState(0);
  const [breaksTaken, setBreaksTaken] = useState(0);
  const [timeSinceLastBreak, setTimeSinceLastBreak] = useState(0);
  const [showBreakPrompt, setShowBreakPrompt] = useState(false);
  const [breakPromptHours, setBreakPromptHours] = useState(2);
  const [showAnimalMessage, setShowAnimalMessage] = useState(false);
  const [lastBreakDeclineTime, setLastBreakDeclineTime] = useState(0);

  // Auto-start tracking
  const [autoStartEnabled, setAutoStartEnabled] = useState(false);

  // CPT database (loaded once at init)
  const [cptDatabase, setCptDatabase] = useState<CptDatabase | null>(null);

  // Sidecar/HL7 override state — when non-null, accurate per-exam RVU replaces modality defaults
  const [cptOverride, setCptOverride] = useState<{
    cpts: string[];
    rvu: number;
    breakdown: Array<{ cpt: string; description: string; raw: number; adjusted: number }>;
    bilateral: boolean;
    source: RvuSource;
    examDesc: string;
  } | null>(null);

  // Non-RVU complications — still add par time in RVU-derived mode (case complexity not in RVU)
  const NON_RVU_COMPLICATIONS: Complication[] = ['Age >70', 'Cancer Follow', 'Prior Surg Hx', 'Complex Hx'];

  // Session management (Issue #1)
  const [isSessionActive, setIsSessionActive] = useState(false);
  const [sessionStartDateTime, setSessionStartDateTime] = useState<string | null>(null);
  const [sessionEvents, setSessionEvents] = useState<SessionEvent[]>([]);
  const [deletedStudies, setDeletedStudies] = useState(0);
  const [cumulativeParTime, setCumulativeParTime] = useState(0);
  const [showStopSessionDialog, setShowStopSessionDialog] = useState(false);
  const [showPostSessionScreen, setShowPostSessionScreen] = useState(false);
  const [todaySessionCount, setTodaySessionCount] = useState(0);
  const [sessionTags, setSessionTags] = useState<SessionTag[]>(['No Comment']);
  const [sessionDescription, setSessionDescription] = useState('');
  const [verifiedRVU, setVerifiedRVU] = useState<string>('');

  // Firebase integration
  // DO NOT enable Firestore SDK offline persistence (persistentLocalCache).
  // RadTach uses its own IDB write-ahead buffer (offlineBuffer.ts).
  // Enabling both creates two competing retry layers with different semantics.
  const FIREBASE_ENABLED = true; // Toggle to true when Firebase project is configured
  const { currentUser, logout } = useAuth();
  const [firestoreSessionId, setFirestoreSessionId] = useState<string | null>(null);
  const lastFlushedIndex = useRef(0); // Tracks how many events have been synced to Firestore
  const localSessionKeyRef = useRef<string | null>(null);
  const health = useFirestoreHealth();
  const lastFlushAttemptRef = useRef<number>(0);
  const FLUSH_DEBOUNCE_MS = 30000; // 30 seconds
  const [recentSessions, _setRecentSessions] = useState<{ id: string; [key: string]: any }[]>([]);
  const [_recentSessionsLoading, _setRecentSessionsLoading] = useState(false);
  const [showRecentSessions, setShowRecentSessions] = useState(false);

  // Reports state
  const [showReports, setShowReports] = useState(false);
  const [reportEntryPoint, setReportEntryPoint] = useState<'login' | 'postSession' | 'settings' | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [lastSessionEvents, setLastSessionEvents] = useState<SessionEvent[]>([]);
  const [lastSessionData, setLastSessionData] = useState<SessionData | null>(null);
  const [lastSessionSummary, setLastSessionSummary] = useState<SessionSummary | null>(null);

  // Orphaned session recovery state
  const [orphanedSessions, setOrphanedSessions] = useState<{ id: string; [key: string]: any }[] | null>(null);
  const [recoveryChecked, setRecoveryChecked] = useState(false);
  const [recoveryInProgress, setRecoveryInProgress] = useState(false);
  const [recoverySessionIndex, setRecoverySessionIndex] = useState(0);
  const [recoveryPreview, setRecoveryPreview] = useState<{
    events: Record<string, any>[];
    reconstructed: ReturnType<typeof reconstructSessionData>;
    loading: boolean;
    error: string | null;
  } | null>(null);

  // System/Office selection (session start dialog)
  const [showSessionStartDialog, setShowSessionStartDialog] = useState(false);
  const [systemInput, setSystemInput] = useState(() => localStorage.getItem('radtach_lastSystem') || '');
  const [officeList, setOfficeList] = useState<string[]>([]);
  const [officeZips, setOfficeZips] = useState<Record<string, string>>({});
  const [selectedOffice, setSelectedOffice] = useState(() => localStorage.getItem('radtach_lastOffice') || '');
  const [rotationList, setRotationList] = useState<string[]>([]);
  const [selectedRotation, setSelectedRotation] = useState(() => localStorage.getItem('radtach_lastRotation') || '');
  const [halfDay, setHalfDay] = useState(false);
  const [systemError, setSystemError] = useState('');
  const [systemVerified, setSystemVerified] = useState(false);


  // Auth UI state
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authError, setAuthError] = useState('');
  const [isSignupMode, setIsSignupMode] = useState(false);
  const [authTimezone, setAuthTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [authFirstName, setAuthFirstName] = useState('');
  const [authLastName, setAuthLastName] = useState('');
  const [authCredentials, setAuthCredentials] = useState('');
  const [authRequestedRole, setAuthRequestedRole] = useState('radiologist');
  // undefined = not loaded yet, null = loaded but no displayName, string = has displayName
  const [userDisplayName, setUserDisplayName] = useState<string | null | undefined>(undefined);
  const [userFirstName, setUserFirstName] = useState<string | null>(null);
  const [displayNameFirstInput, setDisplayNameFirstInput] = useState('');
  const [displayNameLastInput, setDisplayNameLastInput] = useState('');
  const [displayNameCredInput, setDisplayNameCredInput] = useState('');
  const [authLoading, setAuthLoading] = useState(false);
  // Post-signup fork for non-radiologists
  const [showPostSignupFork, setShowPostSignupFork] = useState(false);
  const [showThankYou, setShowThankYou] = useState(false);
  // Message Center
  const [roleRequests, setRoleRequests] = useState<Array<{ uid: string; displayName: string; email: string; requestedRole: string; requestedAt: any }>>([]);
  const [showMessageCenter, setShowMessageCenter] = useState(false);
  const { signup, login } = useAuth();

  // Track event start times for duration calculation
  const [adminStartTime, setAdminStartTime] = useState<{session: number, system: string} | null>(null);
  const [commsStartTime, setCommsStartTime] = useState<{session: number, system: string} | null>(null);
  const [breakStartTime, setBreakStartTime] = useState<{session: number, system: string} | null>(null);
  const [doubleTapStartTime, setDoubleTapStartTime] = useState<{session: number, system: string} | null>(null);
  const [interstitialStartTime, setInterstitialStartTime] = useState<{session: number, system: string} | null>(null);
  const [studyStartTime, setStudyStartTime] = useState<{session: number, system: string} | null>(null);
  const [lastStudyModality, setLastStudyModality] = useState<Modality | null>(null);
  // studyPauseTime removed — pause functionality replaced by ABC

  const timerRef = useRef<number | null>(null);
  const sessionTimeRef = useRef<number | null>(null);
  const interstitialTimeRef = useRef<number | null>(null);
  const adminTimeRef = useRef<number | null>(null);
  const commsTimeRef = useRef<number | null>(null);
  const breakTimeRef = useRef<number | null>(null);
  const timeSinceLastBreakRef = useRef<number | null>(null);
  // pauseTimeRef removed — pause functionality replaced by ABC
  const doubleTapTimeRef = useRef<number | null>(null); // Issue #3: Double Tap timer
  const sessionStartMsRef = useRef<number>(0); // Wall-clock ms at session start (for drift correction)
  const processSidecarStartRef = useRef<(cmd: SidecarCommand) => void>(() => {});
  const processSidecarStopRef = useRef<() => void>(() => {});
  // Cached Firestore favorites/combos for sync_settings relay to Sidecar
  const firestoreFavoritesRef = useRef<Array<{ cpt: string; aeTitle: string }>>([]);
  const firestoreCombosRef = useRef<Array<{ cpts: string[]; bilateralFlags: boolean[]; modality: string; aeTitle?: string }>>([]);

  // ── Shadow mode-enum timer (parallel system for validation) ──────────
  const shadow = useTimerMode();
  const shadowFlushIdx = useRef<number>(0);

  // Calculate current par time based on selections
  const calculateParTime = () => {
    if (!selectedModality) return 0;

    let total: number;
    let hasBilateral = false;

    if (rvuDerivedMode && cptOverride) {
      // RVU-derived: base from formula, only add non-RVU complication adders
      total = Math.round((cptOverride.rvu / targetRvuPerHour) * 3600 - 8);
      if (total < 0) total = 0;

      selectedComplications.forEach(comp => {
        if (comp === 'Bilateral') {
          hasBilateral = true;
        } else if (NON_RVU_COMPLICATIONS.includes(comp)) {
          total += parTimes[comp] || 0;
        }
        // RVU-modifying complications already reflected in cptOverride.rvu — skip
      });
    } else {
      // Standard modality-based par time
      total = parTimes[selectedModality] || 0;

      selectedComplications.forEach(comp => {
        if (comp === 'Bilateral') {
          hasBilateral = true;
        } else {
          total += parTimes[comp] || 0;
        }
      });
    }

    // Apply Bilateral multiplier last (after all additions)
    // 1.5x matches the typical wRVU increase for bilateral vs unilateral CPT codes
    // Skip when cptOverride — bilateral RVU is already reflected in the higher RVU value
    if (hasBilateral && !cptOverride) {
      total *= 1.5;
    }

    return total;
  };
  
  const calculateRVU = () => {
    // CPT override takes precedence (Sidecar/HL7)
    if (cptOverride) return cptOverride.rvu;

    if (!selectedModality) return 0;

    const modalityRVU = rvuValues[selectedModality];
    let total = typeof modalityRVU === 'number' ? modalityRVU : 0;

    // Add complication RVUs that depend on modality
    let hasBilateral = false;
    selectedComplications.forEach(comp => {
      if (comp === 'Bilateral') {
        hasBilateral = true;
        return;
      }
      const compRVU = rvuValues[comp];
      if (compRVU !== undefined) {
        if (typeof compRVU === 'object' && compRVU !== null) {
          // Modality-specific RVU addition
          const modalitySpecificRVU = compRVU[selectedModality];
          if (typeof modalitySpecificRVU === 'number') {
            total += modalitySpecificRVU;
          }
        } else if (typeof compRVU === 'number') {
          // Direct RVU value
          total += compRVU;
        }
      }
    });

    // Apply Bilateral 1.5x multiplier last (matches typical wRVU bilateral/unilateral ratio)
    if (hasBilateral) {
      total *= 1.5;
    }

    return total;
  };
  
  const currentParTime = calculateParTime();
  const currentStudyRVU = calculateRVU();
  
  // Determine elapsed time background color
  const getElapsedTimeBackground = () => {
    // In stealth mode, always use neutral gray
    if (stealthMode) {
      return 'from-gray-700 to-gray-800';
    }
    
    // If no modality selected or timer hasn't started, use default gray
    if (!selectedModality || currentParTime === 0 || currentTime === 0) {
      return 'from-gray-700 to-gray-800';
    }
    
    const timeRemaining = currentParTime - currentTime;
    
    if (currentTime > currentParTime) {
      // Over par time - steady red
      return 'from-red-600 to-red-700';
    } else if (timeRemaining <= 15) {
      // 15 seconds or less - flashing red
      return 'elapsed-flash-red';
    } else if (timeRemaining <= 30) {
      // 30 seconds or less - yellow
      return 'from-yellow-500 to-yellow-600';
    } else {
      // More than 30 seconds - green
      return 'from-green-600 to-green-700';
    }
  };
  
  const elapsedBackground = getElapsedTimeBackground();
  
  // Timer effect
  useEffect(() => {
    if (isRunning) {
      timerRef.current = setInterval(() => {
        setCurrentTime(prev => prev + 1);
      }, 1000);
    } else {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    }
    
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    };
  }, [isRunning]);

  // Pause timer removed — ABC buttons handle interruptions

  // Double Tap timer effect (Issue #3) - tracks duration of double tap events
  useEffect(() => {
    if (isDoubleTapRunning) {
      doubleTapTimeRef.current = setInterval(() => {
        setDoubleTapTime(prev => prev + 1);
      }, 1000);
    } else {
      if (doubleTapTimeRef.current) {
        clearInterval(doubleTapTimeRef.current);
      }
    }

    return () => {
      if (doubleTapTimeRef.current) {
        clearInterval(doubleTapTimeRef.current);
      }
    };
  }, [isDoubleTapRunning]);

  // Session time effect
  useEffect(() => {
    if (isSessionTimeRunning) {
      sessionTimeRef.current = setInterval(() => {
        setSessionTime(prev => prev + 1);
      }, 1000);
    } else {
      if (sessionTimeRef.current) {
        clearInterval(sessionTimeRef.current);
      }
    }
    
    return () => {
      if (sessionTimeRef.current) {
        clearInterval(sessionTimeRef.current);
      }
    };
  }, [isSessionTimeRunning]);
  
  // Interstitial time effect
  useEffect(() => {
    if (isInterstitialRunning) {
      interstitialTimeRef.current = setInterval(() => {
        setInterstitialTime(prev => prev + 1);
      }, 1000);
    } else {
      if (interstitialTimeRef.current) {
        clearInterval(interstitialTimeRef.current);
      }
    }
    
    return () => {
      if (interstitialTimeRef.current) {
        clearInterval(interstitialTimeRef.current);
      }
    };
  }, [isInterstitialRunning]);
  
  // Admin time effect
  useEffect(() => {
    if (isAdminTimeRunning) {
      adminTimeRef.current = setInterval(() => {
        setAdminTime(prev => prev + 1);
      }, 1000);
    } else {
      if (adminTimeRef.current) {
        clearInterval(adminTimeRef.current);
      }
    }
    
    return () => {
      if (adminTimeRef.current) {
        clearInterval(adminTimeRef.current);
      }
    };
  }, [isAdminTimeRunning]);
  
  // Comms time effect
  useEffect(() => {
    if (isCommsTimeRunning) {
      commsTimeRef.current = setInterval(() => {
        setCommsTime(prev => prev + 1);
      }, 1000);
    } else {
      if (commsTimeRef.current) {
        clearInterval(commsTimeRef.current);
      }
    }

    return () => {
      if (commsTimeRef.current) {
        clearInterval(commsTimeRef.current);
      }
    };
  }, [isCommsTimeRunning]);

  // Break time effect
  useEffect(() => {
    if (isBreakTimeRunning) {
      breakTimeRef.current = setInterval(() => {
        setBreakTime(prev => prev + 1);
      }, 1000);
    } else {
      if (breakTimeRef.current) {
        clearInterval(breakTimeRef.current);
      }
    }

    return () => {
      if (breakTimeRef.current) {
        clearInterval(breakTimeRef.current);
      }
    };
  }, [isBreakTimeRunning]);

  // Time Since Last Break effect - runs when session is running but not on break
  useEffect(() => {
    const shouldRun = isSessionTimeRunning && !isBreakTimeRunning;

    if (shouldRun) {
      timeSinceLastBreakRef.current = setInterval(() => {
        setTimeSinceLastBreak(prev => prev + 1);
      }, 1000);
    } else {
      if (timeSinceLastBreakRef.current) {
        clearInterval(timeSinceLastBreakRef.current);
      }
    }

    return () => {
      if (timeSinceLastBreakRef.current) {
        clearInterval(timeSinceLastBreakRef.current);
      }
    };
  }, [isSessionTimeRunning, isBreakTimeRunning]);

  // Load settings from localStorage on mount
  useEffect(() => {
    try {
      const savedParTimes = localStorage.getItem('radtach_parTimes');
      const savedRVUValues = localStorage.getItem('radtach_rvuValues');
      const savedStealthMode = localStorage.getItem('radtach_stealthMode');
      const savedAutoStart = localStorage.getItem('radtach_autoStart');

      if (savedParTimes) {
        const parsed = JSON.parse(savedParTimes);
        // Migration: Convert old modality names to new ones
        if (parsed['Plain Film'] !== undefined) {
          parsed['XR'] = parsed['Plain Film'];
          delete parsed['Plain Film'];
        }
        if (parsed['Fluoro'] !== undefined) {
          parsed['FL'] = parsed['Fluoro'];
          delete parsed['Fluoro'];
        }
         
        setParTimes(parsed);
      }
      if (savedRVUValues) {
        const parsed = JSON.parse(savedRVUValues);
        // Migration: Convert old modality names to new ones
        if (parsed['Plain Film'] !== undefined) {
          parsed['XR'] = parsed['Plain Film'];
          delete parsed['Plain Film'];
        }
        if (parsed['Fluoro'] !== undefined) {
          parsed['FL'] = parsed['Fluoro'];
          delete parsed['Fluoro'];
        }
        setRVUValues(parsed);
      }
      if (savedStealthMode !== null) {
        setStealthMode(JSON.parse(savedStealthMode));
      }
      if (savedAutoStart !== null) {
        setAutoStartEnabled(JSON.parse(savedAutoStart));
      }
      const savedUseHMSFormat = localStorage.getItem('radtach_useHMSFormat');
      if (savedUseHMSFormat !== null) {
        setUseHMSFormat(JSON.parse(savedUseHMSFormat));
      }
      const savedGpciZip = localStorage.getItem('radtach_gpciZip');
      if (savedGpciZip) {
        setGpciZip(savedGpciZip);
        const gpci = lookupGpci(savedGpciZip);
        if (gpci) setGpciValues(gpci);
      }
      const savedRvuDerivedMode = localStorage.getItem('radtach_rvuDerivedMode');
      if (savedRvuDerivedMode !== null) {
        setRvuDerivedMode(JSON.parse(savedRvuDerivedMode));
      }
      const savedTargetRvuPerHour = localStorage.getItem('radtach_targetRvuPerHour');
      if (savedTargetRvuPerHour !== null) {
        setTargetRvuPerHour(parseFloat(savedTargetRvuPerHour));
      }
    } catch (error: unknown) {
      console.error('Error loading settings from localStorage:', error);
    }
  }, []);
  
  // Save parTimes to localStorage whenever they change
  useEffect(() => {
    try {
      localStorage.setItem('radtach_parTimes', JSON.stringify(parTimes));
    } catch (error: unknown) {
      console.error('Error saving parTimes to localStorage:', error);
    }
  }, [parTimes]);
  
  // Save rvuValues to localStorage whenever they change
  useEffect(() => {
    try {
      localStorage.setItem('radtach_rvuValues', JSON.stringify(rvuValues));
    } catch (error: unknown) {
      console.error('Error saving rvuValues to localStorage:', error);
    }
  }, [rvuValues]);
  
  // Save stealthMode to localStorage whenever it changes
  useEffect(() => {
    try {
      localStorage.setItem('radtach_stealthMode', JSON.stringify(stealthMode));
    } catch (error: unknown) {
      console.error('Error saving stealthMode to localStorage:', error);
    }
  }, [stealthMode]);

  // Save autoStartEnabled to localStorage whenever it changes
  useEffect(() => {
    try {
      localStorage.setItem('radtach_autoStart', JSON.stringify(autoStartEnabled));
    } catch (error: unknown) {
      console.error('Error saving autoStartEnabled to localStorage:', error);
    }
  }, [autoStartEnabled]);

  // Save useHMSFormat to localStorage whenever it changes
  useEffect(() => {
    try {
      localStorage.setItem('radtach_useHMSFormat', JSON.stringify(useHMSFormat));
    } catch (error: unknown) {
      console.error('Error saving useHMSFormat to localStorage:', error);
    }
  }, [useHMSFormat]);

  // Save GPCI ZIP to localStorage whenever it changes
  useEffect(() => {
    try {
      localStorage.setItem('radtach_gpciZip', gpciZip);
    } catch (error: unknown) {
      console.error('Error saving gpciZip to localStorage:', error);
    }
  }, [gpciZip]);

  // Save rvuDerivedMode to localStorage whenever it changes
  useEffect(() => {
    try {
      localStorage.setItem('radtach_rvuDerivedMode', JSON.stringify(rvuDerivedMode));
    } catch (error: unknown) {
      console.error('Error saving rvuDerivedMode to localStorage:', error);
    }
  }, [rvuDerivedMode]);

  // Save targetRvuPerHour to localStorage whenever it changes
  useEffect(() => {
    try {
      localStorage.setItem('radtach_targetRvuPerHour', String(targetRvuPerHour));
    } catch (error: unknown) {
      console.error('Error saving targetRvuPerHour to localStorage:', error);
    }
  }, [targetRvuPerHour]);

  // Phase 6: Load settings from Firestore on auth (overrides localStorage with source-of-truth)
  useEffect(() => {
    if (!FIREBASE_ENABLED || !currentUser) return;

    let cancelled = false;

    const loadSettings = async () => {
      try {
        // Run one-time migration if not yet done
        if (localStorage.getItem('radtach_migrated') !== 'true') {
          await migrateLocalStorageToFirestore(currentUser.uid);
        }

        // Fetch settings from Firestore
        const settings = await firestoreService.getUserSettings(currentUser.uid);

        if (cancelled) return;

        if (settings) {
          if (settings.parTimes && typeof settings.parTimes === 'object') {
            setParTimes(settings.parTimes);
          }
          if (settings.rvuValues && typeof settings.rvuValues === 'object') {
            setRVUValues(settings.rvuValues);
          }
          if (typeof settings.stealthMode === 'boolean') {
            setStealthMode(settings.stealthMode);
          }
          if (typeof settings.autoStartEnabled === 'boolean') {
            setAutoStartEnabled(settings.autoStartEnabled);
          }
          if (typeof settings.useHMSFormat === 'boolean') {
            setUseHMSFormat(settings.useHMSFormat);
          }
          if (typeof settings.gpciZip === 'string' && settings.gpciZip) {
            setGpciZip(settings.gpciZip);
            const gpci = lookupGpci(settings.gpciZip);
            if (gpci) setGpciValues(gpci);
          }
          if (typeof settings.rvuDerivedMode === 'boolean') {
            setRvuDerivedMode(settings.rvuDerivedMode);
          }
          if (typeof settings.targetRvuPerHour === 'number') {
            setTargetRvuPerHour(settings.targetRvuPerHour);
          }
          // Cache favorites/combos for Sidecar sync relay
          if (Array.isArray(settings.favorites)) {
            firestoreFavoritesRef.current = settings.favorites;
          }
          if (Array.isArray(settings.sidecarCombos)) {
            firestoreCombosRef.current = settings.sidecarCombos;
          }
        }

        // Load display name from user profile (null = checked but missing)
        const profile = await firestoreService.getUserProfile(currentUser.uid);
        if (!cancelled) {
          if (profile?.firstName && profile?.lastName) {
            const computed = profile.credentials
              ? `${profile.firstName} ${profile.lastName}, ${profile.credentials}`
              : `${profile.firstName} ${profile.lastName}`;
            setUserDisplayName(computed);
            setUserFirstName(profile.firstName);
          } else {
            setUserDisplayName(null);
          }
        }
      } catch (error) {
        console.error('Failed to load settings from Firestore:', error);
      }
    };

    loadSettings();

    return () => { cancelled = true; };
  }, [currentUser]);

  // Load CPT database (one-time, for Sidecar/HL7 RVU lookups)
  useEffect(() => {
    if (!FIREBASE_ENABLED || !currentUser) return;
    firestoreService.getCptDatabase().then(setCptDatabase).catch(console.error);
  }, [currentUser]);

  // Phase 8: Check admin status when user authenticates
  // Checks both global admin (Config/admins) and per-system admin (systems/{system})
  useEffect(() => {
    if (!FIREBASE_ENABLED || !currentUser) {
      setIsAdmin(false);
      return;
    }
    const system = systemInput.trim();
    const settingsPromise = system
      ? firestoreService.getSystemSettings(system)
      : Promise.resolve({ admins: {} as Record<string, boolean>, presidents: {} as Record<string, boolean>, hospitalAdmins: {} as Record<string, boolean>, itAccess: {} as Record<string, boolean>, hospitalAdminIndividualAccess: false, adminIndividualAccess: false });

    Promise.all([
      firestoreService.checkIsAdmin(currentUser.uid),
      settingsPromise,
    ])
      .then(([isGlobalAdmin, settings]) => {
        const isPerSystemAdmin = settings.admins[currentUser.uid] === true;
        const isPerSystemPresident = settings.presidents[currentUser.uid] === true;
        setIsAdmin(isGlobalAdmin || isPerSystemAdmin);
        // Trigger GAR aggregation on admin or president login (fire and forget)
        if ((isGlobalAdmin || isPerSystemAdmin || isPerSystemPresident) && system) {
          triggerGARAggregation(currentUser.uid, system).catch(console.error);
        }
      })
      .catch(err => {
        console.error('Admin check failed:', err);
        setIsAdmin(false);
      });
  }, [currentUser]);

  // Load role requests for admin message center
  useEffect(() => {
    if (!FIREBASE_ENABLED || !isAdmin) {
      setRoleRequests([]);
      return;
    }
    firestoreService.getRoleRequests().then(setRoleRequests).catch(console.error);
  }, [isAdmin]);

  // Auto-start timer when modality is selected (if AUTO mode is enabled)
  useEffect(() => {
    if (autoStartEnabled && selectedModality && !isRunning && !isDraftMode) {
      // Auto-start the timer
      toggleTimer();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedModality, autoStartEnabled]);

  // ── Sidecar / HL7 command doc listener ──────────────────────────────────
  useEffect(() => {
    if (!FIREBASE_ENABLED || !currentUser || !isSessionActive) return;
    const unsub = firestoreService.listenToCommandDoc(currentUser.uid, (cmd: SidecarCommand | null) => {
      if (!cmd || cmd.ack) return;          // already processed
      if (cmd.source === 'radtach') return; // ignore our own writes

      if (cmd.action === 'start') {
        processSidecarStartRef.current(cmd);
      } else if (cmd.action === 'stop') {
        processSidecarStopRef.current();
      } else if (cmd.action === 'sync_settings_response') {
        // Sidecar sent back merged favorites/combos — write to Firestore
        const newFavs = cmd.favorites;
        const newCombos = cmd.sidecarCombos;
        if (Array.isArray(newFavs) && newFavs.length > 0) {
          firestoreFavoritesRef.current = newFavs;
          firestoreService.saveFavorites(currentUser.uid, newFavs).catch(console.error);
        }
        if (Array.isArray(newCombos) && newCombos.length > 0) {
          firestoreCombosRef.current = newCombos;
          firestoreService.saveSidecarCombos(currentUser.uid, newCombos).catch(console.error);
        }
      }

      // Ack the command (skip ack for sync messages to avoid overwriting)
      if (cmd.action !== 'sync_settings' && cmd.action !== 'sync_settings_response') {
        firestoreService.ackCommandDoc(currentUser.uid).catch(console.error);
      }
    });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser, isSessionActive, cptDatabase]);

  // Format time as MM:SS
  const formatTime = (seconds: number, forceShort: boolean = false): string => {
    const sign = seconds < 0 ? '-' : '';
    const absSeconds = Math.abs(seconds);

    if (useHMSFormat && !forceShort) {
      const hours = Math.floor(absSeconds / 3600);
      const mins = Math.floor((absSeconds % 3600) / 60);
      const secs = absSeconds % 60;
      return `${sign}${hours}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    } else {
      const mins = Math.floor(absSeconds / 60);
      const secs = absSeconds % 60;
      return `${sign}${mins}:${secs.toString().padStart(2, '0')}`;
    }
  };

  // Helper function to get current ISO 8601 datetime string (Issue #1)
  const getCurrentDateTime = (): string => {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}`;
  };

  // Helper function to get today's date string for session ID (Issue #1)
  const getTodayDateString = (): string => {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}${month}${day}`;
  };

  // Generate session ID in format YYYYMMDD-##-{uid}-{rand4}
  // Queries Firestore for today's existing session count to avoid collisions
  // across browser restarts. Random hex suffix as a belt-and-suspenders guard.
  const generateSessionId = (): string => {
    const dateStr = getTodayDateString();
    const sessionNum = String(todaySessionCount + 1).padStart(2, '0');
    const userId = currentUser ? currentUser.uid.slice(0, 7) : 'LOCAL';
    const rand = Math.random().toString(16).slice(2, 6);
    return `${dateStr}-${sessionNum}-${userId}-${rand}`;
  };

  // Async version: queries Firestore for accurate today count before generating ID.
  // Falls back to generateSessionId() if the query fails.
  const generateSessionIdAsync = async (): Promise<string> => {
    const dateStr = getTodayDateString();
    const userId = currentUser ? currentUser.uid.slice(0, 7) : 'LOCAL';
    const rand = Math.random().toString(16).slice(2, 6);
    try {
      if (currentUser) {
        const existingCount = await firestoreService.countTodaySessions(currentUser.uid, dateStr);
        const sessionNum = String(existingCount + 1).padStart(2, '0');
        return `${dateStr}-${sessionNum}-${userId}-${rand}`;
      }
    } catch {
      // Query failed — fall through to local count
    }
    const sessionNum = String(todaySessionCount + 1).padStart(2, '0');
    return `${dateStr}-${sessionNum}-${userId}-${rand}`;
  };

  // Firebase: flush unsent events to Firestore via IDB write-ahead buffer
  const flushEventsToFirestore = (events: SessionEvent[], sessionId: string) => {
    const startIdx = lastFlushedIndex.current;
    const unsent = events.slice(startIdx);
    if (unsent.length === 0) return;
    const key = sessionId || localSessionKeyRef.current || 'unknown';
    const targetIndex = events.length;
    bufferedFlushEvents(currentUser!.uid, key, unsent, startIdx)
      .then(ok => {
        if (ok) {
          lastFlushedIndex.current = Math.max(lastFlushedIndex.current, targetIndex);
          health.reportSuccess();
        } else {
          health.reportFailure(false);
        }
        return flushBuffer(currentUser!.uid);
      }).then(result => {
        if (result && result.remaining === 0 && result.flushed > 0) health.reportSuccess();
      });
  };

  // Shadow flush: write mode-enum events to shadow_events subcollection
  const flushShadowEvents = () => {
    if (!FIREBASE_ENABLED || !firestoreSessionId || !currentUser) return;
    const allShadow = shadow.getEvents();
    const unsent = allShadow.slice(shadowFlushIdx.current);
    if (unsent.length === 0) return;
    firestoreService.flushShadowEvents(currentUser.uid, firestoreSessionId, unsent as Record<string, any>[], shadowFlushIdx.current)
      .then(() => { shadowFlushIdx.current = allShadow.length; })
      .catch(err => console.error('Shadow flush failed:', err));
  };

  // IDB: write every event locally for crash-proof recovery
  const recordEventLocally = (event: SessionEvent) => {
    if (!FIREBASE_ENABLED || !localSessionKeyRef.current) return;
    addLocalEvent(localSessionKeyRef.current, event as Record<string, any>).catch(() => {});
  };

  // Firebase: flush events every 5 completed studies (human-cadence, no fixed interval)
  useEffect(() => {
    if (!FIREBASE_ENABLED || !firestoreSessionId || studiesCompleted === 0) return;
    if (studiesCompleted % 5 === 0) {
      flushEventsToFirestore(sessionEvents, firestoreSessionId);
      flushShadowEvents();
    }
  }, [studiesCompleted]);

  // Firebase: flush IDB buffer on mount (handles data left from previous session) and on tab focus (debounced)
  useEffect(() => {
    if (!FIREBASE_ENABLED || !currentUser) return;

    const attemptFlush = () => {
      const now = Date.now();
      if (now - lastFlushAttemptRef.current < FLUSH_DEBOUNCE_MS) return;
      lastFlushAttemptRef.current = now;
      flushBuffer(currentUser.uid).then(result => {
        if (result) {
          health.setPendingCount(result.remaining);
          if (result.remaining === 0 && result.flushed > 0) health.reportSuccess();
          else if (result.remaining > 0) health.reportFailure(result.canRead);
        }
      });
    };

    attemptFlush();
    window.addEventListener('focus', attemptFlush);
    return () => window.removeEventListener('focus', attemptFlush);
  }, [currentUser]);

  // Orphaned session recovery: detect sessions missing endTime after crash/power loss
  useEffect(() => {
    if (!FIREBASE_ENABLED || !currentUser || recoveryChecked) return;

    const checkOrphans = async () => {
      try {
        // Flush IDB first — pending endSession writes may close orphans
        try {
          await flushBuffer(currentUser.uid);
        } catch {
          // IDB flush failed — continue with orphan check anyway
        }

        const orphans = await firestoreService.getOrphanedSessions(currentUser.uid);
        if (orphans.length === 0) {
          setOrphanedSessions([]);
          setRecoveryChecked(true);
          return;
        }

        // Filter out false positives: sessions with pending endSession in IDB
        const realOrphans: typeof orphans = [];
        for (const s of orphans) {
          const pending = await hasPendingEndSession(s.id);
          if (!pending) realOrphans.push(s);
        }

        if (realOrphans.length === 0) {
          setOrphanedSessions([]);
          setRecoveryChecked(true);
          return;
        }

        setOrphanedSessions(realOrphans);

        // Load first orphan's events and build preview
        const first = realOrphans[0];
        try {
          const firestoreEvents = await firestoreService.getSessionEvents(currentUser.uid, first.id);
          const localEvents = await getLocalEvents(first.id).catch(() => [] as Record<string, any>[]);
          const events = localEvents.length >= firestoreEvents.length ? localEvents : firestoreEvents;
          const reconstructed = reconstructSessionData(first, events);
          setRecoveryPreview({ events, reconstructed, loading: false, error: null });
        } catch {
          setRecoveryPreview({ events: [], reconstructed: reconstructSessionData(first, []), loading: false, error: 'Could not load events' });
        }

        setRecoverySessionIndex(0);
      } catch {
        // Network error or other failure — skip recovery silently, let user through
        setOrphanedSessions([]);
      }
      setRecoveryChecked(true);
    };

    checkOrphans();
  }, [currentUser, recoveryChecked]);

  // Recovery handlers
  const loadOrphanPreview = async (orphan: { id: string; [key: string]: any }) => {
    if (!currentUser) return;
    setRecoveryPreview(prev => prev ? { ...prev, loading: true, error: null } : { events: [], reconstructed: reconstructSessionData(orphan, []), loading: true, error: null });
    try {
      const firestoreEvents = await firestoreService.getSessionEvents(currentUser.uid, orphan.id);
      const localEvents = await getLocalEvents(orphan.id).catch(() => [] as Record<string, any>[]);
      const events = localEvents.length >= firestoreEvents.length ? localEvents : firestoreEvents;
      const reconstructed = reconstructSessionData(orphan, events);
      setRecoveryPreview({ events, reconstructed, loading: false, error: null });
    } catch {
      setRecoveryPreview({ events: [], reconstructed: reconstructSessionData(orphan, []), loading: false, error: 'Could not load events' });
    }
  };

  const advanceRecovery = async () => {
    if (!orphanedSessions) return;
    const nextIndex = recoverySessionIndex + 1;
    if (nextIndex >= orphanedSessions.length) {
      // All orphans handled
      setOrphanedSessions([]);
      setRecoveryPreview(null);
      setRecoverySessionIndex(0);
      return;
    }
    setRecoverySessionIndex(nextIndex);
    await loadOrphanPreview(orphanedSessions[nextIndex]);
  };

  const handleRecoverSession = async () => {
    if (!currentUser || !orphanedSessions || !recoveryPreview) return;
    const orphan = orphanedSessions[recoverySessionIndex];
    setRecoveryInProgress(true);
    try {
      const { reconstructed } = recoveryPreview;
      await firestoreService.endSession(currentUser.uid, orphan.id, reconstructed);

      // Write stale GAR marker if session is from a prior day
      if (orphan.startDateTime && orphan.system) {
        const sessionDate = String(orphan.startDateTime).slice(0, 10);
        const todayDate = new Date().toISOString().slice(0, 10);
        if (sessionDate < todayDate) {
          await firestoreService.writeStaleMarker(orphan.system, sessionDate, currentUser.uid);
        }
      }
    } catch {
      // If recovery write fails, skip this orphan and move on
    }
    clearLocalEvents(orphan.id).catch(() => {});
    setRecoveryInProgress(false);
    await advanceRecovery();
  };

  const handleDiscardSession = async () => {
    if (!currentUser || !orphanedSessions) return;
    const orphan = orphanedSessions[recoverySessionIndex];
    setRecoveryInProgress(true);
    try {
      // Close with zeroed data
      const discardData = reconstructSessionData(orphan, []);
      discardData.notes = { tags: ['No Comment'], description: '(discarded — incomplete session)' };
      await firestoreService.endSession(currentUser.uid, orphan.id, discardData);

      if (orphan.startDateTime && orphan.system) {
        const sessionDate = String(orphan.startDateTime).slice(0, 10);
        const todayDate = new Date().toISOString().slice(0, 10);
        if (sessionDate < todayDate) {
          await firestoreService.writeStaleMarker(orphan.system, sessionDate, currentUser.uid);
        }
      }
    } catch {
      // If discard write fails, skip and move on
    }
    clearLocalEvents(orphan.id).catch(() => {});
    setRecoveryInProgress(false);
    await advanceRecovery();
  };

  // Auth form handler
  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError('');
    setAuthLoading(true);
    try {
      if (isSignupMode) {
        const cred = await signup(authEmail, authPassword);
        const firstName = authFirstName.trim();
        const lastName = authLastName.trim();
        const credentials = authCredentials.trim() || undefined;
        await firestoreService.createUserProfile(cred.user.uid, {
          timezone: authTimezone,
          email: authEmail,
          firstName,
          lastName,
          credentials,
        });
        // Compute displayName for Firebase Auth + session data
        const computedDisplayName = credentials
          ? `${firstName} ${lastName}, ${credentials}`
          : `${firstName} ${lastName}`;
        if (firstName && lastName) {
          await updateProfile(cred.user, { displayName: computedDisplayName });
        }
        // Create role request if non-radiologist
        if (authRequestedRole !== 'radiologist') {
          await firestoreService.createRoleRequest(cred.user.uid, {
            displayName: computedDisplayName || authEmail,
            email: authEmail,
            requestedRole: authRequestedRole,
          });
          setShowPostSignupFork(true);
        }
      } else {
        await login(authEmail, authPassword);
      }
    } catch (err: any) {
      const code = err?.code || '';
      if (code === 'auth/email-already-in-use') setAuthError('An account with this email already exists.');
      else if (code === 'auth/invalid-email') setAuthError('Invalid email address.');
      else if (code === 'auth/weak-password') setAuthError('Password must be at least 6 characters.');
      else if (code === 'auth/user-not-found' || code === 'auth/wrong-password' || code === 'auth/invalid-credential') setAuthError('Invalid email or password.');
      else setAuthError(err?.message || 'Authentication failed.');
    } finally {
      setAuthLoading(false);
    }
  };

  // One-time displayName prompt for existing users without one
  const handleSetDisplayName = async () => {
    if (!currentUser || !displayNameFirstInput.trim() || !displayNameLastInput.trim()) return;
    const firstName = displayNameFirstInput.trim();
    const lastName = displayNameLastInput.trim();
    const credentials = displayNameCredInput.trim() || undefined;
    const computedName = credentials
      ? `${firstName} ${lastName}, ${credentials}`
      : `${firstName} ${lastName}`;
    try {
      await firestoreService.updateUserProfile(currentUser.uid, { firstName, lastName, ...(credentials ? { credentials } : {}) });
      await updateProfile(currentUser, { displayName: computedName });
      setUserDisplayName(computedName);
      setUserFirstName(firstName);
    } catch (err) {
      console.error('Failed to set display name:', err);
    }
  };

  const handleLogout = async () => {
    setShowPostSessionScreen(false);
    setUserFirstName(null);
    await logout();
  };

  // Phase 8: Open Reports from post-session screen
  const handleReviewPerformance = () => {
    setReportEntryPoint('postSession');
    setShowReports(true);
  };

  // Phase 8: Open Reports from header (login entry point — no active session)
  const handleViewReportsFromHeader = () => {
    setReportEntryPoint('login');
    setShowReports(true);
  };

  // Phase 8: Open Reports from Settings (admin only, mid-session)
  const handleViewReportsFromSettings = () => {
    setReportEntryPoint('settings');
    setShowSettings(false);
    setShowReports(true);
  };

  // Phase 8: Exit Reports — return to origin based on entry point
  const handleExitReports = () => {
    setShowReports(false);
    setReportEntryPoint(null);
  };

  // Start a new session (Issue #1)
  const handleStartSession = () => {
    if (FIREBASE_ENABLED) {
      // Show system/office dialog before starting
      setSystemError('');
      setSystemVerified(false);
      setOfficeList([]);
      setRotationList([]);
      setHalfDay(false);
      // Pre-fill from last session if available
      const lastSystem = localStorage.getItem('radtach_lastSystem') || '';
      const lastOffice = localStorage.getItem('radtach_lastOffice') || '';
      const lastRotation = localStorage.getItem('radtach_lastRotation') || '';
      setSystemInput(lastSystem);
      setSelectedOffice(lastOffice);
      setSelectedRotation(lastRotation);
      setShowSessionStartDialog(true);
      return;
    }
    // Non-Firebase path: start immediately (existing behavior)
    startSessionWithOffice('Placeholder');
  };

  // Verify system name against Firestore
  const handleVerifySystem = () => {
    if (!systemInput.trim()) {
      setSystemError('Enter a system name');
      return;
    }
    setSystemError('');
    const system = systemInput.trim();
    Promise.all([
      firestoreService.getSystemOffices(system),
      firestoreService.getSystemRotations(system),
    ])
      .then(([officeResult, rotations]) => {
        if (officeResult) {
          // Use canonical key from Firestore (fixes case-sensitivity)
          setSystemInput(officeResult.key);
          setOfficeList(officeResult.offices);
          const zips = officeResult.officeZips || {};
          setOfficeZips(zips);
          setSystemVerified(true);
          // If previously selected office is in the list, keep it; otherwise clear
          const effectiveOffice = officeResult.offices.includes(selectedOffice)
            ? selectedOffice
            : (officeResult.offices[0] || '');
          if (effectiveOffice !== selectedOffice) {
            setSelectedOffice(effectiveOffice);
          }
          // Auto-set GPCI from office ZIP
          const officeZip = zips[effectiveOffice];
          if (officeZip) {
            setGpciZip(officeZip);
            setGpciValues(lookupGpci(officeZip));
          }
          // Set rotation list (may be null if not configured yet)
          const rots = rotations || ['Unassigned'];
          setRotationList(rots);
          if (!rots.includes(selectedRotation)) {
            setSelectedRotation(rots[0] || '');
          }
        } else {
          setSystemError('System not found');
          setSystemVerified(false);
          setOfficeList([]);
          setRotationList([]);
        }
      })
      .catch(() => {
        setSystemError('Could not connect to database');
        setSystemVerified(false);
      });
  };

  // Confirm system/office/rotation and start session
  const handleConfirmSessionStart = () => {
    if (!selectedOffice) return;
    localStorage.setItem('radtach_lastSystem', systemInput.trim());
    localStorage.setItem('radtach_lastOffice', selectedOffice);
    localStorage.setItem('radtach_lastRotation', selectedRotation);
    // Eagerly save GPCI + currentSystem to Firestore so Sidecar has it immediately
    if (currentUser && gpciValues) {
      firestoreService.saveUserSettings(currentUser.uid, { gpciZip, gpciValues, currentSystem: systemInput.trim() }).catch(console.error);
    }
    setShowSessionStartDialog(false);
    startSessionWithOffice(selectedOffice);
  };

  // Actual session start logic (shared by Firebase and non-Firebase paths)
  const startSessionWithOffice = async (workstationId: string) => {
    const now = getCurrentDateTime();
    setSessionStartDateTime(now);
    sessionStartMsRef.current = Date.now();
    setIsSessionActive(true);
    setIsSessionTimeRunning(true);
    setTodaySessionCount(prev => prev + 1);
    setSessionEvents([]);
    shadow.startSession();
    shadowFlushIdx.current = 0;

    // Firebase: create session document via IDB write-ahead buffer
    if (FIREBASE_ENABLED) {
      const localKey = await generateSessionIdAsync();
      localSessionKeyRef.current = localKey;
      setFirestoreSessionId(localKey);
      bufferedCreateSession(currentUser!.uid, localKey, {
        sessionId: localKey,
        userAbbrev: currentUser!.uid,
        workstationId: workstationId,
        system: systemInput.trim(),
        rotation: selectedRotation || 'Unassigned',
        halfDay: halfDay,
        startDateTime: now,
        ...(userDisplayName ? { displayName: userDisplayName } : {}),
      }).then(ok => {
        if (ok) health.reportSuccess();
        else health.reportFailure(false);
        return flushBuffer(currentUser!.uid);
      }).then(result => {
        if (result) {
          if (result.remaining === 0 && result.flushed > 0) health.reportSuccess();
          else if (result.remaining > 0) health.reportFailure(result.canRead);
        }
      });
      firestoreService.writeSessionStatus(currentUser!.uid, true).catch(console.error);
      // Send sync_settings to Sidecar via command doc (replaces clearCommandDoc)
      firestoreService.writeSyncSettings(
        currentUser!.uid,
        firestoreFavoritesRef.current,
        firestoreCombosRef.current,
      ).catch(console.error);
    }
    // Reset all counters
    setSessionTime(0);
    setInterstitialTime(0);
    setAdminTime(0);
    setCommsTime(0);
    setBreakTime(0);
    setDoubleTapTime(0);
    setAdminEvents(0);
    setCommsEvents(0);
    setBreaksTaken(0);
    setDoubleTapEvents(0);
    setStudiesCompleted(0);
    setDeletedStudies(0);
    setCumulativeParTime(0);
    setCumulativeVariance(0);
    setTotalRVU(0);
    setRvuPerHour(0);
    setRollingRVU(0);
    setCompletedStudies([]);
    setCurrentStreak(0);
    setCurrentTime(0);
    setSelectedModality(null);
    setSelectedComplications([]);
    setLastStudy(null);
    setTimeSinceLastBreak(0);
    setLastBreakDeclineTime(0);

  };

  // Handle STOP SESSION button click (Issue #1)
  const handleStopSessionClick = (event: React.MouseEvent) => {
    if (!event.shiftKey) {
      alert('Hold SHIFT and click to stop the session');
      return;
    }
    setShowStopSessionDialog(true);
  };

  // Build session data for export (Issue #1)
  const buildSessionData = (): { session: SessionData; events: SessionEvent[] } => {
    const sessionData: SessionData = {
      sessionId: localSessionKeyRef.current || generateSessionId(),
      userAbbrev: currentUser ? currentUser.uid : 'LOCAL',
      workstationId: selectedOffice || 'Unknown',
      system: systemInput.trim(),
      rotation: selectedRotation || 'Unassigned',
      halfDay: halfDay,
      startDateTime: sessionStartDateTime || '',
      stopDateTime: getCurrentDateTime(),
      totalSessionTime: sessionTime,
      studiesCompleted: studiesCompleted,
      deletedStudies: deletedStudies,
      cumulativeParTime: cumulativeParTime,
      interstitialTime: interstitialTime,
      adminTime: adminTime,
      adminEvents: adminEvents,
      commsTime: commsTime,
      commsEvents: commsEvents,
      breakTime: breakTime,
      breakEvents: breaksTaken,
      doubleTapTime: doubleTapTime,
      doubleTapEvents: doubleTapEvents,
      swapEvents: sessionEvents.filter(e => e.type === 'STUDY' && (e as StudyEvent).swapped).length,
      totalRVU: totalRVU,
      verifiedRVU: verifiedRVU.trim() ? parseFloat(verifiedRVU) : null,
      ...(userDisplayName ? { displayName: userDisplayName } : {}),
      notes: { tags: sessionTags, description: sessionDescription.trim() || '(none)' },
    };
    return { session: sessionData, events: sessionEvents };
  };

  // End session (Issue #1)
  const handleEndSession = () => {
    resetSession();
    setShowStopSessionDialog(false);
    if (FIREBASE_ENABLED) setShowPostSessionScreen(true);
  };

  // Reset session state (Issue #1)
  const resetSession = () => {
    // Close out any running timers before snapshotting events
    // Without this, timers still running at session end never produce events
    let finalEvents = [...sessionEvents];
    const now = getCurrentDateTime();

    if (isAdminTimeRunning && adminStartTime !== null) {
      const evt = {
        type: 'ADMIN',
        startTimeSession: adminStartTime.session,
        startTimeSystem: adminStartTime.system,
        endTimeSession: sessionTime,
        endTimeSystem: now,
        duration: sessionTime - adminStartTime.session,
      } as TimerEvent;
      finalEvents.push(evt);
      recordEventLocally(evt);
    }
    if (isCommsTimeRunning && commsStartTime !== null) {
      const evt = {
        type: 'COMMS',
        startTimeSession: commsStartTime.session,
        startTimeSystem: commsStartTime.system,
        endTimeSession: sessionTime,
        endTimeSystem: now,
        duration: sessionTime - commsStartTime.session,
      } as TimerEvent;
      finalEvents.push(evt);
      recordEventLocally(evt);
    }
    if (isBreakTimeRunning && breakStartTime !== null) {
      const evt = {
        type: 'BREAK',
        startTimeSession: breakStartTime.session,
        startTimeSystem: breakStartTime.system,
        endTimeSession: sessionTime,
        endTimeSystem: now,
        duration: sessionTime - breakStartTime.session,
      } as TimerEvent;
      finalEvents.push(evt);
      recordEventLocally(evt);
    }
    if (isDoubleTapRunning && doubleTapStartTime !== null) {
      const evt = {
        type: 'DOUBLE_TAP',
        startTimeSession: doubleTapStartTime.session,
        startTimeSystem: doubleTapStartTime.system,
        endTimeSession: sessionTime,
        endTimeSystem: now,
        duration: sessionTime - doubleTapStartTime.session,
        associatedModality: lastStudyModality,
      } as TimerEvent;
      finalEvents.push(evt);
      recordEventLocally(evt);
    }
    if (isInterstitialRunning && interstitialStartTime !== null) {
      const evt = {
        type: 'INTERSTITIAL',
        startTimeSession: interstitialStartTime.session,
        startTimeSystem: interstitialStartTime.system,
        endTimeSession: sessionTime,
        endTimeSystem: now,
        duration: sessionTime - interstitialStartTime.session,
      } as InterstitialEvent;
      finalEvents.push(evt);
      recordEventLocally(evt);
    }

    // Phase 8: Preserve session data for Reports before resetting
    if (FIREBASE_ENABLED) {
      const preserved = buildSessionData();
      setLastSessionEvents(finalEvents);
      setLastSessionData(preserved.session);
      setLastSessionSummary(computeSessionSummary(finalEvents, sessionTime, sessionStartDateTime || undefined));
    }

    // Shadow: finalize and flush
    const finalShadowEvents = shadow.endSession(sessionTime);
    if (FIREBASE_ENABLED && firestoreSessionId && currentUser) {
      const shadowUnsent = finalShadowEvents.slice(shadowFlushIdx.current);
      if (shadowUnsent.length > 0) {
        firestoreService.flushShadowEvents(currentUser.uid, firestoreSessionId, shadowUnsent as Record<string, any>[], shadowFlushIdx.current).catch(() => {});
      }
    }

    // Firebase: final flush via IDB write-ahead buffer, then end session + save settings
    if (FIREBASE_ENABLED && localSessionKeyRef.current) {
      const data = buildSessionData();
      const startIdx = lastFlushedIndex.current;
      const unsent = finalEvents.slice(startIdx);
      const key = localSessionKeyRef.current;
      const summary = computeSessionSummary(finalEvents, sessionTime, sessionStartDateTime || undefined);

      (unsent.length > 0
        ? bufferedFlushEvents(currentUser!.uid, key, unsent, startIdx)
        : Promise.resolve(true)
      ).then(() => bufferedEndSession(currentUser!.uid, key, { ...data.session, summary }))
        .then(() => bufferedSaveUserSettings(currentUser!.uid, {
          parTimes, rvuValues, stealthMode, autoStartEnabled, useHMSFormat,
          gpciZip, gpciValues, rvuDerivedMode, targetRvuPerHour,
          favorites: firestoreFavoritesRef.current,
          sidecarCombos: firestoreCombosRef.current,
        }))
        .then(() => clearLocalEvents(key).catch(() => {}))
        .then(() => flushBuffer(currentUser!.uid))
        .then(result => {
          if (result && result.remaining > 0) {
            health.setHasPendingOnExit(true);
            health.reportFailure(result.canRead);
          } else if (result) {
            health.reportSuccess();
          }
        });

      lastFlushedIndex.current = 0;
      localSessionKeyRef.current = null;
      setFirestoreSessionId(null);
      // Write session_ended BEFORE sessionActive:false so Sidecar sees ended state before status change
      firestoreService.writeSessionEnded(currentUser!.uid)
        .then(() => firestoreService.writeSessionStatus(currentUser!.uid, false))
        .catch(console.error);
    }

    setIsSessionActive(false);
    setIsSessionTimeRunning(false);
    setIsRunning(false);
    setIsInterstitialRunning(false);
    setIsAdminTimeRunning(false);
    setIsCommsTimeRunning(false);
    setIsBreakTimeRunning(false);
    setIsDoubleTapRunning(false);
    setSessionStartDateTime(null);
    setSessionEvents([]);
    setSessionTime(0);
    setInterstitialTime(0);
    setAdminTime(0);
    setCommsTime(0);
    setBreakTime(0);
    setDoubleTapTime(0);
    setAdminEvents(0);
    setCommsEvents(0);
    setBreaksTaken(0);
    setDoubleTapEvents(0);
    setStudiesCompleted(0);
    setDeletedStudies(0);
    setCumulativeParTime(0);
    setCumulativeVariance(0);
    setTotalRVU(0);
    setRvuPerHour(0);
    setRollingRVU(0);
    setCompletedStudies([]);
    setCurrentStreak(0);
    setCurrentTime(0);
    setSelectedModality(null);
    setSelectedComplications([]);
    setLastStudy(null);
    setTimeSinceLastBreak(0);
    setLastBreakDeclineTime(0);

    setLastStudyModality(null);
    setAdminStartTime(null);
    setCommsStartTime(null);
    setBreakStartTime(null);
    setDoubleTapStartTime(null);
    setInterstitialStartTime(null);
    setStudyStartTime(null);
    sessionStartMsRef.current = 0;
    setSessionTags(['No Comment']);
    setSessionDescription('');
    setVerifiedRVU('');
  };

  // Start/Stop timer
  const toggleTimer = () => {
    if (!selectedModality && !isRunning) {
      alert('Please select a modality before starting');
      return;
    }

    // Require active session to start timer (Issue #1)
    if (!isSessionActive && !isRunning) {
      alert('Please start a session first');
      return;
    }

    if (!isRunning) {
      // Starting/Resuming a study
      setIsRunning(true);

      setIsInterstitialRunning(false); // Stop interstitial time
      setIsAdminTimeRunning(false); // Stop admin time
      setIsCommsTimeRunning(false); // Stop comms time
      setIsBreakTimeRunning(false); // Stop break time
      setIsDoubleTapRunning(false); // Stop double tap time

      // Record study start time (Issue #1)
      if (studyStartTime === null) {
        setStudyStartTime({ session: sessionTime, system: getCurrentDateTime() });
      }

      // Record interstitial end if it was running (Issue #1)
      if (interstitialStartTime !== null) {
        const interstitialEvent: InterstitialEvent = {
          type: 'INTERSTITIAL',
          startTimeSession: interstitialStartTime.session,
          startTimeSystem: interstitialStartTime.system,
          endTimeSession: sessionTime,
          endTimeSystem: getCurrentDateTime(),
          duration: sessionTime - interstitialStartTime.session,
        };
        setSessionEvents(prev => [...prev, interstitialEvent]);
        recordEventLocally(interstitialEvent);

        setInterstitialStartTime(null);
      }

      // Record Admin event if it was running (study start auto-stops it)
      if (isAdminTimeRunning && adminStartTime !== null) {
        const evt: TimerEvent = {
          type: 'ADMIN',
          startTimeSession: adminStartTime.session,
          startTimeSystem: adminStartTime.system,
          endTimeSession: sessionTime,
          endTimeSystem: getCurrentDateTime(),
          duration: sessionTime - adminStartTime.session,
        };
        setSessionEvents(prev => [...prev, evt]);
        recordEventLocally(evt);
        setAdminStartTime(null);

      }

      // Record Comms event if it was running
      if (isCommsTimeRunning && commsStartTime !== null) {
        const evt: TimerEvent = {
          type: 'COMMS',
          startTimeSession: commsStartTime.session,
          startTimeSystem: commsStartTime.system,
          endTimeSession: sessionTime,
          endTimeSystem: getCurrentDateTime(),
          duration: sessionTime - commsStartTime.session,
        };
        setSessionEvents(prev => [...prev, evt]);
        recordEventLocally(evt);
        setCommsStartTime(null);

      }

      // Record Break event if it was running
      if (isBreakTimeRunning && breakStartTime !== null) {
        const evt: TimerEvent = {
          type: 'BREAK',
          startTimeSession: breakStartTime.session,
          startTimeSystem: breakStartTime.system,
          endTimeSession: sessionTime,
          endTimeSystem: getCurrentDateTime(),
          duration: sessionTime - breakStartTime.session,
        };
        setSessionEvents(prev => [...prev, evt]);
        recordEventLocally(evt);
        setBreakStartTime(null);
      }

      // Record Double-Tap event if it was running
      if (isDoubleTapRunning && doubleTapStartTime !== null) {
        const evt: TimerEvent = {
          type: 'DOUBLE_TAP',
          startTimeSession: doubleTapStartTime.session,
          startTimeSystem: doubleTapStartTime.system,
          endTimeSession: sessionTime,
          endTimeSystem: getCurrentDateTime(),
          duration: sessionTime - doubleTapStartTime.session,
          associatedModality: lastStudyModality,
        };
        setSessionEvents(prev => [...prev, evt]);
        recordEventLocally(evt);
        setDoubleTapStartTime(null);
      }

      // Start session time if this is the first study
      if (!isSessionTimeRunning) {
        setIsSessionTimeRunning(true);
      }

      // Shadow signal: study started
      if (selectedModality) {
        shadow.signal({
          type: 'study_start',
          modality: selectedModality,
          complications: [...selectedComplications],
          parTime: currentParTime,
          studyNumber: studiesCompleted + 1,
          rvu: currentStudyRVU,
          ...(cptOverride ? { cpts: cptOverride.cpts, rvuSource: cptOverride.source } : {}),
          ...(rvuDerivedMode ? { rvuDerivedMode: true, targetRvuPerHour } : {}),
        }, sessionTime);
      }
    }
    // Pause branch removed — use Admin/Comms/Break to interrupt a study
  };
  
  // ── Sidecar / HL7 command processing ──────────────────────────────────────

  const processSidecarStart = (cmd: SidecarCommand) => {
    // Sidecar requires AUTO mode — enable it if not already on
    if (!autoStartEnabled) {
      setAutoStartEnabled(true);
    }

    // If a study is already running, complete it first (same as clicking a new modality)
    if (selectedModality && (isRunning || currentTime > 0)) {
      completeStudy();
    }

    // Map modality string to Modality type
    const validModalities: Modality[] = ['XR', 'FL', 'CT', 'US', 'MR', 'NM', 'MA', 'PET-CT'];
    const mappedModality = cmd.modality
      ? validModalities.find(m => m === cmd.modality?.toUpperCase()) || null
      : null;

    // Look up CPT(s) from database
    if (cmd.cpts && cmd.cpts.length > 0 && cptDatabase?.entries) {
      let rvu: number;
      let breakdown: Array<{ cpt: string; description: string; raw: number; adjusted: number }>;
      let cpts = [...cmd.cpts];

      // Apply per-CPT bilateral flags (bilateralFlags[]), falling back to cmd.bilateral for all
      const flags = cmd.bilateralFlags || cpts.map(() => cmd.bilateral || false);
      const gpci = gpciValues ?? undefined;
      const effectiveCpts = cpts.map((cpt, i) =>
        flags[i] ? getBilateralRvu(cptDatabase.entries, cpt, gpci).cpt : cpt
      );
      const combo = calculateComboRvu(cptDatabase.entries, effectiveCpts, gpci);
      rvu = combo.total;
      breakdown = combo.breakdown;
      cpts = effectiveCpts;

      setCptOverride({
        cpts,
        rvu,
        breakdown,
        bilateral: cmd.bilateral || false,
        source: cmd.source === 'hl7' ? 'hl7' : 'sidecar',
        examDesc: cmd.examDesc || breakdown.map(b => b.description).join(' + '),
      });

      // Auto-light complications
      const autoComplications: Complication[] = [];
      if (cmd.bilateral) autoComplications.push('Bilateral');
      // Check if any CPT implies CTA
      const hasCta = cpts.some(cpt => {
        const entry = cptDatabase.entries[cpt];
        return entry?.protocol === 'CTA' || entry?.protocol === 'MRA';
      });
      if (hasCta) autoComplications.push('CTA');
      if (autoComplications.length > 0) {
        setSelectedComplications(autoComplications);
      }
    }

    // Set modality (triggers auto-start if AUTO mode is enabled)
    if (mappedModality) {
      setSelectedModality(mappedModality);
    }
  };

  const processSidecarStop = () => {
    if (selectedModality && (isRunning || currentTime > 0)) {
      completeStudy();
    }
  };
  processSidecarStartRef.current = processSidecarStart;
  processSidecarStopRef.current = processSidecarStop;

  // Complete study
  const completeStudy = () => {
    if (!selectedModality) {
      alert('Please select a modality');
      return;
    }
    
    // Check if timer has been started (currentTime > 0 or isRunning)
    if (currentTime === 0 && !isRunning) {
      alert('Please start the timer by clicking Par Time before completing the study');
      return;
    }
    
    setIsRunning(false);

    // Shadow signal: study complete
    shadow.signal({ type: 'study_complete' }, sessionTime);

    // ── Auto-swap: forgotten timer start recovery ────────────────────
    let effectiveTime = currentTime;
    let wasSwapped = false;
    let swapStartOverride: { session: number; system: string } | null = null;
    if (currentTime > 0 && currentTime < 5) {
      const events = [...sessionEvents];
      let lastInterIdx = -1;
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i].type === 'INTERSTITIAL') { lastInterIdx = i; break; }
      }
      if (lastInterIdx >= 0) {
        const inter = events[lastInterIdx] as InterstitialEvent;
        effectiveTime = inter.duration;
        wasSwapped = true;
        // Replace interstitial duration with 10s default gap
        events[lastInterIdx] = {
          ...inter,
          duration: 10,
          endTimeSession: inter.startTimeSession + 10,
        };
        setSessionEvents(events);
        // Adjust cumulative interstitial counter
        setInterstitialTime(prev => prev - (inter.duration - 10));
        // Correct study start time to right after the shortened interstitial
        // so the filmstrip renders the study in the correct time slot
        swapStartOverride = {
          session: inter.startTimeSession + 10,
          system: new Date(
            new Date(inter.startTimeSystem).getTime() + 10000
          ).toISOString(),
        };
        // Shadow signal: swap detected
        shadow.signal({
          type: 'swap_detected',
          interstitialDuration: inter.duration,
          correctedStart: inter.startTimeSession + 10,
          correctedSystem: swapStartOverride.system,
        }, sessionTime);
      }
    }

    const variance = effectiveTime - currentParTime;

    // Update streak counter
    if (variance <= 0) {
      // Study completed at or below par time - increase streak
      setCurrentStreak(prev => Math.min(prev + 1, 6)); // Max 6 for STREAK
    } else {
      // Study completed over par time - reset streak
      setCurrentStreak(0);
    }

    // Save study info for undo (Issue #21: include elapsedTime for interstitial recovery)
    setLastStudy({
      variance: variance,
      rvu: currentStudyRVU,
      streakBefore: currentStreak,
      elapsedTime: effectiveTime,
    });

    setCumulativeVariance(prev => prev + variance);

    // Update total RVU and calculate RVU/hr
    const newTotalRVU = totalRVU + currentStudyRVU;
    setTotalRVU(newTotalRVU);

    // Calculate and update RVU per hour
    if (sessionTime > 0) {
      const hours = sessionTime / 3600;
      setRvuPerHour(newTotalRVU / hours);
    }

    // Issue #6: Track completed study with timestamp for rolling RVU calculation
    const now = Date.now();
    const updatedStudies = [...completedStudies, { timestamp: now, rvu: currentStudyRVU }];
    setCompletedStudies(updatedStudies);

    // Calculate rolling RVU (last 60 minutes)
    const sixtyMinutesAgo = now - (60 * 60 * 1000); // 60 minutes in milliseconds
    const recentStudies = updatedStudies.filter(study => study.timestamp >= sixtyMinutesAgo);
    const calculatedRollingRVU = recentStudies.reduce((sum, study) => sum + study.rvu, 0);
    setRollingRVU(calculatedRollingRVU);

    setStudiesCompleted(prev => prev + 1);

    // Record STUDY event (Issue #1)
    if (studyStartTime !== null && selectedModality) {
      const eventStart = swapStartOverride ?? studyStartTime;
      const studyEvent: StudyEvent = {
        type: 'STUDY',
        studyNumber: studiesCompleted + 1,
        startTimeSession: eventStart.session,
        startTimeSystem: eventStart.system,
        modality: selectedModality,
        complications: [...selectedComplications],
        parTime: currentParTime,
        elapsedTime: effectiveTime,
        variance: variance,
        rvu: currentStudyRVU,
        pauseTime: 0,
        pauseUsed: false,
        drafted: wasDrafted,
        swapped: wasSwapped,
        ...(cptOverride ? { rvuSource: cptOverride.source, cpts: cptOverride.cpts } : {}),
        ...(rvuDerivedMode ? { rvuDerivedMode: true, targetRvuPerHour } : {}),
      };
      setSessionEvents(prev => [...prev, studyEvent]);
      recordEventLocally(studyEvent);
      setWasDrafted(false);
    }

    // Update cumulative par time (Issue #1)
    setCumulativeParTime(prev => prev + currentParTime);

    // Save modality for double tap tracking (Issue #1)
    setLastStudyModality(selectedModality);

    // Start interstitial time and track start (Issue #1)
    setIsInterstitialRunning(true);
    setInterstitialStartTime({ session: sessionTime, system: getCurrentDateTime() });

    // Reset for next study
    setCurrentTime(0);
    setStudyStartTime(null); // Reset study start time
    setSelectedModality(null);
    setSelectedComplications([]);

    // Write "completed" to command doc if Sidecar/HL7 was driving this study
    if (cptOverride && currentUser) {
      firestoreService.writeCommandCompleted(currentUser.uid).catch(console.error);
    }
    setCptOverride(null);

    // Check if break prompt should be shown (FIXED: only prompt if 60 min since last decline)
    const timeInMinutes = timeSinceLastBreak / 60;
    const timeSinceDeclineMinutes = lastBreakDeclineTime > 0
      ? (timeSinceLastBreak - lastBreakDeclineTime) / 60
      : timeInMinutes;

    // Show prompt if:
    // - First time: >= 120 minutes since session start
    // - After decline: >= 60 minutes since they last declined
    if (timeInMinutes >= 120 && timeSinceDeclineMinutes >= 60) {
      const hoursWorked = Math.floor(timeInMinutes / 60);
      setBreakPromptHours(hoursWorked);
      setShowBreakPrompt(true);
    }
  };
  
  // Undo last study
  const undoLastStudy = () => {
    if (!lastStudy) {
      alert('No study to undo');
      return;
    }
    
    // Revert the changes from the last study
    setCumulativeVariance(prev => prev - lastStudy.variance);
    
    // Restore streak counter
    if (lastStudy.streakBefore !== undefined) {
      setCurrentStreak(lastStudy.streakBefore);
    }
    
    // Update total RVU and recalculate RVU/hr
    const newTotalRVU = totalRVU - lastStudy.rvu;
    setTotalRVU(newTotalRVU);
    
    // Recalculate RVU per hour
    if (sessionTime > 0) {
      const hours = sessionTime / 3600;
      setRvuPerHour(newTotalRVU / hours);
    } else {
      setRvuPerHour(0);
    }
    
    setStudiesCompleted(prev => prev - 1);

    // Track deleted study (Issue #1)
    setDeletedStudies(prev => prev + 1);

    // Issue #21: Add erased study's elapsed time to Interstitial Timer
    // Use case: Study opened but someone else claimed it (worklist collision)
    setInterstitialTime(prev => prev + lastStudy.elapsedTime);

    // Clear the last study
    setLastStudy(null);
  };

  // Toggle Admin Time
  const toggleAdminTime = () => {
    shadow.signal({ type: 'admin_toggle' }, sessionTime);
    if (!isAdminTimeRunning) {
      // Starting Admin Time
      setIsAdminTimeRunning(true);
      setIsInterstitialRunning(false);
      setIsCommsTimeRunning(false);
      setAdminEvents(prev => prev + 1); // Issue #4: Increment event counter
      setAdminStartTime({ session: sessionTime, system: getCurrentDateTime() }); // Issue #1: Track start time

      // Stop study timer if in progress (replaced auto-pause)
      if (selectedModality !== null && isRunning) {
        setIsRunning(false);
      }
    } else {
      // Stopping Admin Time - record event (Issue #1)
      if (adminStartTime !== null) {
        const adminEvent: TimerEvent = {
          type: 'ADMIN',
          startTimeSession: adminStartTime.session,
          startTimeSystem: adminStartTime.system,
          endTimeSession: sessionTime,
          endTimeSystem: getCurrentDateTime(),
          duration: sessionTime - adminStartTime.session,
        };
        setSessionEvents(prev => [...prev, adminEvent]);
        recordEventLocally(adminEvent);

        setAdminStartTime(null);
      }

      setIsAdminTimeRunning(false);
      setIsInterstitialRunning(true);
      setInterstitialStartTime({ session: sessionTime, system: getCurrentDateTime() }); // Issue #1

      // Resume study timer if one was in progress
      if (selectedModality !== null && currentTime > 0) {
        setIsRunning(true);
      }
    }
  };

  // Toggle Comms Time
  const toggleCommsTime = () => {
    shadow.signal({ type: 'comms_toggle' }, sessionTime);
    if (!isCommsTimeRunning) {
      // Starting Comms Time
      setIsCommsTimeRunning(true);
      setIsInterstitialRunning(false);
      setIsAdminTimeRunning(false);
      setCommsEvents(prev => prev + 1); // Issue #4: Increment event counter
      setCommsStartTime({ session: sessionTime, system: getCurrentDateTime() }); // Issue #1: Track start time

      // Stop study timer if in progress (replaced auto-pause)
      if (selectedModality !== null && isRunning) {
        setIsRunning(false);
      }
    } else {
      // Stopping Comms Time - record event (Issue #1)
      if (commsStartTime !== null) {
        const commsEvent: TimerEvent = {
          type: 'COMMS',
          startTimeSession: commsStartTime.session,
          startTimeSystem: commsStartTime.system,
          endTimeSession: sessionTime,
          endTimeSystem: getCurrentDateTime(),
          duration: sessionTime - commsStartTime.session,
        };
        setSessionEvents(prev => [...prev, commsEvent]);
        recordEventLocally(commsEvent);

        setCommsStartTime(null);
      }

      setIsCommsTimeRunning(false);
      setIsInterstitialRunning(true);
      setInterstitialStartTime({ session: sessionTime, system: getCurrentDateTime() }); // Issue #1

      // Resume study timer if one was in progress
      if (selectedModality !== null && currentTime > 0) {
        setIsRunning(true);
      }
    }
  };

  // Toggle Break Time
  const toggleBreakTime = () => {
    if (!isBreakTimeRunning) {
      // Signal shadow before starting break (no drift issue on start)
      shadow.signal({ type: 'break_toggle' }, sessionTime);
      // Starting Break - pause Interstitial, Admin, and Comms
      setIsBreakTimeRunning(true);
      setIsInterstitialRunning(false);
      setIsAdminTimeRunning(false);
      setIsCommsTimeRunning(false);
      // Reset Time Since Last Break and decline tracking
      setTimeSinceLastBreak(0);
      setLastBreakDeclineTime(0);
      // Increment breaks taken
      setBreaksTaken(prev => prev + 1);
      setBreakStartTime({ session: sessionTime, system: getCurrentDateTime() }); // Issue #1: Track start time
      // Firebase: flush events on break start (user is idle, good time to write)
      if (FIREBASE_ENABLED && firestoreSessionId) {
        flushEventsToFirestore(sessionEvents, firestoreSessionId);
      }
    } else {
      // Stopping Break - drift correction + record event (Issue #1)

      // Drift correction: reconcile sessionTime with wall clock at break boundary
      // Break end is the cleanest correction point — no timers are mid-flight
      const wallClockElapsed = Math.round((Date.now() - sessionStartMsRef.current) / 1000);
      const drift = wallClockElapsed - sessionTime;
      const correctedSessionTime = Math.abs(drift) > 2 ? wallClockElapsed : sessionTime;
      if (Math.abs(drift) > 2) {
        setSessionTime(wallClockElapsed);
      }

      // F2: Signal shadow with corrected time (after drift correction)
      shadow.signal({ type: 'break_toggle' }, correctedSessionTime);

      if (breakStartTime !== null) {
        const breakEvent: TimerEvent = {
          type: 'BREAK',
          startTimeSession: breakStartTime.session,
          startTimeSystem: breakStartTime.system,
          endTimeSession: correctedSessionTime,
          endTimeSystem: getCurrentDateTime(),
          duration: correctedSessionTime - breakStartTime.session,
        };
        setSessionEvents(prev => [...prev, breakEvent]);
        recordEventLocally(breakEvent);

        setBreakStartTime(null);
      }

      setIsBreakTimeRunning(false);
      setIsInterstitialRunning(true);
      setInterstitialStartTime({ session: correctedSessionTime, system: getCurrentDateTime() }); // Issue #1
    }
  };

  // Toggle Double Tap (Issue #3)
  const toggleDoubleTap = () => {
    // Disable if study is in progress (modality selected OR timer running/has time)
    const isStudyInProgress = selectedModality !== null || currentTime > 0;
    if (isStudyInProgress && !isDoubleTapRunning) {
      // Don't allow starting Double Tap during dictation
      return;
    }
    shadow.signal({ type: 'doubletap_toggle', modality: lastStudyModality ?? undefined }, sessionTime);

    if (!isDoubleTapRunning) {
      // Starting Double Tap - stop Interstitial (productive time, not wasted)
      setIsDoubleTapRunning(true);
      setIsInterstitialRunning(false);
      setDoubleTapEvents(prev => prev + 1);
      setDoubleTapStartTime({ session: sessionTime, system: getCurrentDateTime() }); // Issue #1: Track start time
    } else {
      // Stopping Double Tap - record event (Issue #1)
      if (doubleTapStartTime !== null) {
        const doubleTapEvent: TimerEvent = {
          type: 'DOUBLE_TAP',
          startTimeSession: doubleTapStartTime.session,
          startTimeSystem: doubleTapStartTime.system,
          endTimeSession: sessionTime,
          endTimeSystem: getCurrentDateTime(),
          duration: sessionTime - doubleTapStartTime.session,
          associatedModality: lastStudyModality,
        };
        setSessionEvents(prev => [...prev, doubleTapEvent]);
        recordEventLocally(doubleTapEvent);

        setDoubleTapStartTime(null);
      }

      setIsDoubleTapRunning(false);
      setIsInterstitialRunning(true);
      setInterstitialStartTime({ session: sessionTime, system: getCurrentDateTime() }); // Issue #1
    }
  };

  // Toggle Auto-Start Mode
  const toggleAutoStart = () => {
    setAutoStartEnabled(prev => !prev);
  };

  // Toggle Draft Mode
  const toggleDraft = () => {
    if (!isDraftMode) {
      // Entering draft mode - save current study state
      if (!selectedModality) {
        alert('Please select a modality before using Draft mode');
        return;
      }
      shadow.signal({ type: 'draft_enter' }, sessionTime);
      
      // Stop the timer if it's running
      if (isRunning) {
        setIsRunning(false);
      }
      
      // Save the current study
      setDraftStudy({
        modality: selectedModality,
        complications: [...selectedComplications],
        currentTime: currentTime,
        parTime: currentParTime
      });
      
      // Clear current selections and reset timer
      setSelectedModality(null);
      setSelectedComplications([]);
      setCurrentTime(0);
      
      // Start interstitial time
      setIsInterstitialRunning(true);
      
      // Enter draft mode
      setIsDraftMode(true);
    } else {
      // Exiting draft mode - restore saved study
      if (!draftStudy) {
        alert('No draft study to restore');
        return;
      }
      
      // Cannot restore draft while actively running a timer on another study
      if (isRunning) {
        alert('Please stop the current study timer before resuming the draft');
        return;
      }
      
      // Restore the drafted study
      shadow.signal({ type: 'draft_exit' }, sessionTime);
      setSelectedModality(draftStudy.modality);
      setSelectedComplications(draftStudy.complications);
      setCurrentTime(draftStudy.currentTime);
      setWasDrafted(true);

      // Keep interstitial running until user clicks Par Time to resume

      // Exit draft mode
      setIsDraftMode(false);
      // Clear draft study after restoring
      setDraftStudy(null);
    }
  };
  
  // Toggle complication selection
  const toggleComplication = (complication: Complication): void => {
    if (selectedComplications.includes(complication)) {
      setSelectedComplications(selectedComplications.filter(c => c !== complication));
    } else {
      setSelectedComplications([...selectedComplications, complication]);
    }
  };
  
  // Update par time in settings
  const updateParTime = (key: string, value: string): void => {
    const seconds = parseInt(value) || 0;
    setParTimes(prev => ({
      ...prev,
      [key]: seconds
    }));
  };
  
  // Update RVU values in settings
  const updateRVUValue = (key: string, value: string, modality: string | null = null): void => {
    const rvu = parseFloat(value) || 0;
    if (modality) {
      // Modality-specific complication RVU
      setRVUValues(prev => ({
        ...prev,
        [key]: {
          ...(typeof prev[key] === 'object' ? prev[key] : {}),
          [modality]: rvu
        }
      }));
    } else {
      // Direct RVU value
      setRVUValues(prev => ({
        ...prev,
        [key]: rvu
      }));
    }
  };
  
  // Export settings to CSV
  const exportSettings = () => {
    try {
      // Create CSV content
      const csvRows = [];
      csvRows.push('Setting Type,Key,Value,Modality');
      
      // Export Par Times
      Object.entries(parTimes).forEach(([key, value]) => {
        csvRows.push(`Par Time,"${key}",${value},`);
      });
      
      // Export RVU Values
      Object.entries(rvuValues).forEach(([key, value]) => {
        if (typeof value === 'object') {
          // Modality-specific RVU
          Object.entries(value).forEach(([modality, rvu]) => {
            csvRows.push(`RVU,"${key}",${rvu},"${modality}"`);
          });
        } else {
          // Direct RVU value
          csvRows.push(`RVU,"${key}",${value},`);
        }
      });
      
      const csvContent = csvRows.join('\n');
      
      // Create and download file
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      const filename = `radtach_settings_${new Date().toISOString().slice(0,10)}.csv`;
      link.download = filename;
      link.click();
      
      // Show helpful message
      alert(`Settings exported successfully!\n\nFile saved to your Downloads folder as:\n${filename}\n\n💡 Tip: Email this file to yourself to easily transfer settings to another workstation!`);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      alert('Error exporting settings: ' + errorMessage);
    }
  };
  
  // Import settings from CSV
  const importSettings = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e: ProgressEvent<FileReader>): void => {
      try {
        const text = e.target?.result as string;
        const lines = text.split('\n');
        
        const newParTimes = { ...defaultParTimes };
        const newRVUValues = { ...defaultRVUValues };
        
        // Skip header row
        for (let i = 1; i < lines.length; i++) {
          const line = lines[i].trim();
          if (!line) continue;
          
          // Parse CSV line (handle quoted values)
          const matches = line.match(/(?:"([^"]*)"|([^,]*))/g);
          if (!matches || matches.length < 3) continue;

          const settingType = matches[0].replace(/"/g, '').trim();
          const key = matches[1].replace(/"/g, '').trim();
          const value = matches[2].replace(/"/g, '').trim();
          const modality = matches[3] ? matches[3].replace(/"/g, '').trim() : '';
          
          if (settingType === 'Par Time') {
            newParTimes[key] = parseInt(value) || 0;
          } else if (settingType === 'RVU') {
            if (modality) {
              // Modality-specific RVU
              if (!newRVUValues[key]) newRVUValues[key] = {};
              if (typeof newRVUValues[key] === 'object') {
                newRVUValues[key][modality] = parseFloat(value) || 0;
              }
            } else {
              // Direct RVU value
              newRVUValues[key] = parseFloat(value) || 0;
            }
          }
        }
        
        setParTimes(newParTimes);
        setRVUValues(newRVUValues);
        alert('Settings imported successfully!');
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        alert('Error importing settings: ' + errorMessage);
      }
    };
    
    reader.readAsText(file);
    // Reset input so same file can be imported again
    event.target.value = '';
  };
  
  // Reset settings to defaults
  const resetSettings = () => {
    if (confirm('Are you sure you want to reset all settings to defaults? This cannot be undone.')) {
      setParTimes(defaultParTimes);
      setRVUValues(defaultRVUValues);
      alert('Settings reset to defaults');
    }
  };
  
  const modalities: Modality[] = ['XR', 'FL', 'CT', 'US', 'MR', 'NM', 'MA', 'PET-CT'];
  // Top row: non-RVU modifiers (always manual). Bottom row: RVU modifiers (greyed out when Sidecar active).
  const complicationsTopRow: Complication[] = ['Cancer Follow', 'Multiple Priors', 'Complex Hx', 'Prior Surg Hx', 'Age >70'];
  const complicationsBottomRow: Complication[] = ['+1 Section', '+2 Section', 'CTA', 'Bilateral', 'Vascular'];
  const complications: Complication[] = [...complicationsTopRow, ...complicationsBottomRow];
  
  // Timezone options for signup
  const timezoneOptions = [
    { value: 'America/New_York', label: 'Eastern — New York' },
    { value: 'America/Chicago', label: 'Central — Chicago' },
    { value: 'America/Denver', label: 'Mountain — Denver' },
    { value: 'America/Phoenix', label: 'Mountain (no DST) — Phoenix' },
    { value: 'America/Los_Angeles', label: 'Pacific — Los Angeles' },
    { value: 'America/Anchorage', label: 'Alaska — Anchorage' },
    { value: 'Pacific/Honolulu', label: 'Hawaii — Honolulu' },
  ];

  // Phase 8: Reports view (full-screen, all entry points)
  if (showReports) {
    return (
      <Reports
        entryPoint={reportEntryPoint || 'login'}
        sessionEvents={lastSessionEvents}
        sessionData={lastSessionData}
        summary={lastSessionSummary}
        formatTime={formatTime}
        onExit={handleExitReports}
        userId={currentUser?.uid || null}
        userSystem={systemInput.trim() || null}
        isAdmin={isAdmin}
      />
    );
  }

  // If Firebase is enabled and no user is logged in, show login/signup form
  if (FIREBASE_ENABLED && !currentUser) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center p-4">
        <div className="bg-gray-800 rounded-lg shadow-xl p-8 w-full max-w-sm">
          <h1 className="text-2xl font-bold text-white text-center mb-6">RadTach</h1>
          <h2 className="text-lg text-gray-300 text-center mb-6">
            {isSignupMode ? 'Create Account' : 'Sign In'}
          </h2>
          <form onSubmit={handleAuthSubmit} className="space-y-4">
            <div>
              <label className="block text-sm text-gray-400 mb-1">Email</label>
              <input
                type="email"
                value={authEmail}
                onChange={e => setAuthEmail(e.target.value)}
                required
                className="w-full px-3 py-2 bg-gray-700 text-white rounded border border-gray-600 focus:border-blue-500 focus:outline-none"
                autoComplete="email"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">Password</label>
              <input
                type="password"
                value={authPassword}
                onChange={e => setAuthPassword(e.target.value)}
                required
                minLength={6}
                className="w-full px-3 py-2 bg-gray-700 text-white rounded border border-gray-600 focus:border-blue-500 focus:outline-none"
                autoComplete={isSignupMode ? 'new-password' : 'current-password'}
              />
            </div>
            {isSignupMode && (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm text-gray-400 mb-1">First Name</label>
                    <input
                      type="text"
                      value={authFirstName}
                      onChange={e => setAuthFirstName(e.target.value)}
                      required
                      placeholder="John"
                      className="w-full px-3 py-2 bg-gray-700 text-white rounded border border-gray-600 focus:border-blue-500 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-sm text-gray-400 mb-1">Last Name</label>
                    <input
                      type="text"
                      value={authLastName}
                      onChange={e => setAuthLastName(e.target.value)}
                      required
                      placeholder="Smith"
                      className="w-full px-3 py-2 bg-gray-700 text-white rounded border border-gray-600 focus:border-blue-500 focus:outline-none"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1">Credentials <span className="text-gray-600">(optional)</span></label>
                  <input
                    type="text"
                    value={authCredentials}
                    onChange={e => setAuthCredentials(e.target.value)}
                    placeholder="MD, DO, MBBS, etc."
                    className="w-full px-3 py-2 bg-gray-700 text-white rounded border border-gray-600 focus:border-blue-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1">Role</label>
                  <select
                    value={authRequestedRole}
                    onChange={e => setAuthRequestedRole(e.target.value)}
                    className="w-full px-3 py-2 bg-gray-700 text-white rounded border border-gray-600 focus:border-blue-500 focus:outline-none"
                  >
                    <option value="radiologist">Radiologist</option>
                    <option value="hospitalAdmin">Hospital Administrator (Request)</option>
                    <option value="admin">Admin (Request)</option>
                    <option value="president">President (Request)</option>
                    <option value="it">IT (Request)</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1">Timezone</label>
                  <select
                    value={authTimezone}
                    onChange={e => setAuthTimezone(e.target.value)}
                    className="w-full px-3 py-2 bg-gray-700 text-white rounded border border-gray-600 focus:border-blue-500 focus:outline-none"
                  >
                    {timezoneOptions.map(tz => (
                      <option key={tz.value} value={tz.value}>{tz.label}</option>
                    ))}
                  </select>
                </div>
              </>
            )}
            {authError && (
              <div className="text-red-400 text-sm text-center">{authError}</div>
            )}
            <button
              type="submit"
              disabled={authLoading}
              className="w-full py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-800 disabled:cursor-not-allowed text-white rounded font-medium transition-colors"
            >
              {authLoading ? '...' : isSignupMode ? 'Create Account' : 'Sign In'}
            </button>
          </form>
          <div className="mt-4 text-center">
            <button
              onClick={() => { setIsSignupMode(!isSignupMode); setAuthError(''); }}
              className="text-sm text-blue-400 hover:text-blue-300"
            >
              {isSignupMode ? 'Already have an account? Sign in' : "Don't have an account? Sign up"}
            </button>
          </div>
          <div className="mt-4 text-center">
            <a
              href="https://docs.google.com/forms/d/e/1FAIpQLSewFhqnsSHcaYCxh2slb0xL3Hp_ETw8UsY95X7m73IoGKv-5w/viewform"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-gray-500 hover:text-gray-400"
            >
              Notify Support
            </a>
          </div>
        </div>
      </div>
    );
  }

  // Post-signup thank you (dead-end for non-radiologists who don't need to read studies)
  if (FIREBASE_ENABLED && currentUser && showThankYou) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center p-4">
        <div className="bg-gray-800 rounded-lg shadow-xl p-8 w-full max-w-sm text-center">
          <h1 className="text-2xl font-bold text-white mb-4">Thank You!</h1>
          <p className="text-gray-400 text-sm">
            Your role request has been sent to the RadTach administrator. You can close this page.
          </p>
          <p className="text-gray-600 text-xs mt-6">{currentUser.email}</p>
        </div>
      </div>
    );
  }

  // Post-signup fork: non-radiologist can choose to read studies or leave
  if (FIREBASE_ENABLED && currentUser && showPostSignupFork) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center p-4">
        <div className="bg-gray-800 rounded-lg shadow-xl p-8 w-full max-w-sm text-center">
          <h1 className="text-2xl font-bold text-white mb-2">Account Created</h1>
          <p className="text-gray-400 text-sm mb-8">
            Your role request has been submitted. Are you reading studies today?
          </p>
          <div className="space-y-3">
            <button
              onClick={() => setShowPostSignupFork(false)}
              className="w-full py-3 bg-green-600 hover:bg-green-700 text-white rounded-lg font-medium transition-colors"
            >
              I'm Ready to Read Studies
            </button>
            <button
              onClick={() => setShowThankYou(true)}
              className="w-full py-3 bg-gray-600 hover:bg-gray-700 text-white rounded-lg font-medium transition-colors"
            >
              We're Good
            </button>
          </div>
          <p className="text-gray-600 text-xs mt-6">{currentUser.email}</p>
        </div>
      </div>
    );
  }

  // One-time displayName prompt for existing users who don't have one set
  if (FIREBASE_ENABLED && currentUser && userDisplayName === null) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center p-4">
        <div className="bg-gray-800 rounded-lg shadow-xl p-8 w-full max-w-sm">
          <h1 className="text-2xl font-bold text-white text-center mb-2">Welcome to RadTach</h1>
          <p className="text-gray-400 text-sm text-center mb-6">
            Please set your display name. This helps identify you in group reports and the admin console.
          </p>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm text-gray-400 mb-1">First Name</label>
                <input
                  type="text"
                  value={displayNameFirstInput}
                  onChange={e => setDisplayNameFirstInput(e.target.value)}
                  placeholder="John"
                  className="w-full px-3 py-2 bg-gray-700 text-white rounded border border-gray-600 focus:border-blue-500 focus:outline-none"
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-1">Last Name</label>
                <input
                  type="text"
                  value={displayNameLastInput}
                  onChange={e => setDisplayNameLastInput(e.target.value)}
                  placeholder="Smith"
                  className="w-full px-3 py-2 bg-gray-700 text-white rounded border border-gray-600 focus:border-blue-500 focus:outline-none"
                />
              </div>
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">Credentials <span className="text-gray-600">(optional)</span></label>
              <input
                type="text"
                value={displayNameCredInput}
                onChange={e => setDisplayNameCredInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && displayNameFirstInput.trim() && displayNameLastInput.trim()) handleSetDisplayName(); }}
                placeholder="MD, DO, MBBS, etc."
                className="w-full px-3 py-2 bg-gray-700 text-white rounded border border-gray-600 focus:border-blue-500 focus:outline-none"
              />
            </div>
            <button
              onClick={handleSetDisplayName}
              disabled={!displayNameFirstInput.trim() || !displayNameLastInput.trim()}
              className="w-full py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-800 disabled:cursor-not-allowed text-white rounded font-medium transition-colors"
            >
              Save
            </button>
            <button
              onClick={() => setUserDisplayName(undefined)}
              className="w-full py-1 text-sm text-gray-500 hover:text-gray-400"
            >
              Skip for now
            </button>
          </div>
          <p className="text-gray-600 text-xs text-center mt-4">{currentUser.email}</p>
        </div>
      </div>
    );
  }

  // Orphaned session recovery dialog
  if (FIREBASE_ENABLED && currentUser && recoveryChecked && orphanedSessions && orphanedSessions.length > 0) {
    const orphan = orphanedSessions[recoverySessionIndex];
    const preview = recoveryPreview;
    const sessionDate = orphan?.startDateTime
      ? new Date(orphan.startDateTime).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
      : 'Unknown date';
    const eventsFound = preview?.events.length ?? 0;
    const hasZeroEvents = eventsFound === 0 && preview && !preview.loading;

    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center p-4">
        <div className="bg-gray-800 rounded-lg shadow-xl p-8 w-full max-w-md">
          {orphanedSessions.length > 1 && (
            <p className="text-gray-400 text-xs text-center mb-3">
              {recoverySessionIndex + 1} of {orphanedSessions.length} incomplete sessions
            </p>
          )}
          <h1 className="text-2xl font-bold text-white text-center mb-2">Session Recovery</h1>
          <p className="text-gray-400 text-sm text-center mb-6">
            An incomplete session was found. It may have been interrupted by a browser crash or power loss.
          </p>

          <div className="bg-gray-700 rounded-lg p-4 mb-4 space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-400">Date</span>
              <span className="text-white">{sessionDate}</span>
            </div>
            {orphan?.system && (
              <div className="flex justify-between">
                <span className="text-gray-400">System</span>
                <span className="text-white">{orphan.system}</span>
              </div>
            )}
            {orphan?.workstationId && (
              <div className="flex justify-between">
                <span className="text-gray-400">Office</span>
                <span className="text-white">{orphan.workstationId}</span>
              </div>
            )}
            {orphan?.rotation && (
              <div className="flex justify-between">
                <span className="text-gray-400">Rotation</span>
                <span className="text-white">{orphan.rotation}</span>
              </div>
            )}
            <div className="flex justify-between">
              <span className="text-gray-400">Session ID</span>
              <span className="text-gray-300 text-xs font-mono">{orphan?.id}</span>
            </div>
          </div>

          {preview?.loading ? (
            <div className="text-gray-400 text-sm text-center py-4">Loading session data...</div>
          ) : preview?.error ? (
            <div className="bg-red-900/40 text-red-300 px-4 py-3 rounded-lg text-sm mb-4">
              {preview.error}
            </div>
          ) : preview ? (
            <>
              {hasZeroEvents && (
                <div className="bg-yellow-900/60 text-yellow-200 px-4 py-3 rounded-lg text-sm mb-4">
                  No events were saved before the session ended. Recovery will close this session with zero data.
                </div>
              )}
              <div className="bg-gray-700 rounded-lg p-4 mb-6 space-y-2 text-sm">
                <p className="text-gray-300 font-medium mb-2">Recoverable Data</p>
                <div className="flex justify-between">
                  <span className="text-gray-400">Studies</span>
                  <span className="text-white">{preview.reconstructed.studiesCompleted}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Total RVU</span>
                  <span className="text-white">{preview.reconstructed.totalRVU.toFixed(2)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Session Time</span>
                  <span className="text-white">{formatTime(preview.reconstructed.totalSessionTime)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Events Found</span>
                  <span className="text-white">{eventsFound}</span>
                </div>
              </div>
            </>
          ) : null}

          <div className="flex gap-3">
            <button
              onClick={handleRecoverSession}
              disabled={recoveryInProgress || preview?.loading}
              className="flex-1 py-3 bg-green-600 hover:bg-green-700 disabled:bg-green-800 disabled:cursor-not-allowed text-white rounded-lg font-medium transition-colors"
            >
              {recoveryInProgress ? 'Recovering...' : 'Recover Session'}
            </button>
            <button
              onClick={handleDiscardSession}
              disabled={recoveryInProgress || preview?.loading}
              className="flex-1 py-3 bg-gray-600 hover:bg-gray-700 disabled:bg-gray-700 disabled:cursor-not-allowed text-white rounded-lg font-medium transition-colors"
            >
              {recoveryInProgress ? 'Working...' : 'Discard'}
            </button>
          </div>

          <p className="text-gray-600 text-xs text-center mt-4">
            Recovered sessions may be missing up to 4 studies from the last batch before the crash.
          </p>
        </div>
      </div>
    );
  }

  // Post-session screen (Firebase only)
  if (FIREBASE_ENABLED && showPostSessionScreen) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center p-4">
        <div className="bg-gray-800 rounded-lg shadow-xl p-8 w-full max-w-md text-center">
          <h1 className="text-2xl font-bold text-white mb-2">Session Complete</h1>
          <p className="text-gray-400 text-sm mb-4">{currentUser?.email}</p>

          {health.hasPendingOnExit && (
            <div className="bg-yellow-900/60 text-yellow-200 px-4 py-3 rounded-lg text-sm mb-4 text-left">
              RadTach has had issues communicating with Firestore. Your data for this session
              has been stored locally. The next time you log in, it will be uploaded to Firebase.
            </div>
          )}

          {showRecentSessions ? (
            <div>
              <h2 className="text-lg font-semibold text-white mb-4">Recent Sessions</h2>
              {recentSessions.length === 0 ? (
                <p className="text-gray-400 text-sm mb-4">No sessions found.</p>
              ) : (
                <div className="space-y-2 mb-4 max-h-64 overflow-y-auto">
                  {recentSessions.map((session) => (
                    <div key={session.id} className="bg-gray-700 rounded-lg p-3 text-left">
                      <div className="flex justify-between items-center mb-1">
                        <span className="text-white text-sm font-medium">
                          {session.startDateTime
                            ? new Date(session.startDateTime).toLocaleDateString()
                            : 'Unknown date'}
                        </span>
                        <span className="text-gray-400 text-xs">
                          {typeof session.totalSessionTime === 'number'
                            ? formatTime(session.totalSessionTime)
                            : '--'}
                        </span>
                      </div>
                      <div className="flex justify-between text-xs text-gray-300">
                        <span>{session.studiesCompleted ?? 0} studies</span>
                        <span>{typeof session.totalRVU === 'number' ? session.totalRVU.toFixed(2) : '0.00'} RVU</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <button
                onClick={() => setShowRecentSessions(false)}
                className="w-full py-3 bg-gray-600 hover:bg-gray-700 text-white rounded-lg font-medium transition-colors"
              >
                Back
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              <button
                onClick={handleReviewPerformance}
                className="w-full py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium transition-colors"
              >
                Review Performance
              </button>
              <button
                onClick={() => setShowPostSessionScreen(false)}
                className="w-full py-3 bg-green-600 hover:bg-green-700 text-white rounded-lg font-medium transition-colors"
              >
                Start New Session
              </button>
              <div className="flex justify-center gap-4 text-sm pt-2">
                <a
                  href="https://docs.google.com/forms/d/e/1FAIpQLSf3OzcO9-0Zc8sKZf142nQFI0JkbV7wOX-DRpyiyVR1iIw_6g/viewform"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-gray-500 hover:text-gray-400"
                >
                  Bug Report
                </a>
                <a
                  href="https://docs.google.com/forms/d/e/1FAIpQLSewFhqnsSHcaYCxh2slb0xL3Hp_ETw8UsY95X7m73IoGKv-5w/viewform"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-gray-500 hover:text-gray-400"
                >
                  Notify Support
                </a>
                <a
                  href="https://docs.google.com/forms/d/e/1FAIpQLSfIyXO8tV5DM_MG-BGITaJfa7_FVf8xT9-mnQMv0uO1FAHJfw/viewform"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-gray-500 hover:text-gray-400"
                >
                  Feature Request
                </a>
              </div>
              <button
                onClick={handleLogout}
                className="w-full py-3 bg-gray-600 hover:bg-gray-700 text-white rounded-lg font-medium transition-colors"
              >
                Log Out
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-900 p-4">
      {/* Settings Modal */}
      {showSettings && (
        <div className="fixed inset-0 bg-black bg-opacity-75 flex items-start justify-center z-50 p-4">
          <div className="bg-gray-800 rounded-lg shadow-xl p-6 w-full max-w-2xl my-4 max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-2xl font-bold text-white">Par Time Settings</h2>
              <span className="text-gray-600 text-xs ml-2">Build {BUILD_ID}</span>
              <div className="flex items-center space-x-2">
                {!FIREBASE_ENABLED && (
                  <>
                    {/* Hidden file input for import */}
                    <input
                      type="file"
                      id="import-settings"
                      accept=".csv"
                      onChange={importSettings}
                      className="hidden"
                    />
                    <button
                      onClick={() => document.getElementById('import-settings')?.click()}
                      className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded transition-colors"
                      title="Import Settings from CSV"
                    >
                      Import
                    </button>
                    <button
                      onClick={exportSettings}
                      className="px-3 py-1.5 bg-green-600 hover:bg-green-700 text-white text-sm rounded transition-colors"
                      title="Export Settings to CSV"
                    >
                      Export
                    </button>
                    <button
                      onClick={resetSettings}
                      className="px-3 py-1.5 bg-orange-600 hover:bg-orange-700 text-white text-sm rounded transition-colors"
                      title="Reset to Defaults"
                    >
                      Reset
                    </button>
                  </>
                )}
                <button
                  onClick={() => setShowSettings(false)}
                  className="text-gray-400 hover:text-white text-2xl ml-2"
                >
                  ×
                </button>
              </div>
            </div>
            
            <div className="space-y-6">
              {/* Par Time Mode Toggle */}
              <div>
                <h3 className="text-lg font-semibold text-white mb-3">Par Time Mode</h3>
                <div className="flex space-x-2 mb-4">
                  <button
                    onClick={() => setRvuDerivedMode(false)}
                    className={`px-5 py-2.5 rounded-lg font-medium transition-colors ${
                      !rvuDerivedMode
                        ? 'bg-blue-600 hover:bg-blue-700 text-white'
                        : 'bg-gray-600 hover:bg-gray-500 text-gray-300'
                    }`}
                  >
                    Modality
                  </button>
                  <button
                    onClick={() => setRvuDerivedMode(true)}
                    className={`px-5 py-2.5 rounded-lg font-medium transition-colors ${
                      rvuDerivedMode
                        ? 'bg-blue-600 hover:bg-blue-700 text-white'
                        : 'bg-gray-600 hover:bg-gray-500 text-gray-300'
                    }`}
                  >
                    RVU/hr Derived
                  </button>
                </div>
              </div>

              {rvuDerivedMode ? (
                <>
                  {/* RVU/hr Derived Mode Controls */}
                  <div className="bg-gray-700 p-4 rounded">
                    <div className="flex items-center justify-between mb-3">
                      <span className="text-white font-medium text-lg">Target: {targetRvuPerHour.toFixed(1)} RVU/hr</span>
                    </div>
                    <input
                      type="range"
                      min="5"
                      max="12"
                      step="0.5"
                      value={targetRvuPerHour}
                      onChange={(e) => setTargetRvuPerHour(parseFloat(e.target.value))}
                      className="w-full h-2 bg-gray-600 rounded-lg appearance-none cursor-pointer accent-blue-500"
                    />
                    <div className="flex justify-between text-sm text-gray-400 mt-1">
                      <span>5</span>
                      <span>8.5</span>
                      <span>12</span>
                    </div>

                    <div className="mt-4 space-y-1">
                      <p className="text-sm text-gray-300">
                        CT Abd/Pel (2.55 RVU) → {formatTime(Math.round((2.55 / targetRvuPerHour) * 3600 - 8), true)}
                      </p>
                      <p className="text-sm text-gray-300">
                        CT Head (0.91 RVU) → {formatTime(Math.round((0.91 / targetRvuPerHour) * 3600 - 8), true)}
                      </p>
                      <p className="text-sm text-gray-300">
                        XR Chest (0.32 RVU) → {formatTime(Math.max(0, Math.round((0.32 / targetRvuPerHour) * 3600 - 8)), true)}
                      </p>
                    </div>

                    <div className="mt-4 p-3 bg-gray-800 rounded text-sm text-gray-400">
                      <p>Requires Sidecar CPT data. Manual modality mode uses standard par times as fallback.</p>
                    </div>
                  </div>

                  {/* Non-RVU Complications (always active) */}
                  <div>
                    <h3 className="text-lg font-semibold text-white mb-3">Non-RVU Complications</h3>
                    <p className="text-sm text-gray-400 mb-3">Case complexity not captured by RVU value</p>
                    <div className="grid grid-cols-2 gap-4">
                      {NON_RVU_COMPLICATIONS.map(comp => (
                        <div key={comp} className="flex items-center justify-between bg-gray-700 p-3 rounded">
                          <label className="text-white font-medium">{comp}</label>
                          <div className="flex items-center">
                            <input
                              type="number"
                              min="0"
                              value={parTimes[comp]}
                              onChange={(e) => updateParTime(comp, e.target.value)}
                              className="w-20 px-2 py-1 bg-gray-600 text-white rounded text-center"
                            />
                            <span className="text-gray-300 ml-2">sec</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              ) : (
                <>
                  {/* Standard Modality-Based Par Times */}
                  <div>
                    <h3 className="text-lg font-semibold text-white mb-3">Modalities</h3>
                    <div className="grid grid-cols-2 gap-4">
                      {modalities.map(modality => (
                        <div key={modality} className="flex items-center justify-between bg-gray-700 p-3 rounded">
                          <label className="text-white font-medium">{modality}</label>
                          <div className="flex items-center">
                            <input
                              type="number"
                              min="0"
                              value={parTimes[modality]}
                              onChange={(e) => updateParTime(modality, e.target.value)}
                              className="w-20 px-2 py-1 bg-gray-600 text-white rounded text-center"
                            />
                            <span className="text-gray-300 ml-2">sec</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div>
                    <h3 className="text-lg font-semibold text-white mb-3">Complications</h3>
                    <div className="grid grid-cols-2 gap-4">
                      {complications.map(complication => (
                        <div key={complication} className="flex items-center justify-between bg-gray-700 p-3 rounded">
                          <label className="text-white font-medium">{complication}</label>
                          <div className="flex items-center">
                            <input
                              type="number"
                              min="0"
                              value={parTimes[complication]}
                              onChange={(e) => updateParTime(complication, e.target.value)}
                              className="w-20 px-2 py-1 bg-gray-600 text-white rounded text-center"
                            />
                            <span className="text-gray-300 ml-2">sec</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              )}
              
              <div>
                <h3 className="text-lg font-semibold text-white mb-3">Display Options</h3>
                <div className="bg-gray-700 p-4 rounded">
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="text-white font-medium">Stealth Mode</span>
                      <p className="text-sm text-gray-300 mt-1">
                        Removes colors and flashing. Shows +/- symbols for Above/Below Par. Uses outlines instead of colored buttons.
                        <br />
                        <span className="text-gray-400 italic">Helpful for photosensitivity or colorblindness</span>
                      </p>
                    </div>
                    <div className="ml-4">
                      <button
                        onClick={() => setStealthMode(!stealthMode)}
                        className={`px-6 py-3 rounded-lg font-medium transition-colors ${
                          stealthMode
                            ? 'bg-blue-600 hover:bg-blue-700 text-white'
                            : 'bg-gray-600 hover:bg-gray-500 text-gray-300'
                        }`}
                      >
                        {stealthMode ? 'ON' : 'OFF'}
                      </button>
                    </div>
                  </div>

                  <div className="flex items-center justify-between mt-4 pt-4 border-t border-gray-600">
                    <div>
                      <span className="text-white font-medium">H:M:S Time Format</span>
                      <p className="text-sm text-gray-300 mt-1">
                        Display times as Hours:Minutes:Seconds instead of Minutes:Seconds.
                        <br />
                        <span className="text-gray-400 italic">Useful for longer sessions</span>
                      </p>
                    </div>
                    <div className="ml-4">
                      <button
                        onClick={() => setUseHMSFormat(!useHMSFormat)}
                        className={`px-6 py-3 rounded-lg font-medium transition-colors ${
                          useHMSFormat
                            ? 'bg-blue-600 hover:bg-blue-700 text-white'
                            : 'bg-gray-600 hover:bg-gray-500 text-gray-300'
                        }`}
                      >
                        {useHMSFormat ? 'ON' : 'OFF'}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Phase 8: View Reports (admin only when mid-session) */}
            {FIREBASE_ENABLED && (
              <div className="space-y-4 mt-6">
                <h3 className="text-lg font-semibold text-white mb-3">Reports</h3>
                <div className={`bg-gray-700 p-4 rounded ${!isAdmin ? 'opacity-50' : ''}`}>
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="text-white font-medium">View Reports</span>
                      <p className="text-sm text-gray-300 mt-1">
                        {isAdmin
                          ? 'Open session reports and analytics.'
                          : 'Admin access required.'}
                      </p>
                    </div>
                    <div className="ml-4">
                      <button
                        onClick={handleViewReportsFromSettings}
                        disabled={!isAdmin}
                        className={`px-6 py-3 rounded-lg font-medium transition-colors ${
                          isAdmin
                            ? 'bg-indigo-600 hover:bg-indigo-700 text-white'
                            : 'bg-gray-600 text-gray-500 cursor-not-allowed'
                        }`}
                      >
                        Open
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}

            <div className="flex justify-center gap-4 mt-6 text-sm">
              <a
                href="https://docs.google.com/forms/d/e/1FAIpQLSf3OzcO9-0Zc8sKZf142nQFI0JkbV7wOX-DRpyiyVR1iIw_6g/viewform"
                target="_blank"
                rel="noopener noreferrer"
                className="text-gray-500 hover:text-gray-400"
              >
                Bug Report
              </a>
              <a
                href="https://docs.google.com/forms/d/e/1FAIpQLSewFhqnsSHcaYCxh2slb0xL3Hp_ETw8UsY95X7m73IoGKv-5w/viewform"
                target="_blank"
                rel="noopener noreferrer"
                className="text-gray-500 hover:text-gray-400"
              >
                Notify Support
              </a>
            </div>

            <div className="flex space-x-3 mt-4">
              <button
                onClick={() => {
                  setShowSettings(false);
                  setShowGuide(true);
                }}
                className="flex-1 py-3 bg-gray-600 hover:bg-gray-700 text-white rounded-lg font-medium transition-colors"
              >
                Quick Start Guide
              </button>
              <button
                onClick={() => {
                  setShowSettings(false);
                  setShowRVUSettings(true);
                }}
                className="flex-1 py-3 bg-purple-600 hover:bg-purple-700 text-white rounded-lg font-medium transition-colors flex items-center justify-center"
              >
                RVU Settings →
              </button>
              <button
                onClick={() => setShowSettings(false)}
                className="flex-1 py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium transition-colors"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
      
      {/* RVU Settings Modal */}
      {showRVUSettings && (
        <div className="fixed inset-0 bg-black bg-opacity-75 flex items-start justify-center z-50 p-4">
          <div className="bg-gray-800 rounded-lg shadow-xl p-6 w-full max-w-2xl my-4 max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-2xl font-bold text-white">RVU Settings</h2>
              <div className="flex items-center space-x-2">
                {!FIREBASE_ENABLED && (
                  <>
                    <button
                      onClick={() => document.getElementById('import-settings')?.click()}
                      className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded transition-colors"
                      title="Import Settings from CSV"
                    >
                      Import
                    </button>
                    <button
                      onClick={exportSettings}
                      className="px-3 py-1.5 bg-green-600 hover:bg-green-700 text-white text-sm rounded transition-colors"
                      title="Export Settings to CSV"
                    >
                      Export
                    </button>
                    <button
                      onClick={resetSettings}
                      className="px-3 py-1.5 bg-orange-600 hover:bg-orange-700 text-white text-sm rounded transition-colors"
                      title="Reset to Defaults"
                    >
                      Reset
                    </button>
                  </>
                )}
                <button
                  onClick={() => setShowRVUSettings(false)}
                  className="text-gray-400 hover:text-white text-2xl ml-2"
                >
                  ×
                </button>
              </div>
            </div>
            
            <div className="space-y-6">
              <div>
                <h3 className="text-lg font-semibold text-white mb-3">Modality Base RVU</h3>
                <div className="grid grid-cols-2 gap-4">
                  {modalities.map(modality => (
                    <div key={modality} className="flex items-center justify-between bg-gray-700 p-3 rounded">
                      <label className="text-white font-medium">{modality}</label>
                      <div className="flex items-center">
                        <input
                          type="number"
                          min="0"
                          step="0.1"
                          value={typeof rvuValues[modality] === 'number' ? rvuValues[modality] : 0}
                          onChange={(e) => updateRVUValue(modality, e.target.value)}
                          className="w-20 px-2 py-1 bg-gray-600 text-white rounded text-center"
                        />
                        <span className="text-gray-300 ml-2">RVU</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              
              <div>
                <h3 className="text-lg font-semibold text-white mb-3">Complication RVU Additions</h3>
                
                <div className="bg-gray-700 p-4 rounded mb-3">
                  <h4 className="text-white font-medium mb-3">+1 Section</h4>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="flex items-center justify-between bg-gray-600 p-2 rounded">
                      <label className="text-white text-sm">CT</label>
                      <div className="flex items-center">
                        <input
                          type="number"
                          min="0"
                          step="0.1"
                          value={typeof rvuValues['+1 Section'] === 'object' && rvuValues['+1 Section'] !== null ? (rvuValues['+1 Section'] as { [key: string]: number })['CT'] || 0 : 0}
                          onChange={(e) => updateRVUValue('+1 Section', e.target.value, 'CT')}
                          className="w-16 px-2 py-1 bg-gray-700 text-white rounded text-center text-sm"
                        />
                        <span className="text-gray-300 ml-1 text-xs">RVU</span>
                      </div>
                    </div>
                    <div className="flex items-center justify-between bg-gray-600 p-2 rounded">
                      <label className="text-white text-sm">US</label>
                      <div className="flex items-center">
                        <input
                          type="number"
                          min="0"
                          step="0.1"
                          value={typeof rvuValues['+1 Section'] === 'object' && rvuValues['+1 Section'] !== null ? (rvuValues['+1 Section'] as { [key: string]: number })['US'] || 0 : 0}
                          onChange={(e) => updateRVUValue('+1 Section', e.target.value, 'US')}
                          className="w-16 px-2 py-1 bg-gray-700 text-white rounded text-center text-sm"
                        />
                        <span className="text-gray-300 ml-1 text-xs">RVU</span>
                      </div>
                    </div>
                  </div>
                </div>
                
                <div className="bg-gray-700 p-4 rounded mb-3">
                  <h4 className="text-white font-medium mb-3">+2 Section</h4>
                  <div className="flex items-center justify-between bg-gray-600 p-2 rounded">
                    <label className="text-white text-sm">CT</label>
                    <div className="flex items-center">
                      <input
                        type="number"
                        min="0"
                        step="0.1"
                        value={typeof rvuValues['+2 Section'] === 'object' && rvuValues['+2 Section'] !== null ? (rvuValues['+2 Section'] as { [key: string]: number })['CT'] || 0 : 0}
                        onChange={(e) => updateRVUValue('+2 Section', e.target.value, 'CT')}
                        className="w-16 px-2 py-1 bg-gray-700 text-white rounded text-center text-sm"
                      />
                      <span className="text-gray-300 ml-1 text-xs">RVU</span>
                    </div>
                  </div>
                </div>
                
                <div className="bg-gray-700 p-4 rounded">
                  <h4 className="text-white font-medium mb-3">CTA</h4>
                  <div className="flex items-center justify-between bg-gray-600 p-2 rounded">
                    <label className="text-white text-sm">CT</label>
                    <div className="flex items-center">
                      <input
                        type="number"
                        min="0"
                        step="0.1"
                        value={typeof rvuValues['CTA'] === 'object' && rvuValues['CTA'] !== null ? (rvuValues['CTA'] as { [key: string]: number })['CT'] || 0 : 0}
                        onChange={(e) => updateRVUValue('CTA', e.target.value, 'CT')}
                        className="w-16 px-2 py-1 bg-gray-700 text-white rounded text-center text-sm"
                      />
                      <span className="text-gray-300 ml-1 text-xs">RVU</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            
            <div className="flex space-x-3 mt-6">
              <button
                onClick={() => {
                  setShowRVUSettings(false);
                  setShowSettings(true);
                }}
                className="flex-1 py-3 bg-gray-600 hover:bg-gray-700 text-white rounded-lg font-medium transition-colors"
              >
                ← Back to Par Times
              </button>
              <button
                onClick={() => setShowRVUSettings(false)}
                className="flex-1 py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium transition-colors"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
      
      {/* Quick Start Guide Modal */}
      {showGuide && (
        <div className="fixed inset-0 bg-black bg-opacity-75 z-50 overflow-y-auto">
          <div className="flex min-h-screen items-start justify-center p-4">
            <div className="bg-gray-800 rounded-lg shadow-xl p-8 w-full max-w-4xl my-8">
              <div className="flex justify-between items-center mb-6 border-b border-gray-700 pb-4">
                <div>
                  <h1 className="text-3xl font-bold text-white">RadTach Quick Start Guide</h1>
                  <p className="text-sm text-gray-400 mt-1">Your Radiologist Tachometer for Productivity Tracking</p>
                </div>
                <button
                  onClick={() => setShowGuide(false)}
                  className="text-gray-400 hover:text-white text-3xl leading-none"
                >
                  ×
                </button>
              </div>
              
              <div className="text-gray-200 space-y-6">
                {/* What is RadTach */}
                <section>
                  <h2 className="text-2xl font-bold text-white mb-3">What is RadTach?</h2>
                  <p className="leading-relaxed">
                    RadTach (Radiologist Tachometer) is your personal productivity dashboard for tracking reading efficiency during daily work sessions.
                    Like a car's tachometer measures engine RPM, RadTach measures your workflow speed against target par times,
                    helping you optimize productivity while maintaining quality.
                  </p>
                  <div className="bg-green-900 bg-opacity-30 border border-green-500 rounded-lg p-3 mt-3">
                    <p className="text-sm"><strong className="text-green-400">Zero PHI by design:</strong> RadTach never collects or stores patient data. No names, no MRNs, no dates of birth, no images, no report text. Only time, modality, and complication selections are recorded.</p>
                  </div>
                </section>

                {/* Getting Started */}
                <section>
                  <h2 className="text-2xl font-bold text-white mb-3">Getting Started</h2>
                  <div className="bg-gray-700 rounded-lg p-4 space-y-3">
                    <div className="flex items-start">
                      <span className="flex-shrink-0 w-8 h-8 bg-blue-600 rounded-full flex items-center justify-center text-white font-bold mr-3">1</span>
                      <div>
                        <h3 className="font-semibold text-white">Sign In</h3>
                        <p className="text-sm text-gray-300">Go to <strong>radtach.web.app</strong> and sign in with your email and password. If you don't have an account, click "Sign up" to create one.</p>
                      </div>
                    </div>
                    <div className="flex items-start">
                      <span className="flex-shrink-0 w-8 h-8 bg-blue-600 rounded-full flex items-center justify-center text-white font-bold mr-3">2</span>
                      <div>
                        <h3 className="font-semibold text-white">Start a Session</h3>
                        <p className="text-sm text-gray-300">Click <strong>Start Session</strong>. You'll be asked to verify your system name, then select your office and rotation from picklists configured for your group. Check "Half day" if applicable. Your selections are remembered for next time.</p>
                      </div>
                    </div>
                    <div className="flex items-start">
                      <span className="flex-shrink-0 w-8 h-8 bg-blue-600 rounded-full flex items-center justify-center text-white font-bold mr-3">3</span>
                      <div>
                        <h3 className="font-semibold text-white">Read Studies</h3>
                        <p className="text-sm text-gray-300">Select a modality, start dictating, complete the study. RadTach tracks everything in between. See the <strong>Basic Workflow</strong> section below for details.</p>
                      </div>
                    </div>
                    <div className="flex items-start">
                      <span className="flex-shrink-0 w-8 h-8 bg-red-600 rounded-full flex items-center justify-center text-white font-bold mr-3">4</span>
                      <div>
                        <h3 className="font-semibold text-white">Stop Session (SHIFT+Click)</h3>
                        <p className="text-sm text-gray-300">At the end of your work day, hold <strong>SHIFT</strong> and click <strong>Stop Session</strong>. Confirm the stop, and your session data is saved to the database and exported to clipboard. You'll see options to review your performance, start a new session, or log out.</p>
                      </div>
                    </div>
                  </div>
                </section>

                {/* What is a Session */}
                <section>
                  <h2 className="text-2xl font-bold text-white mb-3">What is a "Session"?</h2>
                  <p className="leading-relaxed mb-3">
                    A session represents your work day (or work half-day). In most cases you'll have one session per day. Start it when you sit down to read, stop it when you're done for the day.
                  </p>
                  <div className="bg-gray-700 rounded-lg p-4 space-y-2 text-sm">
                    <p><strong className="text-white">Going to lunch or an appointment?</strong> Use the <strong>Break</strong> button. Don't stop and restart your session — Break time is tracked separately and pauses Interstitial tracking.</p>
                    <p><strong className="text-white">Group meeting, tumor board, or professional duty?</strong> Use <strong>Admin</strong> time. This accounts for legitimate non-reading work without ending your session.</p>
                    <p><strong className="text-white">Hardware failure or system crash?</strong> If you have to restart your browser, start a new session. Multiple sessions on the same calendar date are treated as one work day in reports.</p>
                    <p><strong className="text-white">Half day?</strong> Check the "Half day" box in the session start dialog, or RadTach will ask when you stop if your session was under 6 hours. Half-day sessions are flagged in reports so they don't skew comparisons with full days.</p>
                  </div>
                </section>

                {/* Basic Workflow */}
                <section>
                  <h2 className="text-2xl font-bold text-white mb-3">Basic Workflow</h2>
                  <div className="bg-gray-700 rounded-lg p-4 space-y-3">
                    <div className="flex items-start">
                      <span className="flex-shrink-0 w-8 h-8 bg-blue-600 rounded-full flex items-center justify-center text-white font-bold mr-3">1</span>
                      <div>
                        <h3 className="font-semibold text-white">Select Modality</h3>
                        <p className="text-sm text-gray-300">Click your exam type: XR, FL, CT, US, MR, NM, MA, or PET-CT</p>
                      </div>
                    </div>
                    <div className="flex items-start">
                      <span className="flex-shrink-0 w-8 h-8 bg-blue-600 rounded-full flex items-center justify-center text-white font-bold mr-3">2</span>
                      <div>
                        <h3 className="font-semibold text-white">Add Complications (Optional)</h3>
                        <p className="text-sm text-gray-300">Click any applicable factors: Cancer Follow, +1 Section, Multiple Priors, etc. These add time to your par and (for some) additional RVU.</p>
                      </div>
                    </div>
                    <div className="flex items-start">
                      <span className="flex-shrink-0 w-8 h-8 bg-yellow-500 rounded-full flex items-center justify-center text-white font-bold mr-3">★</span>
                      <div>
                        <h3 className="font-semibold text-white">Enable AUTO Mode (Optional)</h3>
                        <p className="text-sm text-gray-300">Click the <strong>Auto</strong> button to enable auto-start. When active, the timer starts automatically as soon as you select a modality — no need to click Par Time. Yellow outline indicates AUTO is enabled. Click again to disable.</p>
                      </div>
                    </div>
                    <div className="flex items-start">
                      <span className="flex-shrink-0 w-8 h-8 bg-blue-600 rounded-full flex items-center justify-center text-white font-bold mr-3">3</span>
                      <div>
                        <h3 className="font-semibold text-white">Start Timer</h3>
                        <p className="text-sm text-gray-300">With AUTO disabled: click the blue <strong>Par Time</strong> display to start. With AUTO enabled: timer starts automatically when you select a modality.</p>
                      </div>
                    </div>
                    <div className="flex items-start">
                      <span className="flex-shrink-0 w-8 h-8 bg-blue-600 rounded-full flex items-center justify-center text-white font-bold mr-3">4</span>
                      <div>
                        <h3 className="font-semibold text-white">Adjust On-the-Fly (If Needed)</h3>
                        <p className="text-sm text-gray-300">Change modality or toggle complications anytime while the timer is running — par time updates instantly.</p>
                      </div>
                    </div>
                    <div className="flex items-start">
                      <span className="flex-shrink-0 w-8 h-8 bg-green-600 rounded-full flex items-center justify-center text-white font-bold mr-3">5</span>
                      <div>
                        <h3 className="font-semibold text-white">Click Elapsed Time to Complete</h3>
                        <p className="text-sm text-gray-300">When you finish dictating, click the <strong>Elapsed Time</strong> display to record the study and reset for the next one.</p>
                      </div>
                    </div>
                  </div>
                </section>

                {/* Between Studies */}
                <section>
                  <h2 className="text-2xl font-bold text-white mb-3">Between Studies</h2>
                  <div className="bg-gray-700 rounded-lg p-4 space-y-3">
                    <div className="flex items-start">
                      <span className="flex-shrink-0 w-8 h-8 bg-yellow-600 rounded-full flex items-center justify-center text-white font-bold mr-3">⏱</span>
                      <div>
                        <h3 className="font-semibold text-white">Interstitial Time (Automatic)</h3>
                        <p className="text-sm text-gray-300">Runs automatically between studies. This is your non-reading time: loading the next case, reviewing priors, picking up the next worklist item. It pauses when any other timer is active.</p>
                      </div>
                    </div>
                    <div className="flex items-start">
                      <span className="flex-shrink-0 w-8 h-8 bg-orange-600 rounded-full flex items-center justify-center text-white font-bold mr-3">A</span>
                      <div>
                        <h3 className="font-semibold text-white">Admin Time</h3>
                        <p className="text-sm text-gray-300">Click to start/stop. Use for administrative duties: group meetings, tumor boards, paperwork, phone calls from the department. Pauses Interstitial Time. If clicked during a study, auto-pauses the study and resumes it when Admin stops.</p>
                      </div>
                    </div>
                    <div className="flex items-start">
                      <span className="flex-shrink-0 w-8 h-8 bg-cyan-600 rounded-full flex items-center justify-center text-white font-bold mr-3">C</span>
                      <div>
                        <h3 className="font-semibold text-white">Comms Time</h3>
                        <p className="text-sm text-gray-300">Click to start/stop. Use for critical findings communications: calling referring physicians, waiting for callbacks. Pauses Interstitial Time. Mutually exclusive with Admin — starting one stops the other.</p>
                      </div>
                    </div>
                    <div className="flex items-start">
                      <span className="flex-shrink-0 w-8 h-8 bg-pink-600 rounded-full flex items-center justify-center text-white font-bold mr-3">B</span>
                      <div>
                        <h3 className="font-semibold text-white">Break</h3>
                        <p className="text-sm text-gray-300">Click to start/stop. Use for lunch, appointments, bathroom, or any personal time away from reading. Pauses Interstitial, Admin, and Comms. RadTach prompts you after 2 hours of continuous work — take the break.</p>
                      </div>
                    </div>
                    <div className="flex items-start">
                      <span className="flex-shrink-0 w-8 h-8 bg-yellow-500 rounded-full flex items-center justify-center text-white font-bold mr-3">D</span>
                      <div>
                        <h3 className="font-semibold text-white">Double Tap</h3>
                        <p className="text-sm text-gray-300">A "Double Tap" is when you reopen a just-completed study to fix something you missed. Click to start/stop. Tracks correction time separately — this is productive work, not wasted interstitial time. Disabled while a study is in progress.</p>
                      </div>
                    </div>
                    <div className="flex items-start">
                      <span className="flex-shrink-0 w-8 h-8 bg-purple-600 rounded-full flex items-center justify-center text-white font-bold mr-3">📋</span>
                      <div>
                        <h3 className="font-semibold text-white">Draft</h3>
                        <p className="text-sm text-gray-300">Need to handle a priority case mid-study? Click <strong>Draft</strong> to save your current study's state (modality, complications, elapsed time) without completing it. Read the priority case, then click <strong>Resume Draft</strong> to pick up where you left off.</p>
                      </div>
                    </div>
                    <div className="flex items-start">
                      <span className="flex-shrink-0 w-8 h-8 bg-gray-500 rounded-full flex items-center justify-center text-white font-bold mr-3">↩</span>
                      <div>
                        <h3 className="font-semibold text-white">Undo</h3>
                        <p className="text-sm text-gray-300">Accidentally completed a study or had a worklist collision? Click <strong>Undo</strong> to revert the last completed study. One level deep — use it right away if needed.</p>
                      </div>
                    </div>
                    <div className="flex items-start">
                      <span className="flex-shrink-0 w-8 h-8 bg-amber-500 rounded-full flex items-center justify-center text-white font-bold mr-3">⇄</span>
                      <div>
                        <h3 className="font-semibold text-white">Auto-Swap (Automatic)</h3>
                        <p className="text-sm text-gray-300">Forgot to start the timer? If you realize mid-study, pick the modality, start, and stop quickly — if the elapsed time is under 5 seconds, RadTach assumes you forgot and <strong>swaps</strong>: the preceding interstitial time becomes your study time, and the interstitial is replaced with a 10-second default gap. Swapped studies are marked with a hash pattern on the Filmstrip and counted in session stats.</p>
                        <div className="bg-yellow-900 bg-opacity-40 border border-yellow-600 rounded p-2 mt-2 text-xs text-yellow-200">
                          <strong>Two rules after a swap:</strong> (1) Do not Undo a swapped study — the interstitial has already been rewritten and undo cannot restore it. (2) Run the next study for at least 5 seconds, or it will trigger another swap and overwrite the one you just made.
                        </div>
                      </div>
                    </div>
                  </div>
                </section>

                {/* Understanding the Display */}
                <section>
                  <h2 className="text-2xl font-bold text-white mb-3">Understanding Your Dashboard</h2>

                  <h3 className="text-lg font-semibold text-white mt-4 mb-2">Main Timer Row</h3>
                  <div className="space-y-2 ml-4">
                    <div>
                      <span className="font-semibold text-red-400">Above/Below Par:</span>
                      <span className="text-gray-300"> Your cumulative time balance across all completed studies. </span>
                      <span className="text-green-400">Green</span>
                      <span className="text-gray-300"> = ahead of schedule, </span>
                      <span className="text-red-400">Red</span>
                      <span className="text-gray-300"> = behind schedule.</span>
                    </div>
                    <div>
                      <span className="font-semibold text-blue-400">Par Time:</span>
                      <span className="text-gray-300"> Target time for current exam (modality + complications). </span>
                      <span className="font-semibold">Click to start timing.</span>
                    </div>
                    <div>
                      <span className="font-semibold text-white">Elapsed Time:</span>
                      <span className="text-gray-300"> Current exam duration. Background color shows pacing:</span>
                      <ul className="list-disc ml-6 mt-1 text-sm">
                        <li><span className="text-green-400">Green:</span> 30+ seconds remaining</li>
                        <li><span className="text-yellow-400">Yellow:</span> 15-30 seconds remaining</li>
                        <li><span className="text-red-400">Flashing Red:</span> Under 15 seconds</li>
                        <li><span className="text-red-400">Solid Red:</span> Over par time</li>
                        <li><span className="text-gray-400">Gray:</span> No modality selected or Stealth Mode on</li>
                      </ul>
                      <span className="font-semibold block mt-1">Click to complete the exam.</span>
                    </div>
                  </div>

                  <h3 className="text-lg font-semibold text-white mt-4 mb-2">Session Metrics Row</h3>
                  <div className="space-y-2 ml-4">
                    <div>
                      <span className="font-semibold text-blue-400">Session Time:</span>
                      <span className="text-gray-300"> Total elapsed time since session start</span>
                    </div>
                    <div>
                      <span className="font-semibold text-yellow-400">Interstitial Time:</span>
                      <span className="text-gray-300"> Cumulative time between exams. Yellow border = actively counting</span>
                    </div>
                    <div>
                      <span className="font-semibold text-orange-400">Admin Time:</span>
                      <span className="text-gray-300"> Cumulative administrative time. Hover to see event count</span>
                    </div>
                    <div>
                      <span className="font-semibold text-cyan-400">Comms Time:</span>
                      <span className="text-gray-300"> Cumulative communications time. Hover to see event count</span>
                    </div>
                    <div>
                      <span className="font-semibold text-green-400">Total RVU:</span>
                      <span className="text-gray-300"> Cumulative RVUs generated this session</span>
                    </div>
                    <div>
                      <span className="font-semibold text-purple-400">RVU/hr:</span>
                      <span className="text-gray-300"> Productivity rate (updates on study completion). Hover to see Rolling RVU (last 60 minutes)</span>
                    </div>
                    <div>
                      <span className="font-semibold text-red-400">Break Time / Breaks Taken:</span>
                      <span className="text-gray-300"> Total break time and count. RadTach prompts you after 2 hours of continuous work</span>
                    </div>
                    <div>
                      <span className="font-semibold text-yellow-400">Double Tap Time / Double Taps:</span>
                      <span className="text-gray-300"> Cumulative correction time and count. Lower is better</span>
                    </div>
                  </div>
                </section>

                {/* Reports */}
                <section>
                  <h2 className="text-2xl font-bold text-white mb-3">Reports</h2>
                  <p className="leading-relaxed mb-3">
                    RadTach generates detailed analytics from your session data. Reports are available from two places:
                  </p>
                  <div className="bg-gray-700 rounded-lg p-4 space-y-2 text-sm mb-3">
                    <p><strong className="text-indigo-400">View Reports button (header):</strong> Visible when you're signed in but no session is active. Reviews your most recent work day from saved data.</p>
                    <p><strong className="text-indigo-400">Review Performance button (post-session):</strong> Appears after you stop a session. Reviews the session you just completed, with all data still in memory.</p>
                  </div>

                  <h3 className="text-lg font-semibold text-white mt-4 mb-2">Session Report (Available Now)</h3>
                  <p className="text-sm text-gray-300 mb-2">A comprehensive analysis of your work day, including:</p>
                  <div className="grid grid-cols-2 gap-x-6 gap-y-1 ml-4 text-sm">
                    <p><span className="text-gray-400">6A.</span> Filmstrip Timeline — visual timeline of your session</p>
                    <p><span className="text-gray-400">6B.</span> Studies by Modality — study count breakdown</p>
                    <p><span className="text-gray-400">6C.</span> RVU/hr by Modality — which modalities are most productive</p>
                    <p><span className="text-gray-400">6D.</span> Avg Variance by Modality — where you're fast vs. slow</p>
                    <p><span className="text-gray-400">6E.</span> Top 5 Over/Under Par — best and worst studies</p>
                    <p><span className="text-gray-400">6F.</span> Time Allocation — where your day went (pie chart)</p>
                    <p><span className="text-gray-400">7A.</span> Stamina Curve — performance over the session</p>
                    <p><span className="text-gray-400">7B.</span> Break ROI — do breaks actually help?</p>
                    <p><span className="text-gray-400">7C.</span> Complication Cost — actual vs. allotted time</p>
                    <p><span className="text-gray-400">7D.</span> Interstitial Trend — fatigue indicator</p>
                    <p><span className="text-gray-400">7E.</span> Double Tap Rate — correction frequency</p>
                    <p><span className="text-gray-400">7F.</span> Pause Analysis — is pausing a net positive?</p>
                    <p><span className="text-gray-400">7G.</span> Draft Effectiveness — does drafting beat par?</p>
                    <p><span className="text-gray-400">7H.</span> Productive Time Ratio — % of session actively reading</p>
                    <p><span className="text-gray-400">7I.</span> Peak RVU Window — your best 60-minute stretch</p>
                    <p><span className="text-gray-400">7J.</span> Interruption Recovery — cost of context switching</p>
                    <p><span className="text-gray-400">7K.</span> Complication Stacking — cognitive load analysis</p>
                    <p><span className="text-gray-400">7L.</span> Modality Transition Penalty — batch vs. mixed reading</p>
                  </div>
                  <p className="text-sm text-gray-400 mt-2">Reports can be printed or saved as PDF via the browser's print dialog.</p>

                  <h3 className="text-lg font-semibold text-white mt-4 mb-2">Coming Soon</h3>
                  <div className="ml-4 text-sm space-y-1 text-gray-400">
                    <p><strong className="text-gray-300">Weekly Report</strong> — trends across a week of sessions</p>
                    <p><strong className="text-gray-300">Monthly Report</strong> — monthly productivity analysis</p>
                    <p><strong className="text-gray-300">Quarterly Report</strong> — quarter-over-quarter comparisons</p>
                    <p><strong className="text-gray-300">Yearly Report</strong> — annual performance review</p>
                    <p><strong className="text-gray-300">Group Comparison</strong> — anonymized comparison against your group's average (GAR) and cross-group composite (CR)</p>
                  </div>
                </section>

                {/* Default Values */}
                <section>
                  <h2 className="text-2xl font-bold text-white mb-3">Default Par Times & RVUs</h2>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="bg-gray-700 rounded p-3">
                      <h3 className="font-semibold text-white mb-2">Modality Par Times</h3>
                      <ul className="text-sm space-y-1">
                        <li><span className="text-blue-400">XR:</span> 1:30 (0.2 RVU)</li>
                        <li><span className="text-blue-400">FL:</span> 2:00 (0.4 RVU)</li>
                        <li><span className="text-blue-400">CT:</span> 4:00 (1.0 RVU)</li>
                        <li><span className="text-blue-400">US:</span> 2:00 (0.5 RVU)</li>
                        <li><span className="text-blue-400">MR:</span> 4:00 (1.3 RVU)</li>
                        <li><span className="text-blue-400">NM:</span> 4:00 (0.6 RVU)</li>
                        <li><span className="text-blue-400">MA:</span> 4:00 (1.3 RVU)</li>
                        <li><span className="text-blue-400">PET-CT:</span> 10:00 (2.4 RVU)</li>
                      </ul>
                    </div>
                    <div className="bg-gray-700 rounded p-3">
                      <h3 className="font-semibold text-white mb-2">Complication Modifiers</h3>
                      <ul className="text-sm space-y-1">
                        <li><span className="text-orange-400">Cancer Follow:</span> +4:00</li>
                        <li><span className="text-orange-400">+1 Section:</span> +2:00 (+0.5 RVU for CT/US)</li>
                        <li><span className="text-orange-400">+2 Section:</span> +4:00 (+1.0 RVU for CT)</li>
                        <li><span className="text-orange-400">Multiple Priors:</span> +2:00</li>
                        <li><span className="text-orange-400">Age &gt;70:</span> +2:00</li>
                        <li><span className="text-orange-400">Complex Hx:</span> +2:00</li>
                        <li><span className="text-orange-400">Prior Surg Hx:</span> +2:00</li>
                        <li><span className="text-orange-400">CTA:</span> +3:00 (+0.4 RVU for CT)</li>
                        <li><span className="text-orange-400">Bilateral:</span> x1.5 total par time + RVU</li>
                        <li><span className="text-orange-400">Vascular:</span> +2:00</li>
                      </ul>
                    </div>
                  </div>
                  <p className="text-sm text-gray-400 mt-2 italic">
                    All values are customizable in Settings. These are starting estimates — adjust to match your workflow.
                  </p>
                </section>

                {/* Pro Tips */}
                <section>
                  <h2 className="text-2xl font-bold text-white mb-3">Pro Tips</h2>
                  <div className="bg-blue-900 bg-opacity-30 border border-blue-500 rounded-lg p-4 space-y-2">
                    <p className="flex items-start">
                      <span className="text-blue-400 mr-2">💡</span>
                      <span><strong>Don't overthink it:</strong> Select modality, start reading. You can adjust complications as you discover them during dictation.</span>
                    </p>
                    <p className="flex items-start">
                      <span className="text-blue-400 mr-2">💡</span>
                      <span><strong>Watch the colors:</strong> The Elapsed Time background gives instant visual feedback on your pacing without needing to read numbers.</span>
                    </p>
                    <p className="flex items-start">
                      <span className="text-blue-400 mr-2">💡</span>
                      <span><strong>Complete promptly:</strong> Click to complete right after dictating to accurately track interstitial time.</span>
                    </p>
                    <p className="flex items-start">
                      <span className="text-blue-400 mr-2">💡</span>
                      <span><strong>Monitor Above/Below Par:</strong> This cumulative balance shows if you're trending fast or slow across all studies, not just the current one.</span>
                    </p>
                    <p className="flex items-start">
                      <span className="text-blue-400 mr-2">💡</span>
                      <span><strong>Use AUTO mode:</strong> Once you're comfortable, AUTO mode eliminates one click per study. Select modality and start dictating — the timer is already running.</span>
                    </p>
                    <p className="flex items-start">
                      <span className="text-blue-400 mr-2">💡</span>
                      <span><strong>Customize for your practice:</strong> The default par times are starting estimates. Adjust them in Settings to match your specialty, workflow, and reading speed.</span>
                    </p>
                    <p className="flex items-start">
                      <span className="text-blue-400 mr-2">💡</span>
                      <span><strong>Track Double Taps honestly:</strong> The goal is to reduce them over time by being more thorough on the first read.</span>
                    </p>
                    <p className="flex items-start">
                      <span className="text-blue-400 mr-2">💡</span>
                      <span><strong>Hover for details:</strong> Hover over Admin Time, Comms Time, or RVU/hr to see additional metrics and event counts.</span>
                    </p>
                    <p className="flex items-start">
                      <span className="text-blue-400 mr-2">💡</span>
                      <span><strong>Review your reports:</strong> The Session Report after each work day shows patterns you can't see in real time — stamina curves, break ROI, complication costs, and more.</span>
                    </p>
                  </div>
                </section>

                {/* Customization */}
                <section>
                  <h2 className="text-2xl font-bold text-white mb-3">Customizing RadTach</h2>
                  <p className="mb-2">Click the <strong>Settings</strong> gear icon to access:</p>
                  <ul className="list-disc ml-6 space-y-1 mb-3">
                    <li><strong>Par Time Settings:</strong> Adjust target times for each modality and complication</li>
                    <li><strong>RVU Settings:</strong> Customize RVU values for your practice patterns</li>
                    <li><strong>Stealth Mode:</strong> Removes colors and flashing, uses outlines instead. Helpful for photosensitivity or colorblindness</li>
                    <li><strong>H:M:S Display:</strong> Show times as Hours:Minutes:Seconds instead of Minutes:Seconds (useful for long sessions)</li>
                    <li><strong>Quick Start Guide:</strong> Return to this guide anytime</li>
                  </ul>
                  <div className="bg-green-900 bg-opacity-30 border border-green-500 rounded-lg p-3 mt-3">
                    <p className="text-sm"><strong className="text-green-400">✓ Settings Sync:</strong> Your customized par times, RVU values, and display preferences are saved to the database and follow you across devices. Settings save automatically when you stop a session.</p>
                  </div>
                </section>

                {/* Important Notes */}
                <section>
                  <h2 className="text-2xl font-bold text-white mb-3">Important Notes</h2>
                  <div className="bg-yellow-900 bg-opacity-30 border border-yellow-500 rounded-lg p-4 space-y-2">
                    <p className="flex items-start">
                      <span className="text-yellow-400 mr-2">⚠️</span>
                      <span><strong>Stop your session before closing the browser.</strong> Session data saves to the database on session stop. Closing the tab mid-session may lose unsaved events.</span>
                    </p>
                    <p className="flex items-start">
                      <span className="text-yellow-400 mr-2">⚠️</span>
                      <span><strong>Par times are targets, not requirements.</strong> Quality and thoroughness always come first. The goal is awareness, not speed at the cost of accuracy.</span>
                    </p>
                    <p className="flex items-start">
                      <span className="text-yellow-400 mr-2">⚠️</span>
                      <span><strong>RVU values are estimates.</strong> RadTach estimates RVU from modality and complication selections. Actual billing RVUs (per Epic/Medicalis) are typically 10-20% higher. Use for trends and relative comparison, not financial reporting.</span>
                    </p>
                  </div>
                </section>

                {/* Version History */}
                <section>
                  <h2 className="text-2xl font-bold text-white mb-3">Version History</h2>
                  <div className="space-y-2 text-sm text-gray-300">
                    <p><strong className="text-white">1.4</strong> — Auto-Swap recovery for forgotten timer starts, AUTO mode, Draft/Resume, multi-period reports (Weekly/Monthly/Quarterly/Yearly), Group Comparison</p>
                    <p><strong className="text-white">1.3</strong> — Firebase MVP with database integration and reporting</p>
                    <p><strong className="text-white">1.2</strong> — Vercel-hosted freestanding operational version, text export of session and study data</p>
                  </div>
                </section>

                {/* Footer */}
                <div className="mt-8 pt-6 border-t border-gray-600">
                  <p className="text-center text-gray-400 text-sm">
                    <strong>RadTach</strong> - Your Radiologist Tachometer<br/>
                    Created by Charles Darren Duvall, MD<br/>
                    Coded by Claude (Anthropic)<br/>
                    Version 1.4
                  </p>
                  <p className="text-center text-gray-400 text-xs mt-4">
                    Please forward feedback or identified errors to{' '}
                    <a href="mailto:cdduvallmd@yahoo.com?subject=RadTach" className="text-blue-400 hover:text-blue-300 underline">
                      cdduvallmd@yahoo.com
                    </a>
                    {' '}with the Subject line "RadTach".
                  </p>
                  <p className="text-center text-gray-500 text-xs mt-4">
                    © 2025 Charles Darren Duvall, MD. All rights reserved.
                  </p>
                </div>
              </div>

              <button
                onClick={() => setShowGuide(false)}
                className="mt-6 w-full py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium transition-colors"
              >
                Got It - Let's Start!
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Break Prompt Modal */}
      {showBreakPrompt && (
        <div className="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50">
          <div className="bg-gray-800 rounded-lg shadow-xl p-6 w-full max-w-md">
            <h2 className="text-2xl font-bold text-white mb-4">Time for a Break?</h2>
            <p className="text-gray-200 mb-6">
              You have been working for {breakPromptHours} hours. Would you like to take a break?
            </p>
            <div className="flex gap-4">
              <button
                onClick={() => {
                  setShowBreakPrompt(false);
                  toggleBreakTime();
                }}
                className="flex-1 py-3 bg-green-600 hover:bg-green-700 text-white rounded-lg font-medium transition-colors"
              >
                YES, I believe I will
              </button>
              <button
                onClick={() => {
                  setShowBreakPrompt(false);
                  setShowAnimalMessage(true);
                  // Record the time when user declined the break
                  setLastBreakDeclineTime(timeSinceLastBreak);
                }}
                className="flex-1 py-3 bg-red-600 hover:bg-red-700 text-white rounded-lg font-medium transition-colors"
              >
                NO THANKS, I'm good
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Animal Message Modal */}
      {showAnimalMessage && (
        <div className="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50">
          <div className="bg-gray-800 rounded-lg shadow-xl p-6 w-full max-w-md">
            <h2 className="text-2xl font-bold text-white mb-4">You're an animal!</h2>
            <p className="text-gray-200 mb-6">
              Get back at it!
            </p>
            <button
              onClick={() => setShowAnimalMessage(false)}
              className="w-full py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium transition-colors"
            >
              Close
            </button>
          </div>
        </div>
      )}

      {/* Stop Session Dialog (Issue #1) */}
      {/* Message Center Modal */}
      {showMessageCenter && (
        <div className="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50">
          <div className="bg-gray-800 rounded-lg shadow-xl p-6 w-full max-w-lg">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-xl font-bold text-white">Role Requests</h2>
              <button
                onClick={() => setShowMessageCenter(false)}
                className="text-gray-400 hover:text-white text-2xl"
              >
                &times;
              </button>
            </div>
            {roleRequests.length === 0 ? (
              <p className="text-gray-400 text-sm text-center py-4">No pending requests.</p>
            ) : (
              <div className="space-y-3 max-h-96 overflow-y-auto">
                {roleRequests.map(req => (
                  <div key={req.uid} className="bg-gray-700 rounded-lg p-4">
                    <div className="flex justify-between items-start">
                      <div>
                        <p className="text-white font-medium">{req.displayName}</p>
                        <p className="text-gray-400 text-sm">{req.email}</p>
                        <p className="text-sm mt-1">
                          <span className="text-gray-500">Requests: </span>
                          <span className="text-yellow-400 font-medium">
                            {req.requestedRole === 'hospitalAdmin' ? 'Hospital Admin' :
                             req.requestedRole === 'admin' ? 'Admin' :
                             req.requestedRole === 'president' ? 'President' :
                             req.requestedRole === 'it' ? 'IT' : req.requestedRole}
                          </span>
                        </p>
                        <div className="flex items-center gap-2 mt-2">
                          <span className="text-gray-500 text-xs font-mono">{req.uid}</span>
                          <button
                            onClick={() => navigator.clipboard.writeText(req.uid)}
                            className="text-xs text-blue-400 hover:text-blue-300"
                          >
                            Copy UID
                          </button>
                        </div>
                        {req.requestedAt?.toDate && (
                          <p className="text-gray-600 text-xs mt-1">
                            {req.requestedAt.toDate().toLocaleDateString()}
                          </p>
                        )}
                      </div>
                      <button
                        onClick={() => {
                          firestoreService.dismissRoleRequest(req.uid)
                            .then(() => setRoleRequests(prev => prev.filter(r => r.uid !== req.uid)))
                            .catch(console.error);
                        }}
                        className="px-3 py-1.5 bg-green-600 hover:bg-green-700 text-white text-sm rounded transition-colors whitespace-nowrap"
                      >
                        Addressed
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Session Start Dialog: System/Office selection */}
      {showSessionStartDialog && (
        <div className="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50">
          <div className="bg-gray-800 rounded-lg shadow-xl p-6 w-full max-w-md">
            <h2 className="text-2xl font-bold text-white mb-1">{userFirstName ? `Welcome Back, ${userFirstName}` : 'Start Session'}</h2>
            {userFirstName && (
              <p className="text-gray-500 text-sm mb-4">
                Not {userFirstName}?{' '}
                <button
                  onClick={handleLogout}
                  className="text-blue-400 hover:text-blue-300 underline transition-colors"
                >
                  Switch User
                </button>
              </p>
            )}
            {!userFirstName && <div className="mb-3" />}

            {/* System input */}
            <label className="block text-gray-300 text-sm mb-1">System</label>
            <div className="flex gap-2 mb-2">
              <input
                type="text"
                value={systemInput}
                onChange={(e) => {
                  setSystemInput(e.target.value);
                  setSystemVerified(false);
                  setSystemError('');
                  setOfficeList([]);
                  setRotationList([]);
                }}
                onKeyDown={(e) => { if (e.key === 'Enter') handleVerifySystem(); }}
                placeholder="Enter system name"
                className="flex-1 px-3 py-2 bg-gray-700 text-white rounded-lg border border-gray-600 focus:border-blue-500 focus:outline-none"
                autoFocus
              />
              <button
                onClick={handleVerifySystem}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium transition-colors"
              >
                Verify
              </button>
            </div>
            {systemError && (
              <p className="text-red-400 text-sm mb-2">{systemError}</p>
            )}

            {/* Office dropdown (only shown after system verified) */}
            {systemVerified && officeList.length > 0 && (
              <div className="mt-4">
                <label className="block text-gray-300 text-sm mb-1">Office / Workstation</label>
                <select
                  value={selectedOffice}
                  onChange={(e) => {
                    const office = e.target.value;
                    setSelectedOffice(office);
                    const zip = officeZips[office];
                    if (zip) {
                      setGpciZip(zip);
                      setGpciValues(lookupGpci(zip));
                    }
                  }}
                  className="w-full px-3 py-2 bg-gray-700 text-white rounded-lg border border-gray-600 focus:border-blue-500 focus:outline-none"
                >
                  {officeList.map(office => (
                    <option key={office} value={office}>{office}</option>
                  ))}
                </select>
                {gpciValues && officeZips[selectedOffice] && (
                  <p className="text-cyan-400 text-xs mt-1">GPCI: {gpciValues.localityName}</p>
                )}
              </div>
            )}

            {/* Rotation dropdown (only shown after system verified) */}
            {systemVerified && rotationList.length > 0 && (
              <div className="mt-4">
                <label className="block text-gray-300 text-sm mb-1">Rotation</label>
                <select
                  value={selectedRotation}
                  onChange={(e) => setSelectedRotation(e.target.value)}
                  className="w-full px-3 py-2 bg-gray-700 text-white rounded-lg border border-gray-600 focus:border-blue-500 focus:outline-none"
                >
                  {rotationList.map(rotation => (
                    <option key={rotation} value={rotation}>{rotation}</option>
                  ))}
                </select>
              </div>
            )}

            {/* Half-day checkbox (only shown after system verified) */}
            {systemVerified && (
              <div className="mt-4">
                <label className="flex items-center gap-2 text-gray-300 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={halfDay}
                    onChange={(e) => setHalfDay(e.target.checked)}
                    className="w-4 h-4 rounded border-gray-600 bg-gray-700 text-blue-500 focus:ring-blue-500"
                  />
                  Half-day session
                </label>
              </div>
            )}

            {/* Action buttons */}
            <div className="flex gap-4 mt-6">
              <button
                onClick={handleConfirmSessionStart}
                disabled={!systemVerified || !selectedOffice || !selectedRotation}
                className={`flex-1 py-3 rounded-lg font-medium transition-colors ${
                  systemVerified && selectedOffice && selectedRotation
                    ? 'bg-green-600 hover:bg-green-700 text-white'
                    : 'bg-gray-600 text-gray-400 cursor-not-allowed'
                }`}
              >
                Start Session
              </button>
              <button
                onClick={() => setShowSessionStartDialog(false)}
                className="flex-1 py-3 bg-gray-600 hover:bg-gray-700 text-white rounded-lg font-medium transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {showStopSessionDialog && (
        <div className="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50">
          <div className="bg-gray-800 rounded-lg shadow-xl p-6 w-full max-w-lg">
            <h2 className="text-2xl font-bold text-white mb-4">Session Complete</h2>
            <p className="text-gray-400 text-sm mb-6">
              Session: {localSessionKeyRef.current || generateSessionId()}<br />
              Studies: {studiesCompleted} | RVU: {totalRVU.toFixed(2)} | Time: {formatTime(sessionTime)}
            </p>

            {/* Session Notes */}
            <div className="mb-4">
              <p className="text-gray-200 font-medium mb-1">How was your day?</p>
              <p className="text-gray-500 text-xs mb-3">Select all that apply</p>
              <div className="flex flex-wrap gap-2">
                {(['No Comment', 'Good Day', 'Not Feeling It Today', 'Network & Application Interference',
                  'Low Volume = Low Productivity', 'Real World Intrusion', 'High Volume', 'Short Staffed'] as SessionTag[]).map(tag => {
                  const isSelected = sessionTags.includes(tag);
                  return (
                    <button
                      key={tag}
                      onClick={() => {
                        if (tag === 'No Comment') {
                          setSessionTags(['No Comment']);
                        } else {
                          setSessionTags(prev => {
                            const without = prev.filter(t => t !== 'No Comment');
                            const next = without.includes(tag) ? without.filter(t => t !== tag) : [...without, tag];
                            return next.length === 0 ? ['No Comment'] : next;
                          });
                        }
                      }}
                      className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                        isSelected
                          ? 'bg-blue-600 text-white'
                          : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                      }`}
                    >
                      {tag}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="mb-6">
              <textarea
                value={sessionDescription}
                onChange={e => setSessionDescription(e.target.value.slice(0, 500))}
                placeholder="Add notes about your session (optional)"
                rows={3}
                className="w-full bg-gray-700 text-white rounded-lg p-3 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-500"
              />
              <div className="flex justify-between mt-1">
                <p className="text-gray-600 text-xs">Visible to group presidents and administrators</p>
                <p className="text-gray-600 text-xs">{sessionDescription.length}/500</p>
              </div>
            </div>

            <div className="mb-6">
              <label className="text-gray-200 font-medium text-sm block mb-1">Verified RVUs (from Epic/Medicalis)</label>
              <input
                type="number"
                step="0.1"
                min="0"
                value={verifiedRVU}
                onChange={e => setVerifiedRVU(e.target.value)}
                placeholder="Optional"
                className="w-full bg-gray-700 text-white rounded-lg p-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-500"
              />
              <p className="text-gray-600 text-xs mt-1">Enter total RVUs from Epic or Medicalis for this session</p>
            </div>

            <button
              onClick={handleEndSession}
              className="w-full py-3 bg-green-600 hover:bg-green-700 text-white rounded-lg font-medium transition-colors"
            >
              End Session
            </button>
          </div>
        </div>
      )}

      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div className="flex justify-between items-center mb-2">
          <h1 className="text-3xl font-bold text-white">RadTach 1.3</h1>
          <button
            onClick={isSessionActive ? handleStopSessionClick : handleStartSession}
            className={`px-6 py-3 rounded-lg font-medium transition-colors ${
              isSessionActive
                ? 'bg-red-600 hover:bg-red-700 text-white'
                : 'bg-green-600 hover:bg-green-700 text-white'
            }`}
            title={isSessionActive ? 'Hold SHIFT and click to stop session' : 'Start a new session'}
          >
            {isSessionActive ? 'Stop Session' : 'Start Session'}
          </button>
          {FIREBASE_ENABLED && !isSessionActive && (
            <button
              onClick={handleViewReportsFromHeader}
              className="px-6 py-3 rounded-lg font-medium transition-colors bg-indigo-600 hover:bg-indigo-700 text-white"
              title="View session reports"
            >
              View Reports
            </button>
          )}
          <button
            onClick={toggleDraft}
            className={`px-6 py-3 rounded-lg font-medium transition-colors ${
              stealthMode
                ? isDraftMode
                  ? 'bg-gray-700 hover:bg-gray-600 text-white border-2 border-white'
                  : 'bg-gray-700 hover:bg-gray-600 text-white border-2 border-gray-700'
                : isDraftMode
                ? 'bg-purple-600 hover:bg-purple-700 text-white'
                : 'bg-gray-700 hover:bg-gray-600 text-white'
            }`}
            title={isDraftMode ? 'Click to restore drafted study' : 'Save current study and start priority case'}
          >
            {isDraftMode ? 'Resume Draft' : 'Draft'}
          </button>
          <button
            onClick={toggleAutoStart}
            className={`px-6 py-3 rounded-lg font-medium transition-colors ${
              stealthMode
                ? autoStartEnabled
                  ? 'bg-gray-700 hover:bg-gray-600 text-white border-2 border-white'
                  : 'bg-gray-700 hover:bg-gray-600 text-white border-2 border-gray-700'
                : autoStartEnabled
                ? 'bg-gray-700 hover:bg-gray-600 text-white border-2 border-yellow-400'
                : 'bg-gray-700 hover:bg-gray-600 text-white'
            }`}
            title={autoStartEnabled ? 'Click to disable auto-start timer' : 'Click to enable auto-start timer when modality is selected'}
          >
            Auto
          </button>
          <button
            onClick={toggleBreakTime}
            className={`px-6 py-3 rounded-lg font-medium transition-colors ${
              stealthMode
                ? isBreakTimeRunning
                  ? 'bg-gray-700 hover:bg-gray-600 text-white border-2 border-white'
                  : 'bg-gray-700 hover:bg-gray-600 text-white border-2 border-gray-700'
                : isBreakTimeRunning
                ? 'bg-gray-700 hover:bg-gray-600 text-white border-4 border-red-600'
                : 'bg-gray-700 hover:bg-gray-600 text-white'
            }`}
            title={isBreakTimeRunning ? 'Click to end break' : 'Take a break'}
          >
            Break
          </button>
          <div className="flex items-center space-x-6">
            <div className="text-center">
              <div className="text-sm text-gray-400">Studies Completed</div>
              <div className="text-2xl font-bold text-white">{studiesCompleted}</div>
            </div>
            <button
              onClick={undoLastStudy}
              className={`w-12 h-12 ${lastStudy ? 'bg-gray-700 hover:bg-gray-600' : 'bg-gray-800 cursor-not-allowed opacity-50'} text-white rounded-lg flex items-center justify-center transition-colors`}
              title="Undo Last Study"
              disabled={!lastStudy}
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
              </svg>
            </button>
            <button
              onClick={() => setShowSettings(true)}
              className="w-12 h-12 bg-gray-700 hover:bg-gray-600 text-white rounded-lg flex items-center justify-center transition-colors"
              title="Settings"
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </button>
            {isAdmin && roleRequests.length > 0 && (
              <button
                onClick={() => setShowMessageCenter(true)}
                className="relative w-12 h-12 bg-gray-700 hover:bg-gray-600 text-white rounded-lg flex items-center justify-center transition-colors"
                title="Role Requests"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
                </svg>
                <span className="absolute -top-1 -right-1 bg-red-500 text-white text-xs font-bold rounded-full w-5 h-5 flex items-center justify-center">
                  {roleRequests.length}
                </span>
              </button>
            )}
            {FIREBASE_ENABLED && (
              <span
                className={`inline-block w-2.5 h-2.5 rounded-full ${
                  health.status === 'green' ? 'bg-green-500' :
                  health.status === 'yellow' ? 'bg-yellow-500 animate-pulse' :
                  'bg-red-500 animate-pulse'
                }`}
                title={
                  health.status === 'green' ? 'Connected' :
                  health.status === 'yellow' ? `Syncing (${health.pendingCount} pending)` :
                  `Connection issue (${health.pendingCount} pending)`
                }
              />
            )}
          </div>
        </div>

        {/* Error banner (101 / 102) */}
        {health.errorCode && (
          <div className="bg-red-900/80 text-white px-4 py-2 text-sm flex items-center justify-between mb-2 rounded-lg">
            <span>
              <strong>Error {health.errorCode}:</strong>{' '}
              {health.errorCode === 101
                ? 'Unable to reach server. Your data is saved locally and will sync when the connection is restored. If this persists, contact IT.'
                : 'Connected to server but unable to save data. Your data is saved locally. Please contact IT or RadTach support.'}
            </span>
            <button onClick={health.dismissError} className="text-white/70 hover:text-white ml-4 shrink-0">
              Dismiss
            </button>
          </div>
        )}

        {/* Draft Mode Banner */}
        {isDraftMode && draftStudy && (
          <div className={`${stealthMode ? 'bg-gray-800 border-2 border-gray-600' : 'bg-purple-900 bg-opacity-50 border-2 border-purple-500'} rounded-lg p-3 mb-4`}>
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-4">
                <span className={`${stealthMode ? 'text-gray-300' : 'text-purple-300'} font-semibold`}>📋 DRAFT MODE ACTIVE</span>
                <span className="text-white">
                  Saved: <span className="font-bold">{draftStudy.modality}</span>
                  {draftStudy.complications.length > 0 && (
                    <span className="text-gray-300"> + {draftStudy.complications.join(', ')}</span>
                  )}
                  <span className="text-gray-400 ml-2">
                    ({formatTime(draftStudy.currentTime, true)} / {formatTime(draftStudy.parTime, true)})
                  </span>
                </span>
              </div>
              <span className={`${stealthMode ? 'text-gray-300' : 'text-purple-300'} text-sm`}>Click "Resume Draft" to return to this study</span>
            </div>
          </div>
        )}
        
        {/* STREAK Counter */}
        <div className="flex justify-center mb-3">
          <div className="flex items-center space-x-12">
            {['S', 'T', 'R', 'E', 'A', 'K'].map((letter, index) => (
              <div
                key={index}
                className={`text-2xl font-bold transition-all duration-300 ${
                  index < currentStreak
                    ? stealthMode
                      ? 'text-white'
                      : 'text-yellow-400 drop-shadow-[0_0_8px_rgba(251,191,36,0.8)]'
                    : 'text-gray-700'
                }`}
              >
                {letter}
              </div>
            ))}
          </div>
        </div>
        
        {/* Main Timer Display */}
        <div className="grid grid-cols-3 gap-6 mb-4">
          {/* Above/Below Par */}
          <div className="bg-gray-800 rounded-lg p-4 text-center">
            <div className="text-xs text-gray-400 mb-1">Above/Below Par</div>
            <div 
              className="text-5xl font-bold"
              style={{ color: stealthMode ? '#9ca3af' : (cumulativeVariance > 0 ? '#ef4444' : '#10b981') }}
            >
              {stealthMode 
                ? (cumulativeVariance > 0 ? '+' : cumulativeVariance < 0 ? '−' : '') + formatTime(Math.abs(cumulativeVariance))
                : formatTime(cumulativeVariance)
              }
            </div>
            <div className="text-xs text-gray-500 mt-1">
              {cumulativeVariance > 0 ? 'Over' : 'Under'} Par Time
            </div>
          </div>
          
          {/* Par Time */}
          <div 
            onClick={toggleTimer}
            className={`${stealthMode ? 'bg-gray-800 hover:bg-gray-700' : (selectedModality && !isRunning ? 'bg-blue-700 hover:bg-blue-600' : 'bg-gray-800 hover:bg-gray-700')} rounded-lg p-4 text-center ${!isRunning ? 'cursor-pointer' : 'cursor-not-allowed'} transition-colors`}
          >
            <div className="text-xs text-gray-400 mb-1">Par Time</div>
            <div className={`text-5xl font-bold ${stealthMode ? 'text-gray-400' : 'text-blue-400'}`}>
              {formatTime(currentParTime, true)}
            </div>
            <div className="text-xs text-gray-500 mt-1">
              {!isRunning ? 'Click to Start' : 'Current Study Target'}
            </div>
          </div>
          
          {/* Current Elapsed Time */}
          <div 
            onClick={completeStudy}
            className={`bg-gradient-to-br ${elapsedBackground} rounded-lg p-4 text-center transition-colors ${currentTime > 0 || isRunning ? 'cursor-pointer hover:opacity-90' : 'cursor-not-allowed opacity-75'}`}
          >
            <div className={`text-xs mb-1 font-semibold ${!selectedModality || currentParTime === 0 ? 'text-gray-400' : 'text-white'}`}>
              Elapsed Time
            </div>
            <div className="text-5xl font-bold text-white">
              {formatTime(currentTime, true)}
            </div>
            <div className={`text-xs mt-1 ${!selectedModality || currentParTime === 0 ? 'text-gray-500' : 'text-white'}`}>
              {currentTime > 0 ? 'Click to Complete Exam' : isRunning ? 'Timer Running...' : 'Start Timer First'}
            </div>
          </div>
        </div>
        
        {/* All Metrics in 4x2 Grid */}
        <div className="grid grid-cols-4 gap-x-6 gap-y-3 mb-4">
          {/* Top Row: Session Time, Interstitial Time, RVU/hr, Break Time */}
          
          {/* Session Time */}
          <div className={`bg-gray-800 rounded-lg py-3 px-6 border-2 ${stealthMode ? 'border-gray-600' : 'border-blue-500'}`}>
            <div className="flex items-center justify-between">
              <div className="text-left">
                <div className="text-sm text-gray-400">Session</div>
              </div>
              <div className={`text-4xl font-bold ${stealthMode ? 'text-gray-400' : 'text-blue-400'}`}>
                {formatTime(sessionTime)}
              </div>
            </div>
          </div>
          
          {/* Interstitial Time */}
          <div 
            onClick={() => {
              if (isAdminTimeRunning || isCommsTimeRunning) {
                setIsAdminTimeRunning(false);
                setIsCommsTimeRunning(false);
                setIsInterstitialRunning(true);
              }
            }}
            className={`bg-gray-800 rounded-lg py-3 px-6 border-2 ${stealthMode ? 'border-gray-600' : (isInterstitialRunning ? 'border-yellow-500' : 'border-gray-600')} ${isAdminTimeRunning || isCommsTimeRunning ? 'cursor-pointer hover:bg-gray-700' : ''} transition-colors`}
          >
            <div className="flex items-center justify-between">
              <div className="text-left">
                <div className="text-sm text-gray-400">Interstitial</div>
              </div>
              <div className={`text-4xl font-bold ${stealthMode ? 'text-gray-400' : (isInterstitialRunning ? 'text-yellow-400' : 'text-gray-400')}`}>
                {formatTime(interstitialTime)}
              </div>
            </div>
          </div>
          
          {/* RVU/hr (hover to show Rolling RVU - Issue #6) */}
          <div
            onMouseEnter={() => setIsHoveringRVU(true)}
            onMouseLeave={() => setIsHoveringRVU(false)}
            className={`bg-gray-800 rounded-lg py-1.5 px-6 border-2 ${stealthMode ? 'border-gray-600' : 'border-purple-500'} transition-all duration-200 cursor-help`}
          >
            <div className="flex items-center justify-between">
              <div className="text-left">
                <div className="text-sm text-gray-400">
                  {isHoveringRVU ? 'RVU/Last Hr' : 'RVU/hr'}
                </div>
              </div>
              <div className={`text-4xl font-bold ${stealthMode ? 'text-gray-400' : 'text-purple-400'}`}>
                {isHoveringRVU ? rollingRVU.toFixed(2) : rvuPerHour.toFixed(2)}
              </div>
            </div>
          </div>

          {/* Break Time (with Breaks Taken overlay) */}
          <div className={`bg-gray-800 rounded-lg py-3 px-6 border-2 ${stealthMode ? 'border-gray-600' : (isBreakTimeRunning ? 'border-red-500' : 'border-gray-600')} relative overflow-hidden`}>
            {/* Large semi-transparent Breaks Taken number overlay */}
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className={`text-9xl font-bold ${stealthMode ? 'text-gray-600' : 'text-pink-400'} opacity-20`}>
                {breaksTaken}
              </div>
            </div>
            {/* Break Time content (on top of overlay) */}
            <div className="flex items-center justify-between relative z-10">
              <div className="text-left">
                <div className="text-sm text-gray-400">Break Time</div>
              </div>
              <div className={`text-4xl font-bold ${stealthMode ? 'text-gray-400' : (isBreakTimeRunning ? 'text-red-400' : 'text-gray-400')}`}>
                {formatTime(breakTime)}
              </div>
            </div>
          </div>

          {/* Bottom Row: Admin Time, Comms Time, Total RVU, Double Tap (4x2 grid) */}

          {/* Admin Time (with event counter overlay) - Issue #4 */}
          <div
            onClick={toggleAdminTime}
            onMouseEnter={() => setIsHoveringAdmin(true)}
            onMouseLeave={() => setIsHoveringAdmin(false)}
            className={`bg-gray-800 rounded-lg py-1.5 px-6 border-2 ${stealthMode ? 'border-gray-600' : (isAdminTimeRunning ? 'border-orange-500' : 'border-gray-600')} cursor-pointer hover:bg-gray-700 transition-colors relative overflow-hidden`}
          >
            {/* Large semi-transparent Admin event counter overlay */}
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className={`text-9xl font-bold ${stealthMode ? 'text-gray-600' : 'text-orange-400'} opacity-20`}>
                {adminEvents}
              </div>
            </div>
            {/* Admin Time content (on top of overlay) */}
            <div className="flex items-center justify-between relative z-10">
              <div className="text-left">
                <div className="text-sm text-gray-400">Admin Time</div>
              </div>
              <div
                className={`text-4xl font-bold overflow-hidden transition-all duration-300 ease-in-out ${stealthMode ? 'text-gray-400' : (isAdminTimeRunning ? 'text-orange-400' : 'text-gray-400')}`}
                style={{
                  width: (isAdminTimeRunning || isHoveringAdmin) ? 'auto' : '0px',
                  opacity: (isAdminTimeRunning || isHoveringAdmin) ? 1 : 0
                }}
              >
                {formatTime(adminTime)}
              </div>
            </div>
          </div>

          {/* Comms Time (with event counter overlay) - Issue #4 */}
          <div
            onClick={toggleCommsTime}
            onMouseEnter={() => setIsHoveringComms(true)}
            onMouseLeave={() => setIsHoveringComms(false)}
            className={`bg-gray-800 rounded-lg py-1.5 px-6 border-2 ${stealthMode ? 'border-gray-600' : (isCommsTimeRunning ? 'border-cyan-500' : 'border-gray-600')} cursor-pointer hover:bg-gray-700 transition-colors relative overflow-hidden`}
          >
            {/* Large semi-transparent Comms event counter overlay */}
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className={`text-9xl font-bold ${stealthMode ? 'text-gray-600' : 'text-cyan-400'} opacity-20`}>
                {commsEvents}
              </div>
            </div>
            {/* Comms Time content (on top of overlay) */}
            <div className="flex items-center justify-between relative z-10">
              <div className="text-left">
                <div className="text-sm text-gray-400">Comms Time</div>
              </div>
              <div
                className={`text-4xl font-bold overflow-hidden transition-all duration-300 ease-in-out ${stealthMode ? 'text-gray-400' : (isCommsTimeRunning ? 'text-cyan-400' : 'text-gray-400')}`}
                style={{
                  width: (isCommsTimeRunning || isHoveringComms) ? 'auto' : '0px',
                  opacity: (isCommsTimeRunning || isHoveringComms) ? 1 : 0
                }}
              >
                {formatTime(commsTime)}
              </div>
            </div>
          </div>

          {/* Total RVU */}
          <div className={`bg-gray-800 rounded-lg py-1.5 px-6 border-2 ${stealthMode ? 'border-gray-600' : 'border-green-500'}`}>
            <div className="flex items-center justify-between">
              <div className="text-left">
                <div className="text-sm text-gray-400">Total RVU</div>
              </div>
              <div className={`text-4xl font-bold ${stealthMode ? 'text-gray-400' : 'text-green-400'}`}>
                {totalRVU.toFixed(2)}
              </div>
            </div>
          </div>

          {/* Double Tap (with event counter overlay) - Issue #3 */}
          <div
            onClick={toggleDoubleTap}
            className={`bg-gray-800 rounded-lg py-1.5 px-6 border-2 ${
              stealthMode
                ? 'border-gray-600'
                : (isDoubleTapRunning ? 'border-yellow-500' : 'border-gray-600')
            } ${
              (selectedModality !== null || currentTime > 0) && !isDoubleTapRunning
                ? 'opacity-50 cursor-not-allowed'
                : 'cursor-pointer hover:bg-gray-700'
            } transition-colors relative overflow-hidden`}
          >
            {/* Large semi-transparent Double Tap event counter overlay */}
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className={`text-9xl font-bold ${stealthMode ? 'text-gray-600' : 'text-yellow-400'} opacity-20`}>
                {doubleTapEvents}
              </div>
            </div>
            {/* Double Tap timer content (on top of overlay) */}
            <div className="flex items-center justify-between relative z-10">
              <div className="text-left">
                <div className="text-sm text-gray-400">Double Tap</div>
              </div>
              <div className={`text-4xl font-bold ${stealthMode ? 'text-gray-400' : (isDoubleTapRunning ? 'text-yellow-400' : 'text-gray-400')}`}>
                {formatTime(doubleTapTime)}
              </div>
            </div>
          </div>

        </div>
        
        {/* Modality Selection */}
        <div className="bg-gray-800 rounded-lg pt-3 pb-1.5 px-6 mb-2">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-xl font-semibold text-white">Modality</h2>
            {cptOverride && (
              <span className="text-sm font-mono px-2 py-0.5 rounded" style={{ backgroundColor: '#92400e', color: '#fbbf24' }}>
                {cptOverride.source.toUpperCase()}: {cptOverride.examDesc} — {cptOverride.rvu.toFixed(2)} RVU
              </span>
            )}
          </div>
          <div className="grid grid-cols-8 gap-3">
            {modalities.map(modality => (
              <button
                key={modality}
                onClick={() => { setCptOverride(null); setSelectedModality(modality); }}
                className={`py-4 px-4 rounded-lg font-medium text-sm transition-colors ${
                  stealthMode
                    ? selectedModality === modality
                      ? 'bg-gray-700 text-white border-2 border-white'
                      : 'bg-gray-700 text-gray-300 hover:bg-gray-600 border-2 border-gray-700'
                    : selectedModality === modality
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                }`}
              >
                {modality}
              </button>
            ))}
          </div>
        </div>
        
        {/* Complications Selection */}
        <div className="bg-gray-800 rounded-lg pt-3 pb-1.5 px-6 mb-2">
          <h2 className="text-xl font-semibold text-white mb-2">Complications (Optional)</h2>
          {/* Top row: non-RVU modifiers — always available */}
          <div className="grid grid-cols-5 gap-3 mb-2">
            {complicationsTopRow.map(complication => {
              const isSelected = selectedComplications.includes(complication);
              return (
                <button
                  key={complication}
                  onClick={() => toggleComplication(complication)}
                  className={`py-4 px-4 rounded-lg font-medium text-sm transition-colors ${
                    stealthMode
                      ? isSelected
                        ? 'bg-gray-700 text-white border-2 border-white'
                        : 'bg-gray-700 text-gray-300 hover:bg-gray-600 border-2 border-gray-700'
                      : isSelected
                      ? 'bg-orange-600 text-white'
                      : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                  }`}
                >
                  {complication}
                </button>
              );
            })}
          </div>
          {/* Bottom row: RVU modifiers — greyed out when Sidecar drives RVU */}
          <div className={`grid grid-cols-5 gap-3${cptOverride ? ' opacity-40' : ''}`}>
            {complicationsBottomRow.map(complication => {
              const isLocked = cptOverride !== null;
              const isSelected = selectedComplications.includes(complication);
              const isAutoLit = isLocked && isSelected;
              return (
                <button
                  key={complication}
                  onClick={() => { if (!isLocked) toggleComplication(complication); }}
                  disabled={isLocked}
                  className={`py-4 px-4 rounded-lg font-medium text-sm transition-colors ${
                    isLocked
                      ? isAutoLit
                        ? 'bg-amber-700 text-amber-200 cursor-not-allowed'
                        : 'bg-gray-800 text-gray-600 cursor-not-allowed'
                      : stealthMode
                        ? isSelected
                          ? 'bg-gray-700 text-white border-2 border-white'
                          : 'bg-gray-700 text-gray-300 hover:bg-gray-600 border-2 border-gray-700'
                        : isSelected
                        ? 'bg-orange-600 text-white'
                        : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                  }`}
                >
                  {complication}
                </button>
              );
            })}
          </div>
        </div>
      </div>
      
      <style>{`
        @keyframes flash-red {
          0%, 100% {
            background: linear-gradient(to bottom right, #dc2626, #b91c1c);
          }
          50% {
            background: linear-gradient(to bottom right, #991b1b, #7f1d1d);
          }
        }
        
        .elapsed-flash-red {
          animation: flash-red 0.5s ease-in-out infinite;
        }
      `}</style>
    </div>
  );
}

export default function RadTach() {
  return (
    <AuthProvider>
      <RadTachInner />
    </AuthProvider>
  );
}
