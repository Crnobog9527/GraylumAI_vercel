/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { isReportModelConflict, modelLabel, reportModelChoices, reportModelErrorText } from './reportModelView';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

it('maps every stable code to plain text and unknown errors to the config text', () => {
  expect(reportModelErrorText(new Error('REPORT_MODEL_PRICING_UNAVAILABLE'))).toContain('报价');
  expect(reportModelErrorText(new Error('REPORT_MODEL_CONFLICT'))).toContain('重新读取');
  expect(reportModelErrorText(new Error('raw server text'))).toBe(reportModelErrorText(new Error('REPORT_MODEL_CONFIG_UNAVAILABLE')));
  expect(reportModelErrorText(new Error('toString'))).not.toContain('function');
  expect(isReportModelConflict(new Error('REPORT_MODEL_CONFLICT'))).toBe(true);
  expect(isReportModelConflict(new Error('REPORT_MODEL_UNAVAILABLE'))).toBe(false);
});

it('labels models from the known lists and never guesses an unknown one', () => {
  expect(modelLabel(A, [{ id: A, name: '模型 甲' }])).toBe('模型 甲');
  expect(modelLabel(B, undefined, [{ id: B, name: '模型 乙' }])).toBe('模型 乙');
  expect(modelLabel(null)).toBe('未设置');
  expect(modelLabel(B, [])).toBe('未知模型（22222222）');
});

it('keeps a saved model that dropped out of the eligible list visible but not selectable', () => {
  expect(reportModelChoices([{ id: A, name: '甲' }], B, [{ id: B, name: '乙' }])).toEqual([
    { id: A, name: '甲', disabled: false }, { id: B, name: '乙（当前不可选）', disabled: true },
  ]);
  expect(reportModelChoices([{ id: A, name: '甲' }], A, undefined)).toEqual([{ id: A, name: '甲', disabled: false }]);
});
