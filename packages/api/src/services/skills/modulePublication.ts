/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { packageHash, packageHashPayload, sha256, type PackageDescriptor } from './loader';
import { validatePublication } from './publication';
import { validateWorkflow } from '../artifacts/workflow';
import { summaryModelOption } from '../artifacts/modelPolicy';

const label = z.string().trim().min(1).max(160).regex(/^[^\r\n\x00-\x1f]+$/);
export const moduleSkillInput = z.object({
  moduleId: z.string().uuid(), skillId: z.string().uuid(), revisionId: z.string().uuid(), requestId: z.string().uuid(),
  expectedUpdatedAt: z.string().nullable(), expectedVersion: z.number().int().min(0),
  kind: z.enum(['document', 'social']),
  directoryName: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64),
  files: z.array(z.object({ path: z.string().max(240), base64: z.string().max(2_800_000) }).strict()).min(1).max(64),
  steps: z.array(z.object({ title: label, resources: z.array(z.string().max(240)).min(1).max(64) }).strict()).min(1).max(32),
  resourcePlanReviewed: z.literal(true),
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
    report: { id: 'confirmed-report', version: input.expectedVersion + 1, title: input.module.title,
      sections: steps.map(step => ({ title: step.title, stepId: step.id })) },
  }, descriptor);
  return { ...publication, workflow };
}

export async function saveModuleSkill(db: SupabaseClient, actorId: string, value: ModuleSkillInput) {
  const prepared = prepareModuleSkill(value);
  const model = await db.from('ai_models').select('id,name,model_id,provider,is_active,max_tokens,input_limit,api_key,api_endpoint,token_counting_supported,tokenizer_family').eq('id',value.module.model_id).single();
  if(model.error || !model.data) throw new Error('请选择已配置的对话模型');
  const option=summaryModelOption(model.data);
  if(!option.available) throw new Error(option.reason ?? '对话模型配置不完整');
  const { descriptor, files, workflow } = prepared;
  const { data, error } = await db.rpc('admin_publish_skill_module', {
    p_actor_id: actorId, p_module_id: value.moduleId, p_expected_updated_at: value.expectedUpdatedAt,
    p_metadata: value.module, p_skill_id: value.skillId, p_revision_id: value.revisionId,
    p_request_id: value.requestId, p_expected_version: value.expectedVersion,
    p_manifest: descriptor, p_hash_payload: packageHashPayload(descriptor), p_files: files, p_workflow: workflow,
  });
  if (error || !data) throw new Error('Skill 发布未完成，请重新读取模块，检查版本和模型后再发布。');
  return data as { moduleId: string; revisionId: string; version: number };
}
