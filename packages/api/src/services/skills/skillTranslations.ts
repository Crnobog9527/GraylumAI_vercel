/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { workflowSchema } from '../artifacts/workflow';
import {
  skillDisplaySource, skillDisplayTranslations, unknownTranslationKeys,
  type SkillDisplayLocale, type SkillDisplaySource, type SkillDisplayTranslations, type SkillLocaleTranslations,
} from '../../shared/skillTranslations';

/** SKILL-I18N-HOOK: the administrator's per-Skill display translations, saved on their own. */
export const SKILL_TRANSLATION_ERRORS = ['SKILL_TRANSLATIONS_UNAVAILABLE', 'SKILL_TRANSLATIONS_MODULE_NOT_FOUND',
  'SKILL_TRANSLATIONS_CONFLICT', 'SKILL_TRANSLATIONS_NOT_PUBLISHED', 'SKILL_TRANSLATIONS_UNKNOWN_KEY'] as const;

function stored(value: unknown): SkillDisplayTranslations {
  const parsed = skillDisplayTranslations.safeParse(value);
  return parsed.success ? parsed.data : {};
}

/** The module, its translations and the labels of its one enabled workflow (null before the first publication). */
export async function readSkillTranslations(db: SupabaseClient, actorId: string, moduleId: string) {
  const module = await db.from('modules').select('id,display_translations,updated_at').eq('id', moduleId).maybeSingle();
  if (module.error) throw new Error('SKILL_TRANSLATIONS_UNAVAILABLE');
  if (!module.data) throw new Error('SKILL_TRANSLATIONS_MODULE_NOT_FOUND');
  // artifact_workflows is closed to service_role (0067); 0273 reads the enabled workflow for administrators only.
  const published = await db.rpc('admin_skill_display_workflow', { p_actor_id: actorId, p_module_id: moduleId });
  if (published.error?.message === 'SKILL_TRANSLATIONS_MODULE_NOT_FOUND') throw new Error('SKILL_TRANSLATIONS_MODULE_NOT_FOUND');
  if (published.error) throw new Error('SKILL_TRANSLATIONS_UNAVAILABLE');
  let source: SkillDisplaySource | null = null;
  if (published.data !== null && published.data !== undefined) {
    const workflow = workflowSchema.safeParse(published.data);
    if (!workflow.success) throw new Error('SKILL_TRANSLATIONS_UNAVAILABLE');
    source = skillDisplaySource(workflow.data);
  }
  return { moduleId: module.data.id as string, moduleUpdatedAt: module.data.updated_at as string, source,
    translations: stored(module.data.display_translations) };
}

function compact(value: SkillLocaleTranslations): SkillLocaleTranslations | undefined {
  const fields = Object.fromEntries(Object.entries(value.fields ?? {}).filter(([, map]) => Object.keys(map).length));
  const out: SkillLocaleTranslations = {
    ...(value.reportTitle ? { reportTitle: value.reportTitle } : {}),
    ...(Object.keys(value.steps ?? {}).length ? { steps: value.steps } : {}),
    ...(Object.keys(fields).length ? { fields } : {}),
    ...(Object.keys(value.reportSections ?? {}).length ? { reportSections: value.reportSections } : {}),
  };
  return Object.keys(out).length ? out : undefined;
}

/**
 * Replaces one locale's translations. Compare-and-set on the module version the editor opened, so it never
 * overwrites a newer save; every key must name a label of the currently published workflow.
 */
export async function saveSkillTranslations(db: SupabaseClient, actorId: string, input: {
  moduleId: string; locale: SkillDisplayLocale; translations: SkillLocaleTranslations; expectedModuleUpdatedAt: string;
}) {
  const current = await readSkillTranslations(db, actorId, input.moduleId);
  if (!current.source) throw new Error('SKILL_TRANSLATIONS_NOT_PUBLISHED');
  if (unknownTranslationKeys(current.source, input.translations).length) throw new Error('SKILL_TRANSLATIONS_UNKNOWN_KEY');
  const next: SkillDisplayTranslations = { ...current.translations };
  const value = compact(input.translations);
  if (value) next[input.locale] = value; else delete next[input.locale];
  const result = await db.from('modules')
    .update({ display_translations: next, updated_at: new Date().toISOString() })
    .eq('id', input.moduleId).eq('updated_at', input.expectedModuleUpdatedAt).select('id,display_translations,updated_at');
  if (result.error) throw new Error('SKILL_TRANSLATIONS_UNAVAILABLE');
  if (result.data?.length !== 1) throw new Error('SKILL_TRANSLATIONS_CONFLICT');
  // The version comes from this conditional write itself, never from a later read another save could move.
  const row = result.data[0]!;
  return { moduleId: row.id as string, moduleUpdatedAt: row.updated_at as string, source: current.source,
    translations: stored(row.display_translations) };
}
