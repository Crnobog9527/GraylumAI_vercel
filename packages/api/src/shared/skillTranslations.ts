/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';

/**
 * SKILL-I18N-HOOK (Owner 2026-10-12): a Skill's published workflow stays in Simplified Chinese, the only
 * original. Administrators may add display translations for the text users see (step names, field names,
 * the report title and report section titles); a missing or outdated translation falls back to the original.
 * Question-card options are written by the model per turn and follow the reply-language rule instead.
 */
export const SKILL_DISPLAY_LOCALES = ['en'] as const;
export type SkillDisplayLocale = typeof SKILL_DISPLAY_LOCALES[number];

const text = z.string().trim().min(1).max(160).regex(/^[^\r\n\x00-\x1f]+$/);
// `__proto__` can never be an own key of a parsed record, so a label with that exact text is not translatable
// (it always shows the original) instead of being dropped silently.
export const UNTRANSLATABLE_KEY = '__proto__';
const key = z.string().min(1).max(160);
// zod drops such a key while parsing a record, so refuse the raw input before it gets there.
const record = <T extends z.ZodType>(value: T) => z.preprocess(
  raw => (raw && typeof raw === 'object' && Object.hasOwn(raw, UNTRANSLATABLE_KEY) ? null : raw), z.record(key, value));
// Each translation records the original it translates; when a republished Skill changes that text, it no
// longer matches and the original shows again instead of a translation of different words.
const entry = z.object({ original: key, text }).strict();
export type SkillTranslationEntry = z.infer<typeof entry>;
export const skillLocaleTranslations = z.object({
  reportTitle: entry.optional(),
  steps: record(entry).optional(),
  fields: record(record(entry)).optional(),
  // Report sections have no id; they are keyed by their original title (reportGeneration.sections).
  reportSections: record(text).optional(),
}).strict();
export type SkillLocaleTranslations = z.infer<typeof skillLocaleTranslations>;
export const skillDisplayTranslations = z.object({ en: skillLocaleTranslations.optional() }).strict();
export type SkillDisplayTranslations = z.infer<typeof skillDisplayTranslations>;

/** The labels of a published workflow that may carry a translation, in display order. */
export type SkillDisplaySource = {
  reportTitle: string;
  steps: { id: string; title: string; fields: { id: string; title: string }[] }[];
  reportSections: string[];
};

type WorkflowLike = {
  steps: { id: string; title: string; information?: { id: string; title: string }[] }[];
  report: { title: string };
  reportGeneration?: { sections: string[] };
};

export function skillDisplaySource(workflow: WorkflowLike): SkillDisplaySource {
  return {
    reportTitle: workflow.report.title,
    steps: workflow.steps.map(step => ({ id: step.id, title: step.title,
      fields: (step.information ?? []).map(field => ({ id: field.id, title: field.title })) })),
    reportSections: workflow.reportGeneration?.sections ?? [],
  };
}

const own = <T>(record: Record<string, T> | undefined, name: string) =>
  record && Object.hasOwn(record, name) ? record[name] : undefined;
/** The translation of `original`, only while it was made for exactly that text. */
const matching = (value: SkillTranslationEntry | undefined, original: string) =>
  value && value.original === original ? value.text : undefined;

/** Translations that do not name a label of this workflow, or were made for different words (empty when all match). */
export function unknownTranslationKeys(source: SkillDisplaySource, value: SkillLocaleTranslations): string[] {
  const steps = new Map(source.steps.map(step => [step.id, step]));
  const sections = new Set(source.reportSections);
  return [
    ...(value.reportTitle && value.reportTitle.original !== source.reportTitle ? ['reportTitle'] : []),
    ...Object.entries(value.steps ?? {}).filter(([id, item]) => steps.get(id)?.title !== item.original).map(([id]) => `steps.${id}`),
    ...Object.entries(value.fields ?? {}).flatMap(([stepId, fields]) => Object.entries(fields)
      .filter(([id, item]) => steps.get(stepId)?.fields.find(field => field.id === id)?.title !== item.original)
      .map(([id]) => `fields.${stepId}.${id}`)),
    ...Object.keys(value.reportSections ?? {}).filter(title => !sections.has(title)).map(title => `reportSections.${title}`),
  ];
}

/**
 * The labels to show for a locale: the translation when one exists for the current workflow, otherwise the
 * original. `undefined` locale (or Chinese) always returns the originals. A translation made for different
 * words (the Skill was republished with a changed label) is ignored. Never changes ids or stored text.
 */
export function localizedSkillLabels(source: SkillDisplaySource, translations: SkillDisplayTranslations | null | undefined,
  locale: SkillDisplayLocale | undefined): SkillDisplaySource {
  const value = locale ? translations?.[locale] : undefined;
  if (!value) return source;
  return {
    reportTitle: matching(value.reportTitle, source.reportTitle) ?? source.reportTitle,
    steps: source.steps.map(step => {
      const fields = own(value.fields, step.id);
      return { id: step.id, title: matching(own(value.steps, step.id), step.title) ?? step.title,
        fields: step.fields.map(field => ({ id: field.id, title: matching(own(fields, field.id), field.title) ?? field.title })) };
    }),
    reportSections: source.reportSections.map(title => own(value.reportSections, title) ?? title),
  };
}
