/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/** Edit revisions per conversation: a failed save may roll the shown title back only while it is the latest edit. */
export function createRenameRevisions() {
  const latest = new Map<string, number>();
  return {
    next(sessionId: string) {
      const revision = (latest.get(sessionId) ?? 0) + 1;
      latest.set(sessionId, revision);
      return revision;
    },
    isLatest(sessionId: string, revision: number) {
      return latest.get(sessionId) === revision;
    },
  };
}
