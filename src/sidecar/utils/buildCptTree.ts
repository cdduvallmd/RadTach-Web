import type { CptEntry, ChargemasterEntry } from '../../types/cpt';

export interface TreeLeaf {
  cpt: string;
  entry: CptEntry;
  aeTitle?: string;              // Chargemaster AE Title (when chargemaster active)
  comboCpts?: string[];          // All CPTs for combo leaves (multi-CPT chargemaster entries)
  comboBilateralFlags?: boolean[];
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
// Optional protocol/bodyPart overrides control where the guest lands in the host tree.
interface GuestEntry {
  cpt: string;
  protocol?: string;    // Override protocol in host (default: entry's native protocol)
  bodyPart?: string;    // Override body part in host (default: first body part in host)
}

const MODALITY_GUESTS: Record<string, GuestEntry[]> = {
  MA: [
    { cpt: '76882', protocol: 'Ultrasound' },       // Axillary US (nonvascular extremity)
    { cpt: '76942', protocol: 'Procedures' },        // Echo guide for biopsy
    { cpt: '77080', bodyPart: 'Bone Density' },      // DXA bone density axial
    { cpt: '77081', bodyPart: 'Bone Density' },      // DXA bone density appendicular
  ],
};

// Custom protocol ordering per modality. Protocols not listed sort alphabetically after.
const PROTOCOL_ORDER: Record<string, string[]> = {
  MA: ['Mammography', 'Ultrasound', 'MRI', 'Procedures'],
};

function protoSortKey(modality: string, protocol: string): string {
  const order = PROTOCOL_ORDER[modality];
  if (order) {
    const idx = order.indexOf(protocol);
    if (idx !== -1) return String(idx).padStart(3, '0');
  }
  // Unlisted protocols sort alphabetically after ordered ones
  return `999_${protocol}`;
}

export function buildCptTree(entries: Record<string, CptEntry>, chargemaster?: ChargemasterEntry[]): ModalityGroup[] {
  // Group by modality → bodyPart → protocol
  const modalityMap = new Map<string, Map<string, Map<string, TreeLeaf[]>>>();

  if (chargemaster && chargemaster.length > 0) {
    // Build tree from chargemaster entries (institution-specific AE Titles)
    // Facility-only entries (no professional component) are stored for reports
    // but excluded from the navigation tree — radiologists don't interact with them
    for (const cm of chargemaster) {
      if (cm.facilityOnly) continue;

      const primaryEntry = entries[cm.cpts[0]];
      if (!primaryEntry) {
        console.warn(`Chargemaster: unknown CPT ${cm.cpts[0]} in "${cm.aeTitle}", skipping`);
        continue;
      }

      const mod = cm.modality || primaryEntry.modality || 'OTHER';
      const bp = cm.bodyPart || primaryEntry.bodyPart || 'Other';
      const proto = cm.protocol || primaryEntry.protocol || primaryEntry.description;

      const leaf: TreeLeaf = {
        cpt: cm.cpts[0],
        entry: primaryEntry,
        aeTitle: cm.aeTitle,
        ...(cm.cpts.length > 1 ? {
          comboCpts: cm.cpts,
          comboBilateralFlags: cm.bilateralFlags,
        } : {}),
      };

      if (!modalityMap.has(mod)) modalityMap.set(mod, new Map());
      const bpMap = modalityMap.get(mod)!;
      if (!bpMap.has(bp)) bpMap.set(bp, new Map());
      const protoMap = bpMap.get(bp)!;
      if (!protoMap.has(proto)) protoMap.set(proto, []);
      protoMap.get(proto)!.push(leaf);
    }
  } else {
    // Build tree from full CPT database (no chargemaster)
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

    // Inject guest codes into host modalities (only for raw CPT tree)
    for (const [hostMod, guests] of Object.entries(MODALITY_GUESTS)) {
      if (!modalityMap.has(hostMod)) continue;
      const bpMap = modalityMap.get(hostMod)!;
      for (const guest of guests) {
        const entry = entries[guest.cpt];
        if (!entry) continue;
        const proto = guest.protocol || entry.protocol || entry.description;
        const bp = guest.bodyPart || bpMap.keys().next().value!;
        if (!bpMap.has(bp)) bpMap.set(bp, new Map());
        const protoMap = bpMap.get(bp)!;
        if (!protoMap.has(proto)) protoMap.set(proto, []);
        protoMap.get(proto)!.push({ cpt: guest.cpt, entry });
      }
    }
  }

  // Build tree with branch collapsing
  const result: ModalityGroup[] = [];

  for (const [mod, bpMap] of modalityMap) {
    const bodyParts: BodyPartGroup[] = [];

    for (const [bp, protoMap] of bpMap) {
      const protocols: ProtocolGroup[] = [];
      for (const [proto, leaves] of protoMap) {
        // Sort leaves by AE Title (if chargemaster) or description
        leaves.sort((a, b) => (a.aeTitle ?? a.entry.description).localeCompare(b.aeTitle ?? b.entry.description));
        protocols.push({ protocol: proto, leaves });
      }
      protocols.sort((a, b) => protoSortKey(mod, a.protocol).localeCompare(protoSortKey(mod, b.protocol)));

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
