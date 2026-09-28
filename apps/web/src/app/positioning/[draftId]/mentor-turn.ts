/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { AgentTurnEvent, AgentTurnOutcome } from "@repo/api/src/shared/agentTurn";
import { OPENING_INPUT, openingRequestId } from "@repo/api/src/shared/opcQuestions";

/** One mentor turn as sent to `opc.mentorTurnStream` (same input as `opc.prepareStep`). */
export type MentorRequest = {
  draftId: string;
  stepId: string;
  purpose: "mentor";
  requestId: string;
  input: string;
  questionId?: string;
  organizeAfter?: boolean;
};

/**
 * The retained browser record of one explicit mentor send, stored before any
 * network call. `executionId` is added once the server has admitted the
 * request, so a reload can resume that execution instead of sending again.
 */
export type MentorStepEnvelope<Information> = {
  request: MentorRequest;
  information?: Information;
  editingSnapshot?: string;
  executionId?: string;
};

const EXECUTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Read a retained envelope defensively. A pre-upgrade value stored the bare
 * request; an envelope from before single-request turns has no execution id.
 * Both stay valid and resend their original request.
 */
export function parseStepEnvelope<Information>(raw: string): MentorStepEnvelope<Information> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const candidate = isRecord(parsed.request) ? parsed.request : parsed;
  if (
    typeof candidate.draftId !== "string" ||
    typeof candidate.stepId !== "string" ||
    typeof candidate.requestId !== "string" ||
    typeof candidate.input !== "string"
  )
    return null;
  const executionId = typeof parsed.executionId === "string" && EXECUTION_ID.test(parsed.executionId) ? parsed.executionId : undefined;
  return {
    request: candidate as unknown as MentorRequest,
    information: isRecord(parsed.information) ? (parsed.information as Information) : undefined,
    editingSnapshot: typeof parsed.editingSnapshot === "string" ? parsed.editingSnapshot : undefined,
    ...(executionId ? { executionId } : {}),
  };
}

/**
 * The retained envelope with the admitted execution id added, or null when the
 * stored value no longer belongs to this request (it was released or replaced)
 * or cannot be read. Everything else in the stored value is kept verbatim.
 */
export function envelopeWithExecution(raw: string | null, requestId: string, executionId: string): string | null {
  if (!raw || !EXECUTION_ID.test(executionId)) return null;
  const envelope = parseStepEnvelope(raw);
  if (!envelope || envelope.request.requestId !== requestId) return null;
  const stored = JSON.parse(raw) as Record<string, unknown>;
  return JSON.stringify(isRecord(stored.request) ? { ...stored, executionId } : { request: stored, executionId });
}

/**
 * The host-authored opening of one question. Its request id is derived from
 * draft, round, step and question, so a retry reuses the same turn; the
 * question id is required, or the server refuses the opening and the question
 * card it may carry could never be answered.
 */
export function openingRequest(draftId: string, roundId: string, stepId: string, questionId: string): MentorRequest {
  return {
    draftId,
    stepId,
    purpose: "mentor",
    requestId: openingRequestId(draftId, roundId, stepId, questionId),
    input: OPENING_INPUT,
    questionId,
  };
}

export const STREAM_INTERRUPTED = "OPC_EXECUTION_STREAM_INTERRUPTED";

/**
 * Read the events of one turn. A resumed execution passes its known id; a new
 * single-request turn learns it from `admitted`, which is reported once so the
 * caller can retain it before any text arrives. A stream that ends without a
 * result was interrupted: the caller resumes by execution id or resends the
 * same request, never a new one.
 *
 * `onFinished` runs once when the stream ends for any reason, for example to
 * re-read the credit balance: a finished turn may have settled a charge.
 */
export async function readAgentTurn(
  events: AsyncIterable<AgentTurnEvent>,
  handlers: {
    executionId?: string;
    onAdmitted?: (executionId: string) => void;
    onProgress: (executionId: string, event: AgentTurnEvent) => void;
    onFinished?: () => void;
  },
): Promise<{ executionId: string; result: AgentTurnOutcome }> {
  let executionId = handlers.executionId;
  let result: AgentTurnOutcome | undefined;
  try {
    for await (const event of events) {
      if (event.type === "admitted") {
        if (executionId) continue;
        executionId = event.executionId;
        handlers.onAdmitted?.(executionId);
      } else if (event.type === "result") result = event.result;
      else if (executionId) handlers.onProgress(executionId, event);
    }
  } finally {
    handlers.onFinished?.();
  }
  if (!executionId || !result) throw new Error(STREAM_INTERRUPTED);
  return { executionId, result };
}

/** Fixed notice for a finished execution without a usable body; none of them is retried. */
export function turnResultNotice(result: AgentTurnOutcome): string | null {
  if (result.unavailable === "output_truncated") return "本次模型调用达到长度上限，原请求已保留，不会自动重试。";
  if (result.unavailable === "provider_history")
    return "历史消息格式暂不兼容，本次执行已停止。原记录已保留；请联系支持检查历史兼容性，不要重复发送这条请求。";
  if (result.unavailable === "preflight") return "本次执行在模型派发前检查失败，已停止并保留原记录。请核对服务状态后再继续，不会自动重放。";
  return null;
}
