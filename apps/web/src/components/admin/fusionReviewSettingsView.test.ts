import { describe, expect, it } from 'vitest';
import { affectsRunning, allSkills, countRunning, draftProblems, runningCount, settingsErrorText, toSaved, warningText, type FusionSettingsValue } from './fusionReviewSettingsView';

const M = (n: number) => `40000000-0000-4000-8000-00000000000${n}`;
const value: FusionSettingsValue = { version: 1, compare: { enabled: false, allowedModelIds: [], defaultModelIds: [], minModels: 2, answerOutputTokens: 8192, maxBudgetUsd: null, dispatchMinutes: 10, breaker: { platformUsd: '2', noDeliveryCalls: 10 } }, review: {
  enabled: true, reviewerModelIds: [M(1), M(2), M(3)], summaryModelId: M(4), skillId: M(5), maxRounds: 2, opinionOutputTokens: 4096,
  summaryOutputTokens: 32768, maxBudgetUsd: '0.5', dispatchMinutes: 10, breaker: { platformUsd: '2', noDeliveryCalls: 10 },
  displayNames: { reviewers: ['目标用户', '操盘手', '挑刺审核人'], summary: '主笔' } } };

describe('jury admin form', () => {
  it('accepts a complete panel and says what is missing before turning the jury on', () => {
    expect(draftProblems(value.review)).toEqual([]);
    const incomplete = { ...value.review, reviewerModelIds: [M(1), '', ''], summaryModelId: null };
    expect(draftProblems(incomplete).join()).toContain('开启评审团前');
    expect(draftProblems({ ...incomplete, enabled: false })).toEqual([]);
  });

  it('catches duplicate models, bad names, lengths and budgets', () => {
    expect(draftProblems({ ...value.review, reviewerModelIds: [M(1), M(1), M(3)] }).join()).toContain('3 个不同的模型');
    expect(draftProblems({ ...value.review, displayNames: { reviewers: ['', 'B', 'C'], summary: 'S' } }).join()).toContain('最多 20 个字');
    expect(draftProblems({ ...value.review, displayNames: { reviewers: ['一二三四五六七八九十一二三四五六七八九十一', 'B', 'C'], summary: 'S' } })).toHaveLength(1);
    expect(draftProblems({ ...value.review, opinionOutputTokens: 100 }).join()).toContain('意见长度');
    expect(draftProblems({ ...value.review, summaryOutputTokens: Number.NaN }).join()).toContain('汇总的输出长度');
    expect(draftProblems({ ...value.review, maxBudgetUsd: '0' }).join()).toContain('大于 0');
    expect(draftProblems({ ...value.review, maxBudgetUsd: 'abc' }).join()).toContain('大于 0');
  });

  it('saves trimmed names, no empty seats and no empty budget', () => {
    const saved = toSaved(value, { ...value.review, enabled: false, reviewerModelIds: [M(1), '', ''], maxBudgetUsd: '  ',
      displayNames: { reviewers: [' 目标用户 ', '操盘手', '挑刺审核人'], summary: '主笔 ' } });
    expect(saved.review).toMatchObject({ reviewerModelIds: [M(1)], maxBudgetUsd: null,
      displayNames: { reviewers: ['目标用户', '操盘手', '挑刺审核人'], summary: '主笔' } });
  });

  it('warns about running reviews only for changes that break their later rounds', () => {
    expect(affectsRunning(value.review, { ...value.review, displayNames: { ...value.review.displayNames, summary: '总编' } })).toBe(false);
    expect(affectsRunning(value.review, { ...value.review, maxRounds: 1 })).toBe(false);
    expect(affectsRunning(value.review, { ...value.review, enabled: false })).toBe(true);
    expect(affectsRunning(value.review, { ...value.review, reviewerModelIds: [M(1), M(2), M(6)] })).toBe(true);
    expect(affectsRunning(value.review, { ...value.review, summaryModelId: M(6) })).toBe(true);
    expect(affectsRunning(value.review, { ...value.review, skillId: M(6) })).toBe(true);
    expect(runningCount([{ state: 'running' }, { state: 'paused' }, { state: 'completed' }])).toBe(2);
    expect(runningCount(null)).toBe(0);
  });

  it('turns server codes into plain words, never the raw code', () => {
    expect(settingsErrorText(new Error('FUSION_MODEL_SEARCH_DENIED'))).toContain('联网搜索');
    expect(settingsErrorText(new Error('something internal'))).toBe('暂时无法读取或保存评审团设置，请稍后再试。');
    expect(warningText('FUSION_REVIEWERS_SAME_PROVIDER')).toContain('同一家公司');
  });
});

describe('reading whole lists', () => {
  it('counts a paused review behind a full page of finished ones', async () => {
    const row = (n: number, state: string) => ({ state, createdAt: `2026-10-${String(20 - Math.floor(n / 100)).padStart(2, '0')}T00:00:00Z`,
      reviewId: `r${n}` });
    const pages = [Array.from({ length: 100 }, (_, n) => row(n, n === 3 ? 'running' : 'completed')),
      [row(100, 'completed'), row(101, 'paused')]];
    const seen: unknown[] = [];
    expect(await countRunning(async before => { seen.push(before); return pages[seen.length - 1]; })).toBe(2);
    expect(seen).toEqual([undefined, { createdAt: '2026-10-20T00:00:00Z', reviewId: 'r99' }]);
  });

  it('follows skills.list past its first 50', async () => {
    const all = Array.from({ length: 120 }, (_, n) => n);
    const offsets: number[] = [];
    const got = await allSkills(async offset => { offsets.push(offset); return { skills: all.slice(offset, offset + 50), total: 120 }; });
    expect(got).toHaveLength(120);
    expect(offsets).toEqual([0, 50, 100]);
  });
});
