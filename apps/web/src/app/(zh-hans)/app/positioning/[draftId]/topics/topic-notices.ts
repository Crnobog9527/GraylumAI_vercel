/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { gateAdmissionNotice } from '@/lib/runtime-gate-notice';
import { definiteRefusalNotice, showsReply } from '@/app/(zh-hans)/app/runtime/gate-notices';

/** This tab's sessionStorage, where the page remembers the stops its user asked for (display only). */
export function tabSession() {
  try { return typeof window === 'undefined' ? null : window.sessionStorage; } catch { return null; }
}

/** Fixed wording for a failed topic operation; the pending operation itself is kept by the caller. */
export function topicFailureMessage(cause: unknown) {
  const gate = gateAdmissionNotice(cause, ['opc.topicTurn']);
  if (gate) return gate;
  const message = cause instanceof Error ? cause.message : '';
  if (message.includes('OPC_TOPIC_SKILL_MISSING'))
    return '当前定位方法没有声明可用的选题方法资源，无法开始选题工作对话。请联系管理员配置选题 Skill 后再继续；本次没有任何调用或花费。';
  if (message.includes('OPC_TOPIC_SOURCE_REVOKED'))
    return '这个工作空间绑定的定位版本已不可用，暂不能继续派发。原对话和成果仍然保留。';
  if (message.includes('OPC_TOPIC_BOUND') || message.includes('OPC_TOPIC_SOURCE_CHANGED'))
    return '这个草稿已经有绑定的选题工作空间，不能静默换到另一个版本。请继续使用原有工作空间。';
  if (message.includes('OPC_REQUEST_CONFLICT'))
    return '这条消息的原请求身份与现在的负载不一致，已停止发送。请读取原任务状态后再决定。';
  const refused = definiteRefusalNotice(cause, ['opc.topicTurn']);
  if (refused) return refused;
  return '本次请求状态待核实。请点「重试」读取原任务，不要重复发送相同内容。';
}

/**
 * The workspace is frozen to the positioning version it was bound to (Owner 2026-11-02: after the positioning is updated,
 * the old topic workspace is read-only and the user is told). It is behind when the project's current formal version is
 * another one; the server then refuses every adoption with OPC_VERSION_CONFLICT.
 */
export function topicWorkspaceStale(boundVersionId: unknown, currentVersionId: unknown) {
  return typeof boundVersionId === 'string' && boundVersionId !== '' &&
    typeof currentVersionId === 'string' && currentVersionId !== '' && boundVersionId !== currentVersionId;
}

export const STALE_WORKSPACE_NOTICE =
  '你已更新过正式定位，这个选题工作区基于旧版本，不能再采用或继续对话；原对话和计划保留，只能查看。';

/** The first message after the user starts the topic work again on the updated positioning (the old conversation is not sent to the model). */
export const REBIND_OPENING_INPUT = '定位已更新。请只根据最新的已确认定位和选题方法，提出第一周选题候选；区分已确认事实与建议，缺少必要信息时先问我。';

/** The server refused to start again on the latest positioning (e.g. the topic method was updated since): say so, never a vague error. */
export const REBIND_REFUSED_NOTICE = '暂时不能用最新定位重新开始选题（选题方法已有更新）。原对话和计划仍可查看，没有任何改动；请联系我们处理。';

/** Another tab still has a topic turn running in the old conversation. */
export const REBIND_BUSY_NOTICE = '这个选题对话在别处还有一轮没结束，请等它结束后再点“用最新定位开始选题”。';

/** What the page shows when starting again on the latest positioning failed. */
export function rebindFailureMessage(cause: unknown) {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (/\bOPC_TOPIC_TURN_ACTIVE\b/.test(message)) return REBIND_BUSY_NOTICE;
  return /OPC_TOPIC_SOURCE_CHANGED|OPC_TOPIC_SKILL_MISSING|OPC_TOPIC_SOURCE_DENIED/.test(message) ? REBIND_REFUSED_NOTICE : topicFailureMessage(cause);
}

/**
 * The opening's request id is a pure function of the draft and the new positioning version, so every browser and tab that restarts the
 * same workspace sends the same id: the second one is a replay of the first turn, never a second charge.
 */
export async function rebindOpeningRequestId(draftId: string, versionId: string) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('topic-rebind-opening:' + draftId + ':' + versionId)));
  const bytes = digest.slice(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; // a version 4 shaped id, as every request id the server accepts
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The user-facing text of a reply without the machine-readable plan or adoption block. */
export function replyProse(text: string | null | undefined) {
  if (!text) return '';
  return text.replace(/```(?:json)?\s*(?:\[[\s\S]*?\]|\{[\s\S]*?\})\s*```/g, '').trim() || text.trim();
}

/**
 * The reply text under a topic turn, or null when there is none to show. A finished turn without a
 * saved reply (stopped before its first word, refused, ended) shows only its notice; a turn still in
 * progress or paused shows its own notice, never a "verifying" placeholder (showsReply, CHAT-NATIVE-OUTPUT).
 */
export function topicReplyText(e: { state: string; body: string | null; primaryBody: string | null; contentAvailable: boolean }) {
  if (!showsReply(e)) return null;
  return e.contentAvailable ? replyProse(e.body ?? e.primaryBody) : '来源已不可用，暂不展示此内容。';
}
