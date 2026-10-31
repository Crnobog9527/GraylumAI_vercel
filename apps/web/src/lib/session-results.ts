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
  return already ? `这段内容已经保存在成果夹里（${RESULT_TYPE_LABEL[already.resultType]}「${already.title}」），不会重复保存。` : '';
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
