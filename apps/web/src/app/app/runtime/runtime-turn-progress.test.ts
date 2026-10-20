/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import type { LiveReply } from '@/app/app/positioning/[draftId]/agent-turn-display';
import { runtimeTurnProgress } from './runtime-turn-progress';

const reply = (over: Partial<LiveReply> = {}): LiveReply =>
  ({ executionId: 'e1', text: '', phase: 'mentor', card: null, rev: 0, points: 0, stalled: false, ...over });
const base = { executionId: 'e1', items: [], turnState: 'running' };
describe('runtimeTurnProgress', () => {
  it('follows the streamed reply', () => {
    expect(runtimeTurnProgress({ ...base, reply: reply({ text: '你好' }), streaming: true })).toMatchObject({
      reopened: false, input: { hasText: true, phase: 'mentor' } });
  });
  it('is reopened when the server still runs a turn this page does not stream', () => {
    expect(runtimeTurnProgress({ ...base, reply: null, streaming: false })?.reopened).toBe(true);
  });
  it('does not pretend the reply is unwritten when the saved answer already exists', () => {
    expect(runtimeTurnProgress({ ...base, reply: null, streaming: false, savedReply: true })?.input)
      .toMatchObject({ phase: 'organizer', hasText: true });
  });
  it('shows nothing for finished or stopped turns', () => {
    expect(runtimeTurnProgress({ ...base, turnState: 'completed', reply: null, streaming: false })).toBeNull();
    expect(runtimeTurnProgress({ ...base, reply: reply({ stopped: true }), streaming: true })).toBeNull();
    expect(runtimeTurnProgress({ ...base, reply: reply({ stopped: true }), streaming: false })).toBeNull();
    expect(runtimeTurnProgress({ ...base, reply: reply({ phase: 'incomplete' }), streaming: true })).toBeNull();
  });
});
