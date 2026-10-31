/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { turnLimits } from './policy';
import { resumeLimits, TurnReplay } from './resume';

const model = (text: string) => JSON.stringify({ choices: [{ message: { content: text } }] });
const row = (seq: number, callKind: 'model' | 'tool', body: string | null, toolName: string | null = null) =>
  ({ seq, callKind, toolName, status: 'ok' as const, body });

describe('what a resume replays', () => {
  it('answers each call from its receipt, in order, then leaves the next call real', () => {
    const replay = new TurnReplay([row(1, 'model', model('a')), row(2, 'tool', '[{"vendor":"v"}]', 'web_search'), row(3, 'model', model('b'))]);
    expect(replay.model()).toBe(model('a'));
    expect(replay.tool('web_search')).toEqual({ status: 'ok', results: [{ vendor: 'v' }] });
    expect(replay.model()).toBe(model('b'));
    expect(replay.model()).toBeNull();
    expect(replay.tool('web_search')).toBeNull();
  });
  it('stops at a receipt without a completion: everything after it is real', () => {
    const lookup = JSON.stringify({ data: { model: 'x' } });
    const replay = new TurnReplay([row(1, 'model', model('a')), row(2, 'model', lookup), row(3, 'model', model('c'))]);
    expect(replay.model()).toBe(model('a'));
    expect(replay.model()).toBeNull();
  });
  it('a tool asked for out of order is not answered from another tool\'s receipt', () => {
    expect(new TurnReplay([row(1, 'tool', '[]', 'web_search')]).tool('web_fetch')).toBeNull();
  });
});

describe('the limits of a resumed turn', () => {
  const full = { model: 5, paidTools: 3, freeTools: 1, decisions: 1 };
  it('keeps to what is left, and each tool return keeps its model call', () => {
    expect(resumeLimits(full, { model: 3, paidTools: 2, freeTools: 1, decisions: 0 }))
      .toEqual({ model: 3, paidTools: 1, freeTools: 1, decisions: 0 });
    expect(resumeLimits(full, { model: 1, paidTools: 2, freeTools: 1, decisions: 0 })).toMatchObject({ model: 1, paidTools: 0, freeTools: 0 });
  });
  it('a model request already answered by its receipt does not take a model call: the tool it asked for can still run', () => {
    // Paused after the model asked for a search and before the search ran: one model call (the continuation) and one search are left.
    const limits = resumeLimits({ model: 2, paidTools: 1, freeTools: 0, decisions: 0 }, { model: 1, paidTools: 1, freeTools: 0, decisions: 0 }, 0, 1);
    expect(limits).toEqual({ model: 1, paidTools: 1, freeTools: 0, decisions: 0, replayedModels: 1 });
    expect(turnLimits.parse(limits)).toEqual(limits);
    // Nothing replayed: the first call is real, so the same count leaves no room for the search.
    expect(resumeLimits({ model: 2, paidTools: 1, freeTools: 0, decisions: 0 }, { model: 1, paidTools: 1, freeTools: 0, decisions: 0 }))
      .toMatchObject({ model: 1, paidTools: 0 });
    const asks = JSON.stringify({ choices: [{ message: { tool_calls: [{ function: { name: 'web_search' } }] } }] });
    expect(new TurnReplay([row(1, 'model', asks)]).replayedModels).toBe(1);
    // The tool ran and the paused turn waits for the final reply: that model call is real, so it keeps its place in the limits.
    expect(new TurnReplay([row(1, 'model', asks), row(2, 'tool', '[]', 'web_search')]).replayedModels).toBe(0);
    expect(resumeLimits({ model: 2, paidTools: 1, freeTools: 0, decisions: 0 }, { model: 1, paidTools: 0, freeTools: 0, decisions: 0 }, 0, 0))
      .toEqual({ model: 1, paidTools: 0, freeTools: 0, decisions: 0 });
    expect(turnLimits.parse(resumeLimits({ model: 2, paidTools: 1, freeTools: 0, decisions: 0 }, { model: 1, paidTools: 0, freeTools: 0, decisions: 0 })))
      .toMatchObject({ model: 1 });
    // A free tool's request leaves no result to wait for.
    const reads = JSON.stringify({ choices: [{ message: { tool_calls: [{ function: { name: 'read_source' } }] } }] });
    expect(new TurnReplay([row(1, 'model', reads)]).replayedModels).toBe(0);
    expect(new TurnReplay([]).replayedModels).toBe(0);
  });
  it('holds room for the organizer, and a negative count left is none', () => {
    expect(resumeLimits({ model: 3, paidTools: 0, freeTools: 1, decisions: 0 }, { model: 2, paidTools: -2, freeTools: 1, decisions: 0 }, 1))
      .toEqual({ model: 2, paidTools: 0, freeTools: 0, decisions: 0 });
  });
});
