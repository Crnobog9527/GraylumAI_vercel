/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { isRecordedNonAnswer } from "@repo/api/src/shared/opcQuestions";

/**
 * Read-only projection of the conversation-driven checklist (CONVERSATION-DRIVEN-CAPTURE F1).
 * The server writes captured values and owns field protection; the page only displays
 * them, lets the user edit through the normal autosave, and adopts or ignores an update
 * through `opc.captureResolve`. Nothing here writes a captured value by itself.
 */
export type FieldStatus = "unknown" | "unclear" | "provisional" | "confirmed" | "deferred";
export type FieldNature = "fact" | "decision" | "hypothesis" | "unknown";
export type FieldValue = { value: string; status: FieldStatus; nature: FieldNature };
export type ChecklistField = {
  id: string;
  title: string;
  required: boolean;
  elicitation?: "user_fact" | "agent_proposal";
};
/** One pending "根据对话整理的更新" of a protected field, bound to its execution and hash. */
export type CaptureSuggestion = {
  executionId: string;
  hash: string;
  value: string;
  status: FieldStatus;
  nature: FieldNature;
};
export type FieldMeta = { source?: "capture" | "user"; protected?: boolean; suggestion?: CaptureSuggestion };
export type StepInformation = {
  schema: ChecklistField[];
  values?: Record<string, FieldValue>;
  meta?: Record<string, unknown>;
  previouslyConfirmed?: string[];
};
export type FieldState = "missing" | "draft" | "confirmed" | "deferred";

export const EMPTY_VALUE: FieldValue = { value: "", status: "unknown", nature: "unknown" };
const statuses = new Set(["unknown", "unclear", "provisional", "confirmed", "deferred"]);
const natures = new Set(["fact", "decision", "hypothesis", "unknown"]);
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The field metadata the server returned, read defensively; a malformed update is dropped. */
export function fieldMeta(info: StepInformation | undefined, fieldId: string): FieldMeta {
  const raw = info?.meta?.[fieldId];
  if (!isObject(raw)) return {};
  const meta: FieldMeta = {};
  if (raw.source === "capture" || raw.source === "user") meta.source = raw.source;
  if (typeof raw.protected === "boolean") meta.protected = raw.protected;
  const s = raw.suggestion;
  if (isObject(s) && typeof s.executionId === "string" && typeof s.hash === "string" && s.hash &&
      typeof s.value === "string" && s.value.trim() && statuses.has(String(s.status)) && natures.has(String(s.nature)))
    meta.suggestion = { executionId: s.executionId, hash: s.hash, value: s.value,
      status: s.status as FieldStatus, nature: s.nature as FieldNature };
  return meta;
}

export function hasContent(value: FieldValue | undefined) {
  return Boolean(value?.value.trim());
}

export function fieldState(value: FieldValue | undefined): FieldState {
  if (value?.status === "confirmed" && hasContent(value)) return "confirmed";
  if (value?.status === "deferred" && hasContent(value)) return "deferred";
  return hasContent(value) ? "draft" : "missing";
}

/** The short status shown next to a field: never a question number. */
export function fieldStateLabel(value: FieldValue | undefined, meta: FieldMeta) {
  const state = fieldState(value);
  if (state === "confirmed") return "已确认";
  if (state === "deferred") return "已暂缓";
  if (state === "missing") return "还没聊到";
  return meta.source === "capture" ? "草稿 · 从对话记下" : meta.source === "user" ? "草稿 · 你填写的" : "草稿";
}

/** A user's typed text applied to a field, exactly as the autosave stores it. */
export function editedValue(previous: FieldValue, text: string): FieldValue {
  return { ...previous, value: text, status: text.trim() ? "provisional" : "unknown",
    nature: previous.nature === "unknown" ? "decision" : previous.nature };
}

/** The value a field shows: the user's unsaved edit first, then the server value. */
export function shownValue(info: StepInformation | undefined, edits: Record<string, FieldValue> | undefined, fieldId: string) {
  return edits?.[fieldId] ?? info?.values?.[fieldId] ?? EMPTY_VALUE;
}

export type StepProgress = {
  /** Required fields with no content (a written deferral reason counts as content). */
  missingRequired: ChecklistField[];
  /** Every required field has content: the step can be reviewed and confirmed once. */
  ready: boolean;
  /** Drafts the server captured from the conversation and nobody has edited since. */
  captured: number;
  /** Pending "根据对话整理的更新" in this step. */
  updates: number;
};

export function stepProgress(info: StepInformation | undefined, edits?: Record<string, FieldValue>): StepProgress {
  const schema = info?.schema ?? [];
  const missingRequired = schema.filter(field => field.required && !hasContent(shownValue(info, edits, field.id)));
  let captured = 0, updates = 0;
  for (const field of schema) {
    const meta = fieldMeta(info, field.id);
    if (meta.suggestion) updates++;
    if (meta.source === "capture" && fieldState(info?.values?.[field.id]) === "draft") captured++;
  }
  return { missingRequired, ready: schema.length > 0 && missingRequired.length === 0, captured, updates };
}

/** True when the step was confirmed before and now waits for a new confirmation. */
export function needsReview(info: StepInformation | undefined, valid: boolean) {
  if (valid) return false;
  return (info?.schema ?? []).some(field => info?.values?.[field.id]?.status === "confirmed" ||
    Boolean(info?.previouslyConfirmed?.includes(field.id)));
}

/**
 * The turn's focus, the same rule the server uses (captureContext.ts): the first
 * required field without content, else the first unconfirmed field, else the last.
 * It is only the request identity; the server derives the real task itself.
 */
export function focusField(info: StepInformation | undefined): string | undefined {
  const schema = info?.schema ?? [];
  const missing = schema.find(field => field.required && !hasContent(info?.values?.[field.id]));
  return (missing ?? schema.find(field => info?.values?.[field.id]?.status !== "confirmed") ?? schema.at(-1))?.id;
}

/** What the user saw of one step when reviewing it: every field and every shown update identity. */
export type VisibleStep = { values: Record<string, FieldValue>; updates: Record<string, string> };

export function visibleStep(info: StepInformation | undefined, edits?: Record<string, FieldValue>): VisibleStep {
  const values: Record<string, FieldValue> = {}, updates: Record<string, string> = {};
  for (const field of info?.schema ?? []) {
    const value = shownValue(info, edits, field.id);
    values[field.id] = { value: value.value, status: value.status, nature: value.nature };
    const suggestion = fieldMeta(info, field.id).suggestion;
    if (suggestion) updates[field.id] = suggestion.executionId + ":" + suggestion.hash;
  }
  return { values, updates };
}

/** The review baseline with the user's own later edits applied on top. */
export function withEdits(baseline: VisibleStep, edits?: Record<string, FieldValue>): VisibleStep {
  if (!edits) return baseline;
  const values = { ...baseline.values };
  for (const [id, value] of Object.entries(edits)) if (Object.hasOwn(values, id)) values[id] = { ...value };
  return { values, updates: baseline.updates };
}

const sameValue = (a: FieldValue | undefined, b: FieldValue | undefined) =>
  (a?.value ?? "") === (b?.value ?? "") && (a?.status ?? "unknown") === (b?.status ?? "unknown") &&
  (a?.nature ?? "unknown") === (b?.nature ?? "unknown");

/** Every field and every update identity must match; anything else means "review again". */
export function sameVisibleStep(a: VisibleStep, b: VisibleStep) {
  const ids = new Set([...Object.keys(a.values), ...Object.keys(b.values)]);
  for (const id of ids) if (!sameValue(a.values[id], b.values[id])) return false;
  const updates = new Set([...Object.keys(a.updates), ...Object.keys(b.updates)]);
  for (const id of updates) if (a.updates[id] !== b.updates[id]) return false;
  return true;
}

export type ReviewProblem = { fieldId: string; reason: "required" | "reason_required" | "non_answer" };

/**
 * The values one step confirmation writes, from exactly what the user reviewed.
 * A field with content is confirmed; a field the user chose to defer keeps its
 * written reason as a deferral; an empty optional field stays empty. A required
 * field with neither content nor a reason, or a value that is only a recorded
 * non-answer ("好的", "不知道"), is reported instead of being confirmed.
 */
export function stepConfirmationValues(schema: readonly ChecklistField[], reviewed: VisibleStep,
  deferred: ReadonlySet<string>, nonAnswers: readonly string[] = []) {
  const values: Record<string, FieldValue> = {};
  const problems: ReviewProblem[] = [];
  for (const field of schema) {
    const current = reviewed.values[field.id] ?? EMPTY_VALUE;
    const text = current.value.trim();
    if (deferred.has(field.id)) {
      if (!text) problems.push({ fieldId: field.id, reason: "reason_required" });
      values[field.id] = { value: text, status: "deferred", nature: current.nature };
    } else if (text) {
      if (isRecordedNonAnswer(text, nonAnswers)) problems.push({ fieldId: field.id, reason: "non_answer" });
      values[field.id] = { value: text, status: "confirmed", nature: current.nature };
    } else {
      if (field.required) problems.push({ fieldId: field.id, reason: "required" });
      values[field.id] = { value: "", status: "unknown", nature: current.nature };
    }
  }
  return { values, problems };
}

/** The saved step result: each field's title and value, deferrals marked. */
export function stepBody(schema: readonly ChecklistField[], values: Record<string, FieldValue>) {
  return schema.filter(field => values[field.id]?.value)
    .map(field => `${field.title}\n${values[field.id]!.status === "deferred" ? "（暂缓确认）" : ""}${values[field.id]!.value}`)
    .join("\n\n");
}

/** Where a turn was asked: a revision opens a new round that reuses step ids. */
type TurnBinding = { roundId?: string | null; stepId?: string };
const sameStep = (a: TurnBinding | null | undefined, b: TurnBinding | null | undefined) =>
  Boolean(a?.roundId && a.stepId && a.roundId === b?.roundId && a.stepId === b?.stepId);

/**
 * A card can be answered only on the newest turn of its step and round. A later
 * turn (or a send still waiting for the server) turns it into history. The
 * focus of the step may have moved since the card was asked: the server binds
 * the answer to the card's own turn, so only the step and round must match.
 */
export function cardStatus(input: {
  isLatest: boolean;
  reply: (TurnBinding & { input: string | null }) | null;
  turn: TurnBinding | undefined;
  shown: { roundId: string | null; stepId: string };
}) {
  const answer = input.reply && sameStep(input.reply, input.turn) ? input.reply.input : null;
  return { answered: !input.isLatest || answer !== null, answer, onShownStep: sameStep(input.turn, input.shown) };
}
