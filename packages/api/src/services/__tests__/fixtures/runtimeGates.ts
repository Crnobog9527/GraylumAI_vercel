/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { RuntimeCallGate } from '../../runtime/newWorkGate';
import { DEFAULT_RUNTIME_RATE_LIMITS } from '../../runtime/rateLimitSettings';
/** Only explicit offline tests may supply this gate; hosts always build real gates. */
export const allowTestCalls: RuntimeCallGate = async () => ({ ok: true });
/** MODEL-IDENTITY-GUARD switch seen by admission through the settings read (default on). */
export const testIdentityGuard = { enabled: true };
export const testAdmissionGates = {
  readNewWorkSettings: async () => ({ ok: true, config: { ...DEFAULT_RUNTIME_RATE_LIMITS } }),
  readAdmissionSettings: async () => ({ ok: true, config: { ...DEFAULT_RUNTIME_RATE_LIMITS }, identityGuard: testIdentityGuard.enabled }),
  newWorkGate: () => ({ message: allowTestCalls, calls: allowTestCalls }),
};
