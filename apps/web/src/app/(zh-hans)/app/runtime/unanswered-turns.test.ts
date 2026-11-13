/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { UNANSWERED_NOTE, unansweredByPlace } from './unanswered-turns';

const m = (seq: number, role: 'user' | 'assistant', turnId: number | null, content = role + seq) => ({ seq, role, turnId, content });

// #1984 staging check (11-14): after a writing voice was deleted mid-reply, the stored question did not show after a reload.
describe('questions with no saved reply (VOICE-ABORT-FIX)', () => {
  it('a voided round between two answered ones is placed before the next reply; one at the end after the last', () => {
    const messages = [m(1, 'user', 1), m(2, 'assistant', 1), m(3, 'user', 2, '写口播稿'), m(4, 'user', 3), m(5, 'assistant', 3),
      m(6, 'user', 4, '再写一篇')];
    const places = unansweredByPlace(messages);
    expect([...places.keys()]).toEqual([1, 2]);
    expect(places.get(1)!.map(x => x.content)).toEqual(['写口播稿']);
    expect(places.get(2)!.map(x => x.content)).toEqual(['再写一篇']);
  });
  it('answered questions are never repeated, whatever the order the rows come in', () => {
    expect(unansweredByPlace([m(2, 'assistant', 1), m(1, 'user', 1)]).size).toBe(0);
    expect(unansweredByPlace([]).size).toBe(0);
  });
  // The work item's conversation (选题 / 稿件) runs the same free-chat turn, voice included: it draws them too.
  it('the work item page draws them, in place and at the end, with the note', () => {
    const page = readFileSync(join(__dirname, 'work-item-workspace.tsx'), 'utf8');
    expect(page).toContain('{unansweredAt(index)}');
    expect(page).toContain('{unansweredAt(replies.length)}');
    expect(page).toContain('{UNANSWERED_NOTE}');
  });
  it('the conversation page draws them, in place and at the end, with the note', () => {
    const page = readFileSync(join(__dirname, 'turn-workspace.tsx'), 'utf8');
    expect(page).toContain('{unansweredAt(index)}');
    expect(page).toContain('{unansweredAt(turns.length)}');
    expect(page).toContain('{UNANSWERED_NOTE}');
    expect(UNANSWERED_NOTE).toBe('这一轮没有生成。');
  });
});
