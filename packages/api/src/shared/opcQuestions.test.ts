/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from "vitest";
import {
  confirmQuestionValues,
  displayedQuestion,
  emptyAnswer,
  isRecordedNonAnswer,
  nextInformationQuestion,
  openingEntryKey,
  openingRequestId,
  questionLabel,
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
