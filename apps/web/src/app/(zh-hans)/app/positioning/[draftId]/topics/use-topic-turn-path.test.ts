/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import type { TurnView } from '@repo/api/src/services/turn/view';
import { topicExecutions, topicSendOutcome, turnRunningNotice } from './use-topic-turn-path';

const R = '00000000-0000-4000-8000-000000000001';
const view = (over: Partial<TurnView> = {}): TurnView => ({ activeTurn: null, lastTurn: null, calls: [], messages: [
  { seq: 1, role: 'user', turnId: 9, content: 'topics', requestId: R }, { seq: 2, role: 'assistant', turnId: 9, content: 'TEXT', requestId: R }], ...over });

describe('the topic workspace on the turn path (CORE-PATH-V2 V2-10b)', () => {
  it('shows each saved exchange under its request id, the handle of the draft and the adoption', () => {
    expect(topicExecutions(view()).executions).toEqual([{ executionId: R, state: 'completed', input: 'topics', body: 'TEXT', primaryBody: 'TEXT',
      contentAvailable: true, unavailableReason: null }]);
  });

  it('shows the running turn and holds the box while it runs', () => {
    const active = { turnId: 10, kind: 'chat', state: 'running' as const, pauseReason: null, openedAt: 'a', updatedAt: 'b' };
    const shown = topicExecutions(view({ activeTurn: active }));
    expect(shown.activeExecution).toBe('turn:10');
    expect(shown.executions.at(-1)).toMatchObject({ executionId: 'turn:10', state: 'running' });
  });

  it('a reply without a request id is not offered as a source', () => {
    expect(topicExecutions(view({ messages: [{ seq: 2, role: 'assistant', turnId: 9, content: 'TEXT' }] })).executions).toEqual([]);
  });

  it('a refusal keeps the words; a result, a replay or a dropped stream never asks to send again', () => {
    expect(topicSendOutcome({ state: 'refused', code: 'TURN_RATE_LIMITED', status: 429 })).toMatchObject({ keepInput: true });
    expect(topicSendOutcome({ state: 'lost' })).toEqual({ notice: null, keepInput: false });
    expect(topicSendOutcome({ state: 'finished', last: { type: 'result', turnId: 9, body: 'x', chargedCredits: 1, settlement: 'done' } }))
      .toEqual({ notice: null, keepInput: false });
    expect(topicSendOutcome({ state: 'finished', last: { type: 'error', code: 'TURN_REQUEST_REPLAYED', turnId: 9 } }))
      .toEqual({ notice: null, keepInput: false });
    expect(topicSendOutcome({ state: 'finished', last: { type: 'error', code: 'TURN_FAILED', turnId: 9 } })).toMatchObject({ keepInput: false });
    expect(topicSendOutcome({ state: 'finished', last: { type: 'error', code: 'OPC_TOPIC_SOURCE_REVOKED' } })).toMatchObject({ keepInput: true,
      notice: expect.stringContaining('定位版本') });
    expect(turnRunningNotice({ executionId: 'turn:1', state: 'completed' })).toBeNull();
    expect(turnRunningNotice({ executionId: 'turn:1', state: 'running' })).toMatchObject({ busy: true });
  });
});
