/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/** Edit revisions per conversation: only the latest edit may end its overlay or report its result. */
export function createRenameRevisions() {
  const latest = new Map<string, number>();
  return {
    begin(sessionId: string) {
      const revision = (latest.get(sessionId) ?? 0) + 1;
      latest.set(sessionId, revision);
      return revision;
    },
    isLatest(sessionId: string, revision: number) {
      return latest.get(sessionId) === revision;
    },
  };
}
