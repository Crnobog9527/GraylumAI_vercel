/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { RuntimeCallGate } from '../../runtime/newWorkGate';
import { DEFAULT_RUNTIME_RATE_LIMITS } from '../../runtime/rateLimitSettings';
/** Only explicit offline tests may supply this gate; hosts always build real gates. */
export const allowTestCalls: RuntimeCallGate = async () => ({ ok: true });
export const testAdmissionGates = {
  readNewWorkSettings: async () => ({ ok: true, config: { ...DEFAULT_RUNTIME_RATE_LIMITS } }),
  newWorkGate: () => ({ message: allowTestCalls, calls: allowTestCalls }),
};
