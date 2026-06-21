// Server-side role check for coaching brief access.
// Mirrors the predicate from src/hooks/useUserRole.ts but scoped against the
// TARGET user's system (not the caller's) — prevents cross-tenant PHI leaks.

import { getFirestore } from 'firebase-admin/firestore';

export interface AuthDecision {
  allowed: boolean;
  reason: string;
}

export async function canCallerCoachTarget(
  callerUid: string,
  targetUid: string,
): Promise<AuthDecision> {
  // Self-access always allowed (rad generates their own brief).
  if (callerUid === targetUid) return { allowed: true, reason: 'self-target' };

  const db = getFirestore();

  // globalAdmin bypass.
  const globalAdmins = await db.doc('Config/admins').get();
  const adminsData = globalAdmins.exists ? globalAdmins.data() ?? {} : {};
  if (adminsData[callerUid] === true) {
    return { allowed: true, reason: 'globalAdmin' };
  }

  // Look up target's system.
  const targetDoc = await db.doc(`users/${targetUid}`).get();
  if (!targetDoc.exists) return { allowed: false, reason: 'target-user-not-found' };
  const targetSystem: string | undefined = targetDoc.data()?.system;
  if (!targetSystem) return { allowed: false, reason: 'target-user-has-no-system' };

  // Per-system admin/president authorization (scoped to TARGET's system).
  const settings = await db.doc(`Config/systemSettings`).get();
  if (!settings.exists) return { allowed: false, reason: 'no-system-settings' };
  const systemData = (settings.data() ?? {})[targetSystem] ?? {};
  const admins = systemData.admins ?? {};
  const presidents = systemData.presidents ?? {};
  if (admins[callerUid] === true || presidents[callerUid] === true) {
    return { allowed: true, reason: `system-admin-of-${targetSystem}` };
  }

  return { allowed: false, reason: 'caller-not-authorized-for-target-system' };
}
