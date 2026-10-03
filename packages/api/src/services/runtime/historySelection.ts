/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type {HistorySelection} from './hostTurn';

export type HistoryOptions = {
  instructions: string; inputBytes: number; historyItems: number; toolBytes: number;
  historySelection: HistorySelection; revisions?: readonly number[];
  projectHistoryItem?: (item: unknown) => unknown;
  projectItemsForSizing?: (items: unknown[], historyCount: number) => unknown[];
};
const row = (item: unknown): Record<string, unknown> =>
  item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : {};

/** Safe suffix starts; orphan results may occur at the SQL window's beginning.
 * An incomplete/deformed dependency cannot be retained in any suffix. */
function safeStarts(history: unknown[]): Set<number> {
  const starts = new Set<number>([history.length]);
  for (let cut = 0; cut < history.length; cut++) {
    if (row(history[cut]).role !== 'user') continue;
    const pending = new Set<unknown>();
    let valid = true;
    for (const item of history.slice(cut)) {
      const value = row(item);
      if (value.type === 'function_call') {
        if (typeof value.callId !== 'string' || pending.has(value.callId)) valid = false;
        pending.add(value.callId);
      } else if (value.type === 'function_call_result') {
        if (!pending.delete(value.callId)) valid = false;
      }
    }
    // Do not cut through a dependency whose call precedes this user.
    const priorCalls = new Set(history.slice(0, cut).filter(item => row(item).type === 'function_call').map(item => row(item).callId));
    if (history.slice(cut).some(item => row(item).type === 'function_call_result' && priorCalls.has(row(item).callId))) valid = false;
    if (valid && !pending.size) starts.add(cut);
  }
  return starts;
}
function measurements(history: unknown[], incoming: unknown[], options: HistoryOptions) {
  const projected = history.map(item => options.projectHistoryItem?.(item) ?? item);
  const items = options.projectItemsForSizing?.([...projected, ...incoming], history.length) ?? [...projected, ...incoming];
  const required = items.slice(history.length);
  const currentBytes = Buffer.byteLength(JSON.stringify(required));
  const size = (cut: number, reserve: boolean, margin: number) =>
    Buffer.byteLength(JSON.stringify({instructions: options.instructions, messages: [...items.slice(cut, history.length), ...required]})) +
    options.toolBytes + margin + (reserve ? Math.max(0, options.historySelection.currentReserveBytes - currentBytes) : 0);
  return {currentBytes, size};
}
export function currentInputBytes(incoming: unknown[]): number {
  return Buffer.byteLength(JSON.stringify(incoming));
}

/** First selection and replay use the same immutable projection. A legal suffix
 * already fitting the frozen reservation is an identity, including 17–48. */
export function selectBlockHistory(history: unknown[], incoming: unknown[], options: HistoryOptions): unknown[] {
  const {size, currentBytes} = measurements(history, incoming, options);
  const fallback = currentBytes > options.historySelection.currentReserveBytes;
  if (size(history.length, false, 1024) > options.inputBytes) throw new Error('RUNTIME_REQUIRED_CONTEXT_EXCEEDS_CAPACITY');
  const starts = safeStarts(history);
  const fits = (cut: number) => history.length - cut <= options.historyItems && size(cut, !fallback, 1024) <= options.inputBytes;
  if (starts.has(0) && fits(0)) return [...history, ...incoming];
  if (fallback) {
    const cut = [...starts].sort((a, b) => a - b).find(fits) ?? history.length;
    return [...history.slice(cut), ...incoming];
  }
  const revisions = options.revisions;
  if (!revisions || revisions.length !== history.length || revisions.some((rev, i) =>
    !Number.isSafeInteger(rev) || rev < 0 || i > 0 && rev <= revisions[i - 1]!)) throw new Error('RUNTIME_HISTORY_SELECTION');
  const seen = new Set<number>();
  for (let cut = 0; cut < history.length; cut++) {
    if (!starts.has(cut)) continue;
    const block = Math.floor(revisions[cut]! / options.historySelection.blockRevisions);
    if (seen.has(block)) continue;
    seen.add(block);
    if (revisions[0]! < block * options.historySelection.blockRevisions && fits(cut)) return [...history.slice(cut), ...incoming];
  }
  return [...incoming];
}

/** Per-call path: never remove a frozen member, even after tool output grows. */
export function validateBlockCall(items: unknown[], historyCount: number, options: HistoryOptions): unknown[] {
  if (!Number.isSafeInteger(historyCount) || historyCount < 0 || historyCount > items.length) throw new Error('RUNTIME_HISTORY_SELECTION');
  const history = items.slice(0, historyCount), required = items.slice(historyCount);
  if (historyCount > options.historyItems || !safeStarts(history).has(0)) throw new Error('RUNTIME_HISTORY_SELECTION');
  const {size} = measurements(history, required, options);
  if (size(0, false, 128) > options.inputBytes) throw new Error('RUNTIME_REQUIRED_CONTEXT_EXCEEDS_CAPACITY');
  return [...history.map(item => options.projectHistoryItem?.(item) ?? item), ...required];
}
