/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { excerptProblem, groupResults, resultErrorText, saveProblem, saveRequestId, savedFromReply, type SessionResultItem } from './session-results';

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
  it('finds a result already saved from the same reply with the same text, whatever its type or title', () => {
    const saved = { ...item('a', 'script'), sourceExecutionId: 'e1', title: '早起口播稿', body: '今天早起……' };
    expect(savedFromReply([saved], 'e1', '今天早起……')).toBe(saved);
    // Another reply, another text, or an edited result (it keeps its own text and no source) is a different save.
    expect(savedFromReply([saved], 'e2', '今天早起……')).toBeUndefined();
    expect(savedFromReply([saved], 'e1', '今天早起')).toBeUndefined();
    expect(savedFromReply([{ ...saved, sourceExecutionId: null, body: '改过' }], 'e1', '今天早起……')).toBeUndefined();
    expect(savedFromReply([], 'e1', 'x')).toBeUndefined();
  });
  it('refuses a repeated save of the same reply and text even when type and title are chosen again', () => {
    const saved = { ...item('a', 'script'), sourceExecutionId: 'e1', title: '早起口播稿', body: '今天早起……' };
    expect(saveProblem('今天早起……', '今天早起……', [saved], 'e1')).toContain('已经保存在成果夹里（口播稿「早起口播稿」）');
    expect(saveProblem('今天早起……', '今天早起……', [], 'e1')).toBe('');
    expect(saveProblem('今天早起……', '今天早起……', [saved], 'e2')).toBe('');
    // A different excerpt of the same reply is still a new result; invalid text keeps its own message.
    expect(saveProblem('今天早起……明天六点见。', '明天六点见。', [saved], 'e1')).toBe('');
    expect(saveProblem('今天早起', '不在回复里', [saved], 'e1')).toContain('只能保存回复里的原文');
  });
  it('maps bounded refusals to plain text and keeps anything else neutral', () => {
    expect(resultErrorText(new Error('OPC_VERSION_CONFLICT'))).toContain('最新版本');
    expect(resultErrorText(new Error('private detail'))).not.toContain('private');
  });
});
