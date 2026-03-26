import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { firestoreService } from '../services/firestore';
import { listenToCommandDoc, writeStartCommand, writeStopCommand } from './services/sidecarFirestore';
import { buildCptTree, type ModalityGroup, type TreeLeaf } from './utils/buildCptTree';
import { searchCpts, type SearchResult } from './utils/cptSearch';
import type { CptDatabase, CptEntry } from '../types/cpt';
import type { GpciValues } from '../utils/gpciLookup';
import type { GooseMessage } from './services/gooseWebSocket';
import HomeScreen from './components/HomeScreen';
import BodyPartScreen from './components/BodyPartScreen';
import ProtocolScreen from './components/ProtocolScreen';
import LeafScreen from './components/LeafScreen';
import ComboBuilder from './components/ComboBuilder';
import ActiveStudy from './components/ActiveStudy';
import CptListScreen from './components/CptListScreen';

type Screen =
  | { type: 'home' }
  | { type: 'common' }
  | { type: 'recent' }
  | { type: 'bodyPart'; modality: string }
  | { type: 'protocol'; modality: string; bodyPart: string }
  | { type: 'leaf'; entry: CptEntry; cpt: string }
  | { type: 'combo' }
  | { type: 'active'; examDesc: string };

export interface SelectedExam {
  cpt: string;
  entry: CptEntry;
  bilateral: boolean;
}

export interface RecentEntry {
  cpts: string[];
  bilateralFlags: boolean[];
}

export interface SavedCombo {
  cpts: string[];
  bilateralFlags: boolean[];
  modality: string;
}

interface Props {
  gooseConnected: boolean;
  testMode?: boolean;
}

const COMMON_CPTS = ['70450', '74177', '71046', '70553'];
const RECENT_KEY = 'sidecar_recent';
const MAX_RECENT = 5;
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

export default function SidecarMain({ gooseConnected, testMode = false }: Props) {
  const { currentUser } = useAuth();
  const [screen, setScreen] = useState<Screen>({ type: 'home' });
  const [cptDb, setCptDb] = useState<CptDatabase | null>(null);
  const [tree, setTree] = useState<ModalityGroup[]>([]);
  const [selectedExams, setSelectedExams] = useState<SelectedExam[]>([]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [recentEntries, setRecentEntries] = useState<RecentEntry[]>(loadRecent);
  const [savedCombos, setSavedCombos] = useState<SavedCombo[]>(loadSavedCombos);
  const [gpciValues, setGpciValues] = useState<GpciValues | null>(null);

  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cptDbRef = useRef(cptDb);
  cptDbRef.current = cptDb;

  // Load CPT database
  useEffect(() => {
    firestoreService.getCptDatabase().then(db => {
      if (db) {
        setCptDb(db);
        setTree(buildCptTree(db.entries));
      }
      setLoading(false);
    });
  }, []);

  // Load GPCI values from user settings
  useEffect(() => {
    if (!currentUser) return;
    firestoreService.getUserSettings(currentUser.uid).then(settings => {
      if (settings?.gpciValues && typeof settings.gpciValues === 'object') {
        const g = settings.gpciValues as { work?: number; pe?: number; mp?: number; localityName?: string };
        if (typeof g.work === 'number' && typeof g.pe === 'number' && typeof g.mp === 'number') {
          setGpciValues(g as GpciValues);
        }
      }
    }).catch(console.error);
  }, [currentUser]);

  // Listen for "completed" from RadTach → auto-return to home
  useEffect(() => {
    if (!currentUser) return;
    const unsub = listenToCommandDoc(currentUser.uid, (cmd) => {
      if (cmd?.action === 'completed') {
        setScreen({ type: 'home' });
        setSelectedExams([]);
      }
    });
    return unsub;
  }, [currentUser]);

  const handleStart = useCallback(async (exams: SelectedExam[]) => {
    if (exams.length === 0 || sending) return;
    const examDesc = exams.length === 1
      ? exams[0].entry.description
      : exams.map(e => e.entry.description).join(' + ');

    // Track recent (full combo, deduplicated by sorted CPT set)
    const entry: RecentEntry = {
      cpts: exams.map(e => e.cpt),
      bilateralFlags: exams.map(e => e.bilateral),
    };
    setRecentEntries(prev => {
      const key = (e: RecentEntry) => [...e.cpts].sort().join(',');
      const entryKey = key(entry);
      const next = [entry, ...prev.filter(e => key(e) !== entryKey)].slice(0, MAX_RECENT);
      saveRecent(next);
      return next;
    });

    // Save combo for modality-level recall (never expires)
    if (exams.length > 1) {
      const combo: SavedCombo = {
        cpts: exams.map(e => e.cpt),
        bilateralFlags: exams.map(e => e.bilateral),
        modality: exams[0].entry.modality,
      };
      setSavedCombos(prev => {
        const key = (c: SavedCombo) => [...c.cpts].sort().join(',');
        const comboKey = key(combo);
        const next = [combo, ...prev.filter(c => key(c) !== comboKey)];
        saveSavedCombos(next);
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
      await writeStartCommand(currentUser.uid, cpts, modality, examDesc, bilateralFlags);
      setScreen({ type: 'active', examDesc });
      setSelectedExams([]);
    } finally {
      setSending(false);
    }
  }, [currentUser, sending, testMode]);

  const handleSignReport = useCallback(async () => {
    if (testMode) {
      setScreen({ type: 'home' });
      return;
    }
    if (!currentUser || sending) return;
    setSending(true);
    try {
      await writeStopCommand(currentUser.uid);
      setScreen({ type: 'home' });
    } finally {
      setSending(false);
    }
  }, [currentUser, sending, testMode]);

  const handleAddExam = useCallback((cpt: string, entry: CptEntry, bilateral: boolean) => {
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
        setSearchResults(searchCpts(query, cptDbRef.current.entries));
      }
    }, 300);
  }, []);

  // Search result selection → navigate to leaf
  const handleSearchSelect = useCallback((cpt: string) => {
    if (!cptDb) return;
    const entry = cptDb.entries[cpt];
    if (entry) {
      setSearchQuery('');
      setSearchResults([]);
      setScreen({ type: 'leaf', entry, cpt });
    }
  }, [cptDb]);

  // Recent entry selection — single CPT → LeafScreen, combo → ComboBuilder
  const handleRecentSelect = useCallback((entry: RecentEntry) => {
    if (!cptDb) return;
    if (entry.cpts.length === 1) {
      const e = cptDb.entries[entry.cpts[0]];
      if (e) setScreen({ type: 'leaf', entry: e, cpt: entry.cpts[0] });
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

  // Handle Goose WebSocket messages (called from SessionGate)
  const handleGooseMessage = useCallback((msg: GooseMessage) => {
    if (msg.action === 'stop') {
      handleSignReport();
    } else if (msg.action === 'search' && msg.text) {
      setScreen({ type: 'home' });
      setSearchQuery(msg.text);
      if (cptDbRef.current) {
        setSearchResults(searchCpts(msg.text, cptDbRef.current.entries));
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
                setScreen({ type: 'leaf', entry: bp.leafEntry!.entry, cpt: bp.leafEntry!.cpt });
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
          onOpenRecent={() => setScreen({ type: 'recent' })}
          onOpenCommon={() => setScreen({ type: 'common' })}
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
          onSelect={handleSearchSelect}
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
              setScreen({ type: 'leaf', entry: leaf.entry, cpt: leaf.cpt });
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
          onSelectLeaf={(leaf: TreeLeaf) => setScreen({ type: 'leaf', entry: leaf.entry, cpt: leaf.cpt })}
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
          onStart={(bilateral) => handleStart([{ cpt: screen.cpt, entry: screen.entry, bilateral }])}
          onAdd={(bilateral) => {
            handleAddExam(screen.cpt, screen.entry, bilateral);
          }}
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
          onRemove={handleRemoveExam}
          onAddMore={() => setScreen({ type: 'home' })}
          onStart={() => handleStart(selectedExams)}
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
