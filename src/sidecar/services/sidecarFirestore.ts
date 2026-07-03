import { db } from '../../services/firebase';
import {
  doc,
  setDoc,
  onSnapshot,
  serverTimestamp,
} from 'firebase/firestore';
import type { SidecarCommand } from '../../types/sidecar';

export function listenToSessionStatus(
  uid: string,
  callback: (active: boolean) => void,
  onError?: (err: Error) => void,
): () => void {
  const docRef = doc(db, 'users', uid, 'status', 'current');
  return onSnapshot(docRef, (snap) => {
    if (snap.exists()) {
      callback(snap.data().sessionActive === true);
    } else {
      callback(false);
    }
  }, (err) => {
    console.error('Session status listener error:', err);
    onError?.(err);
  });
}

export function listenToCommandDoc(
  uid: string,
  callback: (cmd: SidecarCommand | null) => void,
  onError?: (err: Error) => void,
): () => void {
  const docRef = doc(db, 'users', uid, 'commands', 'current');
  return onSnapshot(docRef, (snap) => {
    callback(snap.exists() ? (snap.data() as SidecarCommand) : null);
  }, (err) => {
    console.error('Command doc listener error:', err);
    onError?.(err);
  });
}

export function listenToUserSettings(
  uid: string,
  callback: (settings: Record<string, any> | null) => void,
  onError?: (err: Error) => void,
): () => void {
  const docRef = doc(db, 'users', uid, 'settings', 'current');
  return onSnapshot(docRef, (snap) => {
    callback(snap.exists() ? (snap.data() as Record<string, any>) : null);
  }, (err) => {
    console.error('User settings listener error:', err);
    onError?.(err);
  });
}

export async function writeSyncSettingsResponse(
  uid: string,
  favorites: Array<{ cpt: string; aeTitle: string }>,
  sidecarCombos: Array<{ cpts: string[]; bilateralFlags: boolean[]; modality: string; aeTitle?: string }>,
): Promise<void> {
  const docRef = doc(db, 'users', uid, 'commands', 'current');
  await setDoc(docRef, {
    action: 'sync_settings_response' as const,
    source: 'sidecar' as const,
    favorites,
    sidecarCombos,
    timestamp: serverTimestamp(),
  });
}

export async function writeStartCommand(
  uid: string,
  cpts: string[],
  modality: string,
  examDesc: string,
  bilateralFlags: boolean[],
  swap: boolean = false,
): Promise<void> {
  const docRef = doc(db, 'users', uid, 'commands', 'current');
  const anyBilateral = bilateralFlags.some(b => b);
  await setDoc(docRef, {
    action: 'start' as const,
    cpts,
    modality,
    examDesc,
    bilateral: anyBilateral,         // backward-compat: true if any exam is bilateral
    bilateralFlags,                  // per-CPT flags (parallel to cpts[])
    source: 'sidecar' as const,
    timestamp: serverTimestamp(),
    // Idempotency key: RadTach's onSnapshot fires each time the doc updates
    // (including on WebSocket reconnect). Without a per-write nonce, a resend
    // would re-arm the swap on the following completeStudy. RadTach's command
    // handler dedupes over a rolling window.
    idempotencyKey: crypto.randomUUID(),
    // Swap subsystem (excisable — see src/hooks/useSwapSubsystem.ts). Only set
    // when the rad pressed START + SWAP instead of START.
    ...(swap ? { swap: true } : {}),
  });
}

export async function writeStopCommand(uid: string): Promise<void> {
  const docRef = doc(db, 'users', uid, 'commands', 'current');
  await setDoc(docRef, {
    action: 'stop' as const,
    source: 'sidecar' as const,
    timestamp: serverTimestamp(),
  });
}
