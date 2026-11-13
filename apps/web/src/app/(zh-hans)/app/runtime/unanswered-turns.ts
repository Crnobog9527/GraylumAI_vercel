/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/*
 * VOICE-ABORT-FIX (staging check of #1984, 11-14): a round voided after it was asked (the writing voice was deleted mid-reply,
 * 0535) keeps the user's message and saves no reply. The transcript is drawn reply by reply, each under its question, so such a
 * message had nowhere to show and the user's own words seemed lost after a reload. These are the questions with no reply, each
 * placed before the reply that follows it (or after the last one).
 */
export const UNANSWERED_NOTE = '这一轮没有生成。';
type Message = { seq: number; role: 'user' | 'assistant'; turnId: number | null; content: string };

/** Place (the index of the next reply among the assistant messages; their count for the end) -> the unanswered questions there. */
export function unansweredByPlace<M extends Message>(messages: readonly M[]): Map<number, M[]> {
  const answered = new Set(messages.filter(m => m.role === 'assistant' && m.turnId !== null).map(m => m.turnId));
  const places = new Map<number, M[]>();
  let replies = 0;
  for (const message of [...messages].sort((a, b) => a.seq - b.seq)) {
    if (message.role === 'assistant') { replies++; continue; }
    if (message.turnId !== null && answered.has(message.turnId)) continue;
    places.set(replies, [...(places.get(replies) ?? []), message]);
  }
  return places;
}
