/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { Session } from '@openai/agents';
import type { HistoryItem } from './db';

/*
 * CORE-PATH-V2 2.6 / 2.9 rule 5: the history a turn sends is the visible messages turn_open returned, newest last. Each item
 * is projected from that message alone (its text), so the same message always becomes the same bytes and the prompt cache
 * prefix of earlier turns stays valid. Trimming to the byte budget drops the oldest messages: as the conversation grows the
 * cut only moves forward, never back. No summary, no rewriting (Owner item 31). The positioning mentor uses trimKeepingUserWords
 * below: the same rule, except that older coach replies are cut to their verbatim ending before any of the user's words drop out.
 */
type Item = { type: 'message'; role: 'user'; content: string }
  | { type: 'message'; role: 'assistant'; status: 'completed'; content: Array<{ type: 'output_text'; text: string }> };

export function projectHistory(history: readonly HistoryItem[]): Item[] {
  return history.map(m => m.role === 'user'
    ? { type: 'message', role: 'user', content: m.content }
    : { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: m.content }] });
}

/**
 * The bytes history may take: what the ceiling leaves after the instructions, the current message, the slack kept for the reply, the
 * tool definitions and the room reserved for tool results, except the elastic part of it (a later tool read evicts the oldest history).
 */
export function historyRoom(input: { inputLimit: number; instructionBytes: number; currentBytes: number;
  tools?: { plan: { reserveBytes: number; elasticBytes?: number }; definitionBytes: number } | null }): number {
  const reserved = input.tools ? input.tools.plan.reserveBytes - (input.tools.plan.elasticBytes ?? 0) + input.tools.definitionBytes : 0;
  return Math.max(input.inputLimit - input.instructionBytes - input.currentBytes - 8192 - reserved, 0);
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

/** How much of an older mentor reply is kept when the history does not fit whole: its ending, where its question is. */
export const EARLIER_REPLY_TAIL_CHARS = 200;
export const EARLIER_REPLY_MARK = '[Earlier reply, shortened: only its ending is kept] …';
const assistantText = (item: Item) => item.role === 'assistant' ? item.content.map(part => part.text).join('') : '';
/** An older reply cut to its verbatim ending (no summary, no new words beyond the mark); a user message is never touched. */
export function earlierItem(item: Item): Item {
  if (item.role === 'user') return item;
  const text = assistantText(item), chars = Array.from(text);
  if (chars.length <= EARLIER_REPLY_TAIL_CHARS) return item;
  return { ...item, content: [{ type: 'output_text', text: EARLIER_REPLY_MARK + chars.slice(-EARLIER_REPLY_TAIL_CHARS).join('').trimStart() }] };
}

/** An assistant reply never starts the kept history (as trimHistory). */
const fromUser = (items: Item[]) => { let start = 0; while (start < items.length && items[start]!.role === 'assistant') start++; return items.slice(start); };
/**
 * The positioning mentor's history (Owner's new-account run, 2026-11-26: the coach asked again what the user had already answered).
 * trimHistory drops whole exchanges from the start, so after about six turns the user's own earlier answers were gone while the
 * coach's long replies stayed. Here the user's words are what is kept longest: when the history does not fit whole, the oldest
 * mentor replies are cut to their verbatim ending first (the newest ones stay whole, as many as fit); when even that does not fit,
 * the oldest shortened replies are left out next, and only then the oldest messages of any kind, as trimHistory does. A history
 * that fits is returned unchanged, and an older reply's shortened form is the same bytes in every later turn.
 */
export function trimKeepingUserWords(items: readonly Item[], budget: number): Item[] {
  if (bytes(items) <= budget) return trimHistory(items, budget);
  // The newest reply stays whole: it is what the user is answering now.
  let last = items.length - 1;
  while (last >= 0 && items[last]!.role !== 'assistant') last--;
  const shortened = items.map((item, index) => index === last ? item : earlierItem(item));
  const full = items.map(item => bytes(item)), short = shortened.map(item => bytes(item));
  // Bytes with the first `cut` items shortened: the brackets, every item, and a comma between items.
  let total = 2 + Math.max(items.length - 1, 0) + full.reduce((sum, size) => sum + size, 0);
  for (let cut = 0; cut <= items.length; cut++) {
    if (total <= budget) return fromUser([...shortened.slice(0, cut), ...items.slice(cut)]);
    if (cut < items.length) total += short[cut]! - full[cut]!;
  }
  // Still too long: the oldest shortened replies go next, then, as trimHistory, the oldest messages of any kind.
  const kept = [...shortened], newest = items[last];
  for (let index = 0; index < kept.length && bytes(kept) > budget;) {
    if (kept[index]!.role === 'assistant' && kept[index] !== newest) kept.splice(index, 1); else index++;
  }
  return trimHistory(kept, budget);
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
