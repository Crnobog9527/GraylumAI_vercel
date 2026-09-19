/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from "vitest";
import {
  confirmationActionIsRedundant,
  confirmQuestionValues,
  displayedQuestion,
  emptyAnswer,
  isRecordedNonAnswer,
  navigatorRows,
  nextInformationQuestion,
  openingEntryKey,
  openingRequestId,
  questionDisplayState,
  questionLabel,
  questionStatusLabel,
  reachedQuestions,
  type QuestionAnswer,
} from "./opcQuestions";

const schema = [
  { id: "lane", title: "赛道", required: true },
  { id: "offer", title: "商业卖点", required: true },
  { id: "extra", title: "补充", required: false },
];

it("starts from the first question when persisted values are null", () => {
  expect(displayedQuestion(schema, null)?.id).toBe("lane");
  expect(reachedQuestions(schema, null).map((f) => f.id)).toEqual(["lane"]);
});

it("typing or a suggestion cannot confirm or expose future questions", () => {
  for (const status of ["unknown", "unclear", "provisional"] as const) {
    const values = { lane: { ...emptyAnswer, value: "AI", status } };
    expect(nextInformationQuestion(schema, values)?.id).toBe("lane");
    expect(reachedQuestions(schema, values).map((f) => f.id)).toEqual(["lane"]);
    expect(displayedQuestion(schema, values, "offer")?.id).toBe("lane");
    expect(displayedQuestion(schema, values, "unknown-question")?.id).toBe("lane");
  }
});

it("confirms one field only and preserves every other answer", () => {
  const values = {
    lane: { ...emptyAnswer, value: "AI", status: "provisional" as const },
    offer: { ...emptyAnswer, value: "Still thinking" },
  };
  const first = confirmQuestionValues(schema, values, "lane");
  expect(first.finishStep).toBe(false);
  expect(first.values.offer).toEqual(values.offer);
  expect(values.lane.status).toBe("provisional");
  expect(nextInformationQuestion(schema, first.values)?.id).toBe("offer");
  expect(reachedQuestions(schema, first.values).map((f) => f.id)).toEqual(["lane", "offer"]);
  expect(displayedQuestion(schema, first.values, "lane")?.id).toBe("lane");
  expect(() => confirmQuestionValues(schema, values, "extra")).toThrow("NOT_REACHED");
});

it("requires a reason for required deferral and explicit optional skip", () => {
  expect(() => confirmQuestionValues(schema, {}, "lane", true)).toThrow("ANSWER_REQUIRED");
  const first = confirmQuestionValues(
    schema,
    { lane: { ...emptyAnswer, value: "尚缺案例，接受局限" } },
    "lane",
    true,
  );
  const second = confirmQuestionValues(
    schema,
    { ...first.values, offer: { ...emptyAnswer, value: "摄影课程" } },
    "offer",
  );
  expect(second.finishStep).toBe(false);
  const last = confirmQuestionValues(schema, second.values, "extra", true);
  expect(last.finishStep).toBe(true);
  expect(nextInformationQuestion(schema, last.values)).toBeUndefined();
});

it("editing a previous answer reopens it without deleting later saved answers", () => {
  const values: Record<string, QuestionAnswer> = Object.fromEntries(
    schema.map((f) => [f.id, { ...emptyAnswer, value: f.title, status: "confirmed" }]),
  );
  values.lane = { ...values.lane, status: "provisional" };
  expect(nextInformationQuestion(schema, values)?.id).toBe("lane");
  expect(confirmQuestionValues(schema, values, "lane").values.offer).toEqual(values.offer);
});

it("numbers the current question from the method's own step and field order", () => {
  expect(questionLabel(0, schema, "lane")).toBe("1.1");
  expect(questionLabel(0, schema, "offer")).toBe("1.2");
  expect(questionLabel(0, schema, "extra")).toBe("1.3");
  expect(questionLabel(2, schema, "offer")).toBe("3.2");
  expect(questionLabel(0, schema, "future")).toBeNull();
  expect(questionLabel(0, schema, null)).toBeNull();
  // The number follows the declared order, not the label text.
  expect(questionLabel(0, [{ id: "b", title: "第二", required: true }, { id: "a", title: "第一", required: true }], "a")).toBe("1.2");
});

it("derives one stable opening identity per round entry", () => {
  const first = openingRequestId("draft", "round-a", "step-1", "niche");
  // Refresh, re-login, a second tab or a lost reply stay inside the same round.
  expect(first).toBe(openingRequestId("draft", "round-a", "step-1", "niche"));
  expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(first).not.toBe(openingRequestId("draft", "round-a", "step-1", "supply"));
  expect(first).not.toBe(openingRequestId("draft", "round-a", "step-2", "niche"));
  expect(first).not.toBe(openingRequestId("other-draft", "round-a", "step-1", "niche"));
});

it("gives a revised round its own opening identity for the same question", () => {
  // A revision legitimately needs a fresh opening for the same step/question,
  // while the older round keeps the identity its unresolved request was
  // created with, so that request stays recoverable instead of being reused.
  const originalRound = openingRequestId("draft", "round-a", "step-0", "goal");
  const revisedRound = openingRequestId("draft", "round-b", "step-0", "goal");
  expect(revisedRound).not.toBe(originalRound);
  expect(openingRequestId("draft", "round-b", "step-0", "goal")).toBe(revisedRound);
  expect(openingEntryKey("draft", "round-a", "step-0", "goal"))
    .not.toBe(openingEntryKey("draft", "round-b", "step-0", "goal"));
  expect(openingEntryKey("draft", "round-a", "step-0", "goal"))
    .toBe(openingEntryKey("draft", "round-a", "step-0", "goal"));
});

it("refuses to confirm a recorded acknowledgement or uncertainty as the answer", () => {
  const values = {
    lane: { ...emptyAnswer, value: "好的", status: "provisional" as const },
  };
  expect(isRecordedNonAnswer("好的。", ["好的"])).toBe(true);
  expect(isRecordedNonAnswer("面向独立开发者", ["好的"])).toBe(false);
  expect(() => confirmQuestionValues(schema, values, "lane", false, { nonAnswers: ["好的"] }))
    .toThrow("NOT_SUBSTANTIVE");
  // An explicit deferral is still allowed and keeps its own reason.
  const deferred = confirmQuestionValues(
    schema,
    { lane: { ...emptyAnswer, value: "还没有案例，接受局限" } },
    "lane",
    true,
    { nonAnswers: ["好的"] },
  );
  expect(deferred.values.lane.status).toBe("deferred");
  // Without a recorded non-answer the user's own text is unchanged behaviour.
  expect(confirmQuestionValues(schema, values, "lane").values.lane.status).toBe("confirmed");
});

it("preserves a recorded uncertainty as an explicit deferral, never as a confirmed fact", () => {
  const reason = "还没有案例，接受局限";
  const original: Record<string, QuestionAnswer> = {
    lane: { ...emptyAnswer, value: reason, status: "unclear" },
    offer: { ...emptyAnswer, value: "保留后面的已保存内容", status: "provisional" },
  };
  const options = { nonAnswers: [reason] };
  expect(() => confirmQuestionValues(schema, original, "lane", false, options))
    .toThrow("OPC_QUESTION_ANSWER_NOT_SUBSTANTIVE");
  const result = confirmQuestionValues(schema, original, "lane", true, options);
  expect(result.values.lane).toEqual({ ...original.lane, status: "deferred" });
  expect(result.values.offer).toEqual(original.offer);
  expect(original.lane.status).toBe("unclear");
  expect(result.finishStep).toBe(false);
  expect(() => confirmQuestionValues(schema, {}, "lane", true, options))
    .toThrow("OPC_QUESTION_ANSWER_REQUIRED");
});

it("keeps every reached question in the navigator with its own truthful status", () => {
  const values: Record<string, QuestionAnswer> = {
    lane: { ...emptyAnswer, value: "AI 工具", status: "confirmed" },
    offer: { ...emptyAnswer, value: "摄影经验", status: "deferred" },
    extra: { ...emptyAnswer, value: "草稿", status: "provisional" },
  };
  const rows = navigatorRows(0, schema, values, "offer");
  expect(rows.map((row) => row.id)).toEqual(["lane", "offer", "extra"]);
  expect(rows.map((row) => row.label)).toEqual(["1.1", "1.2", "1.3"]);
  expect(rows.map((row) => row.state)).toEqual(["confirmed", "deferred", "pending"]);
  expect(rows.map((row) => row.selected)).toEqual([false, true, false]);
  expect(questionStatusLabel(rows[0].state)).toBe("已确认");
  expect(questionStatusLabel(rows[1].state)).toBe("待定（已暂缓）");
  // Reached = already resolved plus the current one; the unseen 1.5 stays out.
  const onlyLaneReached = navigatorRows(0, schema, { lane: values.lane }, "lane");
  expect(onlyLaneReached.map((r) => r.id)).toEqual(["lane", "offer"]);
  expect(onlyLaneReached.map((r) => r.label)).toEqual(["1.1", "1.2"]);
  expect(onlyLaneReached.some((r) => r.id === "extra")).toBe(false);
  // A later step numbers its own rows from the pinned field order.
  expect(navigatorRows(2, schema, { lane: values.lane }, "lane")[0].label).toBe("3.1");
});

it("keeps navigator order, identity and status stable while selection changes", () => {
  const values: Record<string, QuestionAnswer> = {
    lane: { ...emptyAnswer, value: "AI 工具", status: "confirmed" },
    offer: { ...emptyAnswer, value: "摄影经验", status: "deferred" },
  };
  const atLane = navigatorRows(0, schema, values, "lane");
  const atOffer = navigatorRows(0, schema, values, "offer");
  expect(atLane.map((row) => row.id)).toEqual(atOffer.map((row) => row.id));
  expect(atLane.map((row) => row.title)).toEqual(atOffer.map((row) => row.title));
  expect(atLane.map((row) => row.state)).toEqual(atOffer.map((row) => row.state));
  // Selecting a reviewed row never changes its answer status.
  expect(atOffer[1].state).toBe("deferred");
});

it("never presents a deferred answer as confirmed in the display state", () => {
  expect(questionDisplayState({ ...emptyAnswer, value: "暂缓原因", status: "deferred" })).toBe("deferred");
  expect(questionDisplayState({ ...emptyAnswer, value: "已确认内容", status: "confirmed" })).toBe("confirmed");
  expect(questionDisplayState({ ...emptyAnswer, value: "草稿", status: "provisional" })).toBe("pending");
  expect(questionDisplayState({ ...emptyAnswer, value: "   ", status: "confirmed" })).toBe("unanswered");
  expect(questionDisplayState(undefined)).toBe("unanswered");
});

it("separates a redundant re-confirmation from a deferred → confirmed action", () => {
  const deferred: QuestionAnswer = { ...emptyAnswer, value: "还没有案例", status: "deferred" };
  const confirmed: QuestionAnswer = { ...emptyAnswer, value: "还没有案例", status: "confirmed" };
  expect(confirmationActionIsRedundant(confirmed, "confirm", "还没有案例")).toBe(true);
  expect(confirmationActionIsRedundant(deferred, "defer", "还没有案例")).toBe(true);
  // Explicitly revisiting a skipped question is a real action even when the stored
  // text is identical, so it must never be suppressed as a duplicate.
  expect(confirmationActionIsRedundant(deferred, "confirm", "还没有案例")).toBe(false);
  expect(confirmationActionIsRedundant(confirmed, "defer", "还没有案例")).toBe(false);
  expect(confirmationActionIsRedundant(confirmed, "confirm", "改过的内容")).toBe(false);
  expect(confirmationActionIsRedundant(undefined, "confirm", "任何内容")).toBe(false);
});

it("an earlier answer under edit never hides later reached rows", () => {
  const values: Record<string, QuestionAnswer> = {
    lane: { ...emptyAnswer, value: "正在修改", status: "provisional" },
    offer: { ...emptyAnswer, value: "摄影经验", status: "deferred" },
    extra: { ...emptyAnswer, value: "已确认补充", status: "confirmed" },
  };
  // The progression prefix shrinks while lane is unresolved…
  expect(reachedQuestions(schema, values).map((f) => f.id)).toEqual(["lane"]);
  // …but the review rows keep every question that was already reached.
  const rows = navigatorRows(0, schema, values, "lane");
  expect(rows.map((row) => row.id)).toEqual(["lane", "offer", "extra"]);
  expect(rows.map((row) => row.label)).toEqual(["1.1", "1.2", "1.3"]);
  expect(rows.map((row) => row.state)).toEqual(["pending", "deferred", "confirmed"]);
  expect(rows[0].selected).toBe(true);
});

it("server-recorded turns extend the visible reach without exposing unreached questions", () => {
  const values: Record<string, QuestionAnswer> = {
    lane: { ...emptyAnswer, value: "改过的内容", status: "provisional" },
  };
  expect(navigatorRows(0, schema, values, "lane").map((row) => row.id)).toEqual(["lane"]);
  expect(navigatorRows(0, schema, values, "lane", ["extra"]).map((row) => row.id))
    .toEqual(["lane", "offer", "extra"]);
  expect(navigatorRows(0, schema, values, "lane", ["extra", "unknown-id"]).map((row) => row.id))
    .toEqual(["lane", "offer", "extra"]);
  expect(navigatorRows(0, schema, values, "lane", ["unknown-id"]).map((row) => row.id))
    .toEqual(["lane"]);
});

it("keeps the already answered rows pinned when an earlier question becomes provisional", () => {
  const resolved: Record<string, QuestionAnswer> = {
    lane: { ...emptyAnswer, value: "AI 工具", status: "confirmed" },
    offer: { ...emptyAnswer, value: "摄影经验", status: "deferred" },
  };
  const before = navigatorRows(0, schema, resolved, "offer");
  const editing: Record<string, QuestionAnswer> = {
    ...resolved,
    lane: { ...resolved.lane, value: "AI 工具（修改中）", status: "provisional" },
  };
  const after = navigatorRows(0, schema, editing, "offer");
  // Every answered row keeps its pinned identity, label and order.
  expect(after.map((row) => row.id)).toEqual(["lane", "offer"]);
  expect(after.map((row) => row.label)).toEqual(["1.1", "1.2"]);
  expect(before.slice(0, 2).map((row) => row.id)).toEqual(after.map((row) => row.id));
  expect(before.slice(0, 2).map((row) => row.label)).toEqual(after.map((row) => row.label));
  expect(before.slice(0, 2).map((row) => row.title)).toEqual(after.map((row) => row.title));
  expect(after[0].state).toBe("pending");
  expect(after[1].state).toBe("deferred");
  // The never answered, never opened trailing question was only the current
  // row; it is not invented into the review list.
  expect(before.map((row) => row.id)).toContain("extra");
  expect(after.map((row) => row.id)).not.toContain("extra");
});
