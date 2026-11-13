/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/*
 * CONTENT-CONVERSATION-DRIVEN C1-lite / P2-B-lite: the free conversation's results folder ("本对话成果夹").
 * Grouped by result type, not by Skill (Owner 2026-10-13, option A). Minutes are never stored here (Q1).
 */
export const RESULT_TYPES = ['script', 'storyboard', 'editing', 'body', 'topic_list', 'copy'] as const;
export type ResultType = typeof RESULT_TYPES[number];
export const RESULT_TYPE_LABEL: Record<ResultType, string> = {
  script: '口播稿', storyboard: '分镜', editing: '剪辑建议', body: '正文', topic_list: '选题清单', copy: '其他文案',
};

export type SessionResultItem = {
  id: string; familyId: string; version: number; versions: number; resultType: ResultType; title: string; body: string;
  sourceExecutionId: string | null; sourceTurnId?: number | null; sourceAvailable: boolean; createdAt: string;
};

/**
 * The type a save starts with (staging validation #1269: a 口播稿 reply defaulted to 正文). From the Skill the reply loaded (its step
 * label: the display title, or an older reply's package name), else from the reply's own opening line; 正文 only when neither says.
 * The user can still pick another type in the form.
 */
const TYPE_WORDS: ReadonlyArray<readonly [ResultType, RegExp, RegExp]> = [
  // [type, words in a Skill's name, words in the reply's opening]; 分镜 first, so 分镜脚本 is a storyboard.
  ['storyboard', /分镜|storyboard/i, /分镜/], ['script', /口播|script/i, /口播/], ['editing', /剪辑|editing/i, /剪辑建议|剪辑方案/],
  ['topic_list', /选题|topic/i, /选题清单|选题列表/],
];
export function guessResultType(input: { skills?: readonly string[]; reply: string }): ResultType {
  for (const skill of input.skills ?? []) for (const [type, words] of TYPE_WORDS) if (words.test(skill)) return type;
  const opening = input.reply.trim().split('\n').find(line => line.trim())?.slice(0, 80) ?? '';
  for (const [type, , words] of TYPE_WORDS) if (words.test(opening)) return type;
  return 'body';
}

/** A result's title as plain words: Markdown marks (bold, heading, quote, list, code) are not shown as stars and hashes. */
export function plainTitle(title: string): string {
  return title.replace(/^\s*(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.、]\s*)/, '').replace(/\*\*|__|`|~~/g, '')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2').trim() || title.trim();
}

/** Fixed type order; only non-empty groups, items in saved order. */
export function groupResults(items: readonly SessionResultItem[]) {
  return RESULT_TYPES.map(type => ({ type, label: RESULT_TYPE_LABEL[type], items: items.filter(item => item.resultType === type) }))
    .filter(group => group.items.length > 0);
}

/**
 * One save request per (reply, type, exact text): clicking again, or after a refresh, saves once; two different
 * excerpts of one reply are two results. Shaped as a UUID (version 5 nibble, RFC variant).
 */
export async function saveRequestId(executionId: string, type: ResultType, text: string) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256',
    new TextEncoder().encode(['session-result-v1', executionId, type, text].join('\u0000'))));
  const bytes = digest.slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * A result already saved from this very reply with exactly this text. Refreshing resets the form (title, type), so the
 * check does not depend on either: the same reply and the same text are never saved twice (an edited result keeps its
 * own text and is not matched).
 */
export function savedFromReply(items: readonly SessionResultItem[], source: string | number, text: string) {
  return items.find(item => (item.sourceExecutionId === source || item.sourceTurnId === source) && item.body === text);
}

/** Why this save must not be sent, or '' when it may go: invalid text, or already saved from this reply. */
export function saveProblem(reply: string, text: string, items: readonly SessionResultItem[], source: string | number) {
  const problem = excerptProblem(reply, text);
  if (problem) return problem;
  const already = savedFromReply(items, source, text);
  return already ? `这段内容已经保存在成果夹里（${RESULT_TYPE_LABEL[already.resultType]}「${plainTitle(already.title)}」），不会重复保存。` : '';
}

/** A reply at most this long, with an image that was not made and none that was, is the failure report and nothing else. */
export const IMAGE_FAILURE_REPLY_CHARS = 500;
/**
 * Whether "保存到成果夹" is offered under a reply. Owner 2026-11-13: a reply that reports an image not made is not a result.
 * Not offered when the reply has an image step that was not made (failed, or not available to the account), no image step that
 * was made or is still being made, and a short text (at most IMAGE_FAILURE_REPLY_CHARS characters): a longer reply carries
 * writing of its own, which stays savable even if its image failed. Every other reply is offered as before.
 */
export function offersSave(reply: string, steps: readonly { tool: string; state: string }[]) {
  const images = steps.filter(step => step.tool === 'image');
  const notMade = images.some(step => step.state === 'failed' || step.state === 'skipped');
  const made = images.some(step => step.state === 'done' || step.state === 'running');
  return !(notMade && !made && Array.from(reply.trim()).length <= IMAGE_FAILURE_REPLY_CHARS);
}

/** The server accepts only text that appears in the reply verbatim; say so before sending. */
export function excerptProblem(reply: string, excerpt: string) {
  if (!excerpt.trim()) return '请保留要保存的内容。';
  if (excerpt.length > 20000) return '一次最多保存 20000 字，请缩短。';
  if (!reply.includes(excerpt)) return '只能保存回复里的原文；要改写，请先保存，再在成果夹里编辑。';
  return '';
}

const REFUSAL_TEXT: Record<string, string> = {
  OPC_RESULT_SOURCE: '这条回复已不可用，不能保存。',
  OPC_RESULT_INVALID: '内容不符合保存要求，请检查后再试。',
  OPC_VERSION_CONFLICT: '这一项已经在别处改过，你的修改没有保存。请先复制你的内容，点取消，再基于最新版本编辑。',
  OPC_REQUEST_CONFLICT: '这次保存和之前的请求不一致，请刷新后再试。',
  OPC_RESULT_LIMIT: '这个对话的成果已达上限，请先删除不需要的。',
  OPC_RESULT_NOT_FOUND: '这一项已不存在，请刷新。',
  OPC_CONVERSATION_ERASED: '这个对话已删除。',
};
export function resultErrorText(cause: unknown) {
  const code = cause instanceof Error ? cause.message : '';
  return REFUSAL_TEXT[code] ?? '保存结果待核实，请稍后刷新查看；再点一次不会重复保存。';
}
