# Health Connect HL7 Integration Spec — RadTach

## Purpose

RadTach needs to know when a radiologist **opens** and **completes** a radiology study, along with the study's modality and CPT code(s). This enables automatic timer control (no manual Sidecar interaction) and accurate RVU tracking.

## What We Need (Minimal Data Set)

| Field | HL7 Segment.Field | Purpose | PHI? |
|-------|-------------------|---------|------|
| Event type | MSH-9 (Message Type) | Distinguish open vs. complete | No |
| Modality | OBR-24 (Diagnostic Service ID) or ZDS segment | Route to correct timer category | No |
| Procedure code (CPT) | OBR-4 (Universal Service ID) | RVU lookup | No |
| Procedure description | OBR-4.2 (Text) | Display name | No |
| Accession number | OBR-18 | Correlate open/complete for same study | No* |
| Timestamp | MSH-7 or OBR-7 | Event timing | No |
| Workstation / Reading location | OBR-20 (Filler Field 1) or custom field | Route to correct RadTach instance | No |
| Radiologist ID | OBR-32 (Principal Result Interpreter) or ORC-12 | Route to correct user | Yes** |

*Accession number is a study identifier, not a patient identifier. No patient name, MRN, DOB, or demographics are requested.

**Radiologist ID is needed for routing only (which RadTach instance receives the message). Can be a system username or employee ID — does not need to be a name.

## What We Do NOT Need

- Patient name (PID-5)
- MRN (PID-3)
- Date of birth (PID-7)
- Address, phone, SSN, insurance
- Clinical history / reason for exam (OBR-13)
- Report text
- Images or image references

## Routing: How to Handle Multiple Workstations

**The Problem:** 12 radiologists reading simultaneously. Each gets their own study open/complete events.

**Recommended Solution:** Route by radiologist identifier.

Health Connect routing rule filters on the **reading radiologist field** (OBR-32 or equivalent) and sends each message to the corresponding RadTach instance. Options:

### Option A: Single Endpoint + RadTach Routes Internally (Simplest)

1. Health Connect sends ALL radiology events to one local endpoint (e.g., `http://localhost:8765/hl7`)
2. Each message includes the radiologist's system ID (e.g., `DUVALL_C`)
3. RadTach's HL7 receiver looks up the radiologist ID → Firestore UID mapping
4. Writes the event to that user's Firestore command doc (same path Sidecar uses: `users/{uid}/commands/current`)
5. RadTach on each workstation receives via existing `onSnapshot` listener

**Advantage:** One Health Connect routing rule, one endpoint. Radiologist can read from any workstation — the message follows the user, not the machine.

### Option B: Per-Workstation Endpoint (More Complex)

1. Health Connect routes by reading location/workstation ID
2. Each workstation runs its own listener on a unique port
3. Messages arrive directly at the workstation where the study was opened

**Disadvantage:** Requires per-workstation configuration in Health Connect. Breaks if radiologist moves between workstations.

### Option C: Per-User Topic/Channel

1. Health Connect writes to a shared queue or Firestore directly
2. Each RadTach instance subscribes to its user's events

**Advantage:** Cleanest separation. **Disadvantage:** Requires Health Connect to write to Firestore (may not be supported natively).

## Recommended Architecture: Option A

```
Health Connect → Filter (strip PHI) → Push to local HL7 receiver
                                            ↓
                                    Parse: modality, CPT, accession, radiologist ID, event type
                                            ↓
                                    Map radiologist ID → Firestore UID
                                            ↓
                                    Write to Firestore: users/{uid}/commands/current
                                            ↓
                                    RadTach picks up via onSnapshot (existing channel)
```

The local HL7 receiver is a lightweight Python/Node service running on one machine (or a server). It receives MLLP messages, parses the 6 fields we need, discards everything else, and writes a Firestore command doc. No PHI persists — the raw HL7 message is processed and dropped.

## Health Connect Configuration Request

**To the Health Connect administrator:**

Please create a routing rule with the following characteristics:

1. **Trigger:** ORM^O01 messages (or equivalent) for radiology orders with status changes indicating:
   - Study opened for reading (status = "IP" or equivalent)
   - Study completed/signed (status = "CM" or equivalent)

2. **Filter:** Only radiology service (OBR-24 in `[CR, CT, MR, US, NM, PT, MG, XA, RF]` or department = Radiology)

3. **Transform:** Strip all segments except:
   - MSH (message header — type, timestamp)
   - OBR (order detail — procedure code, modality, accession, radiologist)
   - Remove PID segment entirely
   - Remove all other segments

4. **Destination:** MLLP TCP push to `[IP:PORT]` (to be determined)
   - Or: REST POST to `https://[endpoint]/hl7` with the stripped message as body

5. **Format:** HL7 v2.x MLLP (standard), or JSON transform if easier

## Security Considerations

- No patient-identifiable data leaves Health Connect
- Accession numbers are operational identifiers, not PHI under HIPAA minimum necessary
- Radiologist system ID is workforce, not patient data
- The receiving endpoint should run on the hospital internal network (no external exposure)
- TLS recommended for the MLLP connection if available
- The Firestore write from the receiver uses a service account with write-only access to `commands` subcollections

## Questions for IT

1. What message type fires when a radiologist opens a study for reading? (ORM, ORU, custom?)
2. What field contains the reading radiologist's identifier? (OBR-32, ORC-12, custom Z-segment?)
3. What field contains the workstation or reading location? (OBR-20, custom?)
4. Is the MLLP feed encrypted (TLS)? If so, what certificate format?
5. Can we receive a sample message (anonymized) to validate our parser?
6. Preferred destination format: MLLP push or REST webhook?
7. Is there an existing radiology routing rule we can clone/modify?

## Timeline Estimate

Once we have a sample message and endpoint configuration:
- Parser development: 1-2 days
- Integration testing with live (stripped) feed: 1 week
- Production deployment: same day as successful test

## FHIR R4 Alternative (Preferred)

If Health Connect has FHIR R4 enabled (InterSystems HealthShare supports this natively), FHIR is the preferred integration path. It's cleaner, more standards-compliant, and easier to get through compliance review.

### Why FHIR Over HL7 v2

- **JSON over REST** instead of pipe-delimited MLLP — no socket handling, standard HTTP
- **Explicit PHI control** — `_elements` parameter restricts which fields are returned in the query
- **Native support** — Visage (PACS) already speaks FHIR; future reporting systems (post-PS360) will be FHIR-compliant
- **Standards trajectory** — FHIR R4 is the CMS-mandated interoperability standard; building on it positions RadTach as a standard FHIR node, not a custom integration
- **Subscription model** — FHIR Subscriptions push notifications on resource changes, eliminating polling

### FHIR Resources We Need

| FHIR Resource | Fields | Purpose |
|---------------|--------|---------|
| `Task` | `status`, `owner`, `for`, `lastModified`, `code` | Study lifecycle (in-progress → completed) |
| `ImagingStudy` | `series.modality`, `identifier` (accession), `started` | Modality and accession number |
| `ServiceRequest` | `code.coding` (CPT system), `code.text` | CPT code and procedure description |
| `Practitioner` | `identifier` (referenced by Task.owner) | Radiologist routing |

### FHIR Field Mapping

| RadTach Need | FHIR Path | Notes |
|-------------|-----------|-------|
| Event type (open/complete) | `Task.status` | `in-progress` = opened, `completed` = signed |
| Modality | `ImagingStudy.series.modality.code` | DICOM modality code (CT, MR, US, etc.) |
| CPT code | `ServiceRequest.code.coding[system=CPT]` | Filter for CPT system OID |
| Procedure description | `ServiceRequest.code.text` | Human-readable name |
| Accession number | `ImagingStudy.identifier[type=ACSN]` | Correlate open/complete events |
| Timestamp | `Task.lastModified` | Event timing |
| Radiologist ID | `Task.owner` → `Practitioner.identifier` | Route to correct RadTach user |

### FHIR Architecture

```
Option 1: FHIR Subscription (Push — Preferred)

  Health Connect FHIR Server
        ↓ (Subscription: Task where status changes for radiology)
  Webhook POST to RadTach receiver (JSON)
        ↓
  Parse: modality, CPT, accession, radiologist, status
        ↓
  Map radiologist → Firestore UID
        ↓
  Write to Firestore: users/{uid}/commands/current
        ↓
  RadTach picks up via onSnapshot


Option 2: FHIR Polling (Pull — Fallback)

  RadTach receiver polls every N seconds:
  GET /Task?status=in-progress,completed
       &_lastUpdated=gt[last_poll_time]
       &owner.identifier=[radiologist_pool]
       &_include=Task:focus
       &_elements=status,owner,lastModified,code
        ↓
  Same processing pipeline as Option 1
```

### FHIR PHI Controls

The `_elements` parameter explicitly limits returned fields:
```
GET /Task?_elements=status,owner,lastModified,code,focus
```

This tells the FHIR server: "only return these fields, nothing else." The server enforces this — our endpoint physically cannot receive data we didn't request. This is a stronger PHI control than HL7 v2 filtering, where we receive the full message and strip it ourselves.

Additionally, the FHIR Subscription can be scoped:
```json
{
  "resourceType": "Subscription",
  "criteria": "Task?owner=Practitioner/[rad-group-id]&code=radiology",
  "channel": {
    "type": "rest-hook",
    "endpoint": "https://[receiver]/fhir-webhook",
    "payload": "application/fhir+json"
  }
}
```

Only radiology tasks for our group's practitioners trigger the webhook. No other department's data touches our endpoint.

### FHIR Questions for IT

1. Is FHIR R4 enabled on your Health Connect instance?
2. Does the FHIR server expose `Task` resources for radiology study lifecycle events?
3. Are FHIR Subscriptions (R4 or R5 topic-based) supported, or should we plan for polling?
4. What `Practitioner.identifier` system is used for radiologist IDs? (NPI, employee ID, AD username?)
5. Is there a FHIR capability statement URL we can review? (`/metadata`)
6. Can we get read-only FHIR client credentials (OAuth2 client_credentials or SMART on FHIR)?
7. Is Visage's FHIR interface accessible from the same network, or is Health Connect the central FHIR broker?

### Visage PACS Integration Note

Visage 7 has native FHIR R4 support. If Health Connect acts as the central FHIR broker, Visage study-open and study-complete events likely already flow through it as `Task` or `ImagingStudy` resource updates. We may be able to subscribe to Visage's existing FHIR events without any new Health Connect routing rules — just a new Subscription endpoint.

If Visage exposes its own FHIR server directly, RadTach could subscribe to Visage's `Task` resources without going through Health Connect at all. This would be the simplest integration path but bypasses IT's central integration engine, which may be a governance concern.

### FHIR vs HL7 v2: Decision Matrix

| Criterion | HL7 v2 | FHIR R4 |
|-----------|--------|---------|
| PHI control | Strip after receipt | Restrict at query time |
| Transport | MLLP (TCP socket) | REST/HTTPS |
| Data format | Pipe-delimited segments | JSON |
| Compliance story | "We filter the feed" | "We only request non-PHI fields" |
| Future-proof | Legacy standard | CMS-mandated standard |
| Visage compatibility | Via Health Connect | Direct or via Health Connect |
| Implementation effort | Moderate (MLLP parser) | Low (REST + JSON) |
| Real-time capability | Yes (MLLP push) | Yes (Subscriptions or polling) |

**Recommendation:** If FHIR R4 is available, use it. Fall back to HL7 v2 MLLP only if FHIR is not enabled or not supported for radiology workflow events.

---

## What This Enables

With HL7/FHIR integration, RadTach becomes fully automatic:
- No manual timer start/stop (study open = timer starts, sign = timer stops)
- Accurate CPT-level RVU (from the actual procedure code, not user selection)
- Modality auto-detection (from the order, not user click)
- Zero workflow disruption (radiologist just reads, RadTach observes)
- Sidecar becomes optional (used for overrides/complications only)
- RadTach operates as a standard FHIR node — positioned for future integrations with any FHIR-compliant system
