import type { Timestamp } from 'firebase/firestore';

export type CommandAction = 'start' | 'stop' | 'completed';
export type CommandSource = 'sidecar' | 'radtach' | 'hl7';
export type RvuSource = 'sidecar' | 'hl7' | 'default';

export interface SidecarCommand {
  action: CommandAction;
  cpts?: string[];           // CPT code(s) — RadTach looks up RVU
  modality?: string;         // CT, MR, XR, etc.
  examDesc?: string;         // human-readable exam name (display only)
  bilateral?: boolean;       // auto-light + disable Bilateral button
  timestamp: Timestamp;
  source: CommandSource;
  ack?: boolean;             // receiver sets true after processing
}
