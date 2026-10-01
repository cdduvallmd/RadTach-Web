/**
 * useSidecarRelay — RadTach's half of the Sidecar favorites/combos sync.
 *
 * Sidecar owns its favorites and combos and writes them to the settings doc
 * itself. A device's direct write can fail on some hospital networks, so
 * RadTach also relays through the command doc:
 *   sendToSidecar()        at session start: the lists as last seen on the server
 *                          (this write also clears the previous session's commands).
 *   receiveFromSidecar()   Sidecar's answer when it holds a newer edit; saved
 *                          to the server if it is still the newer one.
 * Newer edit wins as a whole (utils/sidecarLists), so deletions propagate.
 * An answer without an edit time (a Sidecar tab still running pre-2026-10-01
 * code) is never newer, so an old cache can't bring deleted items back.
 * Until the server copy has been read, the relay does nothing: it would send
 * empty lists, or accept a leftover answer as newer. (Clyde 2026-10-01e #3)
 */
import { useRef, useEffect, useCallback } from 'react';
import { firestoreService } from '../services/firestore';
import { NO_LISTS, readSidecarLists } from '../utils/sidecarLists';
import type { SidecarCommand, SidecarLists } from '../types/sidecar';

export function useSidecarRelay(userId: string | null) {
  // The lists as last read from the server; null until the first read.
  const latest = useRef<SidecarLists | null>(null);

  useEffect(() => {
    latest.current = null;
    if (!userId) return;
    return firestoreService.listenToUserSettings(userId, settings => {
      // Only a stamped copy counts as read: RadTach's own Start write can
      // produce a list-less local snapshot first. (Clyde 2026-10-01f #2)
      if (settings && typeof settings.sidecarEditedAt === 'number') latest.current = readSidecarLists(settings, latest.current ?? NO_LISTS);
    });
  }, [userId]);

  // Also overwrites the previous session's commands (e.g. a stale
  // session_ended), so it always writes: without a server read yet, it
  // clears the doc and sends no lists.
  const sendToSidecar = useCallback(() => {
    if (!userId) return;
    const write = latest.current
      ? firestoreService.writeSyncSettings(userId, latest.current)
      : firestoreService.clearCommandDoc(userId);
    write.catch(console.error);
  }, [userId]);

  const receiveFromSidecar = useCallback((cmd: SidecarCommand) => {
    if (!userId || !latest.current) return;
    const incoming = readSidecarLists(cmd as unknown as Record<string, unknown>, latest.current);
    if (incoming.sidecarEditedAt <= latest.current.sidecarEditedAt) return;
    latest.current = incoming;
    firestoreService.saveSidecarLists(userId, incoming).catch(console.error);
  }, [userId]);

  return { sendToSidecar, receiveFromSidecar };
}
