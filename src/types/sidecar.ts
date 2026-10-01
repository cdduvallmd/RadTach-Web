import type { Timestamp } from 'firebase/firestore';

export type CommandAction = 'start' | 'stop' | 'completed' | 'session_ended' | 'sync_settings' | 'sync_settings_response';
export type CommandSource = 'sidecar' | 'radtach' | 'hl7';
export type RvuSource = 'sidecar' | 'hl7' | 'default';

export interface SyncFavorite { cpt: string; aeTitle: string; }
export interface SyncCombo { cpts: string[]; bilateralFlags: boolean[]; modality: string; aeTitle?: string; }

// Sidecar's favorites and combos, as stored on users/{uid}/settings/current
// and carried by the relay. sidecarEditedAt is the client time (ms) of the
// edit that produced these lists; the newer edit wins as a whole, so a delete
// sticks. 0 = never stamped (written before 2026-10-01).
export interface SidecarLists {
  favorites: SyncFavorite[];
  sidecarCombos: SyncCombo[];
  sidecarEditedAt: number;
}

export interface SidecarCommand {
  action: CommandAction;
  cpts?: string[];           // CPT code(s) — RadTach looks up RVU
  modality?: string;         // CT, MR, XR, etc.
  examDesc?: string;         // human-readable exam name (display only)
  bilateral?: boolean;       // single-exam: auto-light Bilateral button
  bilateralFlags?: boolean[]; // per-CPT bilateral flags (parallel to cpts[])
  favorites?: SyncFavorite[];     // sync_settings / sync_settings_response
  sidecarCombos?: SyncCombo[];    // sync_settings / sync_settings_response
  sidecarEditedAt?: number;       // sync_settings / sync_settings_response (see SidecarLists)
  timestamp: Timestamp;
  source: CommandSource;
  ack?: boolean;             // receiver sets true after processing
  swap?: boolean;            // start action only — arm swap correction for the next completeStudy (see src/hooks/useSwapSubsystem.ts)
  idempotencyKey?: string;   // start action: UUID nonce so onSnapshot re-fire on WebSocket reconnect doesn't re-arm swap on the next completeStudy
}
