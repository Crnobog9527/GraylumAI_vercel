/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import type { ResearchCall } from '@/components/research/research-model';
import { closedTurnSeen, liveAfter, neverOpened, refusalNotice, withResearchRow } from './use-turn-chat';
import { POSITIONING_REQUIRED_NOTICE } from './gate-notices';

const call = (state: ResearchCall['state'], credits: string | null = null): ResearchCall => ({ callId: 'c1', toolName: 'social_search', args: {},
  query: '早起', platform: 'douyin' as never, dataKind: 'keyword_posts', state, credits });

describe('research rows of a free chat turn', () => {
  it('one row per call: the end state replaces the running row, with the settled credits', () => {
    const running = withResearchRow([], call('running'));
    expect(running).toHaveLength(1);
    expect(running[0]).toMatchObject({ id: 'c1', kind: 'research', state: 'running' });
    const done = withResearchRow(running, call('succeeded', '0.30'));
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ state: 'done', credits: '0.3 积分' });
    expect(withResearchRow(done, { ...call('running'), callId: 'c2' })).toHaveLength(2);
  });
});

describe('a send that opened no turn', () => {
  it('stored and charged nothing, whatever the code: the words and any claim for them go back', () => {
    expect(neverOpened({ state: 'refused' })).toBe(true);
    expect(neverOpened({ state: 'finished', last: { type: 'error', code: 'STOP_LOSS_REACHED' } })).toBe(true);
    expect(neverOpened({ state: 'finished', last: { type: 'error', code: 'SOMETHING_NEW' } })).toBe(true);
    // turn_open may have committed with its answer lost: the turn and its freeze exist, the error has no turn.
    for (const code of ['TURN_DATABASE_UNAVAILABLE', 'TURN_OPEN_FAILED', 'TURN_FAILED'])
      expect(neverOpened({ state: 'finished', last: { type: 'error', code } })).toBe(false);
    expect(neverOpened({ state: 'finished', last: { type: 'error', code: 'STOP_LOSS_REACHED', turnId: 12 } })).toBe(false);
    expect(neverOpened({ state: 'finished', last: { type: 'result', turnId: 12 } })).toBe(false);
  });
});

describe('the balance after a turn that closed while the page was away', () => {
  const closed = (turnId: number) => ({ lastTurn: { turnId, kind: 'chat', closeKind: 'completed', failureCode: null, settlement: 'done' as const,
    chargedCredits: 4, closedAt: '2026-11-01T10:00:00Z' } });
  it('acts on the first view, and on every later view that shows a newer closed turn, however the close was learned', () => {
    expect(closedTurnSeen(undefined, closed(7))).toEqual({ changed: true, id: 7 });
    expect(closedTurnSeen(7, closed(7)).changed).toBe(false);
    expect(closedTurnSeen(7, closed(8))).toEqual({ changed: true, id: 8 });
    // A conversation without any closed turn is a view too: nothing to act on twice.
    expect(closedTurnSeen(undefined, { lastTurn: null })).toEqual({ changed: true, id: null });
    expect(closedTurnSeen(null, { lastTurn: null }).changed).toBe(false);
  });
  it('does nothing before the first read', () => {
    expect(closedTurnSeen(undefined, null)).toEqual({ changed: false, id: undefined });
  });
});

describe('the live reply while its steps run', () => {
  it('a step event adds a step, the same id turns it into its end, the first text leaves the steps for the list to fold', () => {
    const start = { text: '', trimmed: ['x'], rows: [], steps: [] };
    const reading = liveAfter(start, { type: 'step', id: '1', tool: 'load_skill', label: '分镜', state: 'running' });
    expect(reading.steps).toEqual([{ id: '1', tool: 'load_skill', state: 'running', label: '分镜' }]);
    const done = liveAfter(reading, { type: 'step', id: '1', tool: 'load_skill', label: '分镜', state: 'done' });
    expect(done.steps).toEqual([{ id: '1', tool: 'load_skill', state: 'done', label: '分镜' }]);
    const two = liveAfter(done, { type: 'step', id: '2', tool: 'research', state: 'running', detail: '早起' });
    expect(two.steps.map(step => step.id)).toEqual(['1', '2']);
    const writing = liveAfter(two, { type: 'text', delta: '第一镜' });
    expect(writing).toMatchObject({ text: '第一镜', trimmed: ['x'] });
    expect(writing.steps).toHaveLength(2);
  });
});

// 走查 26: the page says a definite refusal when it arrives. Only a code that proves the message was not stored qualifies; any other
// failure is still read back first.
describe('a refusal the page can say at once', () => {
  it('is a code that proves nothing was stored: the positioning guide, no credits, a message too long', () => {
    expect(refusalNotice('POSITIONING_REQUIRED')).toEqual({ code: 'POSITIONING_REQUIRED', text: POSITIONING_REQUIRED_NOTICE });
    expect(refusalNotice('TURN_INSUFFICIENT_CREDITS')?.text).toContain('没有发送');
    expect(refusalNotice('TURN_INPUT_TOO_LARGE')?.code).toBe('TURN_INPUT_TOO_LARGE');
  });
  it('is not a failure whose outcome has to be read back, an unknown code, a replay or no code', () => {
    for (const code of ['TURN_PROVIDER_BUSY', 'TURN_CALL_UNKNOWN', 'TURN_FAILED', 'SOMETHING_NEW', 'TURN_REQUEST_REPLAYED', '', null, undefined])
      expect(refusalNotice(code)).toBeNull();
  });
});
