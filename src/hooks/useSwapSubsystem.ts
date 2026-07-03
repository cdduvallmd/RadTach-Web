/**
 * useSwapSubsystem — excisable swap-detection + swap-application module.
 *
 * Consolidates all swap-related logic in one place so the whole subsystem can
 * be deleted cleanly when HL7/FHIR reports swap-vs-new-study events directly.
 * Nothing outside this file needs to know what a swap is; the two call sites
 * in the main component are one dispatch hook and one gate/apply pair inside
 * completeStudy.
 *
 * See RadTach/swap-subsystem-plan.md for the phased plan (Phase 1 = this file
 * plus ~10 lines of call-site wiring; the 5s auto-heuristic still lives here
 * for behavior parity and is retired in Phase 3).
 *
 * Phase 4 excision recipe:
 *   1. Delete this file
 *   2. Delete useSwapArmed / handleSidecarCommandSwapFlag / shouldApplySwap /
 *      applySwap imports and call sites in RadTach_Developmental_Firebase.tsx
 *   3. Delete `swap?: boolean` from SidecarCommand
 *   4. Delete the START + SWAP button on Sidecar
 */

import { useRef, useCallback } from 'react';
import type { SidecarCommand } from '../types/sidecar';

// Minimal shape the swap logic needs from an INTERSTITIAL event. Kept local
// so this module doesn't take a hard dependency on the main file's inline
// SessionEvent union — makes excision clean.
interface SwapCompatibleInterstitialEvent {
  type: 'INTERSTITIAL';
  duration: number;
  startTimeSession: number;
  startTimeSystem: string;
  endTimeSession: number;
}

// Generic bound for the caller's SessionEvent[]. The swap logic only touches
// entries whose type === 'INTERSTITIAL'; other entries pass through untouched.
type EventWithType = { type: string };

export interface SwapResult {
  effectiveTime: number;
  wasSwapped: boolean;
  swapStartOverride: { session: number; system: string } | null;
}

/**
 * Ref-backed flag for "the next completeStudy should apply a swap correction."
 * Set by handleSidecarCommandSwapFlag when Sidecar sends swap: true.
 * Consumed by shouldApplySwap on the next hit and auto-cleared.
 */
export function useSwapArmed(): {
  arm: () => void;
  consume: () => boolean;
} {
  const armed = useRef(false);
  const arm = useCallback(() => {
    armed.current = true;
  }, []);
  const consume = useCallback(() => {
    const wasArmed = armed.current;
    armed.current = false;
    return wasArmed;
  }, []);
  return { arm, consume };
}

/**
 * Called from the commands/current subscription. Reads swap: true off the
 * incoming start command and arms the swap for the next completeStudy.
 * No-op for any command that doesn't carry swap: true.
 */
export function handleSidecarCommandSwapFlag(
  cmd: SidecarCommand,
  arm: () => void,
): void {
  if (cmd.action === 'start' && cmd.swap === true) {
    arm();
  }
}

/**
 * The swap gate. Two paths — legacy 5s auto-heuristic OR manual arm from
 * Sidecar. If the 5s check passes, the manual arm is NOT consumed (reserved
 * for a genuine manual swap on the next study). Preserves behavior parity
 * with the pre-refactor path.
 *
 * Phase 3 removes the 5s branch; this simplifies to `return consumeManualArm();`.
 */
export function shouldApplySwap(
  currentTime: number,
  consumeManualArm: () => boolean,
): boolean {
  if (currentTime > 0 && currentTime < 5) return true;
  return consumeManualArm();
}

/**
 * Applies the swap correction: mutates the last INTERSTITIAL event to a 10s
 * default gap, adjusts the cumulative interstitial counter, and fires the
 * shadow swap_detected signal via the caller's emitter.
 *
 * Returns the effective study duration (the previous interstitial's original
 * duration, which is what the rad was actually dictating for), a wasSwapped
 * flag for downstream logging/filmstrip decisions, and a start-time override
 * for the filmstrip so the study renders in the correct time slot.
 */
export function applySwap<E extends EventWithType>(
  currentTime: number,
  sessionEvents: E[],
  setSessionEvents: (events: E[]) => void,
  setInterstitialTime: (updater: (prev: number) => number) => void,
  emitShadowSwap: (params: {
    interstitialDuration: number;
    correctedStart: number;
    correctedSystem: string;
  }) => void,
): SwapResult {
  const events = [...sessionEvents];
  let lastInterIdx = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === 'INTERSTITIAL') {
      lastInterIdx = i;
      break;
    }
  }
  if (lastInterIdx < 0) {
    return { effectiveTime: currentTime, wasSwapped: false, swapStartOverride: null };
  }
  const inter = events[lastInterIdx] as unknown as SwapCompatibleInterstitialEvent;
  const effectiveTime = inter.duration;
  events[lastInterIdx] = {
    ...inter,
    duration: 10,
    endTimeSession: inter.startTimeSession + 10,
  } as unknown as E;
  setSessionEvents(events);
  setInterstitialTime((prev) => prev - (inter.duration - 10));
  const swapStartOverride = {
    session: inter.startTimeSession + 10,
    system: new Date(new Date(inter.startTimeSystem).getTime() + 10000).toISOString(),
  };
  emitShadowSwap({
    interstitialDuration: inter.duration,
    correctedStart: swapStartOverride.session,
    correctedSystem: swapStartOverride.system,
  });
  return { effectiveTime, wasSwapped: true, swapStartOverride };
}
