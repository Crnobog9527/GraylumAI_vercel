/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { fitToolTurn } from './capacity';

const msg = (role: string, size: number) => ({ type: 'message', role, content: 'x'.repeat(size) });

describe('a tool turn keeps fitting its input budget (CORE-PATH-V2 V2-6)', () => {
  it('drops the oldest history first, never the current message or this turn\'s tool results', () => {
    const history = [msg('user', 1000), msg('assistant', 1000), msg('user', 1000), msg('assistant', 1000)];
    const turn = [msg('user', 100), { type: 'function_call_result', output: 'r'.repeat(20_000) }];
    const items = [...history, ...turn];
    expect(fitToolTurn(items, 'rules', 4, 1_000_000)).toBe(items);
    const kept = fitToolTurn(items, 'rules', 4, 23_000);
    // Two history messages had to go; the kept history starts with a user message.
    expect(kept).toEqual([history[2], history[3], ...turn]);
    // Even with no room at all, this turn's items stay (the final capacity check refuses the request then).
    expect(fitToolTurn(items, 'rules', 4, 10)).toEqual(turn);
  });

  it('never starts the kept history with an assistant reply', () => {
    const items = [msg('user', 1000), msg('assistant', 10), msg('user', 10), msg('user', 50)];
    expect(fitToolTurn(items, '', 3, 200)).toEqual([items[2], items[3]]);
  });
});
