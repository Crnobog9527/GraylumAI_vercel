/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { pendingState, releaseCompleted } from './topic-pending';

const KEY = 'opc-topic-operation:s1';
const opening = { kind: 'chat', request: { draftId: 'd1', requestId: 'r1', input: '定位已更新。请只根据最新的已确认定位……' } };
const reply = { executionId: 'r1', state: 'completed' };

// Codex batch F: the auto first turn 6644 completed normally (charged once) while the page said its outcome was unknown.
describe('which pending operation is an unknown outcome', () => {
  it('a message still being answered in this tab is in flight, not unknown (the auto first turn)', () => {
    expect(pendingState(opening, true, [])).toBe('in_flight');
    expect(pendingState(opening, true, [{ executionId: 'turn:9', state: 'running' }])).toBe('in_flight');
  });
  it('a message whose reply is saved is completed, not unknown (a reload mid-reply, a dropped stream)', () => {
    expect(pendingState(opening, false, [{ executionId: 'r0', state: 'completed' }, reply])).toBe('completed');
  });
  it('a message with no saved reply, and nothing in flight, is still unknown and keeps its notice', () => {
    expect(pendingState(opening, false, undefined)).toBe('unknown');
    expect(pendingState(opening, false, [])).toBe('unknown');
    expect(pendingState(opening, false, [{ executionId: 'r0', state: 'completed' }])).toBe('unknown');
    // The running turn's handle is `turn:<id>`, never the request id: running is not completed.
    expect(pendingState(opening, false, [{ executionId: 'turn:9', state: 'running' }])).toBe('unknown');
  });
  it('a save or an adoption is never settled by a reply: without its answer it stays unknown', () => {
    const save = { kind: 'save', request: { requestId: 'r1' } };
    expect(pendingState(save, false, [reply])).toBe('unknown');
    expect(pendingState(save, true, [reply])).toBe('in_flight');
  });
  it('nothing pending is nothing', () => expect(pendingState(null, false, [reply])).toBe('none'));
});

describe('releasing the frozen record of an answered message', () => {
  const storage = (items: Record<string, string>) => {
    const map = new Map(Object.entries(items));
    return { map, getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k) };
  };
  it('releases the same message as a finished send does (kept under :completed:)', () => {
    const s = storage({ [KEY]: JSON.stringify(opening) });
    expect(releaseCompleted(s, KEY, 'r1')).toBe('released');
    expect(s.map.has(KEY)).toBe(false);
    expect(JSON.parse(s.map.get(KEY + ':completed:r1')!)).toEqual(opening);
  });
  it('a record another tab already released is gone; a different or unreadable one stays', () => {
    expect(releaseCompleted(storage({}), KEY, 'r1')).toBe('gone');
    for (const raw of [JSON.stringify({ ...opening, request: { ...opening.request, requestId: 'r2' } }),
      JSON.stringify({ kind: 'save', request: { requestId: 'r1' } }), '{oops']) {
      const s = storage({ [KEY]: raw });
      expect(releaseCompleted(s, KEY, 'r1')).toBe('other');
      expect(s.map.get(KEY)).toBe(raw);
    }
  });
});
