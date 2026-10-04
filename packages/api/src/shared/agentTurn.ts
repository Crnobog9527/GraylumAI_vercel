/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/**
 * Shared contract for one interactive Agent turn (AGENT-CORE AC-1).
 *
 * Browser and server both import this file. It holds types, schemas and pure
 * functions only: no database, network, environment or Runtime imports.
 *
 * Three things are defined here:
 *
 * 1. The streamed events of one turn (`AgentTurnEvent`), in the order a
 *    single streaming request delivers them.
 * 2. The question card (`QuestionCard`): what the model passes to the
 *    `ask_question` tool and what the page renders.
 * 3. The stored reply body (`body` of a completed execution) and its parser
 *    `readAgentTurnBody`, which reads every body shape that exists: the new
 *    envelope, the legacy JSON mentor protocol and legacy plain text.
 *
 * Changing an exported shape after the UI depends on it is a contract change:
 * report it to the controller first.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Question card
// ---------------------------------------------------------------------------

/** The only tool name that produces a question card. */
export const ASK_QUESTION_TOOL = "ask_question";
// Serialized arguments, not display text. Other tools keep their existing bound.
// This character bound leaves room for the five-field card; the response still
// obeys the independent provider-response byte limit.
export const ASK_QUESTION_ARGUMENT_LIMIT = 49152;
export const DEFAULT_TOOL_ARGUMENT_LIMIT = 4000;
export const toolArgumentLimit = (name: string): number =>
  name === ASK_QUESTION_TOOL ? ASK_QUESTION_ARGUMENT_LIMIT : DEFAULT_TOOL_ARGUMENT_LIMIT;
/** Correlates an answer with the saved card; option indexes are zero based. */
export const questionAnswerSourceSchema = z.object({
  executionId: z.string().uuid(), optionIndex: z.number().int().min(0).max(4).optional(),
}).strict();
export type QuestionAnswerSource = z.infer<typeof questionAnswerSourceSchema>;
/** Display limit for envelope, tool message and plain-text messages. */
export const AGENT_TURN_MESSAGE_LIMIT = 20000;
export const QUESTION_MAX_CHARS = 500;
export const OPTION_MAX_CHARS = 200;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 5;

/**
 * Fixed page control, never a model argument. Every card ends with a fixed
 * "其他" entry that moves focus to the message box, where the user answers in
 * their own words; the box never locks. A clicked option sends the option text
 * itself as the next turn's plain user input.
 *
 * `UNSURE_INPUT` was the reply of an earlier "not sure" button. New pages no
 * longer send it; it stays so history cards answered with it read correctly.
 */
export const UNSURE_INPUT = "我不确定，帮我分析";

const cardText = (max: number) =>
  z.string().trim().min(1).max(max).refine(value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value), "control character");

/**
 * One main question and 2–5 short suggested answers. This schema is the
 * legacy `ask_question` parameter schema and stored card shape.
 * Options must be distinct after trimming. `recommended` is the index of the
 * option the mentor recommends, or null for a neutral card (ranges or
 * categories the user places themselves in); an index outside the options
 * makes the card invalid.
 */
export const questionCardSchema = z
  .object({
    question: cardText(QUESTION_MAX_CHARS),
    options: z
      .array(cardText(OPTION_MAX_CHARS))
      .min(MIN_OPTIONS)
      .max(MAX_OPTIONS)
      .refine(options => new Set(options).size === options.length, "duplicate option"),
    recommended: z.number().int().min(0).max(MAX_OPTIONS - 1).nullable(),
  })
  .strict()
  .refine(card => card.recommended === null || card.recommended < card.options.length, "recommended out of range");
export const questionMessageSchema = cardText(AGENT_TURN_MESSAGE_LIMIT);
/** New calls require all five fields. Legacy storage remains readable separately. */
export const questionToolCardSchema = questionCardSchema.safeExtend({
  message: questionMessageSchema,
  recommendationReason: cardText(AGENT_TURN_MESSAGE_LIMIT).nullable(),
}).refine(card => card.recommended === null
  ? card.recommendationReason === null : card.recommendationReason !== null,
"recommendation reason must match recommended");
export type QuestionCard = z.infer<typeof questionCardSchema> & {
  message?: string; recommendationReason?: string | null;
};

/**
 * Validated card or null. Never throws; invalid model output shows no card.
 * Cards stored before `recommended` existed (local test data only; v5 was
 * never enabled before it) read as having no recommendation.
 */
export function parseQuestionCard(value: unknown): QuestionCard | null {
  const legacy = value && typeof value === "object" && !Array.isArray(value) && !("recommended" in value);
  const extended = value && typeof value === "object" &&
    ("message" in value || "recommendationReason" in value);
  const parsed = extended ? questionToolCardSchema.safeParse(value)
    : questionCardSchema.safeParse(legacy ? { ...value, recommended: null } : value);
  return parsed.success ? parsed.data : null;
}

// ---------------------------------------------------------------------------
// Streamed events
// ---------------------------------------------------------------------------

/**
 * `phase` values. The page must ignore a value it does not know.
 * - `mentor`: the model is producing the reply.
 * - `reading`: the model is reading a Skill reference file (new format only;
 *   not emitted before AC1-5).
 * - `organizer`: the legacy attached organizer is running.
 * - `saving`: the reply is complete and is being stored.
 */
export type AgentTurnPhase = "mentor" | "reading" | "organizer" | "saving";

/** Final execution state carried by the `result` event. */
export type AgentTurnState = 'waiting_credits' | 'waiting_resume' | "completed" | "cancelled" | "cost_pending" | "pending";

/**
 * Why a finished or stopped execution has no usable body. The page maps each
 * value to a fixed notice; none of them may be retried automatically.
 */
export type AgentTurnUnavailable = "provider_rejected" | "output_truncated" | "provider_history" | "preflight" | "capacity" | "latest"
  | "call_limited" | "paused" | "limit_unavailable" | "RUNTIME_PRICE_UNCONFIRMED" | "RUNTIME_PRICE_CONFIGURATION_PENDING";

/** The execution outcome. `body` is the stored reply body; read it with `readAgentTurnBody`. */
export type AgentTurnOutcome = {
  code?: 'RUNTIME_WAITING_CREDITS' | 'RUNTIME_WAITING_RESUME';
  executionId?: string; cursor?: number; epoch?: number; remainingCalls?: number;
  state: AgentTurnState;
  body?: string;
  summary?: string;
  unavailable?: AgentTurnUnavailable;
};

/**
 * Events of one turn, in delivery order:
 *
 *   admitted → (phase | text)* → card? → result
 *
 * - `admitted` comes first and only from the single-request turn. It carries
 *   the execution id; store it so a reload can resume that same execution
 *   instead of sending the request again.
 * - `text` is the whole public reply text so far, not a delta. Each `text`
 *   event replaces the previously displayed text. Reasoning, raw JSON and
 *   provider metadata are never sent.
 * - `card` arrives at most once, after the reply text, when the model asked a
 *   question card. It is final for this turn.
 * - `result` is last. A stream that ends without `result` was interrupted:
 *   resume by execution id, do not resend as a new request.
 */
export type AgentTurnEvent =
  | { type: "admitted"; executionId: string }
  | { type: "phase"; phase: AgentTurnPhase }
  | { type: "text"; text: string }
  | { type: "card"; card: QuestionCard }
  | { type: "result"; result: AgentTurnOutcome };

// ---------------------------------------------------------------------------
// Stored reply body
// ---------------------------------------------------------------------------

/** Marks the host-built envelope. Legacy bodies never carry this field. */
export const AGENT_TURN_FORMAT = "agent-turn.v1";
/** Legacy JSON mentor messages keep their existing 4000-character display limit. */
export const LEGACY_MESSAGE_LIMIT = 4000;
/** Bodies above this size are not parsed at all. */
export const AGENT_TURN_BODY_LIMIT = 262144;

/**
 * The stored body of a new-format turn:
 *
 *   {"format":"agent-turn.v1","message":"…","card":{"question":"…","options":[…],"recommended":0|null}|null}
 *
 * It is still a JSON object with a top-level `message` string, so the legacy
 * mentor parser keeps showing the text of new turns without a migration.
 */
export type AgentTurnEnvelope = { format: typeof AGENT_TURN_FORMAT; message: string; card: QuestionCard | null };

/**
 * - `envelope`: new format; `card` may be present.
 * - `legacy_json`: the old JSON mentor protocol; only `message` is read here.
 *   Its structured fields stay with the existing mentor parser.
 * - `plain`: a plain-text reply (older executions).
 * - `empty`: no body.
 * - `invalid`: JSON-looking or malformed content that must not be shown raw;
 *   the page shows `INVALID_REPLY_NOTICE`.
 * - `oversized`: above `AGENT_TURN_BODY_LIMIT`; not parsed, shown as a notice.
 */
export type AgentTurnBodyKind = "envelope" | "legacy_json" | "plain" | "empty" | "invalid" | "oversized";
export type AgentTurnBody = {
  kind: AgentTurnBodyKind;
  /** Display text; empty for `empty`, `invalid` and `oversized`. */
  message: string;
  card: QuestionCard | null;
  /** True when `message` was cut at its display limit. */
  truncated: boolean;
};

/** Same wording as the existing mentor parser, so both paths agree. */
export const INVALID_REPLY_NOTICE = "本次回复格式不完整，暂时无法展示正文。原记录已保留，请核对执行状态。";

function limited(text: string, limit: number) {
  const trimmed = text.trim();
  return { message: trimmed.slice(0, limit), truncated: trimmed.length > limit };
}

/**
 * Build the stored body for a new-format turn (server side). Throws on an
 * invalid card or an over-long message: the caller builds the body from
 * already validated values, so a failure here is a host defect.
 */
export function agentTurnBody(message: string, card: QuestionCard | null): string {
  const text = z.string().max(AGENT_TURN_MESSAGE_LIMIT).parse(message.trim());
  const envelope: AgentTurnEnvelope = {
    format: AGENT_TURN_FORMAT,
    message: text,
    card: card === null ? null : (card.message === undefined ? questionCardSchema : questionToolCardSchema).parse(card),
  };
  if (!envelope.message && !envelope.card) throw new Error("AGENT_TURN_BODY_EMPTY");
  return JSON.stringify(envelope);
}

/**
 * Read any stored reply body for display. Never throws. Model output is
 * untrusted: an invalid card is dropped (the message still shows), and
 * unknown fields are ignored.
 */
export function readAgentTurnBody(raw: string | null | undefined): AgentTurnBody {
  const none = (kind: AgentTurnBodyKind): AgentTurnBody => ({ kind, message: "", card: null, truncated: false });
  if (raw === null || raw === undefined || !raw.trim()) return none("empty");
  if (raw.length > AGENT_TURN_BODY_LIMIT) return none("oversized");
  // Legacy plain text, including text that happens to be a bare JSON scalar.
  // Text that merely looks like a structured reply is never shown raw; this
  // matches the existing mentor parser.
  const plain = (): AgentTurnBody =>
    /^\s*[[{`]/.test(raw) ? none("invalid") : { kind: "plain", card: null, ...limited(raw, AGENT_TURN_MESSAGE_LIMIT) };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return plain();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return plain();
  const value = parsed as Record<string, unknown>;
  const message = typeof value.message === "string" ? value.message : "";
  if (value.format === AGENT_TURN_FORMAT) {
    const card = parseQuestionCard(value.card);
    const text = limited(card?.message ?? message, AGENT_TURN_MESSAGE_LIMIT);
    if (!text.message && !card) return none("invalid");
    return { kind: "envelope", card, ...text };
  }
  if (!message.trim()) return none("invalid");
  return { kind: "legacy_json", card: null, ...limited(message, LEGACY_MESSAGE_LIMIT) };
}
