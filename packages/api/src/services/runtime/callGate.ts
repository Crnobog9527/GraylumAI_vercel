/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { GateRejection, RuntimeCallGate } from './newWorkGate';

export function runtimeCallGate(input: { call: RuntimeCallGate; actor: () => Promise<string>; version: 'bill2.v1' | 'bill2.v2';
  onRejected: (reason: GateRejection) => void; enter?: () => (() => void) | undefined }) {
  return async (reserve = true, checkPause = true) => {
    const leave = input.enter?.();
    try {
      const actor = await input.actor();
      const verdict = checkPause
        ? reserve ? await input.call(actor, 1, input.version) : await input.call(actor, 1, input.version, false)
        : await input.call(actor, 1, input.version, reserve, false);
      if (!verdict.ok) { input.onRejected(verdict.reason); throw new Error('RUNTIME_NEW_CALL_DENIED'); }
    } catch (error) {
      input.onRejected('limit_unavailable'); throw error;
    } finally { leave?.(); }
  };
}
