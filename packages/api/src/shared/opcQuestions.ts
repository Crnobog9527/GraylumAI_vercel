/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
export type InformationQuestion = { id: string; title: string; required: boolean };
export type QuestionAnswer = {
  value: string;
  status: "unknown" | "unclear" | "provisional" | "confirmed" | "deferred";
  nature: "fact" | "decision" | "hypothesis" | "unknown";
};
export const emptyAnswer: QuestionAnswer = { value: "", status: "unknown", nature: "unknown" };

/** Text (including a mentor suggestion) is not a user's confirmation. */
export function questionIsConfirmed(answer: QuestionAnswer | undefined) {
  return Boolean(answer?.value.trim() && ["confirmed", "deferred"].includes(answer.status));
}
export function nextInformationQuestion(
  schema: readonly InformationQuestion[],
  values: Record<string, QuestionAnswer> | null | undefined = {},
) {
  const answers = values ?? {};
  return schema.find(field => !questionIsConfirmed(answers[field.id]));
}
/** Only previously reached questions and the current question are navigable. */
export function reachedQuestions(
  schema: readonly InformationQuestion[],
  values: Record<string, QuestionAnswer> | null | undefined = {},
) {
  const answers = values ?? {};
  const next = schema.findIndex(field => !questionIsConfirmed(answers[field.id]));
  return next < 0 ? schema : schema.slice(0, next + 1);
}
export function displayedQuestion(
  schema: readonly InformationQuestion[],
  values: Record<string, QuestionAnswer> | null | undefined = {},
  selectedId?: string,
) {
  return reachedQuestions(schema, values).find(field => field.id === selectedId)
    ?? nextInformationQuestion(schema, values) ?? schema.at(-1);
}
/**
 * Hierarchical identity is derived from the pinned method's declared order: the
 * step order and the information order inside that step. Nothing here is
 * hardcoded per method, and no future question or total count is exposed.
 */
export function questionPosition(
  schema: readonly InformationQuestion[],
  questionId: string | null | undefined,
) {
  if (!questionId) return -1;
  return schema.findIndex(field => field.id === questionId);
}
/** `1.1`, `1.2`, `2.3` … for a question inside its step. */
export function questionLabel(
  stepIndex: number,
  schema: readonly InformationQuestion[],
  questionId: string | null | undefined,
) {
  const position = questionPosition(schema, questionId);
  return position < 0 ? null : `${stepIndex + 1}.${position + 1}`;
}
/** Same normalization for stored utterances and candidate answers. */
function normalizeUtterance(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s\u3000]+/gu, " ")
    .replace(/[。.!！?？,，、~～…]+$/u, "")
    .trim();
}
/**
 * The Agent opens the current question itself. The turn carries a host-authored
 * marker instead of pretending the user said something, so the conversation
 * never records fabricated user speech.
 */
export const OPENING_INPUT = "HOST_OPEN_CURRENT_QUESTION";
export function isOpeningInput(input: string | null | undefined) {
  return (input ?? "").trim() === OPENING_INPUT;
}
export const QUESTION_TASK_PREFIX = "opc-question:";
export const OPENING_TASK_PREFIX = "opc-opening:";
export function questionTask(questionId: string, opening = false) {
  return (opening ? OPENING_TASK_PREFIX : QUESTION_TASK_PREFIX) + questionId;
}
export function taskQuestionId(task: string | null | undefined) {
  if (!task) return null;
  for (const prefix of [QUESTION_TASK_PREFIX, OPENING_TASK_PREFIX])
    if (task.startsWith(prefix)) return task.slice(prefix.length) || null;
  return null;
}
export function taskIsOpening(task: string | null | undefined) {
  return Boolean(task?.startsWith(OPENING_TASK_PREFIX));
}
/**
 * Stable identity for one entry into one question **inside one round**.
 *
 * The round is part of the identity on purpose:
 * - a refresh, a re-login, a second tab or a lost reply inside the same round
 *   reuses this request id, so the server replays the original turn instead of
 *   producing a second execution, a second BILL2 run or a second reservation;
 * - a revision creates a new round whose analysis is genuinely new, so the same
 *   step/question gets a distinct opening identity there instead of being
 *   suppressed by, or reusing, the older round's reply;
 * - an unresolved request from an older round keeps the id it was created with
 *   and stays recoverable through its own execution identity.
 */
export function openingRequestId(
  draftId: string,
  roundId: string,
  stepId: string,
  questionId: string,
) {
  // A deterministic RFC-4122-shaped UUID derived from the stable entry identity.
  const hex = fnv1aHex(
    `${draftId}\u0000${roundId}\u0000${stepId}\u0000${questionId}\u0000opening`,
    32,
  );
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
/** The same entry identity as a private per-round browser marker key. */
export function openingEntryKey(
  draftId: string,
  roundId: string,
  stepId: string,
  questionId: string,
) {
  return `opc-opening:${draftId}:${roundId}:${stepId}:${questionId}`;
}
function fnv1aHex(seed: string, length: number) {
  let out = "";
  let counter = 0;
  while (out.length < length) {
    let hash = 0x811c9dc5;
    for (const char of `${seed}#${counter++}`) {
      hash ^= char.codePointAt(0) ?? 0;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    out += hash.toString(16).padStart(8, "0");
  }
  return out.slice(0, length);
}

/**
 * A recorded non-answer (an acknowledgement, an uncertainty or a request for
 * help) is not a business answer, even though it is non-empty text. The host
 * records which utterances the mentor classified as non-answers; a value that
 * is merely one of those utterances is refused instead of being confirmed as
 * positioning content. This compares against the recorded conversation, so it
 * is contextual rather than a keyword blocklist.
 */
export function isRecordedNonAnswer(
  value: string,
  nonAnswers: readonly string[] = [],
) {
  const candidate = normalizeUtterance(value);
  if (!candidate) return false;
  return nonAnswers.some(entry => normalizeUtterance(entry) === candidate);
}
export function confirmQuestionValues(
  schema: readonly InformationQuestion[],
  current: Record<string, QuestionAnswer>,
  questionId: string,
  defer = false,
  options: { nonAnswers?: readonly string[] } = {},
) {
  const field = reachedQuestions(schema, current).find(item => item.id === questionId);
  if (!field) throw new Error("OPC_QUESTION_NOT_REACHED");
  const values = Object.fromEntries(schema.map(item => [item.id, { ...(current[item.id] ?? emptyAnswer) }]));
  const answer = values[questionId];
  const value = answer.value.trim();
  if (!value && (!defer || field.required)) throw new Error("OPC_QUESTION_ANSWER_REQUIRED");
  // A non-answer cannot be confirmed as business content. Explicit deferral
  // records the user's non-empty reason as a limitation, not as a confirmed
  // fact; that reason may legitimately be the same recorded uncertainty.
  if (!defer && value && isRecordedNonAnswer(value, options.nonAnswers))
    throw new Error("OPC_QUESTION_ANSWER_NOT_SUBSTANTIVE");
  values[questionId] = {
    ...answer,
    value: value || "用户明确选择暂不提供此选填信息。",
    status: defer ? "deferred" : "confirmed",
  };
  return { values, finishStep: schema.every(item => questionIsConfirmed(values[item.id])) };
}
