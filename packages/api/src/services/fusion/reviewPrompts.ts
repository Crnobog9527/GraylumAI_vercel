/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { OPINION_RESPONSE_FORMAT, REVISION_RESPONSE_FORMAT, type Opinion, type StepValues } from './hostChecks';
import type { FusionRequest } from './request';

/** Files of the review Skill package (FUSION-REVIEW §4.3). Their text is private and published through the
 * existing Skill upload; this repository only knows the paths. */
export const REVIEW_SKILL_FILES = { reviewer: 'reviewer.md', summary: 'summary.md', rubric: 'rubric.md' } as const;
export type ReviewSkill = { skillId: string; revisionId: string; packageHash: string };
export type ReviewSkillText = { reviewer: string; summary: string; rubric: string };
const identity = z.object({ skillId: z.string().uuid(), revisionId: z.string().uuid(), packageHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();

/** The published revision of the selected review Skill, frozen at review start. */
export async function resolveReviewSkill(admin: SupabaseClient, skillId: string): Promise<ReviewSkill> {
  const skill = await admin.from('skills').select('id,status,published_version').eq('id', skillId).maybeSingle();
  if (skill.error || !skill.data || skill.data.status !== 'published') throw new Error('FUSION_REVIEW_SKILL_UNAVAILABLE');
  const revision = await admin.from('skill_revisions').select('id').eq('skill_id', skillId)
    .eq('version', skill.data.published_version).maybeSingle();
  if (revision.error || !revision.data) throw new Error('FUSION_REVIEW_SKILL_UNAVAILABLE');
  const pack = await admin.from('skill_packages').select('package_hash').eq('revision_id', revision.data.id).maybeSingle();
  if (pack.error || !pack.data) throw new Error('FUSION_REVIEW_SKILL_UNAVAILABLE');
  return identity.parse({ skillId, revisionId: revision.data.id, packageHash: pack.data.package_hash });
}

/** Reads the frozen revision through the service-role reader (0256): id, revision and hash must all match. */
export async function readReviewSkill(admin: SupabaseClient, skill: ReviewSkill): Promise<ReviewSkillText> {
  const read = async (path: string) => {
    const result = await admin.rpc('fusion_review_skill_file', { p_skill_id: skill.skillId, p_revision_id: skill.revisionId,
      p_package_hash: skill.packageHash, p_path: path });
    if (result.error || typeof result.data !== 'string') throw new Error('FUSION_REVIEW_SKILL_UNAVAILABLE');
    return Buffer.from(result.data, 'base64').toString('utf8');
  };
  return { reviewer: await read(REVIEW_SKILL_FILES.reviewer), summary: await read(REVIEW_SKILL_FILES.summary),
    rubric: await read(REVIEW_SKILL_FILES.rubric) };
}

/** Host-written format rules appended to the Skill text: the schema is also enforced by response_format. */
const REVIEWER_FORMAT = [
  '输出要求：只输出一个 JSON 对象 {"issues":[{"location","problem","suggestion","severity"}]}。',
  'severity 只能是 critical、major、minor。没有问题时 issues 为空数组。',
  '只依据给出的报告和资料，不要联网，需要外部核实的说法标为"待核实"。',
].join('\n');
const SUMMARY_FORMAT = [
  '输出要求：只输出一个 JSON 对象 {"body","steps","changeNotes"}。',
  'body 是修订后的完整报告，必须保留给出的全部 "## " 章节标题，顺序不变，每节都有内容。',
  'steps 必须列出给出的每一个步骤和每一个字段：没改的字段照抄 currentValue、changed=false；改了的字段 changed=true，值非空、不超过 400 字。',
  'changeNotes 对每个改动过的章节写一条：改了定位事实就在 fields 里列出对应的 stepId 和 fieldId（这些字段必须 changed=true），只改表述就 wordingOnly=true、fields 为空。',
].join('\n');

export type ReviewContext = { report: string; materials: unknown; sections: string[];
  /** Round 2 onward: the last revision that passed, as the base for steps (§2.2). */
  previous?: { steps: StepValues; changeNotes: unknown } };

export function reviewerRequest(skill: ReviewSkillText, context: ReviewContext): FusionRequest {
  return { instructions: `${skill.reviewer}\n\n${skill.rubric}\n\n${REVIEWER_FORMAT}`,
    input: JSON.stringify({ report: context.report, materials: context.materials, sections: context.sections,
      ...(context.previous ? { previousRevision: context.previous } : {}) }),
    responseFormat: OPINION_RESPONSE_FORMAT as unknown as Record<string, unknown> };
}

/** Reviewers are labelled A, B, C… for the summary model, never by model name (§2.2). */
export function summaryRequest(skill: ReviewSkillText, context: ReviewContext, opinions: Opinion[],
  declared: Array<{ stepId: string; fieldIds: string[] }>, current: StepValues): FusionRequest {
  const steps = declared.map(step => ({ stepId: step.stepId, fields: step.fieldIds.map(fieldId =>
    ({ fieldId, currentValue: current[step.stepId]?.[fieldId] ?? '' })) }));
  return { instructions: `${skill.summary}\n\n${skill.rubric}\n\n${SUMMARY_FORMAT}`,
    input: JSON.stringify({ report: context.report, materials: context.materials, sections: context.sections, steps,
      opinions: opinions.map((opinion, index) => ({ reviewer: String.fromCharCode(65 + index), issues: opinion.issues })),
      ...(context.previous ? { previousChangeNotes: context.previous.changeNotes,
        note: 'steps 以 currentValue 为基准修改，资料只作原始事实参考。' } : {}) }),
    responseFormat: REVISION_RESPONSE_FORMAT as unknown as Record<string, unknown> };
}
