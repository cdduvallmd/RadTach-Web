import { useState, useEffect, useRef } from "react";

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
}

interface DraftStudyData {
  modality: Modality | null;
  complications: Complication[];
  currentTime: number;
  parTime: number;
}

export default function RadTach() {
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
    'Bilateral': 0, // Special: multiplies par time by 2
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
  const [isPaused, setIsPaused] = useState(false);

  // Double Tap tracking (Issue #3) - tracks when reopening recently-completed studies
  const [doubleTapTime, setDoubleTapTime] = useState(0);
  const [isDoubleTapRunning, setIsDoubleTapRunning] = useState(false);
  const [doubleTapEvents, setDoubleTapEvents] = useState(0);
  // const [lastStudyModality, setLastStudyModality] = useState<Modality | null>(null); // TODO: FIREBASE - Uncomment for Phase 3 (Issue #3). Associates Double Tap events with modality for analytics

  // Track if Admin/Comms auto-paused a study (so we can resume it when they stop)
  const [studyWasAutoPaused, setStudyWasAutoPaused] = useState(false);

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

  const timerRef = useRef<number | null>(null);
  const sessionTimeRef = useRef<number | null>(null);
  const interstitialTimeRef = useRef<number | null>(null);
  const adminTimeRef = useRef<number | null>(null);
  const commsTimeRef = useRef<number | null>(null);
  const breakTimeRef = useRef<number | null>(null);
  const timeSinceLastBreakRef = useRef<number | null>(null);
  const pauseTimeRef = useRef<number | null>(null); // Issue #2: Pause timer
  const doubleTapTimeRef = useRef<number | null>(null); // Issue #3: Double Tap timer
  
  // Calculate current par time based on selections
  const calculateParTime = () => {
    if (!selectedModality) return 0;
    
    let total = parTimes[selectedModality] || 0;
    let hasBilateral = false;
    
    selectedComplications.forEach(comp => {
      if (comp === 'Bilateral') {
        hasBilateral = true;
      } else {
        total += parTimes[comp] || 0;
      }
    });
    
    // Apply Bilateral multiplier last (after all additions)
    if (hasBilateral) {
      total *= 2;
    }
    
    return total;
  };
  
  const calculateRVU = () => {
    if (!selectedModality) return 0;

    const modalityRVU = rvuValues[selectedModality];
    let total = typeof modalityRVU === 'number' ? modalityRVU : 0;

    // Add complication RVUs that depend on modality
    selectedComplications.forEach(comp => {
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

  // Pause timer effect (Issue #2) - tracks pause duration
  useEffect(() => {
    if (isPaused) {
      pauseTimeRef.current = setInterval(() => {
        // setPauseTime(prev => prev + 1); // TODO: FIREBASE - Uncomment for Phase 3. Accumulates pause time for STUDY event recording
      }, 1000);
    } else {
      if (pauseTimeRef.current) {
        clearInterval(pauseTimeRef.current);
      }
    }

    return () => {
      if (pauseTimeRef.current) {
        clearInterval(pauseTimeRef.current);
      }
    };
  }, [isPaused]);

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

  // Auto-start timer when modality is selected (if AUTO mode is enabled)
  useEffect(() => {
    if (autoStartEnabled && selectedModality && !isRunning && !isDraftMode) {
      // Auto-start the timer
      toggleTimer();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedModality, autoStartEnabled]);

  // Format time as MM:SS
  const formatTime = (seconds: number): string => {
    const mins = Math.floor(Math.abs(seconds) / 60);
    const secs = Math.abs(seconds) % 60;
    const sign = seconds < 0 ? '-' : '';
    return `${sign}${mins}:${secs.toString().padStart(2, '0')}`;
  };
  
  // Start/Stop timer
  const toggleTimer = () => {
    if (!selectedModality && !isRunning) {
      alert('Please select a modality before starting');
      return;
    }
    
    if (!isRunning) {
      // Starting/Resuming a study
      setIsRunning(true);
      setIsPaused(false); // Issue #2: Stop pause tracking when resuming
      setIsInterstitialRunning(false); // Stop interstitial time
      setIsAdminTimeRunning(false); // Stop admin time
      setIsCommsTimeRunning(false); // Stop comms time
      setIsBreakTimeRunning(false); // Stop break time

      // Start session time and interstitial time if this is the first study
      if (!isSessionTimeRunning) {
        setIsSessionTimeRunning(true);
        setIsInterstitialRunning(true);
        // Stop interstitial immediately since we're starting a study
        setTimeout(() => setIsInterstitialRunning(false), 0);
      }
    } else {
      // Pausing a study - stop elapsed time, start pause tracking and interstitial time
      setIsRunning(false);
      setIsPaused(true); // Issue #2: Start pause tracking
      setIsInterstitialRunning(true); // Start tracking non-productive time
    }
  };
  
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
    const variance = currentTime - currentParTime;
    
    // Update streak counter
    if (variance <= 0) {
      // Study completed at or below par time - increase streak
      setCurrentStreak(prev => Math.min(prev + 1, 6)); // Max 6 for STREAK
    } else {
      // Study completed over par time - reset streak
      setCurrentStreak(0);
    }
    
    // Save study info for undo
    setLastStudy({
      variance: variance,
      rvu: currentStudyRVU,
      streakBefore: currentStreak // Save streak for undo
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
    
    // Start interstitial time
    setIsInterstitialRunning(true);
    
    // Reset for next study
    setCurrentTime(0);
    // setPauseTime(0); // TODO: FIREBASE - Uncomment for Phase 3 (Issue #2). Resets pause timer after recording to database
    setIsPaused(false); // Issue #2: Clear pause state
    // setLastStudyModality(selectedModality); // TODO: FIREBASE - Uncomment for Phase 3 (Issue #3). Saves modality for next Double Tap event association
    setSelectedModality(null);
    setSelectedComplications([]);

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
    
    // Clear the last study
    setLastStudy(null);
  };
  
  // Toggle Admin Time
  const toggleAdminTime = () => {
    if (!isAdminTimeRunning) {
      // Starting Admin Time
      setIsAdminTimeRunning(true);
      setIsInterstitialRunning(false);
      setIsCommsTimeRunning(false);
      setAdminEvents(prev => prev + 1); // Issue #4: Increment event counter

      // If study is in progress, auto-pause it
      const isStudyInProgress = selectedModality !== null && isRunning;
      if (isStudyInProgress) {
        setIsRunning(false);
        setIsPaused(true);
        setStudyWasAutoPaused(true);
      }
    } else {
      // Stopping Admin Time - restart Interstitial
      setIsAdminTimeRunning(false);
      setIsInterstitialRunning(true);

      // If we auto-paused a study, resume it
      if (studyWasAutoPaused) {
        setIsRunning(true);
        setIsPaused(false);
        setStudyWasAutoPaused(false);
      }
    }
  };

  // Toggle Comms Time
  const toggleCommsTime = () => {
    if (!isCommsTimeRunning) {
      // Starting Comms Time
      setIsCommsTimeRunning(true);
      setIsInterstitialRunning(false);
      setIsAdminTimeRunning(false);
      setCommsEvents(prev => prev + 1); // Issue #4: Increment event counter

      // If study is in progress, auto-pause it
      const isStudyInProgress = selectedModality !== null && isRunning;
      if (isStudyInProgress) {
        setIsRunning(false);
        setIsPaused(true);
        setStudyWasAutoPaused(true);
      }
    } else {
      // Stopping Comms Time - restart Interstitial
      setIsCommsTimeRunning(false);
      setIsInterstitialRunning(true);

      // If we auto-paused a study, resume it
      if (studyWasAutoPaused) {
        setIsRunning(true);
        setIsPaused(false);
        setStudyWasAutoPaused(false);
      }
    }
  };

  // Toggle Break Time
  const toggleBreakTime = () => {
    if (!isBreakTimeRunning) {
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
    } else {
      // Stopping Break - restart Interstitial
      setIsBreakTimeRunning(false);
      setIsInterstitialRunning(true);
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

    if (!isDoubleTapRunning) {
      // Starting Double Tap - stop Interstitial (productive time, not wasted)
      setIsDoubleTapRunning(true);
      setIsInterstitialRunning(false);
      setDoubleTapEvents(prev => prev + 1);
    } else {
      // Stopping Double Tap - restart Interstitial and reset duration for next event
      setIsDoubleTapRunning(false);
      setIsInterstitialRunning(true);
      setDoubleTapTime(0);
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
      setSelectedModality(draftStudy.modality);
      setSelectedComplications(draftStudy.complications);
      setCurrentTime(draftStudy.currentTime);
      
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
  const complications: Complication[] = ['Cancer Follow', '+1 Section', '+2 Section', 'Multiple Priors', 'Age >70', 'Complex Hx', 'Prior Surg Hx', 'CTA', 'Bilateral', 'Vascular'];
  
  return (
    <div className="min-h-screen bg-gray-900 p-4">
      {/* Settings Modal */}
      {showSettings && (
        <div className="fixed inset-0 bg-black bg-opacity-75 flex items-start justify-center z-50 p-4 overflow-y-auto">
          <div className="bg-gray-800 rounded-lg shadow-xl p-6 w-full max-w-2xl my-4">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-2xl font-bold text-white">Par Time Settings</h2>
              <div className="flex items-center space-x-2">
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
                <button
                  onClick={() => setShowSettings(false)}
                  className="text-gray-400 hover:text-white text-2xl ml-2"
                >
                  ×
                </button>
              </div>
            </div>
            
            <div className="space-y-6">
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
                </div>
              </div>
            </div>
            
            <div className="flex space-x-3 mt-6">
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
        <div className="fixed inset-0 bg-black bg-opacity-75 flex items-start justify-center z-50 p-4 overflow-y-auto">
          <div className="bg-gray-800 rounded-lg shadow-xl p-6 w-full max-w-2xl my-4">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-2xl font-bold text-white">RVU Settings</h2>
              <div className="flex items-center space-x-2">
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
                </section>

                {/* Basic Workflow */}
                <section>
                  <h2 className="text-2xl font-bold text-white mb-3">Basic Workflow</h2>
                  <div className="bg-gray-700 rounded-lg p-4 space-y-3">
                    <div className="flex items-start">
                      <span className="flex-shrink-0 w-8 h-8 bg-blue-600 rounded-full flex items-center justify-center text-white font-bold mr-3">1</span>
                      <div>
                        <h3 className="font-semibold text-white">Select Modality</h3>
                        <p className="text-sm text-gray-300">Click your exam type: Plain Film, Fluoro, CT, US, MR, or NM</p>
                      </div>
                    </div>
                    <div className="flex items-start">
                      <span className="flex-shrink-0 w-8 h-8 bg-blue-600 rounded-full flex items-center justify-center text-white font-bold mr-3">2</span>
                      <div>
                        <h3 className="font-semibold text-white">Add Complications (Optional)</h3>
                        <p className="text-sm text-gray-300">Click any applicable factors: Cancer Follow, +1 Section, Multiple Priors, etc.</p>
                      </div>
                    </div>
                    <div className="flex items-start">
                      <span className="flex-shrink-0 w-8 h-8 bg-yellow-500 rounded-full flex items-center justify-center text-white font-bold mr-3">★</span>
                      <div>
                        <h3 className="font-semibold text-white">Enable AUTO Mode (Optional)</h3>
                        <p className="text-sm text-gray-300">Click the Auto button (between Draft and Break) to enable auto-start. When active, the timer starts automatically as soon as you select a modality - no need to click Par Time! Yellow outline indicates AUTO is enabled. Click again to disable.</p>
                      </div>
                    </div>
                    <div className="flex items-start">
                      <span className="flex-shrink-0 w-8 h-8 bg-blue-600 rounded-full flex items-center justify-center text-white font-bold mr-3">3</span>
                      <div>
                        <h3 className="font-semibold text-white">Start Timer</h3>
                        <p className="text-sm text-gray-300">With AUTO disabled: Click the blue Par Time display to start. With AUTO enabled: Timer starts automatically when you select a modality!</p>
                      </div>
                    </div>
                    <div className="flex items-start">
                      <span className="flex-shrink-0 w-8 h-8 bg-blue-600 rounded-full flex items-center justify-center text-white font-bold mr-3">4</span>
                      <div>
                        <h3 className="font-semibold text-white">Adjust On-the-Fly (If Needed)</h3>
                        <p className="text-sm text-gray-300">Change modality or toggle complications anytime - par time updates instantly</p>
                      </div>
                    </div>
                    <div className="flex items-start">
                      <span className="flex-shrink-0 w-8 h-8 bg-green-600 rounded-full flex items-center justify-center text-white font-bold mr-3">5</span>
                      <div>
                        <h3 className="font-semibold text-white">Click Elapsed Time to Complete</h3>
                        <p className="text-sm text-gray-300">Finish the exam by clicking the Elapsed Time display</p>
                      </div>
                    </div>
                    <div className="flex items-start">
                      <span className="flex-shrink-0 w-8 h-8 bg-yellow-600 rounded-full flex items-center justify-center text-white font-bold mr-3">6</span>
                      <div>
                        <h3 className="font-semibold text-white">Manage Time Between Studies (Optional)</h3>
                        <p className="text-sm text-gray-300">Interstitial Time tracks non-productive time. Click Admin Time for administrative work or Comms Time when contacting physicians. These pause Interstitial tracking and help distinguish productive non-reading time from actual downtime.</p>
                      </div>
                    </div>
                    <div className="flex items-start">
                      <span className="flex-shrink-0 w-8 h-8 bg-red-600 rounded-full flex items-center justify-center text-white font-bold mr-3">7</span>
                      <div>
                        <h3 className="font-semibold text-white">Take Breaks (Recommended)</h3>
                        <p className="text-sm text-gray-300">Click the Break button to take a break. RadTach will prompt you after 2 hours of continuous work. Break Time is tracked separately and pauses Interstitial Time. Your Break Time and Breaks Taken are displayed in the metrics grid.</p>
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
                      <span className="text-gray-300"> Your cumulative time balance. </span>
                      <span className="text-green-400">Green</span>
                      <span className="text-gray-300"> = ahead of schedule, </span>
                      <span className="text-red-400">Red</span>
                      <span className="text-gray-300"> = behind schedule.</span>
                    </div>
                    <div>
                      <span className="font-semibold text-blue-400">Par Time:</span>
                      <span className="text-gray-300"> Target time for current exam. </span>
                      <span className="font-semibold">Click to start timing.</span>
                    </div>
                    <div>
                      <span className="font-semibold text-white">Elapsed Time:</span>
                      <span className="text-gray-300"> Current exam duration. Color shows pacing:</span>
                      <ul className="list-disc ml-6 mt-1 text-sm">
                        <li><span className="text-green-400">Green:</span> 30+ seconds remaining</li>
                        <li><span className="text-yellow-400">Yellow:</span> 15-30 seconds remaining</li>
                        <li><span className="text-red-400">Flashing Red:</span> Under 15 seconds</li>
                        <li><span className="text-red-400">Solid Red:</span> Over par time</li>
                      </ul>
                      <span className="font-semibold block mt-1">Click to complete the exam.</span>
                    </div>
                  </div>

                  <h3 className="text-lg font-semibold text-white mt-4 mb-2">Session Metrics Row</h3>
                  <div className="space-y-2 ml-4">
                    <div>
                      <span className="font-semibold text-blue-400">Session Time:</span>
                      <span className="text-gray-300"> Total elapsed time since your first exam started</span>
                    </div>
                    <div>
                      <span className="font-semibold text-yellow-400">Interstitial Time:</span>
                      <span className="text-gray-300"> Time between exams (non-productive time - loading images, reviewing priors). Yellow border = actively counting. Click to resume if Admin/Comms is running</span>
                    </div>
                    <div>
                      <span className="font-semibold text-orange-400">Admin Time:</span>
                      <span className="text-gray-300"> Administrative duties between exams. Click to start/stop. Pauses Interstitial Time when active</span>
                    </div>
                    <div>
                      <span className="font-semibold text-cyan-400">Comms Time:</span>
                      <span className="text-gray-300"> Critical findings communications (calling physicians, waiting for callbacks). Click to start/stop. Pauses Interstitial Time when active</span>
                    </div>
                    <div>
                      <span className="font-semibold text-green-400">Total RVU:</span>
                      <span className="text-gray-300"> Cumulative RVUs generated this session</span>
                    </div>
                    <div>
                      <span className="font-semibold text-purple-400">RVU/hr:</span>
                      <span className="text-gray-300"> Your productivity rate (updates when studies are completed)</span>
                    </div>
                    <div>
                      <span className="font-semibold text-red-400">Break Time:</span>
                      <span className="text-gray-300"> Total time spent on breaks during this session. Red border when actively on break. View-only display</span>
                    </div>
                    <div>
                      <span className="font-semibold text-pink-400">Breaks Taken:</span>
                      <span className="text-gray-300"> Number of breaks taken this session. RadTach prompts you to take a break after 2 hours of continuous work</span>
                    </div>
                  </div>
                </section>

                {/* Default Values */}
                <section>
                  <h2 className="text-2xl font-bold text-white mb-3">Default Par Times & RVUs</h2>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="bg-gray-700 rounded p-3">
                      <h3 className="font-semibold text-white mb-2">Modality Par Times</h3>
                      <ul className="text-sm space-y-1">
                        <li><span className="text-blue-400">Plain Film:</span> 1 min (0.2 RVU)</li>
                        <li><span className="text-blue-400">Fluoro:</span> 2 min (0.4 RVU)</li>
                        <li><span className="text-blue-400">CT:</span> 4 min (1.0 RVU)</li>
                        <li><span className="text-blue-400">US:</span> 2 min (0.5 RVU)</li>
                        <li><span className="text-blue-400">MR:</span> 4 min (1.3 RVU)</li>
                        <li><span className="text-blue-400">NM:</span> 4 min (0.6 RVU)</li>
                        <li><span className="text-blue-400">PET-CT:</span> 10 min (2.4 RVU)</li>
                      </ul>
                    </div>
                    <div className="bg-gray-700 rounded p-3">
                      <h3 className="font-semibold text-white mb-2">Complication Modifiers</h3>
                      <ul className="text-sm space-y-1">
                        <li><span className="text-orange-400">Cancer Follow:</span> +4 min</li>
                        <li><span className="text-orange-400">+1 Section:</span> +2 min (+0.5 RVU for CT/US)</li>
                        <li><span className="text-orange-400">+2 Section:</span> +4 min (+1.0 RVU for CT)</li>
                        <li><span className="text-orange-400">Multiple Priors:</span> +2 min</li>
                        <li><span className="text-orange-400">Age &gt;70:</span> +2 min</li>
                        <li><span className="text-orange-400">Complex Hx:</span> +2 min</li>
                        <li><span className="text-orange-400">Prior Surg Hx:</span> +2 min</li>
                        <li><span className="text-orange-400">CTA:</span> +3 min (+0.4 RVU for CT)</li>
                      </ul>
                    </div>
                  </div>
                  <p className="text-sm text-gray-400 mt-2 italic">
                    All values are customizable in Settings
                  </p>
                </section>

                {/* Pro Tips */}
                <section>
                  <h2 className="text-2xl font-bold text-white mb-3">Pro Tips</h2>
                  <div className="bg-blue-900 bg-opacity-30 border border-blue-500 rounded-lg p-4 space-y-2">
                    <p className="flex items-start">
                      <span className="text-blue-400 mr-2">💡</span>
                      <span><strong>Don't overthink it:</strong> Select modality, start reading. You can adjust complications as you discover them.</span>
                    </p>
                    <p className="flex items-start">
                      <span className="text-blue-400 mr-2">💡</span>
                      <span><strong>Watch the colors:</strong> Elapsed Time background gives instant visual feedback on your pacing.</span>
                    </p>
                    <p className="flex items-start">
                      <span className="text-blue-400 mr-2">💡</span>
                      <span><strong>Complete promptly:</strong> Click to complete right after dictating to accurately track interstitial time.</span>
                    </p>
                    <p className="flex items-start">
                      <span className="text-blue-400 mr-2">💡</span>
                      <span><strong>Monitor Above/Below Par:</strong> This shows if you're trending fast or slow for the session.</span>
                    </p>
                    <p className="flex items-start">
                      <span className="text-blue-400 mr-2">💡</span>
                      <span><strong>Set RVU goals:</strong> Use RVU/hr to track productivity improvements over time.</span>
                    </p>
                    <p className="flex items-start">
                      <span className="text-blue-400 mr-2">💡</span>
                      <span><strong>Customize for your practice:</strong> Adjust par times in Settings to match your specialty and workflow.</span>
                    </p>
                  </div>
                </section>

                {/* Customization */}
                <section>
                  <h2 className="text-2xl font-bold text-white mb-3">Customizing RadTach</h2>
                  <p className="mb-2">Click the Settings gear icon to access:</p>
                  <ul className="list-disc ml-6 space-y-1 mb-3">
                    <li><strong>Par Time Settings:</strong> Adjust target times for each modality and complication</li>
                    <li><strong>RVU Settings:</strong> Customize RVU values for your practice patterns</li>
                    <li><strong>Quick Start Guide:</strong> Return to this guide anytime</li>
                  </ul>
                  <div className="bg-green-900 bg-opacity-30 border border-green-500 rounded-lg p-3 mt-3">
                    <p className="text-sm"><strong className="text-green-400">✓ Settings Auto-Save:</strong> Your customized par times and RVU values are automatically saved in your browser and will persist between sessions.</p>
                  </div>
                  <div className="bg-blue-900 bg-opacity-30 border border-blue-500 rounded-lg p-3 mt-2">
                    <p className="text-sm mb-2"><strong className="text-blue-400">Import/Export Settings:</strong></p>
                    <ul className="text-sm space-y-1 ml-4">
                      <li><strong>Export:</strong> Save your settings to a CSV file for backup or sharing with colleagues</li>
                      <li><strong>Import:</strong> Load settings from a CSV file to restore or use on another device/browser</li>
                      <li><strong>Reset:</strong> Restore all settings to default values</li>
                    </ul>
                    <div className="bg-blue-800 rounded p-2 mt-2 text-xs">
                      <p className="font-semibold mb-1">💡 Transferring Settings to Another Workstation:</p>
                      <ol className="list-decimal ml-4 space-y-1">
                        <li><strong>Export:</strong> Click Export button - file saves to your Downloads folder</li>
                        <li><strong>Email yourself:</strong> Attach the CSV file and send to your email address</li>
                        <li><strong>On new workstation:</strong> Download the CSV from your email</li>
                        <li><strong>File location:</strong> The downloaded CSV will be in:
                          <ul className="ml-4 mt-1">
                            <li>• Windows: C:\Users\[YourName]\Downloads</li>
                            <li>• Mac: /Users/[YourName]/Downloads</li>
                            <li>• Linux: /home/[YourName]/Downloads</li>
                          </ul>
                        </li>
                        <li><strong>Import:</strong> Open RadTach, click Settings → Import → Select the CSV file</li>
                      </ol>
                      <p className="mt-2 text-yellow-200"><strong>Tip:</strong> You don't need to move the CSV file - just import it directly from your Downloads folder!</p>
                    </div>
                  </div>
                </section>

                {/* Important Notes */}
                <section>
                  <h2 className="text-2xl font-bold text-white mb-3">Important Notes</h2>
                  <div className="bg-yellow-900 bg-opacity-30 border border-yellow-500 rounded-lg p-4 space-y-2">
                    <p className="flex items-start">
                      <span className="text-yellow-400 mr-2">⚠️</span>
                      <span><strong>Data doesn't persist:</strong> Refreshing the page resets all session data. This is by design for daily use.</span>
                    </p>
                    <p className="flex items-start">
                      <span className="text-yellow-400 mr-2">⚠️</span>
                      <span><strong>Par times are targets, not requirements:</strong> Quality and thoroughness always come first.</span>
                    </p>
                    <p className="flex items-start">
                      <span className="text-yellow-400 mr-2">⚠️</span>
                      <span><strong>RVU values are approximate:</strong> Actual billing RVUs vary by exam protocol and coding.</span>
                    </p>
                  </div>
                </section>

                {/* Footer */}
                <div className="mt-8 pt-6 border-t border-gray-600">
                  <p className="text-center text-gray-400 text-sm">
                    <strong>RadTach</strong> - Your Radiologist Tachometer<br/>
                    Created by Charles Darren Duvall, MD<br/>
                    Coded by Claude (Anthropic)<br/>
                    Version 1.2
                  </p>
                  <p className="text-center text-gray-400 text-xs mt-4">
                    Please forward feedback or identified errors to{' '}
                    <a href="mailto:cdduvallmd@yahoo.com?subject=RadTach" className="text-blue-400 hover:text-blue-300 underline">
                      cdduvallmd@yahoo.com
                    </a>
                    {' '}with the Subject line "RadTach".
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

      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div className="flex justify-between items-center mb-2">
          <h1 className="text-3xl font-bold text-white">RadTach 1.2</h1>
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
          </div>
        </div>
        
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
                    ({formatTime(draftStudy.currentTime)} / {formatTime(draftStudy.parTime)})
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
              {formatTime(currentParTime)}
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
              {formatTime(currentTime)}
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
                {isHoveringRVU ? rollingRVU.toFixed(1) : rvuPerHour.toFixed(1)}
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
                {totalRVU.toFixed(1)}
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
          <h2 className="text-xl font-semibold text-white mb-2">Modality</h2>
          <div className="grid grid-cols-8 gap-3">
            {modalities.map(modality => (
              <button
                key={modality}
                onClick={() => setSelectedModality(modality)}
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
          <div className="grid grid-cols-5 gap-3">
            {complications.map(complication => (
              <button
                key={complication}
                onClick={() => toggleComplication(complication)}
                className={`py-4 px-4 rounded-lg font-medium text-sm transition-colors ${
                  stealthMode
                    ? selectedComplications.includes(complication)
                      ? 'bg-gray-700 text-white border-2 border-white'
                      : 'bg-gray-700 text-gray-300 hover:bg-gray-600 border-2 border-gray-700'
                    : selectedComplications.includes(complication)
                    ? 'bg-orange-600 text-white'
                    : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                }`}
              >
                {complication}
              </button>
            ))}
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
