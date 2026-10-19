/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { DEBATE_RESPONSE_FORMAT, DECISIONS, MIN_REASON_CHARACTERS, OPINION_RESPONSE_FORMAT, type Opinion,
  type StepValues } from './hostChecks';
import { SECTION_REVISION_FORMAT } from './revisionCheck';
import type { FusionRequest } from './request';
import { reportBodyText } from '../../shared/reportData';

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

/** Users see only the seat names (Owner 2026-10-14): no text may name the model or its maker. A prompt rule only; an
 * output filter belongs to the model-identity answer replacement (see the PR's after-launch list). */
const NO_SELF_IDENTITY = '任何文字里都不要提到你是哪个模型、哪家公司开发的，也不要用"作为某某模型"这类说法；评审之间只用代号 A/B/C 互称。';
/** Host-written format rules appended to the Skill text: the schema is also enforced by response_format. */
const REVIEWER_FORMAT = [
  '输出要求：只输出一个 JSON 对象 {"decisions":[...],"issues":[...]}。',
  'decisions 必须正好 4 条，decision 分别是 positioning（定位）、audience（受众）、platform（平台）、monetization（变现路径），各一条：'
    + 'strongestCase 写原报告这样选的最强理由，strongestAlternative 写最强的替代方案，verdict 写 keep（原方案更站得住）或 change（替代方案更好或原方案有漏洞），basis 写判断依据。',
  'issues 只放需要改的地方，每条都要写：location（必须是给出的章节标题之一，原样照抄）、perspective（从哪类受众或"用户本人"的角度）、'
    + `problem（为什么有问题，至少 ${MIN_REASON_CHARACTERS} 个字）、suggestion（具体怎么改，至少 ${MIN_REASON_CHARACTERS} 个字，不能只是重复问题）、severity（critical、major 或 minor）。`,
  '章节对不上、理由或改法太笼统的条目会被宿主丢掉。没有需要改的地方时 issues 为空数组。',
  '只依据给出的报告和资料，不要联网，需要外部核实的说法标为"待核实"。',
  NO_SELF_IDENTITY,
].join('\n');
const DEBATE_FORMAT = [
  '这是第 2 轮：评审之间对关键决定有分歧。input.others 是其他评审的第 1 轮意见，input.mine 是你自己的第 1 轮意见。',
  'input.respondTo 列出了你必须回应的每一对（评审代号 + 关键决定）：每一对正好写一条 responses，不多不少，不回应自己。'
    + 'reviewer 写对方的代号，decision 写这个关键决定，strongestView 先把对方在这个决定上的观点讲到最强，'
    + 'stance 写 agree 或 disagree，reason 写理由。',
  '然后重新给出你自己的 decisions 和 issues（格式同第 1 轮），可以保留、修改或撤回第 1 轮的意见。',
].join('\n');
const SUMMARY_FORMAT = [
  NO_SELF_IDENTITY,
  '输出要求（以下格式优先于前文的任何格式说明）：只输出一个 JSON 对象 {"adjudication","revisions","fieldChanges"}，不要输出完整报告。',
  'adjudication 是裁决记录：去重后的每个问题一条，section 写它属于哪个章节（给出的章节标题原样照抄；涉及全文的写"全文"），issue 写问题概要，'
    + 'reviewers 写哪些评审提出（代号 A/B/C），single 标是否只有一位评审提出，disputed 标评审之间对它是否有分歧，'
    + 'opinion 写评审团对这一处的最终意见，reason 写理由（回原文核实的结果；有冲突时双方的最强理由和裁决），fix 写建议怎么改，'
    + 'adopted 写修订稿里是否采纳（批评没压过原文的最强理由就不采纳、保留原文）。最终是否接受修订由用户决定。'
    + 'issue、opinion、reason、fix 各写一两句、不超过 60 字。',
  'revisions 只列出你要修改的章节，每章一条：section 写给出的章节标题（原样照抄），text 写这一章替换后的完整正文，不要写 "## " 标题行，'
    + '正文里也不要出现 "## " 开头的行（需要小标题用 "### "）。没有意见或不采纳意见的章节不要列出，宿主会原样保留原文。',
  'fieldChanges 只列出改动过的定位字段（input.steps 里的 currentValue 是现值）：stepId、fieldId 照抄，value 写新值（非空、不超过 400 字、和现值不同），'
    + 'sections 写这个改动体现在 revisions 里的哪几章（必须是你列出并确实改过的章节）。只改措辞、不改定位事实时 fieldChanges 为空数组。',
  'input.issuesBySection 是三位评审按章节归好的问题，input.decisions 是他们对 4 个关键决定的判断和互相的回应。',
].join('\n');

/** Host-written length rule: counted in characters (as the host check counts), headings included. The host knows the
 * original length, so the model gets the exact room it has instead of guessing. */
const lengthRule = (max: number, current: number) =>
  `原报告正文（含章节标题）现有 ${current} 个字符，替换后的全文不能超过 ${max} 个字符，超过就算修订失败；改写要精简，不要扩写。`;

export type ReviewContext = { report: string; materials: unknown; sections: string[];
  /** The template's length limit in characters; the host check refuses a longer body, so the model is told the number. */
  maxCharacters: number };
/** Reviewers are labelled A, B, C… by their position in the frozen panel, never by model name (§2.2). */
export const reviewerLabel = (index: number) => String.fromCharCode(65 + index);
const shown = (opinion: Opinion) => ({ decisions: opinion.decisions, issues: opinion.issues,
  ...(opinion.responses ? { responses: opinion.responses } : {}) });

export function reviewerRequest(skill: ReviewSkillText, context: ReviewContext): FusionRequest {
  return { instructions: `${skill.reviewer}\n\n${skill.rubric}\n\n${REVIEWER_FORMAT}`,
    input: JSON.stringify({ report: context.report, materials: context.materials, sections: context.sections }),
    responseFormat: OPINION_RESPONSE_FORMAT as unknown as Record<string, unknown> };
}

/** Round 2, only on disagreement: each reviewer sees the others' round-1 opinions and answers them. */
export function debateRequest(skill: ReviewSkillText, context: ReviewContext, mine: Opinion | null,
  others: Array<{ reviewer: string; opinion: Opinion }>, disputed: string[]): FusionRequest {
  return { instructions: `${skill.reviewer}\n\n${skill.rubric}\n\n${REVIEWER_FORMAT}\n${DEBATE_FORMAT}`,
    input: JSON.stringify({ report: context.report, materials: context.materials, sections: context.sections,
      mine: mine ? shown(mine) : null, others: others.map(item => ({ reviewer: item.reviewer, ...shown(item.opinion) })),
      // Exactly these pairs must be answered, each once: every other reviewer on every disputed decision.
      respondTo: others.flatMap(item => disputed.map(decision => ({ reviewer: item.reviewer, decision }))) }),
    responseFormat: DEBATE_RESPONSE_FORMAT as unknown as Record<string, unknown> };
}

/** Issues grouped by section and key decisions with each reviewer's verdict, so the summary reads one place at a time. */
function grouped(sections: string[], opinions: Array<{ reviewer: string; opinion: Opinion }>) {
  const title = (value: string) => value.replace(/^#+\s*/, '').trim();
  return {
    issuesBySection: sections.map(section => ({ section, issues: opinions.flatMap(({ reviewer, opinion }) => opinion.issues
      .filter(issue => title(issue.location) === section)
      .map(issue => ({ reviewer, severity: issue.severity, perspective: issue.perspective, problem: issue.problem, suggestion: issue.suggestion }))) }))
      .filter(group => group.issues.length),
    decisions: DECISIONS.map(decision => ({ decision,
      views: opinions.flatMap(({ reviewer, opinion }) => opinion.decisions.filter(d => d.decision === decision)
        .map(d => ({ reviewer, verdict: d.verdict, strongestCase: d.strongestCase, strongestAlternative: d.strongestAlternative, basis: d.basis }))),
      responses: opinions.flatMap(({ reviewer, opinion }) => (opinion.responses ?? []).filter(r => r.decision === decision)
        .map(r => ({ from: reviewer, to: r.reviewer, stance: r.stance, strongestView: r.strongestView, reason: r.reason }))) })),
  };
}

/** The summary request. A retry carries the exact problems of the previous attempt (host-computed) so it can avoid them. */
export function summaryRequest(skill: ReviewSkillText, context: ReviewContext, opinions: Array<{ reviewer: string; opinion: Opinion }>,
  declared: Array<{ stepId: string; fieldIds: string[] }>, current: StepValues, previousProblems: string[] = []): FusionRequest {
  const steps = declared.map(step => ({ stepId: step.stepId, fields: step.fieldIds.map(fieldId =>
    ({ fieldId, currentValue: current[step.stepId]?.[fieldId] ?? '' })) }));
  // REPORT-VISUAL: the summary rewrites only the report text. The strategy data block is not sent: adoption always keeps
  // the original block (0300), and a model that edited it wrote change notes for sections whose text never changed.
  const report = reportBodyText(context.report);
  const retry = previousProblems.length
    ? '\n这是第 2 次修订：input.previousProblems 是上一次没通过宿主检查的具体原因，这次必须避开。' : '';
  return { instructions: `${skill.summary}\n\n${skill.rubric}\n\n${SUMMARY_FORMAT}\n${lengthRule(context.maxCharacters, [...report].length)}${retry}`,
    input: JSON.stringify({ report, materials: context.materials, sections: context.sections, steps, ...grouped(context.sections, opinions),
      ...(previousProblems.length ? { previousProblems } : {}) }),
    responseFormat: SECTION_REVISION_FORMAT as unknown as Record<string, unknown> };
}
