/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { excerptProblem, groupResults, resultErrorText, saveRequestId, type SessionResultItem } from './session-results';

const item = (id: string, resultType: SessionResultItem['resultType']): SessionResultItem => ({
  id, familyId: id, version: 1, versions: 1, resultType, title: id, body: 'b', sourceExecutionId: null,
  sourceAvailable: true, createdAt: '2026-10-23T00:00:00Z',
});

describe('session results', () => {
  it('groups by result type in a fixed order, keeping saved order and dropping empty groups', () => {
    const groups = groupResults([item('a', 'copy'), item('b', 'script'), item('c', 'copy')]);
    expect(groups.map(g => [g.label, g.items.map(i => i.id)])).toEqual([['口播稿', ['b']], ['其他文案', ['a', 'c']]]);
  });
  it('derives one stable UUID per reply, type and exact text', async () => {
    const exec = '11111111-1111-4111-8111-111111111111';
    const first = await saveRequestId(exec, 'script', '原文');
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(await saveRequestId(exec, 'script', '原文')).toBe(first);
    expect(await saveRequestId(exec, 'copy', '原文')).not.toBe(first);
    expect(await saveRequestId(exec, 'script', '原文。')).not.toBe(first);
  });
  it('accepts only verbatim, non-empty excerpts up to 20000 characters', () => {
    expect(excerptProblem('今天早起，明天六点见。', '明天六点见。')).toBe('');
    expect(excerptProblem('今天早起', '   ')).toContain('请保留');
    expect(excerptProblem('今天早起', '今天晚起')).toContain('只能保存回复里的原文');
    expect(excerptProblem('x'.repeat(20001), 'x'.repeat(20001))).toContain('20000');
  });
  it('maps bounded refusals to plain text and keeps anything else neutral', () => {
    expect(resultErrorText(new Error('OPC_VERSION_CONFLICT'))).toContain('最新版本');
    expect(resultErrorText(new Error('private detail'))).not.toContain('private');
  });
});
