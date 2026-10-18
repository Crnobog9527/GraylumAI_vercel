/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { slowHint, toolCounts, turnSteps } from './turn-steps-model';

const none = { running: 0, done: 0, failed: 0 };
describe('turnSteps', () => {
  it('shows one thinking step before anything arrives', () => {
    expect(turnSteps({ phase: 'mentor', hasText: false, tools: none })).toEqual([
      { id: 'write', state: 'running', label: '正在想怎么回复…' }]);
  });
  it('splits tools and writing, with progress counts', () => {
    const steps = turnSteps({ phase: 'mentor', hasText: false, tools: { running: 2, done: 3, failed: 0 } });
    expect(steps.map(s => [s.id, s.state])).toEqual([['tools', 'running'], ['write', 'waiting']]);
    expect(steps[0].label).toContain('已完成 3/5');
  });
  it('ticks tools off and shows writing once text streams', () => {
    const steps = turnSteps({ phase: 'mentor', hasText: true, tools: { running: 0, done: 4, failed: 1 } });
    expect(steps[0]).toMatchObject({ id: 'tools', state: 'done' });
    expect(steps[0].label).toContain('1 项这次没查到');
    expect(steps[1]).toMatchObject({ id: 'write', state: 'running', label: '正在写回复…' });
  });
  it('walks through organizer and saving', () => {
    expect(turnSteps({ phase: 'organizer', hasText: true, tools: none }).map(s => [s.id, s.state]))
      .toEqual([['write', 'done'], ['organize', 'running']]);
    expect(turnSteps({ phase: 'saving', hasText: true, tools: none }).map(s => [s.id, s.state]))
      .toEqual([['write', 'done'], ['save', 'running']]);
  });
});
describe('toolCounts / slowHint', () => {
  it('counts states', () => {
    expect(toolCounts(['running', 'succeeded', 'failed', 'missing', 'unknown', 'done'])).toEqual({ running: 1, done: 2, failed: 2, pending: 1 });
  });
  it('does not report unsettled lookups as completed', () => {
    const steps = turnSteps({ phase: 'mentor', hasText: true, tools: { running: 0, done: 2, failed: 0, pending: 1 } });
    expect(steps[0].label).toBe('查资料和数据：完成 2 项，1 项待核对');
  });
  it('escalates the hint with time', () => {
    expect(slowHint(5000)).toBeNull();
    expect(slowHint(30000)).toContain('请先别刷新');
    expect(slowHint(130000)).toContain('刷新页面会暂时看不到实时进度');
  });
});
