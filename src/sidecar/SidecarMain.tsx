import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { firestoreService } from '../services/firestore';
import { listenToCommandDoc, writeStartCommand, writeStopCommand } from './services/sidecarFirestore';
import { buildCptTree, type ModalityGroup, type TreeLeaf } from './utils/buildCptTree';
import { searchCpts, type SearchResult } from './utils/cptSearch';
import type { CptDatabase, CptEntry } from '../types/cpt';
import type { GooseMessage } from './services/gooseWebSocket';
import HomeScreen from './components/HomeScreen';
import BodyPartScreen from './components/BodyPartScreen';
import ProtocolScreen from './components/ProtocolScreen';
import LeafScreen from './components/LeafScreen';
import ComboBuilder from './components/ComboBuilder';
import ActiveStudy from './components/ActiveStudy';

type Screen =
  | { type: 'home' }
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

interface Props {
  gooseConnected: boolean;
  testMode?: boolean;
}

export default function SidecarMain({ gooseConnected, testMode = false }: Props) {
  const { currentUser } = useAuth();
  const [screen, setScreen] = useState<Screen>({ type: 'home' });
  const [cptDb, setCptDb] = useState<CptDatabase | null>(null);
  const [tree, setTree] = useState<ModalityGroup[]>([]);
  const [selectedExams, setSelectedExams] = useState<SelectedExam[]>([]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);

  // Search state
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep cptDb accessible to Goose handler via ref
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
    if (testMode) {
      // Skip Firestore write — just navigate
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
      // Skip Firestore write — just navigate
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

  // Handle Goose WebSocket messages (called from SessionGate)
  const handleGooseMessage = useCallback((msg: GooseMessage) => {
    if (msg.action === 'stop') {
      handleSignReport();
    } else if (msg.action === 'search' && msg.text) {
      // Navigate to home if not already there
      setScreen({ type: 'home' });
      // Populate search box — skip debounce, search immediately
      setSearchQuery(msg.text);
      if (cptDbRef.current) {
        setSearchResults(searchCpts(msg.text, cptDbRef.current.entries));
      }
    }
  }, [handleSignReport]);

  // Expose handler to SessionGate via ref
  const gooseHandlerRef = useRef(handleGooseMessage);
  gooseHandlerRef.current = handleGooseMessage;

  // Register the handler on the window so SessionGate can call it
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
          onSelectModality={mod => setScreen({ type: 'bodyPart', modality: mod })}
          onSignReport={handleSignReport}
          comboCount={selectedExams.length}
          onOpenCombo={() => setScreen({ type: 'combo' })}
          searchQuery={searchQuery}
          onSearchChange={handleSearchChange}
          searchResults={searchResults}
          onSearchSelect={handleSearchSelect}
          gooseConnected={gooseConnected}
        />
      );

    case 'bodyPart':
      return (
        <BodyPartScreen
          modality={screen.modality}
          group={modalityGroup!}
          onSelectBodyPart={(bp, leaf) => {
            if (leaf) {
              setScreen({ type: 'leaf', entry: leaf.entry, cpt: leaf.cpt });
            } else {
              setScreen({ type: 'protocol', modality: screen.modality, bodyPart: bp });
            }
          }}
          onBack={() => setScreen({ type: 'home' })}
          onSignReport={handleSignReport}
        />
      );

    case 'protocol': {
      const bpGroup = modalityGroup?.bodyParts.find(bp => bp.bodyPart === screen.bodyPart);
      return (
        <ProtocolScreen
          modality={screen.modality}
          bodyPart={screen.bodyPart}
          protocols={bpGroup?.protocols ?? []}
          onSelectLeaf={(leaf: TreeLeaf) => setScreen({ type: 'leaf', entry: leaf.entry, cpt: leaf.cpt })}
          onBack={() => setScreen({ type: 'bodyPart', modality: screen.modality })}
          onSignReport={handleSignReport}
        />
      );
    }

    case 'leaf':
      return (
        <LeafScreen
          cpt={screen.cpt}
          entry={screen.entry}
          entries={cptDb.entries}
          onStart={(bilateral) => handleStart([{ cpt: screen.cpt, entry: screen.entry, bilateral }])}
          onAdd={(bilateral) => {
            handleAddExam(screen.cpt, screen.entry, bilateral);
          }}
          onBack={() => {
            const mod = screen.entry.modality;
            const bp = screen.entry.bodyPart;
            // Check if this body part has multiple protocols
            const mg = tree.find(m => m.modality === mod);
            const bpg = mg?.bodyParts.find(b => b.bodyPart === bp);
            if (bpg && !bpg.isLeaf) {
              setScreen({ type: 'protocol', modality: mod, bodyPart: bp });
            } else {
              setScreen({ type: 'bodyPart', modality: mod });
            }
          }}
          onSignReport={handleSignReport}
          disabled={sending}
        />
      );

    case 'combo':
      return (
        <ComboBuilder
          exams={selectedExams}
          entries={cptDb.entries}
          onRemove={handleRemoveExam}
          onAddMore={() => setScreen({ type: 'home' })}
          onStart={() => handleStart(selectedExams)}
          onSignReport={handleSignReport}
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
