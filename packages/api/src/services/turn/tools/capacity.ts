/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/*
 * CORE-PATH-V2 V2-6, 2.7: a turn with tools grows with every tool return (each up to 20,000 bytes), so before each model call
 * the oldest history messages are dropped until the request fits again; the current message and this turn's tool calls and
 * results are always kept. The cut only moves forward (history.ts), and an assistant reply never starts the kept history.
 * The complete request is still checked before it is sent (assertRuntimeRequestCapacity).
 */
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

/** `items` is the model input as the SDK builds it: `historyCount` history messages first, then this turn's items. */
export function fitToolTurn<T>(items: T[], instructions: string, historyCount: number, budget: number): T[] {
  let total = Buffer.byteLength(instructions) + bytes(items), start = 0;
  const history = Math.min(historyCount, items.length);
  while (total > budget && start < history) total -= bytes(items[start++]) + 1;
  while (start < history && (items[start] as { role?: unknown }).role === 'assistant') start++;
  return start ? items.slice(start) : items;
}
