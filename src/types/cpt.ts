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
}

export interface CptDatabase {
  year: number;
  updatedAt: string;
  source: string;
  entries: Record<string, CptEntry>;
}

export interface SidecarTreeNode {
  label: string;
  children?: SidecarTreeNode[];
  cpt?: string;
  entry?: CptEntry;
}
