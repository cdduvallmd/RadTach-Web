export interface CptEntry {
  cpt: string;
  description: string;
  pcRvu: number;
  defaultAeTitle: string;
  modality: string;
  bodyPart: string;
  protocol: string;
  tcRvu: number;
  globalRvu: number;
  bilateralEligible?: boolean;
  variant?: string;
  impliedComplications?: string[];
  workRvu?: number;
  facPeRvu?: number;
  mpRvu?: number;
}

export interface CptDatabase {
  year: number;
  updatedAt: string;
  source: string;
  entries: Record<string, CptEntry>;
}

export interface ChargemasterEntry {
  aeTitle: string;
  cpts: string[];
  bilateralFlags: boolean[];
  modality: string;
  bodyPart: string;
  protocol: string;
  facilityOnly?: boolean;  // true = no professional component, hidden from Sidecar nav
  globalRvu?: number;      // sum of global RVUs for all CPTs (professional + technical)
  tcRvu?: number;          // sum of technical component RVUs for all CPTs
  workRvu?: number;        // sum of work RVUs for all CPTs (= 0 for facilityOnly)
}

export interface SidecarTreeNode {
  label: string;
  children?: SidecarTreeNode[];
  cpt?: string;
  entry?: CptEntry;
}
