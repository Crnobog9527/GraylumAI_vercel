/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { validateOrganizerTemplate } from './organizerTemplate';
import { reportManifest } from '../report/contract';
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import type { SupabaseClient } from '@supabase/supabase-js';
import { packageHash, packageHashPayload, sha256, type PackageDescriptor } from './loader';
import { validatePublication } from './publication';
import { validateWorkflow,informationSchema } from '../artifacts/workflow';
import { RUNTIME_MODEL_COLUMNS, runtimeModelOption } from '../models/runtimeEligibility';
import { parseWorkflowManifest, workflowManifestPath } from './workflowManifest';
import { readSocialMediaFlag, saveSocialMediaFlag } from './socialMediaFlag';
import { isPositioningWorkflow } from '../opc/positioningWorkflow';

const label = z.string().trim().min(1).max(160).regex(/^[^\r\n\x00-\x1f]+$/);
export const moduleSkillInput = z.object({
  moduleId: z.string().uuid(), skillId: z.string().uuid(), revisionId: z.string().uuid(), requestId: z.string().uuid(),
  expectedUpdatedAt: z.string().nullable(), expectedVersion: z.number().int().min(0),
  kind: z.enum(['document', 'social']),
  directoryName: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64),
  files: z.array(z.object({ path: z.string().max(240), base64: z.string().max(2_800_000) }).strict()).min(1).max(64),
  reportGeneration:reportManifest.optional(),
  planResources:z.array(z.string().max(240)).min(1).max(64).optional(),
  steps: z.array(z.object({ title: label, information:z.array(informationSchema).max(24).optional(), resources: z.array(z.string().max(240)).min(1).max(64) }).strict()).min(1).max(32),
  resourcePlanReviewed: z.literal(true),
  /** POSITIONING-GATE: required when the module is created, so a new Skill is never enabled before this choice. */
  socialMediaRelated: z.boolean().optional(),
  module: z.object({
    title: z.string().trim().min(1).max(100), description: z.string().max(500).nullable(),
    full_description: z.string().max(5000).nullable(), model_id: z.string().uuid(),
    platform: z.enum(['all','web','mobile','desktop','api']),
    category: z.enum(['writing','marketing','video','business','education','coding','analysis','creative','other']),
    icon: z.string().max(50), image_url: z.string().max(1000).nullable(),
    badge_type: z.enum(['new','hot','recommend']).nullable(), badge_text: z.string().max(80).nullable(),
    credits_display: z.string().max(80).nullable(), sort_order: z.number().int().min(0).max(1000),
    active: z.boolean(), is_featured: z.boolean(),
    features: z.string().max(10000).nullable(), examples: z.string().max(10000).nullable(),
    preparation_questions: z.string().max(10000).nullable(),
  }).strict(),
}).strict();
export type ModuleSkillInput = z.infer<typeof moduleSkillInput>;

export function prepareModuleSkill(value: ModuleSkillInput) {
  const input = moduleSkillInput.parse(value);
  const manifestFile = input.files.find(file=>file.path===workflowManifestPath);
  if (manifestFile) {
    let manifestText: string;
    try { manifestText = new TextDecoder('utf-8',{fatal:true}).decode(Buffer.from(manifestFile.base64,'base64')); }
    catch { throw new Error('workflow.yaml 必须使用 UTF-8 编码'); }
    const {organizerTemplate, ...declared} = parseWorkflowManifest(manifestText);
    if (organizerTemplate !== undefined) {
      const file = input.files.find(item => item.path === organizerTemplate);
      if (!file) throw new Error('SKILL_ORGANIZER_TEMPLATE_INVALID');
      validateOrganizerTemplate(organizerTemplate, Buffer.from(file.base64, 'base64'));
    }
    if (!isDeepStrictEqual(declared,JSON.parse(JSON.stringify({kind:input.kind,steps:input.steps,
      planResources:input.planResources,reportGeneration:input.reportGeneration}))))
      throw new Error('workflow.yaml 与提交的步骤或问题不一致，请重新导入 Skill 文件夹');
  }
  const descriptor: PackageDescriptor = {
    packageId: input.skillId, revisionId: input.revisionId, directoryName: input.directoryName,
    packageHash: '', tasks: {}, requiredCapabilities: ['documents.read'],
    files: input.files.map(f => { const bytes = Buffer.from(f.base64, 'base64'); return {
      path: f.path, bytes: bytes.length, sha256: sha256(bytes), mediaType: (f.path.endsWith('.md') ? 'text/markdown' : 'text/yaml') as 'text/markdown' | 'text/yaml', requires: [],
    }; }),
  };
  descriptor.packageHash = packageHash(descriptor);
  const publication = validatePublication({ id: input.skillId, revisionId: input.revisionId,
    requestId: input.requestId, expectedVersion: input.expectedVersion, resourcePlanReviewed: true,
    descriptor, files: input.files });
  // SKILL.md is always loaded by the existing loader. Resource choices are
  // explicitly reviewed by the administrator; no executable source is inferred.
  const steps = input.steps.map((step, i) => ({ ...step, id: `step-${i + 1}`,
    dependsOn: i ? [`step-${i}`] : [], minLength: 1, maxLength: 20000,
    requiresEvidence: false, requiredCapabilities: ['documents.read'],
  }));
  const workflow = validateWorkflow({ id: `module-${input.moduleId.replaceAll('-', '')}`,
    version: input.expectedVersion + 1, kind: input.kind, steps,
    ...(input.reportGeneration?{reportGeneration:input.reportGeneration}:{}),
    ...(input.planResources?{planResources:input.planResources}:{}),
    report: { id: 'confirmed-report', version: input.expectedVersion + 1, title: input.module.title,
      sections: steps.map(step => ({ title: step.title, stepId: step.id })) },
  }, descriptor);
  return { ...publication, workflow };
}

export async function saveModuleSkill(db: SupabaseClient, actorId: string, value: ModuleSkillInput) {
  const prepared = prepareModuleSkill(value);
  // POSITIONING-GATE: a module getting its first Skill (new, or a converted prompt module) needs the explicit choice;
  // a module that already has a Skill ignores it (separate setting card).
  // The editor sends the choice only for a first Skill, and an exact retry resends it: whenever present, the stated
  // choice is applied idempotently (never re-derived from the binding a partially committed first try created).
  const choice = value.socialMediaRelated;
  if (choice === undefined && (value.expectedUpdatedAt === null || !(await boundSkill(db, value.moduleId))))
    throw new Error('SOCIAL_MEDIA_FLAG_REQUIRED');
  const flag = choice === true;
  if (flag && isPositioningWorkflow(prepared.workflow)) throw new Error('SOCIAL_MEDIA_FLAG_POSITIONING_SKILL');
  // "否" clears a flag a former prompt module may carry, before publishing (the 0219 guard refuses a flagged positioning Skill).
  if (choice === false && value.expectedUpdatedAt !== null) await clearSocialFlag(db, value.moduleId);
  const model = await db.from('ai_models').select(RUNTIME_MODEL_COLUMNS).eq('id',value.module.model_id).single();
  if(model.error || !model.data) throw new Error('请选择已配置的对话模型');
  const option=runtimeModelOption(model.data,'skill');
  if(!option.available) throw new Error(option.reason ?? '对话模型配置不完整');
  const { descriptor, files, workflow } = prepared;
  const { data, error } = await db.rpc('admin_publish_skill_module', {
    p_actor_id: actorId, p_module_id: value.moduleId, p_expected_updated_at: value.expectedUpdatedAt,
    // A flagged new module is created disabled, flagged, and only then enabled as requested.
    p_metadata: flag ? { ...value.module, active: false } : value.module, p_skill_id: value.skillId, p_revision_id: value.revisionId,
    p_request_id: value.requestId, p_expected_version: value.expectedVersion,
    p_manifest: descriptor, p_hash_payload: packageHashPayload(descriptor), p_files: files, p_workflow: workflow,
  });
  // POSITIONING-GATE (0219): a module marked social-media related cannot become the positioning Skill.
  if (error?.message === 'SOCIAL_MEDIA_FLAG_POSITIONING_SKILL') throw new Error('SOCIAL_MEDIA_FLAG_POSITIONING_SKILL');
  if (error || !data) throw new Error('Skill 发布未完成，请重新读取模块，检查版本和模型后再发布。');
  const published = data as { moduleId: string; revisionId: string; version: number };
  if (flag) await flagNewModule(db, value.moduleId, value.module.active);
  return published;
}

async function boundSkill(db: SupabaseClient, moduleId: string): Promise<boolean> {
  const row = await db.from('modules').select('skill_id').eq('id', moduleId).maybeSingle();
  if (row.error) throw new Error('Skill 发布未完成，请重新读取模块，检查版本和模型后再发布。');
  return Boolean(row.data?.skill_id);
}

async function clearSocialFlag(db: SupabaseClient, moduleId: string) {
  let opened;
  try { opened = await readSocialMediaFlag(db, moduleId); }
  catch (error) { if (error instanceof Error && error.message === 'SOCIAL_MEDIA_FLAG_MODULE_NOT_FOUND') return; throw error; }
  if (!opened.socialMediaRelated) return;
  await saveSocialMediaFlag(db, { moduleId, socialMediaRelated: false, expectedSocialMediaRelated: true,
    expectedModuleUpdatedAt: opened.moduleUpdatedAt });
}

/** Any failure here leaves the new module disabled (never enabled without its flag); the administrator reopens it. */
async function flagNewModule(db: SupabaseClient, moduleId: string, active: boolean) {
  try {
    // An exact retry after a lost response finds the flag already saved: keep it and continue.
    const opened = await readSocialMediaFlag(db, moduleId);
    const version = opened.socialMediaRelated ? opened.moduleUpdatedAt : (await saveSocialMediaFlag(db, { moduleId,
      socialMediaRelated: true, expectedSocialMediaRelated: false, expectedModuleUpdatedAt: opened.moduleUpdatedAt })).moduleUpdatedAt;
    if (!active) return;
    const enabled = await db.from('modules').update({ active: true, updated_at: new Date().toISOString() })
      .eq('id', moduleId).eq('social_media_related', true).eq('updated_at', version).select('id');
    if (enabled.error || enabled.data?.length !== 1) throw new Error('SOCIAL_MEDIA_FLAG_CONFLICT');
  } catch { throw new Error('SOCIAL_MEDIA_FLAG_NEW_MODULE_INCOMPLETE'); }
}
