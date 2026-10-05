/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { AgentTurnEvent, AgentTurnOutcome, QuestionAnswerSource } from "@repo/api/src/shared/agentTurn";
import { OPENING_INPUT, openingRequestId } from "@repo/api/src/shared/opcQuestions";
import { gateResultNotice, PROVIDER_HISTORY_NOTICE } from "@/lib/runtime-gate-notice";

/** One mentor turn as sent to `opc.mentorTurnStream` (same input as `opc.prepareStep`). */
export type MentorRequest = {
  draftId: string;
  stepId: string;
  purpose: "mentor";
  requestId: string;
  input: string;
  questionId?: string;
  answerSource?: QuestionAnswerSource;
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

/**
 * True once the execution will not change any more. `pending` means another
 * reader (for example the interrupted first stream) still owns a running
 * execution: its result is not known yet.
 */
export function isTerminalTurn(result: AgentTurnOutcome) {
  return result.state !== "pending";
}

/**
 * What happens to the retained envelope after a resumed or resent turn
 * returns. A terminal outcome releases it. A still-running execution keeps it,
 * with its execution id, so the next recovery ("重试") resumes that execution.
 * The page only runs that same recovery by itself once history shows the
 * execution is terminal (see step-recovery.ts); it never resends a request.
 */
export function envelopeAfterTurn(
  raw: string | null,
  requestId: string,
  executionId: string | undefined,
  result: AgentTurnOutcome,
): { release: true } | { release: false; next: string | null } {
  if (isTerminalTurn(result)) return { release: true };
  return { release: false, next: executionId ? envelopeWithExecution(raw, requestId, executionId) : null };
}

type EnvelopeStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Record the admitted execution id in the envelope stored under `key`, if it is still this request's. */
export function retainExecution(storage: EnvelopeStorage, key: string, requestId: string, executionId: string) {
  const next = envelopeWithExecution(storage.getItem(key), requestId, executionId);
  if (next) storage.setItem(key, next);
}

/**
 * Apply `envelopeAfterTurn` to the stored envelope. Returns true when the turn
 * is terminal; only this request's envelope (or an unreadable one) is removed.
 */
export function settleEnvelope(
  storage: EnvelopeStorage,
  key: string,
  requestId: string,
  executionId: string | undefined,
  result: AgentTurnOutcome,
) {
  const raw = storage.getItem(key);
  const after = envelopeAfterTurn(raw, requestId, executionId, result);
  const owner = raw === null ? null : parseStepEnvelope(raw)?.request.requestId;
  if (after.release && (owner === requestId || owner === undefined)) storage.removeItem(key);
  else if (!after.release && after.next) storage.setItem(key, after.next);
  return after.release;
}

/** Requested on every mentor stream; only native-output executions answer with `textDelta` (older ones keep `text`). */
export const TEXT_PROTOCOL = "textDelta-v1" as const;

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

/**
 * Fixed notice for a finished execution without a usable body; none of them is retried.
 * Output truncation has none: the turn itself shows it once (mentorReplyDisplay).
 */
export function turnResultNotice(result: AgentTurnOutcome): string | null {
  if (result.unavailable === "output_truncated") return null;
  if (result.unavailable === "provider_history")
    return PROVIDER_HISTORY_NOTICE;
  if (result.unavailable === "preflight") return "本次执行在模型派发前检查失败，已停止并保留原记录。请核对服务状态后再继续，不会自动重放。";
  return gateResultNotice(result.unavailable);
}

export type MentorTurn = { executionId: string; roundId?: string | null; stepId: string; questionId: string | null; kind: string };
export type MentorExecution = {
    request?: MentorRequest | null;
    unavailableReason?: string | null;
    historyOmitted?: boolean;
    executionId: string;
    input: string | null;
    body: string | null;
    primaryBody: string | null;
    summary: string | null;
    state: string;
    /** Native-output result metadata; present only when the history carries it. */
    completeness?: "complete" | "length_limit";
    organized?: boolean;
    envelopeCompact?: boolean;
  };

/**
 * A reply that may feed an adoptable candidate: not cut at the length limit,
 * not a compact envelope, not left unorganized. Missing metadata (older
 * replies) keeps the existing behaviour.
 */
export function isCompleteResult(execution: Pick<MentorExecution, "completeness" | "organized" | "envelopeCompact">) {
  return execution.completeness !== "length_limit" && execution.envelopeCompact !== true && execution.organized !== false;
}

/** Exact JSON identity, including nested source and extra keys; property order is irrelevant. */
export function sameRequest(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!isRecord(a) || !isRecord(b) || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && sameRequest(a[key], b[key]));
}

export function isAnswerSourceDenied(error: unknown): boolean {
  return error instanceof Error && error.message === "OPC_ANSWER_SOURCE_DENIED";
}

/** A definite pre-admission refusal releases only its own envelope, never an unknown outcome. */
export function releaseRejectedAnswer(storage: EnvelopeStorage, key: string, requestId: string, error: unknown): boolean {
  if (!isAnswerSourceDenied(error)) return false;
  const raw = storage.getItem(key);
  if (raw && parseStepEnvelope(raw)?.request.requestId === requestId) storage.removeItem(key);
  return true;
}
