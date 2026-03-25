import type { CptEntry } from '../../types/cpt';

export interface TreeLeaf {
  cpt: string;
  entry: CptEntry;
}

export interface ProtocolGroup {
  protocol: string;
  leaves: TreeLeaf[];
}

export interface BodyPartGroup {
  bodyPart: string;
  protocols: ProtocolGroup[];
  isLeaf: boolean;       // true = single protocol + single CPT → skip protocol screen
  leafEntry?: TreeLeaf;  // set when isLeaf
}

export interface ModalityGroup {
  modality: string;
  bodyParts: BodyPartGroup[];
}

const MODALITY_ORDER = ['CT', 'MR', 'XR', 'US', 'FL', 'NM', 'MA', 'PET-CT'];

// Guest codes: CPTs that appear in a modality section they don't natively belong to.
// The entry keeps its original modality in the database — it just also shows up here.
const MODALITY_GUESTS: Record<string, string[]> = {
  MA: ['76882'],  // Axillary US (nonvascular extremity) — commonly paired with mammography
};

export function buildCptTree(entries: Record<string, CptEntry>): ModalityGroup[] {
  // Group by modality → bodyPart → protocol
  const modalityMap = new Map<string, Map<string, Map<string, TreeLeaf[]>>>();

  for (const [cpt, entry] of Object.entries(entries)) {
    const mod = entry.modality || 'OTHER';
    const bp = entry.bodyPart || 'Other';
    const proto = entry.protocol || entry.description;

    if (!modalityMap.has(mod)) modalityMap.set(mod, new Map());
    const bpMap = modalityMap.get(mod)!;
    if (!bpMap.has(bp)) bpMap.set(bp, new Map());
    const protoMap = bpMap.get(bp)!;
    if (!protoMap.has(proto)) protoMap.set(proto, []);
    protoMap.get(proto)!.push({ cpt, entry });
  }

  // Inject guest codes into host modalities
  for (const [hostMod, guestCpts] of Object.entries(MODALITY_GUESTS)) {
    if (!modalityMap.has(hostMod)) continue;
    const bpMap = modalityMap.get(hostMod)!;
    for (const cpt of guestCpts) {
      const entry = entries[cpt];
      if (!entry) continue;
      const proto = entry.protocol || entry.description;
      // Add to the first (or only) body part in the host modality
      const firstBp = bpMap.keys().next().value!;
      const protoMap = bpMap.get(firstBp)!;
      if (!protoMap.has(proto)) protoMap.set(proto, []);
      protoMap.get(proto)!.push({ cpt, entry });
    }
  }

  // Build tree with branch collapsing
  const result: ModalityGroup[] = [];

  for (const [mod, bpMap] of modalityMap) {
    const bodyParts: BodyPartGroup[] = [];

    for (const [bp, protoMap] of bpMap) {
      const protocols: ProtocolGroup[] = [];
      for (const [proto, leaves] of protoMap) {
        // Sort leaves by description
        leaves.sort((a, b) => a.entry.description.localeCompare(b.entry.description));
        protocols.push({ protocol: proto, leaves });
      }
      protocols.sort((a, b) => a.protocol.localeCompare(b.protocol));

      // Branch collapsing: single protocol with single CPT → leaf
      const totalLeaves = protocols.reduce((sum, p) => sum + p.leaves.length, 0);
      const isLeaf = protocols.length === 1 && totalLeaves === 1;

      bodyParts.push({
        bodyPart: bp,
        protocols,
        isLeaf,
        leafEntry: isLeaf ? protocols[0].leaves[0] : undefined,
      });
    }
    bodyParts.sort((a, b) => a.bodyPart.localeCompare(b.bodyPart));

    result.push({ modality: mod, bodyParts });
  }

  // Sort by preferred modality order, then alphabetically for unlisted
  result.sort((a, b) => {
    const ia = MODALITY_ORDER.indexOf(a.modality);
    const ib = MODALITY_ORDER.indexOf(b.modality);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a.modality.localeCompare(b.modality);
  });

  return result;
}
