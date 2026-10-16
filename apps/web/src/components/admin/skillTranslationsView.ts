/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SkillDisplaySource, SkillLocaleTranslations } from '../../../../../packages/api/src/shared/skillTranslations';

/** SKILL-I18N-HOOK admin view helpers; the server re-checks every save. */
const ERRORS: Record<string, string> = {
  SKILL_TRANSLATIONS_UNAVAILABLE: '暂时无法读取或保存英文对照，请稍后再试。',
  SKILL_TRANSLATIONS_MODULE_NOT_FOUND: '找不到这个功能模块，可能已被删除，请刷新页面。',
  SKILL_TRANSLATIONS_CONFLICT: '这个模块在你打开窗口后被改过（可能是英文对照，也可能是其他内容）。请关闭窗口重新打开，看到最新内容后再保存。',
  SKILL_TRANSLATIONS_NOT_PUBLISHED: '这个 Skill 还没有发布，发布后才能填写英文对照。',
  SKILL_TRANSLATIONS_UNKNOWN_KEY: 'Skill 的步骤或字段在你打开窗口后变了。请关闭窗口重新打开后再填写。',
};

/** Plain text for the stable codes; never the raw code or server text. */
export function skillTranslationsErrorText(error: unknown) {
  const code = error && typeof error === 'object' && 'message' in error ? String(error.message) : '';
  return Object.hasOwn(ERRORS, code) ? ERRORS[code] : ERRORS.SKILL_TRANSLATIONS_UNAVAILABLE;
}

/** One row per translatable label: the form key, what it is, and the Chinese original. */
export type TranslationRow = { key: string; kind: string; original: string };
export type TranslationDraft = Record<string, string>;

export function translationRows(source: SkillDisplaySource): TranslationRow[] {
  return [
    { key: 'reportTitle', kind: '报告标题', original: source.reportTitle },
    ...source.steps.flatMap((step, index) => [
      { key: `step:${step.id}`, kind: `第 ${index + 1} 步名称`, original: step.title },
      ...step.fields.map(field => ({ key: `field:${step.id}:${field.id}`, kind: `第 ${index + 1} 步字段`, original: field.title })),
    ]),
    ...source.reportSections.map((title, index) => ({ key: `section:${index}`, kind: '报告章节标题', original: title })),
  ];
}

/** The saved English translations as form values; labels without one start empty. */
export function draftFrom(source: SkillDisplaySource, saved: SkillLocaleTranslations | undefined): TranslationDraft {
  const draft: TranslationDraft = {};
  const put = (key: string, value: string | undefined) => { if (value) draft[key] = value; };
  const own = (record: Record<string, string> | undefined, name: string) =>
    record && Object.hasOwn(record, name) ? record[name] : undefined;
  put('reportTitle', saved?.reportTitle);
  for (const step of source.steps) {
    put(`step:${step.id}`, own(saved?.steps, step.id));
    const fields = saved?.fields && Object.hasOwn(saved.fields, step.id) ? saved.fields[step.id] : undefined;
    for (const field of step.fields) put(`field:${step.id}:${field.id}`, own(fields, field.id));
  }
  source.reportSections.forEach((title, index) => put(`section:${index}`, own(saved?.reportSections, title)));
  return draft;
}

/** The save payload: trimmed, empty inputs dropped (they fall back to the Chinese original). */
export function translationsFrom(source: SkillDisplaySource, draft: TranslationDraft): SkillLocaleTranslations {
  const value = (key: string) => draft[key]?.trim() || undefined;
  const steps: Record<string, string> = {};
  const fields: Record<string, Record<string, string>> = {};
  const reportSections: Record<string, string> = {};
  for (const step of source.steps) {
    const title = value(`step:${step.id}`);
    if (title) steps[step.id] = title;
    for (const field of step.fields) {
      const text = value(`field:${step.id}:${field.id}`);
      if (text) (fields[step.id] ??= {})[field.id] = text;
    }
  }
  source.reportSections.forEach((title, index) => {
    const text = value(`section:${index}`);
    if (text) reportSections[title] = text;
  });
  const reportTitle = value('reportTitle');
  return { ...(reportTitle ? { reportTitle } : {}), ...(Object.keys(steps).length ? { steps } : {}),
    ...(Object.keys(fields).length ? { fields } : {}), ...(Object.keys(reportSections).length ? { reportSections } : {}) };
}

/** Same rule as the server: one line, at most 160 characters. Returns the first bad row's original, if any. */
export function invalidTranslation(rows: TranslationRow[], draft: TranslationDraft): TranslationRow | undefined {
  return rows.find(row => {
    const text = draft[row.key]?.trim();
    // eslint-disable-next-line no-control-regex
    return text ? text.length > 160 || /[\r\n\x00-\x1f]/.test(text) : false;
  });
}
