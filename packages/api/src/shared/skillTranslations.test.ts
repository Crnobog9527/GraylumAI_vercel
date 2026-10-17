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

const e = (original: string, text: string) => ({ original, text });

it('shows translations where they exist and the Chinese original everywhere else', () => {
  const english = localizedSkillLabels(source, { en: { reportTitle: e('账号定位报告', 'Positioning report'),
    steps: { 'step-1': e('了解你', 'About you') }, fields: { 'step-1': { goal: e('目标', 'Goal') } },
    reportSections: { 执行方案: 'Action plan' } } }, 'en');
  expect(english).toEqual({ reportTitle: 'Positioning report', reportSections: ['定位结论', 'Action plan'], steps: [
    { id: 'step-1', title: 'About you', fields: [{ id: 'goal', title: 'Goal' }, { id: 'time', title: '可投入时间' }] },
    { id: 'step-2', title: '诊断与平台对标', fields: [] },
  ] });
});

it('returns the originals without a locale, without translations, and ignores keys of an older workflow', () => {
  const translations = { en: { steps: { 'step-1': e('了解你', 'About you'), 'step-9': e('旧步骤', 'Removed step') },
    fields: { 'step-9': { x: e('旧', 'Old') } } } };
  expect(localizedSkillLabels(source, translations, undefined)).toBe(source);
  expect(localizedSkillLabels(source, null, 'en')).toBe(source);
  expect(localizedSkillLabels(source, {}, 'en')).toBe(source);
  const english = localizedSkillLabels(source, translations, 'en');
  expect(english.steps.map(step => step.title)).toEqual(['About you', '诊断与平台对标']);
  // Inherited object keys never count as translations.
  expect(localizedSkillLabels(skillDisplaySource({ ...workflow, steps: [{ id: 'toString', title: '原文' }] }),
    { en: { steps: {} } }, 'en').steps[0]!.title).toBe('原文');
});

it('shows the original again once a republished Skill changes the words a translation was made for', () => {
  // Same step id and field id, new Chinese wording: the old English would describe something else.
  const republished = skillDisplaySource({ ...workflow, report: { title: '定位方案' }, steps: [
    { id: 'step-1', title: '认识你', information: [{ id: 'goal', title: '最想达成的目标' }, { id: 'time', title: '可投入时间' }] },
  ] });
  const english = localizedSkillLabels(republished, { en: { reportTitle: e('账号定位报告', 'Positioning report'),
    steps: { 'step-1': e('了解你', 'About you') }, fields: { 'step-1': { goal: e('目标', 'Goal'), time: e('可投入时间', 'Time') } } } }, 'en');
  expect(english.reportTitle).toBe('定位方案');
  expect(english.steps[0]).toEqual({ id: 'step-1', title: '认识你',
    fields: [{ id: 'goal', title: '最想达成的目标' }, { id: 'time', title: 'Time' }] });
});

it('names every key that does not match the current workflow, or was made for different words', () => {
  expect(unknownTranslationKeys(source, { reportTitle: e('账号定位报告', 'R'), steps: { 'step-1': e('了解你', 'A') },
    fields: { 'step-1': { goal: e('目标', 'G') } }, reportSections: { 定位结论: 'C' } })).toEqual([]);
  expect(unknownTranslationKeys(source, { reportTitle: e('旧标题', 'R'), steps: { 'step-3': e('了解你', 'A'), 'step-2': e('旧', 'B') },
    fields: { 'step-2': { goal: e('目标', 'G') }, 'step-1': { nope: e('目标', 'N'), time: e('时间', 'T') } },
    reportSections: { 不存在: 'C' } })).toEqual(['reportTitle', 'steps.step-3', 'steps.step-2', 'fields.step-2.goal',
    'fields.step-1.nope', 'fields.step-1.time', 'reportSections.不存在']);
});

it('accepts only single-line labels of at most 160 characters, and only known locales and keys', () => {
  expect(skillLocaleTranslations.safeParse({ steps: { 'step-1': e('了解你', '  About you ') } }).data)
    .toEqual({ steps: { 'step-1': e('了解你', 'About you') } });
  for (const bad of [{ steps: { 'step-1': e('了解你', '') } }, { steps: { 'step-1': e('了解你', 'a\nb') } },
    { reportTitle: e('标题', 'x'.repeat(161)) }, { steps: { 'step-1': 'About you' } }, { steps: { 'step-1': { text: 'A' } } },
    { title: 'unknown key' }]) expect(skillLocaleTranslations.safeParse(bad).success).toBe(false);
  expect(skillDisplayTranslations.safeParse({ fr: {} }).success).toBe(false);
  expect(skillDisplayTranslations.safeParse({ en: { reportTitle: e('标题', 'Report') } }).success).toBe(true);
});

it('the largest translation set a valid workflow allows fits the 2 MB database limit (0273)', () => {
  // workflowSchema maxima: 32 steps x 24 fields, 64 report sections, ids up to 64 characters, labels up to 160
  // UTF-16 units (at most 3 UTF-8 bytes each); jsonb text adds a space after every ':' and ','.
  const label = (n: number) => String(n).padStart(160, '汉');
  const id = (n: number) => 'a' + String(n).padStart(63, '0');
  const steps = Array.from({ length: 32 }, (_, s) => ({ id: id(s), title: label(s),
    information: Array.from({ length: 24 }, (_, f) => ({ id: id(f), title: label(1000 + f) })) }));
  const largest = skillDisplaySource({ steps, report: { title: label(9) },
    reportGeneration: { sections: Array.from({ length: 64 }, (_, i) => label(2000 + i)) } });
  const e = (original: string) => ({ original, text: label(7) });
  const value = skillLocaleTranslations.parse({ reportTitle: e(largest.reportTitle),
    steps: Object.fromEntries(largest.steps.map(step => [step.id, e(step.title)])),
    fields: Object.fromEntries(largest.steps.map(step => [step.id, Object.fromEntries(step.fields.map(f => [f.id, e(f.title)]))])),
    reportSections: Object.fromEntries(largest.reportSections.map(title => [title, label(8)])) });
  expect(unknownTranslationKeys(largest, value)).toEqual([]);
  const json = JSON.stringify({ en: value });
  const separators = (json.match(/[:,]/g) ?? []).length;
  expect(Buffer.byteLength(json) + separators).toBeLessThan(2097152);
});

it('refuses __proto__ as a key instead of dropping it, and shows that label untranslated', () => {
  expect(skillLocaleTranslations.safeParse(JSON.parse('{"reportSections":{"__proto__":"Odd title"}}')).success).toBe(false);
  expect(skillLocaleTranslations.safeParse({ steps: { ['__proto__']: { original: 'x', text: 'y' } } }).success).toBe(false);
  expect(skillLocaleTranslations.safeParse(JSON.parse('{"fields":{"step-1":{"__proto__":{"original":"x","text":"y"}}}}')).success)
    .toBe(false);
  expect(localizedSkillLabels({ reportTitle: 'R', steps: [], reportSections: ['__proto__'] },
    { en: { reportSections: { 定位结论: 'x' } } }, 'en').reportSections).toEqual(['__proto__']);
});
