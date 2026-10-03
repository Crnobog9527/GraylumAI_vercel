/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {projectOpenRouterItemsForSizing} from './openRouterHistory';

export function latestHistoryTurn(history: unknown[]): unknown[] {
  const start = history.findLastIndex(item => (item as {role?: unknown} | null)?.role === 'user');
  return start < 0 ? history : history.slice(start);
}

/** Optional older history can be omitted before freezing, but never the latest
 * user turn or any of its assistant/tool items. Keep original objects/revisions;
 * the caller freezes the omission notice atomically with selected membership.
 * Current input and frozen replay never enter this recovery path.
 */
export function recoverOpenRouterHistory(history: unknown[], toolNames: ReadonlySet<string>): unknown[] {
  const latestStart = history.length - latestHistoryTurn(history).length;
  for (let cut = 0; cut <= latestStart; cut++) {
    if (cut > 0 && (history[cut] as {role?: unknown} | null)?.role !== 'user') continue;
    const suffix = history.slice(cut);
    try {
      projectOpenRouterItemsForSizing(suffix, suffix.length, toolNames);
      return suffix;
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'RUNTIME_PROVIDER_HISTORY_DENIED') throw error;
    }
  }
  throw new Error('RUNTIME_PROVIDER_HISTORY_DENIED');
}

/** Capacity selection following compatibility recovery must not silently undo
 * its promise to retain the latest turn. This still uses original Session items. */
export function assertLatestHistoryRetained(history: unknown[], selected: unknown[]): void {
  if (!selected.length || latestHistoryTurn(history).some(item => !selected.includes(item))) {
    throw new Error('RUNTIME_PROVIDER_HISTORY_DENIED');
  }
}
