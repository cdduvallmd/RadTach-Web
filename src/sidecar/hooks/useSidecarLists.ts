/**
 * useSidecarLists — Sidecar's favorites and saved combos.
 *
 * This device keeps a copy in localStorage, stamped with the time of the edit
 * that produced it. The settings doc holds the shared copy. Newer edit wins
 * as a whole (utils/sidecarLists):
 *   - server copy newer (or the same) → this device takes it, so a delete
 *     made anywhere reaches every device;
 *   - this device's copy newer (its write didn't land) → it is sent again,
 *     directly and through RadTach's relay.
 * A relayed copy is taken only when strictly newer; a tie is settled by the
 * server copy, read directly. (Clyde 2026-10-01e #3)
 *
 *   lists                 { favorites, sidecarCombos, sidecarEditedAt }
 *   edit(change)          apply a user edit and save it everywhere
 *   receiveRelay(cmd)     RadTach's sync_settings command
 */
import { useState, useRef, useEffect, useCallback } from 'react';
import { firestoreService } from '../../services/firestore';
import { listenToUserSettings, writeSyncSettingsResponse } from '../services/sidecarFirestore';
import { NO_LISTS, readSidecarLists } from '../../utils/sidecarLists';
import type { SidecarCommand, SidecarLists } from '../../types/sidecar';

const FAVORITES_KEY = 'sidecar_favorites';
const COMBO_KEY = 'sidecar_saved_combos';
const EDITED_KEY = 'sidecar_lists_edited_at';

function loadLocal(): SidecarLists {
  try {
    return readSidecarLists({
      favorites: JSON.parse(localStorage.getItem(FAVORITES_KEY) || '[]'),
      sidecarCombos: JSON.parse(localStorage.getItem(COMBO_KEY) || '[]'),
      sidecarEditedAt: Number(localStorage.getItem(EDITED_KEY) || 0),
    }, NO_LISTS);
  } catch {
    return NO_LISTS;
  }
}

function saveLocal(lists: SidecarLists) {
  localStorage.setItem(FAVORITES_KEY, JSON.stringify(lists.favorites));
  localStorage.setItem(COMBO_KEY, JSON.stringify(lists.sidecarCombos));
  localStorage.setItem(EDITED_KEY, String(lists.sidecarEditedAt));
}

type ListChange = Partial<Pick<SidecarLists, 'favorites' | 'sidecarCombos'>>;

export function useSidecarLists(userId: string | null, log: (msg: string) => void) {
  const [lists, setLists] = useState<SidecarLists>(loadLocal);
  // The latest lists, readable from callbacks between renders.
  const current = useRef(lists);

  const apply = useCallback((next: SidecarLists) => {
    current.current = next;
    setLists(next);
    saveLocal(next);
  }, []);

  const push = useCallback((next: SidecarLists) => {
    if (!userId) return;
    firestoreService.saveSidecarLists(userId, next)
      .then(() => log('Lists → Firestore OK'))
      .catch(err => log(`Lists → Firestore FAIL: ${err.message}`));
  }, [userId, log]);

  // Take the other copy unless this device holds the newer edit; returns
  // true when it does.
  const localIsNewer = useCallback((other: SidecarLists): boolean => {
    if (current.current.sidecarEditedAt > other.sidecarEditedAt) return true;
    apply(other);
    return false;
  }, [apply]);

  useEffect(() => {
    if (!userId) return;
    return listenToUserSettings(userId, settings => {
      if (!settings) return;
      if (localIsNewer(readSidecarLists(settings, current.current))) {
        log('Local edit is newer than Firestore — sending it');
        push(current.current);
      }
    });
  }, [userId, localIsNewer, push, log]);

  const edit = useCallback((change: (lists: SidecarLists) => ListChange) => {
    const prev = current.current;
    // Strictly later than the edit it replaces, even if the clock stepped back.
    const next = { ...prev, ...change(prev), sidecarEditedAt: Math.max(Date.now(), prev.sidecarEditedAt + 1) };
    apply(next);
    push(next);
  }, [apply, push]);

  const receiveRelay = useCallback((cmd: SidecarCommand) => {
    if (!userId) return;
    const relayed = readSidecarLists(cmd as unknown as Record<string, unknown>, current.current);
    const localAt = current.current.sidecarEditedAt;
    if (relayed.sidecarEditedAt > localAt) {
      apply(relayed);
      log('Relay: took newer lists from RadTach');
    } else if (localAt > relayed.sidecarEditedAt) {
      log('Relay: local edit is newer — answering RadTach');
      writeSyncSettingsResponse(userId, current.current)
        .then(() => log('Response write OK'))
        .catch(err => log(`Response write FAIL: ${err.message}`));
    } else {
      log('Relay: up to date');
    }
  }, [userId, apply, log]);

  return { lists, edit, receiveRelay };
}
