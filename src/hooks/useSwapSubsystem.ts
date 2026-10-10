/**
 * useSwapSubsystem — excisable swap-detection + swap-application module.
 *
 * Consolidates all swap-related logic in one place so the whole subsystem can
 * be deleted cleanly when HL7/FHIR reports swap-vs-new-study events directly.
 * Nothing outside this file needs to know what a swap is; the two call sites
 * in the main component are one dispatch hook and one gate inside completeStudy.
 * The correction itself lives in mode-enum (`swap_detected`, computed from its
 * own events since 3d); legacy's applySwap was removed in Phase 7.
 *
 * See RadTach/swap-subsystem-plan.md for the phased plan (Phase 1 = this file
 * plus ~10 lines of call-site wiring; the 5s auto-heuristic still lives here
 * for behavior parity and is retired in Phase 3).
 *
 * Phase 4 excision recipe:
 *   1. Delete this file
 *   2. Delete useSwapArmed / handleSidecarCommandSwapFlag / shouldApplySwap
 *      imports and call sites in App.tsx, and mode-enum's swap_detected
 *   3. Delete `swap?: boolean` from SidecarCommand
 *   4. Delete the START + SWAP button on Sidecar
 */

import { useRef, useCallback } from 'react';
import type { SidecarCommand } from '../types/sidecar';

/**
 * Ref-backed flag for "the next completeStudy should apply a swap correction."
 * Set by handleSidecarCommandSwapFlag when Sidecar sends swap: true.
 * Consumed by shouldApplySwap on the next hit and auto-cleared.
 *
 * `armIfKeyNew` dedupes on idempotency key so a WebSocket reconnect
 * re-firing onSnapshot for the same commands/current doc can't re-arm the
 * swap on the *following* study. Bounded ring of the last 100 keys is kept
 * per session — plenty of headroom, no unbounded growth.
 */
export function useSwapArmed(): {
  arm: () => void;
  armIfKeyNew: (key: string | undefined) => void;
  consume: () => boolean;
} {
  const armed = useRef(false);
  const seenKeys = useRef<Set<string>>(new Set());
  const seenOrder = useRef<string[]>([]);
  const MAX_KEYS = 100;
  const arm = useCallback(() => {
    armed.current = true;
  }, []);
  const armIfKeyNew = useCallback((key: string | undefined) => {
    // No key present = older Sidecar client. Arm defensively; risk of double-arm
    // is bounded by rad-input cadence (a re-delivered start would still be paired
    // with a new completeStudy, not a stale one).
    if (!key) {
      armed.current = true;
      return;
    }
    if (seenKeys.current.has(key)) return;
    seenKeys.current.add(key);
    seenOrder.current.push(key);
    if (seenOrder.current.length > MAX_KEYS) {
      const oldest = seenOrder.current.shift();
      if (oldest) seenKeys.current.delete(oldest);
    }
    armed.current = true;
  }, []);
  const consume = useCallback(() => {
    const wasArmed = armed.current;
    armed.current = false;
    return wasArmed;
  }, []);
  return { arm, armIfKeyNew, consume };
}

/**
 * Called from the commands/current subscription. Reads swap: true off the
 * incoming start command and arms the swap for the next completeStudy.
 * Dedupes on cmd.idempotencyKey so a WebSocket reconnect can't re-arm
 * the swap on the following study.
 */
export function handleSidecarCommandSwapFlag(
  cmd: SidecarCommand,
  armIfKeyNew: (key: string | undefined) => void,
): void {
  if (cmd.action === 'start' && cmd.swap === true) {
    armIfKeyNew(cmd.idempotencyKey);
  }
}

/**
 * The swap gate. Post-Phase-3: deterministic control only — a swap fires
 * if and only if the manual arm (set by Sidecar's START + SWAP button) is
 * present. The legacy 5-second auto-heuristic was retired 2026-07-07 after
 * a clean field-validation shift and confirmation that the auto path was
 * the source of false-positive swap noise (short-interval Par-Par
 * transitions tripping it during otherwise-legitimate rapid-study workflow).
 */
export function shouldApplySwap(consumeManualArm: () => boolean): boolean {
  return consumeManualArm();
}
