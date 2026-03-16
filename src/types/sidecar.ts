import type { Timestamp } from 'firebase/firestore';

export type CommandAction = 'start' | 'stop' | 'completed' | 'session_ended';
export type CommandSource = 'sidecar' | 'radtach' | 'hl7';
export type RvuSource = 'sidecar' | 'hl7' | 'default';

export interface SidecarCommand {
  action: CommandAction;
  cpts?: string[];           // CPT code(s) — RadTach looks up RVU
  modality?: string;         // CT, MR, XR, etc.
  examDesc?: string;         // human-readable exam name (display only)
  bilateral?: boolean;       // single-exam: auto-light Bilateral button
  bilateralFlags?: boolean[]; // per-CPT bilateral flags (parallel to cpts[])
  timestamp: Timestamp;
  source: CommandSource;
  ack?: boolean;             // receiver sets true after processing
}
