import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { firestoreService } from '../services/firestore';
import { listenToCommandDoc, listenToUserSettings, writeStartCommand, writeStopCommand, writeSyncSettingsResponse } from './services/sidecarFirestore';
import { buildCptTree, type ModalityGroup, type TreeLeaf } from './utils/buildCptTree';
import { searchCpts, type SearchResult } from './utils/cptSearch';
import type { CptDatabase, CptEntry, ChargemasterEntry } from '../types/cpt';
import type { GpciValues } from '../utils/gpciLookup';
import { sendToGoose, type GooseMessage } from './services/gooseWebSocket';
import HomeScreen from './components/HomeScreen';
import BodyPartScreen from './components/BodyPartScreen';
import ProtocolScreen from './components/ProtocolScreen';
import LeafScreen from './components/LeafScreen';
import ComboBuilder from './components/ComboBuilder';
import ActiveStudy from './components/ActiveStudy';
import CptListScreen from './components/CptListScreen';
import SavedCombosScreen from './components/SavedCombosScreen';
import { MODALITY_COLORS } from './utils/modalityColors';
// comboColor used in SavedCombosScreen, BodyPartScreen, ProtocolScreen, HomeScreen, CptListScreen

type Screen =
  | { type: 'home' }
  | { type: 'common' }
  | { type: 'recent' }
  | { type: 'favorites' }
  | { type: 'bodyPart'; modality: string }
  | { type: 'protocol'; modality: string; bodyPart: string }
  | { type: 'leaf'; entry: CptEntry; cpt: string; aeTitle?: string }
  | { type: 'combo' }
  | { type: 'savedCombos' }
  | { type: 'active'; examDesc: string };

export interface SelectedExam {
  cpt: string;
  entry: CptEntry;
  bilateral: boolean;
}

export interface FavoriteEntry {
  cpt: string;
  aeTitle: string;
}

export interface RecentEntry {
  cpts: string[];
  bilateralFlags: boolean[];
  aeTitle?: string;  // user's combo rename, surfaced in Recent + Modality views
}

export interface SavedCombo {
  cpts: string[];
  bilateralFlags: boolean[];
  modality: string;
  aeTitle?: string;
}

interface Props {
  gooseConnected: boolean;
  testMode?: boolean;
}

const COMMON_CPTS = ['70450', '74177', '71046', '70553', '73030', '71045', '73620', '76536', '72148', '72141'];
const RECENT_KEY = 'sidecar_recent';
const MAX_RECENT = 10;
const COMBO_KEY = 'sidecar_saved_combos';

function loadRecent(): RecentEntry[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    if (!Array.isArray(raw)) return [];
    return raw.map((item: unknown) => {
      if (typeof item === 'string') {
        return { cpts: [item], bilateralFlags: [false] };
      }
      return item as RecentEntry;
    });
  } catch { return []; }
}

function saveRecent(entries: RecentEntry[]) {
  localStorage.setItem(RECENT_KEY, JSON.stringify(entries.slice(0, MAX_RECENT)));
}

function loadSavedCombos(): SavedCombo[] {
  try {
    return JSON.parse(localStorage.getItem(COMBO_KEY) || '[]');
  } catch { return []; }
}

function saveSavedCombos(combos: SavedCombo[]) {
  localStorage.setItem(COMBO_KEY, JSON.stringify(combos));
}

const FAVORITES_KEY = 'sidecar_favorites';

function loadLocalFavorites(): FavoriteEntry[] {
  try {
    return JSON.parse(localStorage.getItem(FAVORITES_KEY) || '[]');
  } catch { return []; }
}

function saveLocalFavorites(entries: FavoriteEntry[]) {
  localStorage.setItem(FAVORITES_KEY, JSON.stringify(entries));
}

export default function SidecarMain({ gooseConnected, testMode = false }: Props) {
  const { currentUser } = useAuth();
  const [screen, setScreen] = useState<Screen>({ type: 'home' });
  const [cptDb, setCptDb] = useState<CptDatabase | null>(null);
  const [tree, setTree] = useState<ModalityGroup[]>([]);
  const [selectedExams, setSelectedExams] = useState<SelectedExam[]>([]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [recentEntries, setRecentEntries] = useState<RecentEntry[]>(loadRecent);
  const [savedCombos, setSavedCombos] = useState<SavedCombo[]>(loadSavedCombos); // localStorage as fallback, Firestore is primary
  const [favorites, setFavorites] = useState<FavoriteEntry[]>([]);
  const [gpciValues, setGpciValues] = useState<GpciValues | null>(null);
  const [systemName, setSystemName] = useState<string | null>(null);
  const [chargemaster, setChargemaster] = useState<ChargemasterEntry[] | null>(null);
  const [comboAeTitle, setComboAeTitle] = useState<string | undefined>(undefined);

  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sync log for debugging favorites/combos persistence
  const [syncLog, setSyncLog] = useState<string[]>([]);
  const addSyncLog = (msg: string) => {
    const ts = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });
    setSyncLog(prev => [`${ts} ${msg}`, ...prev].slice(0, 20));
  };

  const cptDbRef = useRef(cptDb);
  cptDbRef.current = cptDb;

  // Load CPT database
  useEffect(() => {
    firestoreService.getCptDatabase().then(db => {
      if (db) setCptDb(db);
      setLoading(false);
    });
  }, []);

  // Build tree when CPT database or chargemaster changes
  useEffect(() => {
    if (cptDb) {
      setTree(buildCptTree(cptDb.entries, chargemaster ?? undefined));
    }
  }, [cptDb, chargemaster]);

  // Listen to user settings via onSnapshot (persistent connection, survives flaky networks)
  const settingsMergedRef = useRef(false); // one-time combo merge flag
  useEffect(() => {
    if (!currentUser) return;
    settingsMergedRef.current = false;
    addSyncLog('Settings listener started');
    const unsub = listenToUserSettings(currentUser.uid, (settings) => {
      if (!settings) { addSyncLog('Settings: empty doc'); return; }
      addSyncLog('Settings snapshot received');
      if (settings.gpciValues && typeof settings.gpciValues === 'object') {
        const g = settings.gpciValues as { work?: number; pe?: number; mp?: number; localityName?: string };
        if (typeof g.work === 'number' && typeof g.pe === 'number' && typeof g.mp === 'number') {
          setGpciValues(g as GpciValues);
        }
      }
      if (typeof settings.currentSystem === 'string' && settings.currentSystem) {
        setSystemName(settings.currentSystem);
      }
      if (!settingsMergedRef.current) {
        // One-time merge on first snapshot: Firestore + localStorage for both favorites and combos
        settingsMergedRef.current = true;

        // Favorites merge
        const firestoreFavs = Array.isArray(settings.favorites) ? settings.favorites as FavoriteEntry[] : [];
        addSyncLog(`Merge: Firestore ${firestoreFavs.length} favs, localStorage ${loadLocalFavorites().length} favs`);
        const localFavs = loadLocalFavorites();
        const favSeen = new Set<string>();
        const mergedFavs: FavoriteEntry[] = [];
        for (const f of [...firestoreFavs, ...localFavs]) {
          if (!favSeen.has(f.cpt)) { favSeen.add(f.cpt); mergedFavs.push(f); }
        }
        setFavorites(mergedFavs);
        saveLocalFavorites(mergedFavs);
        addSyncLog(`Merged favs: ${mergedFavs.length} (${mergedFavs.length > firestoreFavs.length ? 'pushing to Firestore' : 'no change'})`);
        if (mergedFavs.length > firestoreFavs.length) {
          firestoreService.saveFavorites(currentUser.uid, mergedFavs)
            .then(() => addSyncLog('Favs write OK'))
            .catch(err => addSyncLog(`Favs write FAIL: ${err.message}`));
        }

        // Combos merge (named versions win over unnamed)
        const firestoreCombos = Array.isArray(settings.sidecarCombos) ? settings.sidecarCombos as SavedCombo[] : [];
        const localCombos = loadSavedCombos();
        addSyncLog(`Merge: Firestore ${firestoreCombos.length} combos, localStorage ${localCombos.length} combos`);
        const comboKey = (c: SavedCombo) => [...c.cpts].sort().join(',');
        const comboMap = new Map<string, SavedCombo>();
        for (const c of [...firestoreCombos, ...localCombos]) {
          const k = comboKey(c);
          const existing = comboMap.get(k);
          if (!existing || (c.aeTitle && !existing.aeTitle)) {
            comboMap.set(k, c);
          }
        }
        const mergedCombos = [...comboMap.values()];
        setSavedCombos(mergedCombos);
        saveSavedCombos(mergedCombos);
        const remoteNameMap = new Map(firestoreCombos.map(c => [comboKey(c), c.aeTitle]));
        const hasNew = mergedCombos.length > firestoreCombos.length;
        const hasNewNames = mergedCombos.some(c => c.aeTitle && !remoteNameMap.get(comboKey(c)));
        addSyncLog(`Merged combos: ${mergedCombos.length} (${hasNew ? 'new items' : ''}${hasNewNames ? ' new names' : ''}${!hasNew && !hasNewNames ? 'no change' : ''})`);
        if (hasNew || hasNewNames) {
          firestoreService.saveSidecarCombos(currentUser.uid, mergedCombos)
            .then(() => addSyncLog('Combos write OK'))
            .catch(err => addSyncLog(`Combos write FAIL: ${err.message}`));
        }
      } else {
        // Subsequent updates: Firestore is source of truth
        if (Array.isArray(settings.favorites)) {
          setFavorites(settings.favorites as FavoriteEntry[]);
        }
        if (Array.isArray(settings.sidecarCombos)) {
          setSavedCombos(settings.sidecarCombos as SavedCombo[]);
        }
      }
    });
    return unsub;
  }, [currentUser]);

  // Load chargemaster when system name is available
  useEffect(() => {
    if (!systemName) return;
    firestoreService.getSystemChargemaster(systemName).then(cm => {
      if (cm) setChargemaster(cm);
    }).catch(console.error);
  }, [systemName]);

  // Listen for commands from RadTach
  useEffect(() => {
    if (!currentUser) return;
    const unsub = listenToCommandDoc(currentUser.uid, (cmd) => {
      if (cmd?.action === 'completed') {
        sendToGoose({ action: 'end_exam' });
        setScreen({ type: 'home' });
        setSelectedExams([]);
        setPendingStop(false);
        if (pendingStopTimer.current) {
          clearTimeout(pendingStopTimer.current);
          pendingStopTimer.current = null;
        }
      } else if (cmd?.action === 'sync_settings' && cmd.source === 'radtach') {
        // RadTach sent Firestore favorites/combos — merge with localStorage
        const remoteFavs: FavoriteEntry[] = Array.isArray(cmd.favorites) ? cmd.favorites as FavoriteEntry[] : [];
        addSyncLog(`CMD sync_settings: ${remoteFavs.length} favs, ${Array.isArray(cmd.sidecarCombos) ? cmd.sidecarCombos.length : 0} combos from RadTach`);
        const localFavs = loadLocalFavorites();
        const favSeen = new Set<string>();
        const mergedFavs: FavoriteEntry[] = [];
        for (const f of [...remoteFavs, ...localFavs]) {
          if (!favSeen.has(f.cpt)) { favSeen.add(f.cpt); mergedFavs.push(f); }
        }
        setFavorites(mergedFavs);
        saveLocalFavorites(mergedFavs);

        const remoteCombos: SavedCombo[] = Array.isArray(cmd.sidecarCombos) ? cmd.sidecarCombos as SavedCombo[] : [];
        const localCombos = loadSavedCombos();
        const comboKey = (c: SavedCombo) => [...c.cpts].sort().join(',');
        // Build a map preferring the copy with an aeTitle (named > unnamed)
        const comboMap = new Map<string, SavedCombo>();
        for (const c of [...remoteCombos, ...localCombos]) {
          const k = comboKey(c);
          const existing = comboMap.get(k);
          if (!existing) {
            comboMap.set(k, c);
          } else if (c.aeTitle && !existing.aeTitle) {
            // Named version wins over unnamed
            comboMap.set(k, c);
          }
        }
        const mergedCombos = [...comboMap.values()];
        setSavedCombos(mergedCombos);
        saveSavedCombos(mergedCombos);

        // Respond if local contributed new items OR named versions that Firestore didn't have
        const remoteKeys = new Set(remoteCombos.map(comboKey));
        const remoteNameMap = new Map(remoteCombos.map(c => [comboKey(c), c.aeTitle]));
        const hasNewItems = mergedCombos.some(c => !remoteKeys.has(comboKey(c)));
        const hasNewNames = mergedCombos.some(c => c.aeTitle && !remoteNameMap.get(comboKey(c)));
        const favsChanged = mergedFavs.length > remoteFavs.length;
        addSyncLog(`CMD merge: ${mergedFavs.length} favs, ${mergedCombos.length} combos`);
        if (favsChanged || hasNewItems || hasNewNames) {
          addSyncLog('Sending sync_settings_response...');
          writeSyncSettingsResponse(currentUser.uid, mergedFavs, mergedCombos)
            .then(() => addSyncLog('Response write OK'))
            .catch(err => addSyncLog(`Response write FAIL: ${err.message}`));
        } else {
          addSyncLog('No changes to send back');
        }
      }
    });
    return unsub;
  }, [currentUser]);

  const handleStart = useCallback(async (exams: SelectedExam[], comboAeTitle?: string, userTitle?: string, swap: boolean = false) => {
    if (exams.length === 0 || sending) return;
    const effectiveTitle = comboAeTitle || userTitle;
    const examDesc = effectiveTitle
      ? effectiveTitle
      : exams.length === 1
        ? exams[0].entry.description
        : exams.map(e => e.entry.description).join(' + ');

    // Track recent (full combo, deduplicated by sorted CPT set).
    // Preserve any prior aeTitle when re-running a known combo without a new title.
    const entry: RecentEntry = {
      cpts: exams.map(e => e.cpt),
      bilateralFlags: exams.map(e => e.bilateral),
      ...(effectiveTitle ? { aeTitle: effectiveTitle } : {}),
    };
    setRecentEntries(prev => {
      const key = (e: RecentEntry) => [...e.cpts].sort().join(',');
      const entryKey = key(entry);
      const existing = prev.find(e => key(e) === entryKey);
      const merged: RecentEntry = { ...entry, aeTitle: entry.aeTitle || existing?.aeTitle };
      const next = [merged, ...prev.filter(e => key(e) !== entryKey)].slice(0, MAX_RECENT);
      saveRecent(next);
      return next;
    });

    // Save combo for modality-level recall (never expires)
    if (exams.length > 1) {
      const combo: SavedCombo = {
        cpts: exams.map(e => e.cpt),
        bilateralFlags: exams.map(e => e.bilateral),
        modality: exams[0].entry.modality,
        ...(effectiveTitle ? { aeTitle: effectiveTitle } : {}),
      };
      setSavedCombos(prev => {
        const key = (c: SavedCombo) => [...c.cpts].sort().join(',');
        const comboKey = key(combo);
        // Preserve existing aeTitle if user didn't provide a new one
        const existing = prev.find(c => key(c) === comboKey);
        const merged = { ...combo, aeTitle: combo.aeTitle || existing?.aeTitle };
        const next = [merged, ...prev.filter(c => key(c) !== comboKey)];
        saveSavedCombos(next);
        if (currentUser) firestoreService.saveSidecarCombos(currentUser.uid, next).catch(console.error);
        return next;
      });
    }

    if (testMode) {
      setScreen({ type: 'active', examDesc });
      setSelectedExams([]);
      return;
    }
    if (!currentUser) return;
    setSending(true);
    try {
      const cpts = exams.map(e => e.cpt);
      const modality = exams[0].entry.modality;
      const bilateralFlags = exams.map(e => e.bilateral);
      await writeStartCommand(currentUser.uid, cpts, modality, examDesc, bilateralFlags, swap);
      sendToGoose({
        action: 'start_exam',
        bodyParts: [...new Set(exams.map(e => e.entry.bodyPart))],
        bodyPart: exams[0].entry.bodyPart,  // Deprecated fallback
        modality,
      });
      setScreen({ type: 'active', examDesc });
      setSelectedExams([]);
    } finally {
      setSending(false);
    }
  }, [currentUser, sending, testMode]);

  // Track pending stop for network lag indicator on home screen
  const [pendingStop, setPendingStop] = useState(false);
  const pendingStopTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleSignReport = useCallback(async () => {
    if (testMode) {
      setScreen({ type: 'home' });
      return;
    }
    if (!currentUser || sending) return;
    setSending(true);
    sendToGoose({ action: 'end_exam' });

    // Race: Firestore write vs 5s timeout
    const timeout = new Promise<'timeout'>(r => setTimeout(() => r('timeout'), 5000));
    const write = writeStopCommand(currentUser.uid).then(() => 'done' as const).catch(() => 'done' as const);
    const result = await Promise.race([write, timeout]);

    setSending(false);
    setScreen({ type: 'home' });
    setSelectedExams([]);

    if (result === 'timeout') {
      // Write still in flight — show indicator, clear when it resolves or 15s hard cap
      setPendingStop(true);
      write.then(() => setPendingStop(false));
      pendingStopTimer.current = setTimeout(() => setPendingStop(false), 15000);
    }
  }, [currentUser, sending, testMode]);

  const handleAddExam = useCallback((cpt: string, entry: CptEntry, bilateral: boolean) => {
    setComboAeTitle(undefined); // Manual combo, not from chargemaster
    setSelectedExams(prev => [...prev, { cpt, entry, bilateral }]);
    setScreen({ type: 'combo' });
  }, []);

  const handleRemoveExam = useCallback((index: number) => {
    setSelectedExams(prev => {
      const next = prev.filter((_, i) => i !== index);
      if (next.length === 0) setScreen({ type: 'home' });
      return next;
    });
  }, []);

  const handleRenameCombo = useCallback((index: number, aeTitle: string) => {
    setSavedCombos(prev => {
      const next = prev.map((c, i) => i === index ? { ...c, aeTitle: aeTitle || undefined } : c);
      saveSavedCombos(next);
      if (currentUser) firestoreService.saveSidecarCombos(currentUser.uid, next).catch(console.error);
      return next;
    });
  }, [currentUser]);

  const handleDeleteCombo = useCallback((index: number) => {
    addSyncLog(`Delete combo at index ${index}`);
    setSavedCombos(prev => {
      const next = prev.filter((_, i) => i !== index);
      saveSavedCombos(next);
      if (currentUser) firestoreService.saveSidecarCombos(currentUser.uid, next)
        .then(() => addSyncLog('Combo delete → Firestore OK'))
        .catch(err => addSyncLog(`Combo delete → Firestore FAIL: ${err.message}`));
      return next;
    });
  }, [currentUser]);

  const handleAddFavorite = useCallback((cpt: string, aeTitle: string) => {
    addSyncLog(`Add fav: ${cpt} "${aeTitle}"`);
    setFavorites(prev => {
      const next = [{ cpt, aeTitle }, ...prev.filter(f => f.cpt !== cpt)];
      saveLocalFavorites(next);
      addSyncLog(`Saved ${next.length} favs to localStorage`);
      if (currentUser) firestoreService.saveFavorites(currentUser.uid, next)
        .then(() => addSyncLog('Fav add → Firestore OK'))
        .catch(err => addSyncLog(`Fav add → Firestore FAIL: ${err.message}`));
      return next;
    });
  }, [currentUser]);

  const handleRemoveFavorite = useCallback((cpt: string) => {
    addSyncLog(`Remove fav: ${cpt}`);
    setFavorites(prev => {
      const next = prev.filter(f => f.cpt !== cpt);
      saveLocalFavorites(next);
      if (currentUser) firestoreService.saveFavorites(currentUser.uid, next)
        .then(() => addSyncLog('Fav remove → Firestore OK'))
        .catch(err => addSyncLog(`Fav remove → Firestore FAIL: ${err.message}`));
      return next;
    });
  }, [currentUser]);

  const handleFavoriteSelect = useCallback((fav: FavoriteEntry) => {
    if (!cptDb) return;
    const entry = cptDb.entries[fav.cpt];
    if (entry) setScreen({ type: 'leaf', entry, cpt: fav.cpt, aeTitle: fav.aeTitle });
  }, [cptDb]);

  // Resolve display name: chargemaster aeTitle > favorite name > undefined (CMS fallback)
  const favLookup = useRef<Map<string, string>>(new Map());
  favLookup.current = new Map(favorites.map(f => [f.cpt, f.aeTitle]));
  const resolveName = useCallback((cpt: string, chargemasterAeTitle?: string): string | undefined => {
    return chargemasterAeTitle || favLookup.current.get(cpt) || undefined;
  }, []);

  const chargemasterRef = useRef(chargemaster);
  chargemasterRef.current = chargemaster;

  // Search handler with 300ms debounce
  const handleSearchChange = useCallback((query: string) => {
    setSearchQuery(query);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!query.trim()) {
      setSearchResults([]);
      return;
    }
    debounceRef.current = setTimeout(() => {
      if (cptDbRef.current) {
        setSearchResults(searchCpts(query, cptDbRef.current.entries, 10, chargemasterRef.current ?? undefined));
      }
    }, 300);
  }, []);

  // Search result selection → navigate to leaf or combo builder
  const handleSearchSelect = useCallback((result: SearchResult) => {
    if (!cptDb) return;
    setSearchQuery('');
    setSearchResults([]);
    if (result.comboCpts && result.comboCpts.length > 1) {
      // Chargemaster combo → load into ComboBuilder
      const exams: SelectedExam[] = result.comboCpts
        .map((cpt, i) => {
          const e = cptDb.entries[cpt];
          return e ? { cpt, entry: e, bilateral: result.comboBilateralFlags?.[i] ?? false } : null;
        })
        .filter((e): e is SelectedExam => e !== null);
      if (exams.length > 0) {
        setComboAeTitle(result.aeTitle);
        setSelectedExams(exams);
        setScreen({ type: 'combo' });
      }
    } else {
      const entry = cptDb.entries[result.cpt];
      if (entry) {
        setScreen({ type: 'leaf', entry, cpt: result.cpt, aeTitle: resolveName(result.cpt, result.aeTitle) });
      }
    }
  }, [cptDb]);

  // Recent entry selection — single CPT → LeafScreen, combo → ComboBuilder
  const handleRecentSelect = useCallback((entry: RecentEntry) => {
    if (!cptDb) return;
    if (entry.cpts.length === 1) {
      const e = cptDb.entries[entry.cpts[0]];
      if (e) setScreen({ type: 'leaf', entry: e, cpt: entry.cpts[0], aeTitle: resolveName(entry.cpts[0]) });
    } else {
      const exams: SelectedExam[] = entry.cpts
        .map((cpt, i) => {
          const e = cptDb.entries[cpt];
          return e ? { cpt, entry: e, bilateral: entry.bilateralFlags[i] } : null;
        })
        .filter((e): e is SelectedExam => e !== null);
      if (exams.length > 0) {
        setSelectedExams(exams);
        setScreen({ type: 'combo' });
      }
    }
  }, [cptDb]);

  // Saved combo recall → load into ComboBuilder
  const handleComboRecall = useCallback((combo: SavedCombo) => {
    if (!cptDb) return;
    const exams: SelectedExam[] = combo.cpts
      .map((cpt, i) => {
        const e = cptDb.entries[cpt];
        return e ? { cpt, entry: e, bilateral: combo.bilateralFlags[i] } : null;
      })
      .filter((e): e is SelectedExam => e !== null);
    if (exams.length > 0) {
      setSelectedExams(exams);
      setScreen({ type: 'combo' });
    }
  }, [cptDb]);

  // Handle leaf selection — routes chargemaster combos to ComboBuilder
  const handleLeafSelect = useCallback((leaf: TreeLeaf) => {
    if (!cptDb) return;
    if (leaf.comboCpts && leaf.comboCpts.length > 1) {
      // Chargemaster combo → load all CPTs into ComboBuilder
      const exams: SelectedExam[] = leaf.comboCpts
        .map((cpt, i) => {
          const e = cptDb.entries[cpt];
          return e ? { cpt, entry: e, bilateral: leaf.comboBilateralFlags?.[i] ?? false } : null;
        })
        .filter((e): e is SelectedExam => e !== null);
      if (exams.length > 0) {
        setComboAeTitle(leaf.aeTitle);
        setSelectedExams(exams);
        setScreen({ type: 'combo' });
      }
    } else {
      setScreen({ type: 'leaf', entry: leaf.entry, cpt: leaf.cpt, aeTitle: resolveName(leaf.cpt, leaf.aeTitle) });
    }
  }, [cptDb]);

  // Handle Goose WebSocket messages (called from SessionGate)
  const handleGooseMessage = useCallback((msg: GooseMessage) => {
    if (msg.action === 'stop') {
      handleSignReport();
    } else if (msg.action === 'search' && msg.text) {
      setScreen({ type: 'home' });
      setSearchQuery(msg.text);
      if (cptDbRef.current) {
        setSearchResults(searchCpts(msg.text, cptDbRef.current.entries, 10, chargemasterRef.current ?? undefined));
      }
    }
  }, [handleSignReport]);

  // Expose handler to SessionGate via ref
  const gooseHandlerRef = useRef(handleGooseMessage);
  gooseHandlerRef.current = handleGooseMessage;

  useEffect(() => {
    (window as unknown as Record<string, unknown>).__gooseHandler = (msg: GooseMessage) => {
      gooseHandlerRef.current(msg);
    };
    return () => {
      delete (window as unknown as Record<string, unknown>).__gooseHandler;
    };
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <div className="w-10 h-10 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!cptDb) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center p-4">
        <p className="text-red-400">CPT database not found. Contact administrator.</p>
      </div>
    );
  }

  const modalityGroup = screen.type === 'bodyPart' || screen.type === 'protocol'
    ? tree.find(m => m.modality === screen.modality)
    : null;

  switch (screen.type) {
    case 'home':
      return (
        <HomeScreen
          modalities={tree.map(m => m.modality)}
          onSelectModality={mod => {
            const group = tree.find(m => m.modality === mod);
            if (group && group.bodyParts.length === 1) {
              const bp = group.bodyParts[0];
              if (bp.isLeaf) {
                setScreen({ type: 'leaf', entry: bp.leafEntry!.entry, cpt: bp.leafEntry!.cpt, aeTitle: resolveName(bp.leafEntry!.cpt) });
              } else {
                setScreen({ type: 'protocol', modality: mod, bodyPart: bp.bodyPart });
              }
            } else {
              setScreen({ type: 'bodyPart', modality: mod });
            }
          }}
          comboCount={selectedExams.length}
          onOpenCombo={() => setScreen({ type: 'combo' })}
          searchQuery={searchQuery}
          onSearchChange={handleSearchChange}
          searchResults={searchResults}
          onSearchSelect={handleSearchSelect}
          gooseConnected={gooseConnected}
          pendingStop={pendingStop}
          favNames={favLookup.current}
          syncLog={syncLog}
          onOpenRecent={() => setScreen({ type: 'recent' })}
          onOpenCommon={() => setScreen({ type: 'common' })}
          onOpenFavorites={() => setScreen({ type: 'favorites' })}
          favoritesCount={favorites.length}
          savedComboCount={savedCombos.length}
          onOpenSavedCombos={() => setScreen({ type: 'savedCombos' })}
        />
      );

    case 'recent':
      return (
        <CptListScreen
          title="Recent"
          recentEntries={recentEntries}
          entries={cptDb.entries}
          onSelectRecent={handleRecentSelect}
          onBack={() => setScreen({ type: 'home' })}
        />
      );

    case 'common':
      return (
        <CptListScreen
          title="Common"
          cpts={COMMON_CPTS}
          entries={cptDb.entries}
          onSelect={(cpt) => {
            const entry = cptDb.entries[cpt];
            if (entry) setScreen({ type: 'leaf', entry, cpt, aeTitle: resolveName(cpt) });
          }}
          onBack={() => setScreen({ type: 'home' })}
        />
      );

    case 'favorites':
      return (
        <div className="min-h-screen bg-gray-900 flex flex-col">
          <div className="flex-1 p-3 pb-4">
            <div className="flex items-center mb-4 max-w-sm mx-auto">
              <button onClick={() => setScreen({ type: 'home' })} className="text-blue-400 hover:text-blue-300 text-sm mr-3">&larr; Back</button>
              <h1 className="text-lg font-bold text-white">Favorites</h1>
            </div>
            {favorites.length === 0 ? (
              <p className="text-gray-500 text-center text-sm mt-12">No favorites yet. Add exams from the exam detail screen.</p>
            ) : (
              <div className="max-w-sm mx-auto space-y-1.5">
                {favorites.filter(f => cptDb.entries[f.cpt]).map(fav => {
                  const entry = cptDb.entries[fav.cpt];
                  return (
                    <div key={fav.cpt} className="flex items-stretch gap-1.5">
                      <button
                        onClick={() => handleFavoriteSelect(fav)}
                        className="flex-1 text-left p-2.5 bg-gray-800 hover:bg-gray-700 rounded-lg active:scale-95 transition-all"
                      >
                        <div className="flex items-center gap-2 mb-0.5">
                          <span className="text-xs font-bold px-1.5 py-0.5 rounded" style={{ backgroundColor: MODALITY_COLORS[entry.modality] || '#6b7280', color: 'white' }}>
                            {entry.modality}
                          </span>
                          <span className="text-gray-400 text-xs">{fav.cpt}</span>
                          <span className="text-gray-500 text-xs ml-auto">{entry.bodyPart}</span>
                        </div>
                        <p className="text-white text-sm font-medium">{fav.aeTitle}</p>
                        <p className="text-gray-500 text-xs mt-0.5">{entry.description}</p>
                      </button>
                      <button
                        onClick={() => handleRemoveFavorite(fav.cpt)}
                        className="px-2.5 bg-gray-800 hover:bg-red-900/50 rounded-lg text-gray-500 hover:text-red-400 text-lg transition-colors"
                        title="Remove from favorites"
                      >
                        &times;
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      );

    case 'savedCombos':
      return (
        <SavedCombosScreen
          combos={savedCombos}
          entries={cptDb.entries}
          onSelect={handleComboRecall}
          onRename={handleRenameCombo}
          onDelete={handleDeleteCombo}
          onBack={() => setScreen({ type: 'home' })}
        />
      );

    case 'bodyPart':
      return (
        <BodyPartScreen
          modality={screen.modality}
          group={modalityGroup!}
          savedCombos={savedCombos.filter(c => c.modality === screen.modality)}
          entries={cptDb.entries}
          onSelectBodyPart={(bp, leaf) => {
            if (leaf) {
              handleLeafSelect(leaf);
            } else {
              setScreen({ type: 'protocol', modality: screen.modality, bodyPart: bp });
            }
          }}
          onSelectCombo={handleComboRecall}
          onBack={() => setScreen({ type: 'home' })}
        />
      );

    case 'protocol': {
      const bpGroup = modalityGroup?.bodyParts.find(bp => bp.bodyPart === screen.bodyPart);
      const isSingleBp = modalityGroup && modalityGroup.bodyParts.length === 1;
      const modalityCombos = isSingleBp
        ? savedCombos.filter(c => c.modality === screen.modality)
        : undefined;
      return (
        <ProtocolScreen
          modality={screen.modality}
          bodyPart={screen.bodyPart}
          protocols={bpGroup?.protocols ?? []}
          gpci={gpciValues ?? undefined}
          savedCombos={modalityCombos}
          entries={isSingleBp ? cptDb.entries : undefined}
          favNames={favLookup.current}
          onSelectLeaf={(leaf: TreeLeaf) => handleLeafSelect(leaf)}
          onSelectCombo={isSingleBp ? handleComboRecall : undefined}
          onBack={() => {
            const group = tree.find(m => m.modality === screen.modality);
            if (group && group.bodyParts.length === 1) {
              setScreen({ type: 'home' });
            } else {
              setScreen({ type: 'bodyPart', modality: screen.modality });
            }
          }}
        />
      );
    }

    case 'leaf':
      return (
        <LeafScreen
          cpt={screen.cpt}
          entry={screen.entry}
          entries={cptDb.entries}
          gpci={gpciValues ?? undefined}
          aeTitle={screen.aeTitle}
          onStart={(bilateral, swap) => handleStart([{ cpt: screen.cpt, entry: screen.entry, bilateral }], screen.aeTitle, undefined, swap)}
          onAdd={(bilateral) => {
            handleAddExam(screen.cpt, screen.entry, bilateral);
          }}
          onAddFavorite={handleAddFavorite}
          isFavorite={favorites.some(f => f.cpt === screen.cpt)}
          onBack={() => {
            const mod = screen.entry.modality;
            const bp = screen.entry.bodyPart;
            const mg = tree.find(m => m.modality === mod);
            const bpg = mg?.bodyParts.find(b => b.bodyPart === bp);
            if (bpg && !bpg.isLeaf) {
              setScreen({ type: 'protocol', modality: mod, bodyPart: bp });
            } else if (mg && mg.bodyParts.length === 1) {
              setScreen({ type: 'home' });
            } else {
              setScreen({ type: 'bodyPart', modality: mod });
            }
          }}
          disabled={sending}
        />
      );

    case 'combo':
      return (
        <ComboBuilder
          exams={selectedExams}
          entries={cptDb.entries}
          gpci={gpciValues ?? undefined}
          aeTitle={comboAeTitle}
          comboModality={selectedExams[0]?.entry.modality}
          onRemove={handleRemoveExam}
          onAddSameModality={() => {
            const mod = selectedExams[0]?.entry.modality;
            if (!mod) return;
            const group = tree.find(m => m.modality === mod);
            if (group && group.bodyParts.length === 1) {
              setScreen({ type: 'protocol', modality: mod, bodyPart: group.bodyParts[0].bodyPart });
            } else {
              setScreen({ type: 'bodyPart', modality: mod });
            }
          }}
          onAddDifferentModality={() => setScreen({ type: 'home' })}
          onStart={(userTitle, swap) => handleStart(selectedExams, comboAeTitle, userTitle, swap)}
          disabled={sending}
        />
      );

    case 'active':
      return (
        <ActiveStudy
          examDesc={screen.examDesc}
          onSignReport={handleSignReport}
          disabled={sending}
        />
      );
  }
}
