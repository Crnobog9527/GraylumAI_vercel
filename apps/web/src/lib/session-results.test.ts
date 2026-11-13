/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import {
  IMAGE_FAILURE_REPLY_CHARS, excerptProblem, groupResults, guessResultType, offersSave, plainTitle, resultErrorText, saveProblem, saveRequestId, savedFromReply,
  type SessionResultItem,
} from './session-results';

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

// Owner 2026-11-13: an image that was not made left "保存到成果夹" under a reply that only said so.
describe('offersSave', () => {
  const failed = { tool: 'image', state: 'failed' }, skipped = { tool: 'image', state: 'skipped' };
  const made = { tool: 'image', state: 'done' }, running = { tool: 'image', state: 'running' };
  const short = 'Shotviva 的生图额度用完了，充值后再说一声，我就重新生成。';
  it('not offered under a short reply whose image was not made and none was', () => {
    expect(offersSave(short, [failed])).toBe(false);
    expect(offersSave(short, [skipped])).toBe(false);
    expect(offersSave(short, [{ tool: 'research', state: 'done' }, failed])).toBe(false);
    expect(offersSave('x'.repeat(IMAGE_FAILURE_REPLY_CHARS), [failed])).toBe(false);
  });
  it('offered for every other reply: no image, an image made or still coming, or a long reply with writing of its own', () => {
    expect(offersSave(short, [])).toBe(true);
    expect(offersSave(short, [{ tool: 'research', state: 'failed' }])).toBe(true);
    expect(offersSave(short, [made])).toBe(true);
    expect(offersSave(short, [failed, made])).toBe(true);
    expect(offersSave(short, [running])).toBe(true);
    expect(offersSave('文'.repeat(IMAGE_FAILURE_REPLY_CHARS + 1), [failed])).toBe(true);
  });
});

describe('UI-FINISH: what a save starts with', () => {
  it('takes the type from the Skill the reply loaded: a 口播稿 Skill saves as 口播稿, not 正文', () => {
    expect(guessResultType({ skills: ['视频口播稿'], reply: '今天聊聊早起。' })).toBe('script');
    expect(guessResultType({ skills: ['short-video-script'], reply: 'x' })).toBe('script');
    expect(guessResultType({ skills: ['分镜脚本'], reply: 'x' })).toBe('storyboard');
    expect(guessResultType({ skills: ['剪辑建议'], reply: 'x' })).toBe('editing');
    expect(guessResultType({ skills: ['每周选题'], reply: 'x' })).toBe('topic_list');
  });
  it('else from the reply\'s opening line, and 正文 only when nothing says', () => {
    expect(guessResultType({ reply: '## 60 秒口播稿\n大家好……' })).toBe('script');
    expect(guessResultType({ skills: ['Hooks'], reply: '这是一篇文章。\n口播的部分在后面。' })).toBe('body');
    expect(guessResultType({ reply: '' })).toBe('body');
  });
  it('a title without Markdown marks', () => {
    expect(plainTitle('**一句话说明**：早起')).toBe('一句话说明：早起');
    expect(plainTitle('## 标题')).toBe('标题');
    expect(plainTitle('- *重点* 和 `代码`')).toBe('重点 和 代码');
    expect(plainTitle('2026年计划')).toBe('2026年计划');
    expect(plainTitle('**')).toBe('**');
  });
});
