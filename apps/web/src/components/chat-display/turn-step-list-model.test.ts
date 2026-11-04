import { describe, expect, it } from 'vitest';
import { mergeStep, stepLine, stepsOpen, stepsSummary, visibleSteps, type ReplyStep } from './turn-step-list-model';

const step = (tool: ReplyStep['tool'], state: ReplyStep['state'], extra: Partial<ReplyStep> = {}): ReplyStep => ({ id: `${tool}-${state}`, tool, state, ...extra });

describe('the line of each step', () => {
  it('running: what is being done, with the Skill\'s public name or the search\'s first words', () => {
    expect(stepLine(step('think', 'running'))).toBe('正在思考…');
    expect(stepLine(step('load_skill', 'running', { label: '分镜脚本' }))).toBe('正在读取「分镜脚本」方法…');
    expect(stepLine(step('load_skill', 'running'))).toBe('正在读取方法…');
    expect(stepLine(step('research', 'running', { detail: '早起口播' }))).toBe('正在联网搜索：早起口播…');
    expect(stepLine(step('research', 'running'))).toBe('正在联网搜索…');
    expect(stepLine(step('read_source', 'running'))).toBe('正在查阅资料库…');
    expect(stepLine(step('coach_review', 'running'))).toBe('正在读取你的作品数据…');
    expect(stepLine(step('other', 'running'))).toBe('正在处理…');
  });
  it('done: what was done, with the count when there is one', () => {
    expect(stepLine(step('load_skill', 'done', { label: '分镜脚本' }))).toBe('已读取「分镜脚本」方法');
    expect(stepLine(step('research', 'done', { count: 6 }))).toBe('已搜索，找到 6 条结果');
    expect(stepLine(step('research', 'done', { count: 0 }))).toBe('已搜索，没有找到结果');
    expect(stepLine(step('research', 'done'))).toBe('已搜索');
    expect(stepLine(step('read_source', 'done', { count: 2 }))).toBe('已查阅资料库，找到 2 条相关内容');
    expect(stepLine(step('coach_review', 'done'))).toBe('已读取你的作品数据');
  });
  it('failed and skipped: neutral words that say what happens instead', () => {
    expect(stepLine(step('research', 'failed'))).toBe('联网搜索暂时没成功，改用已有信息回答');
    expect(stepLine(step('load_skill', 'failed', { label: '分镜脚本' }))).toBe('「分镜脚本」方法暂时读取不了，改为直接回答');
    expect(stepLine(step('read_source', 'skipped'))).toBe('这次没有查阅资料库');
    expect(stepLine(step('coach_review', 'skipped'))).toBe('这次没有读取作品数据');
    expect(stepLine(step('coach_review', 'skipped', { reason: 'no_brand' }))).toBe('还没连接作品账号，这次按定位和资料回答');
    for (const state of ['failed', 'skipped'] as const) for (const tool of ['load_skill', 'research', 'read_source', 'coach_review', 'other'] as const)
      expect(stepLine(step(tool, state))).not.toMatch(/错误|失败|异常|出错/);
  });
});

describe('the list of a reply', () => {
  it('a step event adds or replaces by id, so a running step becomes its end', () => {
    const one = mergeStep([], { id: '1', tool: 'research', state: 'running', detail: '早起' });
    const two = mergeStep(one, { id: '1', tool: 'research', state: 'done', detail: '早起', count: 6 });
    expect(two).toEqual([{ id: '1', tool: 'research', state: 'done', detail: '早起', count: 6 }]);
    expect(mergeStep(two, { id: '2', tool: 'other', state: 'running' }).map(item => item.id)).toEqual(['1', '2']);
    expect(mergeStep([], { id: '3', tool: 'coach_review', state: 'skipped', reason: 'no_brand' })).toEqual([{ id: '3', tool: 'coach_review', state: 'skipped', reason: 'no_brand' }]);
  });
  it('live with no text and nothing running, the reply is thinking; with text, or with a step running, nothing is added', () => {
    expect(visibleSteps([], true, false).map(item => item.tool)).toEqual(['think']);
    expect(visibleSteps([step('load_skill', 'done')], true, false).map(item => item.tool)).toEqual(['load_skill', 'think']);
    expect(visibleSteps([step('load_skill', 'running')], true, false)).toHaveLength(1);
    expect(visibleSteps([step('load_skill', 'done')], true, true)).toHaveLength(1);
    expect(visibleSteps([], true, true)).toEqual([]);
    expect(visibleSteps([], false, false)).toEqual([]);
  });
  it('open while the reply waits or a step runs; folded once the text flows or the reply ended, unless the reader opened it', () => {
    const done = [step('load_skill', 'done')];
    expect(stepsOpen(done, true, false, null)).toBe(true);
    expect(stepsOpen([step('research', 'running')], true, true, false)).toBe(true);
    expect(stepsOpen(done, true, true, null)).toBe(false);
    expect(stepsOpen(done, false, true, null)).toBe(false);
    expect(stepsOpen(done, false, true, true)).toBe(true);
  });
  it('the folded row counts the ended steps and names the ones that did not work', () => {
    expect(stepsSummary([step('load_skill', 'done'), step('research', 'done')])).toBe('已完成 2 个步骤');
    expect(stepsSummary([step('load_skill', 'done'), step('research', 'failed')])).toBe('已完成 2 个步骤，其中 1 个没成功');
  });
});
