/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { draftFrom, invalidTranslation, skillTranslationsErrorText, translationRows, translationsFrom } from './skillTranslationsView';

const source = { reportTitle: '账号定位报告', reportSections: ['定位结论'], steps: [
  { id: 'step-1', title: '了解你', fields: [{ id: 'goal', title: '目标' }] },
  { id: 'step-2', title: '诊断', fields: [] },
] };

it('lists every label with its Chinese original', () => {
  expect(translationRows(source)).toEqual([
    { key: 'reportTitle', kind: '报告标题', original: '账号定位报告' },
    { key: 'step:step-1', kind: '第 1 步名称', original: '了解你' },
    { key: 'field:step-1:goal', kind: '第 1 步字段', original: '目标' },
    { key: 'step:step-2', kind: '第 2 步名称', original: '诊断' },
    { key: 'section:0', kind: '报告章节标题', original: '定位结论' },
  ]);
});

it('round-trips saved translations and drops empty inputs', () => {
  const saved = { reportTitle: 'Report', steps: { 'step-1': 'About you' }, fields: { 'step-1': { goal: 'Goal' } },
    reportSections: { 定位结论: 'Positioning' } };
  const draft = draftFrom(source, saved);
  expect(draft).toEqual({ reportTitle: 'Report', 'step:step-1': 'About you', 'field:step-1:goal': 'Goal', 'section:0': 'Positioning' });
  expect(translationsFrom(source, draft)).toEqual(saved);
  expect(translationsFrom(source, { ...draft, reportTitle: '  ', 'field:step-1:goal': '' }))
    .toEqual({ steps: { 'step-1': 'About you' }, reportSections: { 定位结论: 'Positioning' } });
  expect(translationsFrom(source, { 'step:step-2': ' Diagnosis ' })).toEqual({ steps: { 'step-2': 'Diagnosis' } });
  expect(draftFrom(source, undefined)).toEqual({});
});

it('flags multi-line or over-long inputs before saving', () => {
  const rows = translationRows(source);
  expect(invalidTranslation(rows, { 'step:step-1': 'ok' })).toBeUndefined();
  expect(invalidTranslation(rows, { 'step:step-1': 'a\nb' })?.original).toBe('了解你');
  expect(invalidTranslation(rows, { reportTitle: 'x'.repeat(161) })?.original).toBe('账号定位报告');
});

it('maps every stable code to plain text and unknown errors to the generic text', () => {
  expect(skillTranslationsErrorText(new Error('SKILL_TRANSLATIONS_CONFLICT'))).toContain('重新打开');
  expect(skillTranslationsErrorText(new Error('SKILL_TRANSLATIONS_NOT_PUBLISHED'))).toContain('还没有发布');
  expect(skillTranslationsErrorText(new Error('SKILL_TRANSLATIONS_UNKNOWN_KEY'))).toContain('步骤或字段');
  expect(skillTranslationsErrorText(new Error('raw server text')))
    .toBe(skillTranslationsErrorText(new Error('SKILL_TRANSLATIONS_UNAVAILABLE')));
  expect(skillTranslationsErrorText(new Error('toString'))).not.toContain('function');
});
