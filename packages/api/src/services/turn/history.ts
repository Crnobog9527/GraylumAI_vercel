/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { Session } from '@openai/agents';
import type { HistoryItem } from './db';

/*
 * CORE-PATH-V2 2.6 / 2.9 rule 5: the history a turn sends is the visible messages turn_open returned, newest last. Each item
 * is projected from that message alone (its text), so the same message always becomes the same bytes and the prompt cache
 * prefix of earlier turns stays valid. Trimming to the byte budget drops the oldest messages: as the conversation grows the
 * cut only moves forward, never back. No summary, no rewriting (Owner item 31).
 */
type Item = { type: 'message'; role: 'user'; content: string }
  | { type: 'message'; role: 'assistant'; status: 'completed'; content: Array<{ type: 'output_text'; text: string }> };

export function projectHistory(history: readonly HistoryItem[]): Item[] {
  return history.map(m => m.role === 'user'
    ? { type: 'message', role: 'user', content: m.content }
    : { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: m.content }] });
}

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
/** The newest items whose JSON array fits `budget` bytes; an assistant reply never starts the kept history. */
export function trimHistory(items: readonly Item[], budget: number): Item[] {
  // Exactly the bytes of JSON.stringify(kept): the brackets, then each item plus a comma after the first.
  let total = 2, start = items.length;
  while (start > 0) {
    const next = total + bytes(items[start - 1]) + (start === items.length ? 0 : 1);
    if (next > budget) break;
    total = next; start--;
  }
  while (start < items.length && items[start]!.role === 'assistant') start++;
  return items.slice(start);
}

/** The SDK reads the turn's history from here and writes nothing back: the turn's own messages are saved once by turn_close. */
export function turnSession(items: readonly Item[]): Session {
  const kept = [...items] as never[];
  return {
    getSessionId: async () => 'turn',
    getItems: async () => [...kept],
    addItems: async () => {},
    popItem: async () => undefined,
    clearSession: async () => {},
  };
}
