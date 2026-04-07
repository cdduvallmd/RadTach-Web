# SIDECAR.md

Phone-optimized CPT tree remote control for RadTach. Lazy-loaded at `radtach.web.app/sidecar` — desktop users never download it. All code in `src/sidecar/`.

---

## Architecture

### Screen Flow (State Machine)

```
HomeScreen → BodyPartScreen → ProtocolScreen → LeafScreen → ActiveStudy
                                    ↓                ↓
                                ComboBuilder ←───── ADD
                                    ↓
                                ActiveStudy
```

State machine in `SidecarMain.tsx`. Screen type union:
```typescript
type Screen =
  | { type: 'home' }
  | { type: 'common' }
  | { type: 'recent' }
  | { type: 'bodyPart'; modality: string }
  | { type: 'protocol'; modality: string; bodyPart: string }
  | { type: 'leaf'; entry: CptEntry; cpt: string; aeTitle?: string }
  | { type: 'combo' }
  | { type: 'active'; examDesc: string };
```

### Session Gating

Listens to `users/{uid}/status/current` (written by RadTach on session start/end). Three states: waiting → active → ended.

### Command Flow

Sidecar writes `start`/`stop` to `users/{uid}/commands/current`. RadTach writes `completed`/`session_ended` back. Both sides use `onSnapshot` listeners.

### Shared Code

Imports `services/firebase`, `contexts/AuthContext`, `types/cpt`, `types/sidecar`, `utils/cptLookup`, `utils/gpciLookup`. No duplication with main RadTach.

---

## Key Files

| File | Purpose |
|------|---------|
| `src/sidecar/SidecarMain.tsx` | State machine navigator, chargemaster/GPCI loading, combo handling |
| `src/sidecar/Sidecar.tsx` | Entry point: AuthProvider → login gate → SessionGate |
| `src/sidecar/utils/buildCptTree.ts` | Flat CPT DB → `ModalityGroup[] → BodyPartGroup[] → ProtocolGroup[] → TreeLeaf[]` with branch collapsing and chargemaster support |
| `src/sidecar/utils/cptSearch.ts` | Token-scored search across CPT descriptions, AE Titles, modalities, body parts |
| `src/sidecar/services/sidecarFirestore.ts` | Session status listener, command doc listener, start/stop command writes |
| `src/sidecar/components/HomeScreen.tsx` | Modality grid, search bar, recent/common buttons |
| `src/sidecar/components/BodyPartScreen.tsx` | Body part list with branch-collapsed leaf shortcuts |
| `src/sidecar/components/ProtocolScreen.tsx` | Protocol groups, leaf rows with AE Title/COMBO display |
| `src/sidecar/components/LeafScreen.tsx` | Exam confirmation: AE Title heading, bilateral toggle, START/ADD |
| `src/sidecar/components/ComboBuilder.tsx` | Multi-exam builder with per-exam RVU breakdown |
| `src/sidecar/components/ActiveStudy.tsx` | Active study display + sign report button |
| `src/sidecar/components/CptListScreen.tsx` | Shared list view for Recent and Common screens |
| `src/sidecar/components/LoginScreen.tsx` | Firebase auth login |
| `src/sidecar/components/SessionGate.tsx` | Waiting/active/ended gating, Goose WebSocket |
| `src/types/cpt.ts` | `CptEntry`, `CptDatabase`, `ChargemasterEntry` |
| `src/types/sidecar.ts` | `SidecarCommand`, `CommandAction`, `CommandSource` |
| `src/services/firestore.ts` | `getSystemChargemaster()`, `getUserSettings()` (system name + GPCI) |
| `scripts/seedChargemaster.ts` | CSV → Firestore chargemaster seeder with CMS triage report |

---

## CPT Tree

`buildCptTree.ts` transforms flat `CptDatabase.entries` (or chargemaster entries) into a navigable tree:

```
ModalityGroup[] → BodyPartGroup[] → ProtocolGroup[] → TreeLeaf[]
```

**Branch collapsing:** Single protocol + single CPT → `isLeaf = true`, skips protocol screen. Single-body-part modalities (e.g., MA → Breast) skip body part screen entirely.

**Guest codes (`MODALITY_GUESTS`):** CPTs that appear in a modality section they don't natively belong to. The entry keeps its original modality in the database — it just also shows up in the host tree. Only applies when building from the raw CPT database (no chargemaster).

### TreeLeaf Interface

```typescript
interface TreeLeaf {
  cpt: string;                     // Primary CPT (first for combos)
  entry: CptEntry;                 // Primary CPT database entry
  aeTitle?: string;                // Institution AE Title (chargemaster active)
  comboCpts?: string[];            // All CPTs for chargemaster combo leaves
  comboBilateralFlags?: boolean[];
}
```

When a chargemaster combo leaf is tapped, `handleLeafSelect` in SidecarMain loads all CPTs into `selectedExams[]` and navigates to ComboBuilder — same UX as a saved combo.

---

## GPCI Adjustment

Sidecar loads GPCI values from `users/{uid}/settings/current` (written by RadTach at session start based on the selected office's ZIP). LeafScreen, ProtocolScreen, and ComboBuilder all display GPCI-adjusted work RVUs. Falls back to raw `workRvu` when no GPCI is configured.

---

## Recent List with Combo Recall

Recent exams stored as `RecentEntry[] ({ cpts: string[], bilateralFlags: boolean[] })` in localStorage. Single exams and full combos saved on START, deduplicated by sorted CPT set. Tapping a single-CPT entry → LeafScreen. Tapping a combo entry → loads all exams into ComboBuilder. Amber left border accent + `COMBO (N)` badge. Max 5 entries.

**Saved combos** (per modality): Persisted in localStorage under `sidecar_saved_combos`. Shown in ProtocolScreen for single-body-part modalities and in BodyPartScreen. Never expire.

---

## Chargemaster & AE Title Navigation

### Motivation

Radiologists don't think in CPT codes — they think in AE Titles, the institution-specific procedure names from their PACS worklist. "CT HEAD WO CONTRAST" is instantly recognizable; "Ct head/brain w/o dye" (CMS description) is not. A per-system chargemaster maps AE Titles to CPT codes.

### Two-Tier Combos

- **System combos**: Multi-CPT chargemaster entries (admin-defined, Firestore, everyone sees them)
- **Personal combos**: User-built via combo builder (localStorage, individual preference)

### ChargemasterEntry

```typescript
interface ChargemasterEntry {
  aeTitle: string;           // "CT HEAD WO CONTRAST"
  cpts: string[];            // ["70450"] or ["71275", "74177"] for combos
  bilateralFlags: boolean[]; // parallel to cpts
  modality: string;          // derived from first CPT
  bodyPart: string;          // derived from first CPT
  protocol: string;          // derived from first CPT
  facilityOnly?: boolean;    // true = no professional component, hidden from nav
  globalRvu?: number;        // professional + technical (full billing value)
  tcRvu?: number;            // technical component only
  workRvu?: number;          // professional work component (0 for facilityOnly)
}
```

### Firestore Storage

Stored on the system document: `systems/{systemName}.chargemaster: ChargemasterEntry[]`

Why on the system doc (not a subcollection):
- Read-heavy, write-rarely (admin setup)
- All entries needed at startup to build the navigation tree
- Typically 100-300 entries × ~200 bytes ≈ 20-60KB, well within 1MB limit
- Single read gets system config + chargemaster together

### System Context

`currentSystem` is stored in `users/{userId}/settings/current` alongside GPCI values. Written by RadTach on session start (`handleConfirmSessionStart`). Read by SidecarMain to load the correct chargemaster.

### Loading Flow

```
SidecarMain startup:
  1. Load CPT database (getCptDatabase)
  2. Load user settings (getUserSettings) → extract gpciValues + currentSystem
  3. If currentSystem set → load chargemaster (getSystemChargemaster)
  4. Build tree: buildCptTree(cptDb.entries, chargemaster ?? undefined)
```

Tree rebuilds when either `cptDb` or `chargemaster` changes.

### Navigation with Chargemaster

When chargemaster is active:
- **ProtocolScreen leaf labels**: AE Title replaces CMS description. Combo leaves show `COMBO (N)` badge.
- **LeafScreen heading**: AE Title as primary (large), CMS description as secondary (small gray).
- **ComboBuilder header**: AE Title for system combos, "Combo Builder" for personal combos.
- **HomeScreen search**: Matches AE Titles (score +3) alongside CPT codes and descriptions.
- **ActiveStudy examDesc**: Uses AE Title when available.

### Graceful Fallback

| Scenario | Behavior |
|----------|----------|
| System has chargemaster | Tree from chargemaster, AE Title labels |
| System has no chargemaster | Tree from full CPT database, CMS description labels |
| User has no system set | Same as no chargemaster |
| Chargemaster entry references unknown CPT | Entry skipped with console warning |
| Chargemaster entry is `facilityOnly` | Skipped in tree and search, retained for reports |

---

## Facility-Only Codes & Global RVU Tracking

### Rationale

Facility-only CPT codes (work RVU = 0) have no professional component — radiologists don't earn RVU credit for them. But they represent real hospital billing. Retaining them enables global RVU impact analysis:

- **Individual performance**: work RVU (what the radiologist generates)
- **Group/system performance**: global RVU (professional + technical — what the hospital bills)
- **Outage impact**: "Your system generates X global RVU/hour. A 4-hour outage defers $Y in billing." Hospital cannot bill technical component without a completed report. Knowing both sides of the billing system (professional and technical) documents the total cash flow impact of downtime.

### Data Model

Every `ChargemasterEntry` carries `globalRvu`, `tcRvu`, and `workRvu` (summed across all CPTs in the entry). Facility-only entries have `facilityOnly: true` and `workRvu: 0`.

### Visibility Rules

- **Sidecar navigation** (`buildCptTree`): Skips `facilityOnly` entries
- **Sidecar search** (`cptSearch`): Skips `facilityOnly` entries
- **Admin/President reports** (future): Includes all entries for global RVU aggregation

---

## CSV Import & Chargemaster Seeding

### CSV Format

```csv
AE Title, CPT1, CPT2, CPT3
CT HEAD WO CONTRAST, 70450
CTA CHEST W CT ABD PEL W, 71275, 74177
SCREENING MAMMO BILATERAL W TOMO, 77067, 77061
```

Column A: AE Title (required). Columns B+: CPT codes (at least one required).

### Seed Script

`scripts/seedChargemaster.ts` — modeled on `seedCptAdmin.ts` (Firebase REST API with CLI refresh token).

```bash
# Basic import
npx tsx scripts/seedChargemaster.ts --csv data/chargemaster.csv --system "Mercy"

# With CMS RVU triage (identifies candidates and facility-only codes)
npx tsx scripts/seedChargemaster.ts --csv data/chargemaster.csv --system "Mercy" --rvu /tmp/PPRRVU2026_Jan_nonQPP.csv

# Dry run with report file
npx tsx scripts/seedChargemaster.ts --csv data/chargemaster.csv --system "Mercy" --rvu /tmp/PPRRVU2026_Jan_nonQPP.csv --report triage.txt --dry-run
```

**Flags:**
- `--csv <path>` — chargemaster CSV file (required)
- `--system <name>` — Firestore system name (required)
- `--rvu <path>` — CMS PPRRVU CSV for triage (auto-checks `/tmp/` if omitted)
- `--report <path>` — write triage report to file
- `--dry-run` — parse and report only, skip Firestore write

**Shared PACS = shared chargemaster:** Same CSV can be imported into multiple systems by running with different `--system` flags.

### Import Triage

When the CMS RVU file is available, unknown CPTs are triaged into buckets:

| Bucket | Condition | Action |
|--------|-----------|--------|
| **PROFESSIONAL** | All CPTs in our database | Written with RVU fields, visible in Sidecar |
| **FACILITY-ONLY** | All CPTs have 0 work RVU in CMS | Written with `facilityOnly: true`, hidden from nav, used in reports |
| **MIXED** | Known + facility-only CPTs | Written — professional CPTs drive nav, facility CPTs contribute to global RVU |
| **CANDIDATE** | Has work RVU in CMS but not in our DB | Reported but NOT written — add to `cpt-rvu-2026.json` first |
| **UNKNOWN** | Not in CMS RVU file | Reported — may be non-radiology, custom, or HCPCS Level II |

The triage report includes per-entry `wRVU` and `gRVU` columns, plus summary totals across the entire chargemaster.

### Adding Candidate CPTs

When the triage report identifies candidates (professional codes we don't carry), add them to `data/cpt-rvu-2026.json` with the appropriate fields, then re-run the seed script. The candidate entries will move from the "CANDIDATE" bucket to "PROFESSIONAL".

### Seeding CPT Database to Production

`scripts/seedCptDatabase.ts` writes `data/cpt-rvu-2026.json` to Firestore `Config/cptDatabase`.

```bash
npm run seed:cpt                # local emulator (localhost:8080)
npm run seed:cpt -- --prod      # production Firestore
```

**Production auth:** The `--prod` path uses the Firestore REST API with a Google OAuth access token derived from the Firebase CLI's refresh token (`~/.config/configstore/firebase-tools.json`). This bypasses Firestore security rules — no user sign-in needed, just `firebase login` on the machine. The script reads the refresh token, exchanges it for an access token via `https://oauth2.googleapis.com/token`, and PATCHes the document directly.

**Prerequisite:** `firebase login` (already done if you've ever run `firebase deploy`).

**Why not Admin SDK:** The Admin SDK's Firestore client requires either a service account key or Application Default Credentials (gcloud CLI). We have neither — Firebase CLI login doesn't set ADC. The REST API with the CLI's refresh token is the simplest path that works.

**Why not client SDK with sign-in:** The user authenticates via Google OAuth (Sign in with Google), not email/password. `signInWithEmailAndPassword` doesn't work for Google accounts, and the OAuth popup flow isn't available in a Node.js script.

### Firestore Write Strategy

Uses `PATCH` with `updateMask.fieldPaths=chargemaster` — only touches the chargemaster field, preserving offices, rotations, roles, and all other system config.

---

## Search

`cptSearch.ts` token-based scoring:

| Match type | Score | Notes |
|------------|-------|-------|
| CPT code exact | +10 | Any CPT in a chargemaster combo entry |
| AE Title contains token | +3 | Only when chargemaster active |
| Modality exact | +3 | |
| Body part contains token | +2 | |
| Description contains token | +1 | CMS description fallback |

When chargemaster is active, chargemaster entries are searched first (with AE Title boost), then CPTs not in the chargemaster are searched as fallback. Facility-only entries are excluded from search.

Search results carry `aeTitle`, `comboCpts`, and `comboBilateralFlags` so HomeScreen can display combo badges and SidecarMain can route combo results directly to ComboBuilder.

---

## Future: Admin Chargemaster UI (Phase 3)

A web page at `/admin/chargemaster` for visual chargemaster management:
- CSV upload with preview table and validation
- Add/edit/delete individual entries
- Combo builder: search CPTs, assemble multi-CPT entries, assign AE Title
- System selector (for multi-system admins)
- Export to CSV

Deferred — the seed script handles initial setup, and chargemaster changes are infrequent.

---

## Goose WebSocket Integration

Sidecar accepts voice commands from Goose (the voice assistant) via WebSocket. `SessionGate` manages the connection; messages are dispatched to `SidecarMain` via `window.__gooseHandler`.

Supported actions:
- `stop` → triggers sign report
- `search` → populates search bar with spoken text, shows results
