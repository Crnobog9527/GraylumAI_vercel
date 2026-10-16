/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import {
  localizedSkillLabels, skillDisplaySource, skillDisplayTranslations, skillLocaleTranslations, unknownTranslationKeys,
} from './skillTranslations';

const workflow = {
  steps: [
    { id: 'step-1', title: '了解你', information: [{ id: 'goal', title: '目标' }, { id: 'time', title: '可投入时间' }] },
    { id: 'step-2', title: '诊断与平台对标' },
  ],
  report: { title: '账号定位报告' },
  reportGeneration: { sections: ['定位结论', '执行方案'] },
};
const source = skillDisplaySource(workflow);

it('lists the labels users see, in display order', () => {
  expect(source).toEqual({ reportTitle: '账号定位报告', reportSections: ['定位结论', '执行方案'], steps: [
    { id: 'step-1', title: '了解你', fields: [{ id: 'goal', title: '目标' }, { id: 'time', title: '可投入时间' }] },
    { id: 'step-2', title: '诊断与平台对标', fields: [] },
  ] });
  expect(skillDisplaySource({ ...workflow, reportGeneration: undefined }).reportSections).toEqual([]);
});

it('shows translations where they exist and the Chinese original everywhere else', () => {
  const english = localizedSkillLabels(source, { en: { reportTitle: 'Positioning report', steps: { 'step-1': 'About you' },
    fields: { 'step-1': { goal: 'Goal' } }, reportSections: { 执行方案: 'Action plan' } } }, 'en');
  expect(english).toEqual({ reportTitle: 'Positioning report', reportSections: ['定位结论', 'Action plan'], steps: [
    { id: 'step-1', title: 'About you', fields: [{ id: 'goal', title: 'Goal' }, { id: 'time', title: '可投入时间' }] },
    { id: 'step-2', title: '诊断与平台对标', fields: [] },
  ] });
});

it('returns the originals without a locale, without translations, and ignores keys of an older workflow', () => {
  const translations = { en: { steps: { 'step-1': 'About you', 'step-9': 'Removed step' }, fields: { 'step-9': { x: 'Old' } } } };
  expect(localizedSkillLabels(source, translations, undefined)).toBe(source);
  expect(localizedSkillLabels(source, null, 'en')).toBe(source);
  expect(localizedSkillLabels(source, {}, 'en')).toBe(source);
  const english = localizedSkillLabels(source, translations, 'en');
  expect(english.steps.map(step => step.title)).toEqual(['About you', '诊断与平台对标']);
  // Inherited object keys never count as translations.
  expect(localizedSkillLabels(skillDisplaySource({ ...workflow, steps: [{ id: 'toString', title: '原文' }] }),
    { en: { steps: {} } }, 'en').steps[0]!.title).toBe('原文');
});

it('names every key that does not match the current workflow', () => {
  expect(unknownTranslationKeys(source, { steps: { 'step-1': 'A' }, fields: { 'step-1': { goal: 'G' } },
    reportSections: { 定位结论: 'C' } })).toEqual([]);
  expect(unknownTranslationKeys(source, { steps: { 'step-3': 'A' }, fields: { 'step-2': { goal: 'G' }, 'step-1': { nope: 'N' } },
    reportSections: { 不存在: 'C' } })).toEqual(['steps.step-3', 'fields.step-2.goal', 'fields.step-1.nope', 'reportSections.不存在']);
});

it('accepts only single-line labels of at most 160 characters, and only known locales and keys', () => {
  expect(skillLocaleTranslations.safeParse({ steps: { 'step-1': '  About you ' } }).data).toEqual({ steps: { 'step-1': 'About you' } });
  for (const bad of [{ steps: { 'step-1': '' } }, { steps: { 'step-1': 'a\nb' } }, { reportTitle: 'x'.repeat(161) },
    { title: 'unknown key' }]) expect(skillLocaleTranslations.safeParse(bad).success).toBe(false);
  expect(skillDisplayTranslations.safeParse({ fr: {} }).success).toBe(false);
  expect(skillDisplayTranslations.safeParse({ en: { reportTitle: 'Report' } }).success).toBe(true);
});
