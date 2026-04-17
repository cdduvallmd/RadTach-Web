export const MODALITY_COLORS: Record<string, string> = {
  CT: '#3b82f6',
  MR: '#8b5cf6',
  XR: '#10b981',
  US: '#f59e0b',
  FL: '#ec4899',
  NM: '#06b6d4',
  MA: '#f97316',
  'PET-CT': '#ef4444',
};

/** Returns the modality color if all entries share one modality, otherwise amber. */
export function comboColor(modality: string | undefined): string {
  return modality ? (MODALITY_COLORS[modality] || '#f59e0b') : '#f59e0b';
}
