/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/**
 * Rename bookkeeping per conversation. Each save gets a revision; only the latest may roll the shown
 * title back, and it rolls back to the last title the server confirmed, never to an optimistic one.
 */
export function createRenameRevisions() {
  const latest = new Map<string, number>();
  const confirmed = new Map<string, string>();
  const inFlight = new Map<string, number>();
  return {
    /** Start a save. `shown` is the title on screen, which is the confirmed one when nothing is pending. */
    begin(sessionId: string, shown: string) {
      if (!inFlight.get(sessionId)) confirmed.set(sessionId, shown);
      inFlight.set(sessionId, (inFlight.get(sessionId) ?? 0) + 1);
      const revision = (latest.get(sessionId) ?? 0) + 1;
      latest.set(sessionId, revision);
      return revision;
    },
    /** A save finished. An empty saved name means the server default, which only a refetch knows. */
    settle(sessionId: string, savedName: string | null) {
      inFlight.set(sessionId, Math.max(0, (inFlight.get(sessionId) ?? 1) - 1));
      if (savedName === null) return;
      if (savedName) confirmed.set(sessionId, savedName); else confirmed.delete(sessionId);
    },
    isLatest(sessionId: string, revision: number) {
      return latest.get(sessionId) === revision;
    },
    rollbackTitle(sessionId: string, fallback: string) {
      return confirmed.get(sessionId) ?? fallback;
    },
  };
}
