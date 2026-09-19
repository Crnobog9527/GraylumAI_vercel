/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

type HandoffItem = {
  workItemId: string;
  sessionId: string;
  [key: string]: unknown;
};

type Handoff = {
  requestId?: string;
  result: HandoffItem[];
  [key: string]: unknown;
};

/**
 * Keep immutable handoff request history while exposing each persistent work
 * item only once to read clients. A definite stale-account retry can create a
 * second handoff request that correctly points at the existing work item and
 * Session; rendering both results would duplicate the same UI identity.
 */
export function dedupeHandoffResults<T extends { handoffs?: Handoff[] }>(
  value: T,
): T {
  if (!Array.isArray(value.handoffs)) return value;
  const seen = new Set<string>();
  return {
    ...value,
    handoffs: value.handoffs.map((handoff) => ({
      ...handoff,
      result: handoff.result.filter((item) => {
        if (seen.has(item.workItemId)) return false;
        seen.add(item.workItemId);
        return true;
      }),
    })),
  } as T;
}
