/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {projectOpenRouterItemsForSizing} from './openRouterHistory';

/** Optional old history may be cut only before first-call membership is frozen.
 * Keep original objects/revisions. Never salvage fields from an unknown item,
 * never remove current input, and never apply this to a frozen replay/tool turn.
 * A retained suffix must start at a user turn and pass the complete validator,
 * so orphan results, unknown tools and metadata never reach the model.
 */
export function recoverOpenRouterHistory(history: unknown[], toolNames: ReadonlySet<string>): unknown[] {
  for (let cut = 0; cut <= history.length; cut++) {
    if (cut > 0 && cut < history.length &&
      (history[cut] as {role?: unknown} | null)?.role !== 'user') continue;
    const suffix = history.slice(cut);
    try {
      projectOpenRouterItemsForSizing(suffix, suffix.length, toolNames);
      return suffix;
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'RUNTIME_PROVIDER_HISTORY_DENIED') throw error;
    }
  }
  return [];
}
