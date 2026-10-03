/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { gateAdmissionNotice, gateResultNotice } from '@/lib/runtime-gate-notice';

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
  return '本次请求状态待核实。请点「重试」读取原任务，不要重复发送相同内容。';
}

/**
 * Notice for an admitted topic turn the gate stopped before its first call.
 * The execution is cancelled with no charge, so the operation is finished,
 * but the typed input stays in the box for an explicit new send.
 */
export function topicExecutionNotice(result: unknown): string | null {
  if (!result || typeof result !== 'object' || !('unavailable' in result)) return null;
  return gateResultNotice(result.unavailable);
}
