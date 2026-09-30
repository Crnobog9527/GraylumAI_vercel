/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import {
  budgetErrorMessage, describeLegacy, draftProblems, fieldProblem, toBudgetDraft, toBudgetInput,
  translateValidationMessage,
} from './mentorBudgetDraft';
import { configuredView, legacyView } from './mentorBudgetFixtures';

describe('mentor budget draft', () => {
  it('starts empty without a stored config instead of inventing defaults', () => {
    const draft = toBudgetDraft(legacyView);
    expect(draft.interactive).toEqual({ inputBytes: '', maxOutputTokens: '', historyItems: '' });
    expect(draft.organize).toEqual({ inputBytes: '', historyItems: '' });
    expect(draftProblems(legacyView, draft)).toHaveLength(8);
  });

  it('round-trips a stored config into the complete strict update object', () => {
    const input = toBudgetInput(toBudgetDraft(configuredView));
    expect(input).toEqual(configuredView.config);
    expect(input.organize).not.toHaveProperty('maxOutputTokens');
    expect(draftProblems(configuredView, toBudgetDraft(configuredView))).toEqual([]);
  });

  it('checks each field against the server-provided caps and the schema bounds', () => {
    const draft = toBudgetDraft(configuredView);
    const edit = (patch: Partial<typeof draft.interactive>) => ({ ...draft, interactive: { ...draft.interactive, ...patch } });
    expect(fieldProblem(configuredView, edit({ inputBytes: '90000' }), 'interactive', 'inputBytes')).toBeNull();
    expect(fieldProblem(configuredView, edit({ inputBytes: '90001' }), 'interactive', 'inputBytes')).toBe('不能超过系统上限 90000 字节');
    expect(fieldProblem(configuredView, edit({ inputBytes: '1023' }), 'interactive', 'inputBytes')).toBe('不能小于 1024 字节');
    expect(fieldProblem(configuredView, edit({ maxOutputTokens: '3585' }), 'interactive', 'maxOutputTokens'))
      .toBe('不能超过系统上限 3584 token');
    expect(fieldProblem(configuredView, edit({ maxOutputTokens: '0' }), 'interactive', 'maxOutputTokens')).toBe('不能小于 1 token');
    expect(fieldProblem(configuredView, edit({ historyItems: '1.5' }), 'interactive', 'historyItems')).toBe('请填写不带小数的非负整数');
    expect(fieldProblem(configuredView, edit({ historyItems: '-1' }), 'interactive', 'historyItems')).toBe('请填写不带小数的非负整数');
    expect(fieldProblem(configuredView, edit({ historyItems: '0' }), 'interactive', 'historyItems')).toBeNull();
    const organize = { ...draft, organize: { inputBytes: '112000', historyItems: '1001' } };
    expect(fieldProblem(configuredView, organize, 'organize', 'inputBytes')).toBeNull();
    expect(fieldProblem(configuredView, organize, 'organize', 'historyItems')).toBe('不能超过系统上限 1000 条');
  });

  it('translates server validation issues into Chinese per purpose and field', () => {
    const message = JSON.stringify([
      { code: 'too_big', maximum: 3584, path: ['report', 'maxOutputTokens'], message: 'Too big' },
      { code: 'unrecognized_keys', keys: ['maxOutputTokens'], path: ['organize'], message: 'Unrecognized key' },
      { code: 'invalid_type', expected: 'int', path: ['interactive', 'historyItems'], message: 'Invalid input' },
    ]);
    expect(translateValidationMessage(message)).toBe(
      '报告（预留） · 回答上限（token）：不能超过 3584；整理：包含不支持的字段：maxOutputTokens；交互对话 · 历史条数上限：必须是整数');
    expect(budgetErrorMessage({ message, data: { code: 'BAD_REQUEST' } }, '保存失败')).toMatch(/^服务端拒绝保存：报告/);
  });

  it('keeps Chinese server messages and hides unsafe internals', () => {
    expect(budgetErrorMessage({ message: '无法保存用途预算，请稍后重试', data: { code: 'INTERNAL_SERVER_ERROR' } }, '保存失败'))
      .toBe('无法保存用途预算，请稍后重试');
    expect(budgetErrorMessage({ message: 'Admin role required.', data: { code: 'FORBIDDEN' } }, '保存失败')).toBe('保存失败');
    expect(budgetErrorMessage({ message: 'not json', data: { code: 'BAD_REQUEST' } }, '保存失败')).toBe('not json');
  });

  it('describes the legacy behavior from the server fields in Chinese', () => {
    const lines = describeLegacy(legacyView).join('\n');
    expect(lines).toContain('输入上限 64000 字节，历史 100 条');
    expect(lines).toContain('“批准报价输出上限、模型输出上限、20000”三者中最小的');
    expect(lines).toContain('测试替身固定 1000 token');
    expect(lines).toContain('报告：尚未启用');
    expect(lines).not.toContain('字数');
  });
});
