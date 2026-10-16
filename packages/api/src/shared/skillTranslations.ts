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
const key = z.string().min(1).max(160);
export const skillLocaleTranslations = z.object({
  reportTitle: text.optional(),
  steps: z.record(key, text).optional(),
  fields: z.record(key, z.record(key, text)).optional(),
  // Report sections have no id; they are keyed by their original title (reportGeneration.sections).
  reportSections: z.record(key, text).optional(),
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

const own = (record: Record<string, string> | undefined, name: string) =>
  record && Object.hasOwn(record, name) ? record[name] : undefined;

/** Translation keys that do not name a label of this workflow (empty when every key matches). */
export function unknownTranslationKeys(source: SkillDisplaySource, value: SkillLocaleTranslations): string[] {
  const steps = new Map(source.steps.map(step => [step.id, new Set(step.fields.map(field => field.id))]));
  const sections = new Set(source.reportSections);
  return [
    ...Object.keys(value.steps ?? {}).filter(id => !steps.has(id)).map(id => `steps.${id}`),
    ...Object.entries(value.fields ?? {}).flatMap(([stepId, fields]) => Object.keys(fields)
      .filter(id => !steps.get(stepId)?.has(id)).map(id => `fields.${stepId}.${id}`)),
    ...Object.keys(value.reportSections ?? {}).filter(title => !sections.has(title)).map(title => `reportSections.${title}`),
  ];
}

/**
 * The labels to show for a locale: the translation when one exists for the current workflow, otherwise the
 * original. `undefined` locale (or Chinese) always returns the originals. Never changes ids or stored text.
 */
export function localizedSkillLabels(source: SkillDisplaySource, translations: SkillDisplayTranslations | null | undefined,
  locale: SkillDisplayLocale | undefined): SkillDisplaySource {
  const value = locale ? translations?.[locale] : undefined;
  if (!value) return source;
  return {
    reportTitle: value.reportTitle ?? source.reportTitle,
    steps: source.steps.map(step => {
      const fields = value.fields && Object.hasOwn(value.fields, step.id) ? value.fields[step.id] : undefined;
      return { id: step.id, title: own(value.steps, step.id) ?? step.title,
        fields: step.fields.map(field => ({ id: field.id, title: own(fields, field.id) ?? field.title })) };
    }),
    reportSections: source.reportSections.map(title => own(value.reportSections, title) ?? title),
  };
}
