/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { DEBATE_RESPONSE_FORMAT, DECISIONS, MIN_REASON_CHARACTERS, OPINION_RESPONSE_FORMAT, REVISION_RESPONSE_FORMAT, type Opinion,
  type StepValues } from './hostChecks';
import type { FusionRequest } from './request';
import type { MergeResult } from './reviewMerge';
import type { ReviewerRole } from './reviewEvidence';
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
/** The fixed angle of a reviewer seat (Owner 2026-10-20), written by the host so it follows the model it is bound to. */
export const ROLE_BLOCKS: Record<ReviewerRole, string> = {
  finance: '你这一席的专门任务是算账：把报告自己给出的数字（转化率、客单价、佣金、成本、每周投入时间、粉丝数、发布频率等）逐项算一遍，'
    + '算不通的必须在 problem 里写出算式，并指出错在哪一步（哪个数字没有来源、哪两个数字互相矛盾、哪一步放大了多少倍）。算得通的不用写。',
  evidence: '你这一席的专门任务是证据和对标：报告里的每个事实性说法有没有来源、对标账号的数据和结论对不对得上、"一般来说/大家都"这类断言有没有依据、'
    + '引用的资料和报告结论是否一致。',
  execution: '你这一席的专门任务是用户的执行能力和限制：用户每周的时间、是否出镜、预算、资质、已有素材和设备，报告里的计划和建议用户真的做得到吗？'
    + '哪一步会让这个用户做不下去，或者违反他自己说过的限制。',
};
/** Quote or anchor: the host checks them against the report (reviews started with the evidence check). */
const EVIDENCE_FORMAT = [
  '每条意见都要标 kind：content = 针对报告里写了的内容，omission = 针对报告里缺了的内容（没讲的、漏算的、没提的）。',
  'kind=content 时 quote 必须逐字摘自报告原文（一两句，不改一个字，不加省略号）；kind=omission 时 quote 留空字符串，'
    + 'anchor 写这段内容本应出现的那一章的标题（原样照抄给出的章节标题）。content 时 anchor 留空字符串。',
  '严重（critical）的意见，以及只有你一个人会提的意见，必须有核对得上的 quote 或 anchor，否则宿主会直接丢掉，不会交给汇总。',
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
  '输出要求：只输出一个 JSON 对象 {"adjudication","body","steps","changeNotes"}。',
  'adjudication 是裁决记录：去重后的每个问题一条，section 写它属于哪个章节（给出的章节标题原样照抄；涉及全文的写"全文"），issue 写问题概要，'
    + 'reviewers 写哪些评审提出（代号 A/B/C），single 标是否只有一位评审提出，disputed 标评审之间对它是否有分歧，'
    + 'opinion 写评审团对这一处的最终意见，reason 写理由（回原文核实的结果；有冲突时双方的最强理由和裁决）。reason 必须说清商业上的原因：这一处会让用户在哪一步亏钱、走错路或失去信任，或者原方案为什么在商业上站得住；不能只写"没有依据""没有来源"这类话。fix 写建议怎么改，'
    + 'adopted 写修订稿里是否采纳（批评没压过原文的最强理由就不采纳、保留原文）。最终是否接受修订由用户决定。'
    + 'issue、opinion、reason、fix 各写一两句、不超过 60 字：完整正文已经在 body 里，裁决记录只写要点，否则会超出输出上限。',
  'body 是修订后的完整报告，必须保留给出的全部 "## " 章节标题，顺序不变，每节都有内容。',
  'steps 必须列出给出的每一个步骤和每一个字段：没改的字段照抄 currentValue、changed=false；改了的字段 changed=true，值非空、不超过 400 字。',
  'changeNotes 对每个改动过的章节写一条：改了定位事实就在 fields 里列出对应的 stepId 和 fieldId（这些字段必须 changed=true），只改表述就 wordingOnly=true、fields 为空。',
  '不打算修改的章节必须逐字照抄原文（标点、空格、换行都不变）。宿主会逐字比较每一章：哪怕只改了一个字或一个标点，也必须为这一章写一条 changeNotes，漏写任何一章都算修订失败。',
].join('\n');

/** Host-written length rule: counted in characters (as the host check counts), headings included. */
const lengthRule = (max: number) =>
  `body 全文（含章节标题）不能超过 ${max} 个字符，超过就算修订失败；原报告已经接近上限时，改写要精简，不要扩写。`;

export type ReviewContext = { report: string; materials: unknown; sections: string[];
  /** The review was started with the evidence check: reviewers are asked for quotes/anchors, the summary gets merged issues. */
  evidence?: boolean;
  /** The template's length limit in characters; the host check refuses a longer body, so the model is told the number. */
  maxCharacters: number };
/** Reviewers are labelled A, B, C… by their position in the frozen panel, never by model name (§2.2). */
export const reviewerLabel = (index: number) => String.fromCharCode(65 + index);
const shown = (opinion: Opinion) => ({ decisions: opinion.decisions, issues: opinion.issues,
  ...(opinion.responses ? { responses: opinion.responses } : {}) });

export function reviewerRequest(skill: ReviewSkillText, context: ReviewContext, role?: ReviewerRole | null): FusionRequest {
  const extras = [...(role ? [ROLE_BLOCKS[role]] : []), ...(context.evidence ? [EVIDENCE_FORMAT] : [])].join('\n');
  return { instructions: `${skill.reviewer}\n\n${skill.rubric}\n\n${REVIEWER_FORMAT}${extras ? `\n${extras}` : ''}`,
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

export function summaryRequest(skill: ReviewSkillText, context: ReviewContext, opinions: Array<{ reviewer: string; opinion: Opinion }>,
  declared: Array<{ stepId: string; fieldIds: string[] }>, current: StepValues): FusionRequest {
  const steps = declared.map(step => ({ stepId: step.stepId, fields: step.fieldIds.map(fieldId =>
    ({ fieldId, currentValue: current[step.stepId]?.[fieldId] ?? '' })) }));
  // REPORT-VISUAL: the summary rewrites only the report text. The strategy data block is not sent: adoption always keeps
  // the original block (0300), and a model that edited it wrote change notes for sections whose text never changed.
  return { instructions: `${skill.summary}\n\n${skill.rubric}\n\n${SUMMARY_FORMAT}\n${lengthRule(context.maxCharacters)}`,
    input: JSON.stringify({ report: reportBodyText(context.report), materials: context.materials, sections: context.sections, steps,
      opinions: opinions.map(item => ({ reviewer: item.reviewer, ...shown(item.opinion) })) }),
    responseFormat: REVISION_RESPONSE_FORMAT as unknown as Record<string, unknown> };
}

/** Soft check of a ruling's reason: too short or only a generic phrase. It never fails a revision; the owner's detail marks it. */
export const MIN_BUSINESS_REASON = 30;
export const thinReason = (reason: string) => [...reason.trim()].length < MIN_BUSINESS_REASON
  || /^(没有|缺乏|缺少|无)(任何)?(依据|来源|证据|数据)[。.]?$/.test(reason.trim());

/** What the summary sees of a review started with the evidence check: the issues merged by code (each with the seats that
 * raised it and its verified evidence), the key decisions with every seat's view, and a plain note of what was held back. */
export function summaryRequestMerged(skill: ReviewSkillText, context: ReviewContext, merge: MergeResult,
  opinions: Array<{ reviewer: string; opinion: Opinion }>, declared: Array<{ stepId: string; fieldIds: string[] }>, current: StepValues,
  level = 0): FusionRequest {
  const steps = declared.map(step => ({ stepId: step.stepId, fields: step.fieldIds.map(fieldId =>
    ({ fieldId, currentValue: current[step.stepId]?.[fieldId] ?? '' })) }));
  const report = reportBodyText(context.report);
  const kept = merge.issues.filter(issue => level >= 3 ? false : level >= 2 ? issue.severity !== 'minor' : true);
  const held = merge.dropped.length + Object.values(merge.droppedEarlier).reduce((total, count) => total + count, 0);
  const decisions = DECISIONS.map(decision => ({ decision, views: opinions.flatMap(({ reviewer, opinion }) =>
    opinion.decisions.filter(d => d.decision === decision).map(d => ({ reviewer, verdict: d.verdict,
      ...(level >= 1 ? {} : { strongestCase: d.strongestCase, strongestAlternative: d.strongestAlternative, basis: d.basis }) }))) }));
  return { instructions: `${skill.summary}\n\n${skill.rubric}\n\n${SUMMARY_FORMAT}\n${lengthRule(context.maxCharacters)}`,
    input: JSON.stringify({ report, materials: context.materials, sections: context.sections, steps, decisions,
      // Already merged by code: one entry per issue, with the seats that raised it. Quotes were checked against the report.
      issues: kept.map(issue => ({ section: issue.section, severity: issue.severity, kind: issue.kind, raisedBy: issue.reviewers,
        quotes: issue.quotes, anchor: issue.anchor, views: issue.views })),
      note: held === 0 ? '三位评审提出的意见都已按章节合并，没有被拦下的。'
        : `评审另外提了 ${held} 条意见，因为没有核对得上的原文引用，没有交给你。${kept.length ? '' : '下面没有可用的意见清单，只按关键决定判断。'}` }),
    responseFormat: REVISION_RESPONSE_FORMAT as unknown as Record<string, unknown> };
}
