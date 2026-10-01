import type { SidecarLists, SyncFavorite, SyncCombo } from '../types/sidecar';

// Sidecar's favorites and combos sync by "newer edit wins as a whole": each
// copy (settings doc, relay command, a device's localStorage) carries the
// client time of the edit that produced it, and the newer copy replaces the
// older. Unlike a union merge, a delete propagates. Used by Sidecar
// (useSidecarLists) and by RadTach's relay (useSidecarRelay).

export const NO_LISTS: SidecarLists = { favorites: [], sidecarCombos: [], sidecarEditedAt: 0 };

// Read the lists from a settings doc or relay command. A missing list keeps
// `fallback`'s copy; a missing edit time reads as 0 (never stamped).
export function readSidecarLists(src: Record<string, unknown>, fallback: SidecarLists): SidecarLists {
  return {
    favorites: Array.isArray(src.favorites) ? src.favorites as SyncFavorite[] : fallback.favorites,
    sidecarCombos: Array.isArray(src.sidecarCombos) ? src.sidecarCombos as SyncCombo[] : fallback.sidecarCombos,
    sidecarEditedAt: typeof src.sidecarEditedAt === 'number' ? src.sidecarEditedAt : 0,
  };
}
