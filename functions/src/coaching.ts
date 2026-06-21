// Function 4 — coaching brief generation (Vertex AI Gemini Flash).
// SHIPS DORMANT. Enable via Config/featureFlags.coachingEnabled = true.
//
// Defensive caps (Clyde HIGH #6):
//   - 50K input token hard cap (rejects oversized briefs before Vertex call)
//   - 10 invocations/day per UID (atomic-increment lock at users/{uid}/coachingUsage/{date})
//   - Budget killswitch via Config/featureFlags.coachingEnabled (separate
//     function below subscribes to Cloud Billing Pub/Sub topic and flips it)
//
// Cross-tenant auth (Clyde HIGH #4): roleCheck scopes against the TARGET's
// system, not the caller's. Cross-tenant admins denied.

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { onMessagePublished } from 'firebase-functions/v2/pubsub';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { VertexAI } from '@google-cloud/vertexai';
import { readFlags } from './lib/featureFlags';
import { canCallerCoachTarget } from './lib/roleCheck';
import { assembleBrief } from './lib/briefAssembly';
import { buildCoachingPrompt, COACHING_PROMPT_VERSION } from './lib/geminiPrompt';

const COMMON_OPTS = {
  region: 'us-central1' as const,
  memory: '1GiB' as const,
  timeoutSeconds: 540,
};

const MAX_DAYS_WINDOW = 120;
const ALLOWED_WINDOWS = new Set([7, 28, 84, 120]);
const MAX_PER_DAY_PER_UID = 10;
const MAX_INPUT_TOKENS = 50_000;     // hard cap before Vertex call
const MAX_OUTPUT_TOKENS = 8_192;
const GEMINI_MODEL = 'gemini-2.0-flash-001';

interface CoachingRequest {
  uid?: string;
  daysWindow?: number;
  periodLabel?: string;
}

/** Estimate token count conservatively: ceil(chars / 3). Real Gemini tokenization is ~chars/4, so this is an upper bound. */
function estimateInputTokens(prompt: string): number {
  return Math.ceil(prompt.length / 3);
}

/** Atomic per-day per-uid quota increment. Throws if would exceed cap. */
async function incrementUsageOrThrow(callerUid: string): Promise<number> {
  const db = getFirestore();
  const today = new Date().toISOString().slice(0, 10);
  const ref = db.doc(`users/${callerUid}/coachingUsage/${today}`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const current = snap.exists ? (snap.data()?.count ?? 0) : 0;
    if (current >= MAX_PER_DAY_PER_UID) {
      throw new HttpsError('resource-exhausted', `daily quota reached (${MAX_PER_DAY_PER_UID})`);
    }
    tx.set(ref, { count: current + 1, lastInvokedAt: FieldValue.serverTimestamp() }, { merge: true });
    return current + 1;
  });
}

export const generateCoachingBrief = onCall<CoachingRequest>(COMMON_OPTS, async (request) => {
  const callerUid = request.auth?.uid;
  if (!callerUid) throw new HttpsError('unauthenticated', 'sign-in required');

  const flags = await readFlags();
  if (!flags.coachingEnabled) {
    throw new HttpsError('unavailable', 'coaching feature is currently disabled');
  }

  const targetUid = request.data?.uid ?? callerUid;
  const daysWindow = request.data?.daysWindow ?? 28;
  if (!ALLOWED_WINDOWS.has(daysWindow) || daysWindow > MAX_DAYS_WINDOW) {
    throw new HttpsError('invalid-argument', `daysWindow must be one of ${[...ALLOWED_WINDOWS].join(', ')}`);
  }
  const periodLabel = request.data?.periodLabel ?? 'period';

  // Cross-tenant auth check.
  const auth = await canCallerCoachTarget(callerUid, targetUid);
  if (!auth.allowed) {
    throw new HttpsError('permission-denied', `not authorized for target user: ${auth.reason}`);
  }

  // Atomic quota check.
  const usageCount = await incrementUsageOrThrow(callerUid);

  // Idempotency check — one report per {targetUid, periodEnd} per hour.
  const db = getFirestore();
  const periodEnd = new Date().toISOString().slice(0, 10);
  const reportRef = db.doc(`users/${targetUid}/coachingReports/${periodEnd}`);
  const existing = await reportRef.get();
  if (existing.exists) {
    const generatedAtField = existing.data()?.generatedAt as FirebaseFirestore.Timestamp | undefined;
    if (generatedAtField) {
      const ageMs = Date.now() - generatedAtField.toMillis();
      if (ageMs < 60 * 60 * 1000) {
        return { reportId: periodEnd, generatedAt: generatedAtField.toMillis(), cached: true };
      }
    }
  }

  // Assemble brief.
  const brief = await assembleBrief(targetUid, daysWindow);
  const prompt = buildCoachingPrompt({ brief, periodLabel });

  // Hard input-token cap.
  const tokenEstimate = estimateInputTokens(prompt);
  if (tokenEstimate > MAX_INPUT_TOKENS) {
    throw new HttpsError('resource-exhausted', `brief too large (${tokenEstimate} > ${MAX_INPUT_TOKENS} tokens); reduce daysWindow`);
  }

  // Call Vertex AI Gemini.
  const projectId = process.env.GCLOUD_PROJECT ?? process.env.GCP_PROJECT ?? 'radtach';
  const vertex = new VertexAI({ project: projectId, location: 'us-central1' });
  const model = vertex.getGenerativeModel({
    model: GEMINI_MODEL,
    generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS, temperature: 0.4 },
  });

  let reportText: string;
  try {
    const resp = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
    });
    const candidates = resp.response.candidates ?? [];
    reportText = candidates[0]?.content?.parts?.[0]?.text ?? '';
    if (!reportText) throw new Error('empty Vertex response');
  } catch (err) {
    console.error('Vertex call failed:', err);
    throw new HttpsError('internal', `coaching generation failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Write report doc.
  await reportRef.set({
    targetUid,
    periodStart: brief.periodStart,
    periodEnd,
    daysWindow,
    periodLabel,
    generatedAt: FieldValue.serverTimestamp(),
    generatedBy: callerUid,
    model: GEMINI_MODEL,
    promptVersion: COACHING_PROMPT_VERSION,
    inputTokenEstimate: tokenEstimate,
    briefSnapshot: brief,
    report: reportText,
  });

  return {
    reportId: periodEnd,
    generatedAt: Date.now(),
    callerDailyCount: usageCount,
    inputTokenEstimate: tokenEstimate,
  };
});

/**
 * Pub/Sub-triggered killswitch. Subscribe a topic to a Cloud Billing budget
 * alert; when the alert fires, this function flips coachingEnabled to false.
 * Manual re-enable via Firestore Console.
 *
 * Topic name: budget-alerts (or whatever you configure). To wire: in GCP
 * Console → Billing → Budgets & alerts → create a $2/month budget on the
 * radtach project, attach to a Pub/Sub topic, then this function listens.
 */
export const disableCoachingOnBudget = onMessagePublished(
  {
    topic: 'budget-alerts',
    region: 'us-central1',
  },
  async (event) => {
    console.warn('disableCoachingOnBudget triggered:', event.data.message.json);
    const db = getFirestore();
    await db.doc('Config/featureFlags').set(
      { coachingEnabled: false, lastBudgetDisable: FieldValue.serverTimestamp() },
      { merge: true },
    );
    console.warn('coachingEnabled flipped to false by budget killswitch');
  },
);
