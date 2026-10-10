/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from "vitest";
import {
  cardStatus, editedValue, fieldMeta, fieldState, fieldStateLabel, focusField, needsReview, sameVisibleStep, stepBody,
  stepConfirmationValues, stepProgress, visibleStep, withEdits, type FieldValue, type StepInformation,
} from "./capture-state";

const v = (value: string, status: FieldValue["status"] = "provisional", nature: FieldValue["nature"] = "decision"): FieldValue =>
  ({ value, status, nature });
const update = { executionId: "e1", seq: ["2026-10-06T00:00:00Z", "e1"], value: "先试运营一个月", status: "provisional",
  nature: "decision", basis: "user_statement", hash: "h1" };
const info = (): StepInformation => ({
  schema: [
    { id: "goal", title: "最终目标", required: true },
    { id: "audience", title: "受众", required: true },
    { id: "platform", title: "平台", required: true },
    { id: "benchmark", title: "对标账号", required: false },
  ],
  values: { goal: v("增加到店客流"), audience: v(""), platform: v("小红书", "confirmed") },
  meta: {
    goal: { source: "user", protected: true, suggestion: { ...update } },
    audience: { protected: false },
    platform: { source: "capture", protected: true },
  },
});

describe("fieldMeta", () => {
  it("reads the server metadata and keeps a well-formed update", () => {
    expect(fieldMeta(info(), "goal")).toEqual({ source: "user", protected: true,
      suggestion: { executionId: "e1", hash: "h1", value: "先试运营一个月", status: "provisional", nature: "decision" } });
    expect(fieldMeta(info(), "audience")).toEqual({ protected: false });
  });
  it("drops a malformed update instead of offering it", () => {
    for (const suggestion of [{ ...update, hash: "" }, { ...update, value: "  " }, { ...update, status: "maybe" }, { ...update, executionId: 1 }, "x"]) {
      const broken = { ...info(), meta: { goal: { source: "user", suggestion } } };
      expect(fieldMeta(broken, "goal").suggestion).toBeUndefined();
    }
    expect(fieldMeta({ ...info(), meta: { goal: ["x"] } }, "goal")).toEqual({});
    expect(fieldMeta(undefined, "goal")).toEqual({});
  });
  it("reads a withdrawn update separately, never as pending, and drops a malformed one", () => {
    const withdrawn = { ...update, withdrawnBy: "e2", withdrawnSeq: ["t", "e2"] };
    const read = fieldMeta({ ...info(), meta: { goal: { source: "user", withdrawnSuggestion: withdrawn } } }, "goal");
    expect(read).toEqual({ source: "user", withdrawn: { executionId: "e1", hash: "h1", value: "先试运营一个月", status: "provisional",
      nature: "decision" } });
    expect(stepProgress({ ...info(), meta: { goal: { withdrawnSuggestion: withdrawn } } }).updates).toBe(0);
    expect(fieldMeta({ ...info(), meta: { goal: { withdrawnSuggestion: { ...withdrawn, hash: "" } } } }, "goal")).toEqual({});
  });
});

describe("field and step states", () => {
  it("labels each field without question numbers", () => {
    const i = info();
    expect(fieldStateLabel(i.values!.goal, fieldMeta(i, "goal"))).toBe("草稿 · 你填写的");
    expect(fieldStateLabel(i.values!.platform, {})).toBe("已确认");
    expect(fieldStateLabel(v("原因", "deferred"), {})).toBe("已暂缓");
    expect(fieldStateLabel(v("记下的", "provisional"), { source: "capture" })).toBe("草稿 · 从对话记下");
    expect(fieldStateLabel(undefined, {})).toBe("还没聊到");
    expect(fieldState(v("  ", "confirmed"))).toBe("missing");
  });
  it("counts missing required items, captured drafts and pending updates", () => {
    const i = info();
    expect(stepProgress(i)).toMatchObject({ ready: false, captured: 0, updates: 1 });
    expect(stepProgress(i).missingRequired.map(f => f.id)).toEqual(["audience"]);
    // An unsaved edit counts as content; a written deferral reason too.
    expect(stepProgress(i, { ...i.values!, audience: v("附近的自由职业者") }).ready).toBe(true);
    expect(stepProgress(i, { ...i.values!, audience: v("还没想好", "deferred") }).ready).toBe(true);
    const captured = { ...i, meta: { ...i.meta, goal: { source: "capture" } } };
    expect(stepProgress(captured).captured).toBe(1);
    expect(stepProgress(undefined)).toMatchObject({ ready: false, missingRequired: [] });
  });
  it("marks a step that was confirmed before and is a draft again", () => {
    expect(needsReview(info(), false)).toBe(true);
    expect(needsReview(info(), true)).toBe(false);
    expect(needsReview({ ...info(), values: {}, previouslyConfirmed: ["goal"] }, false)).toBe(true);
    expect(needsReview({ ...info(), values: {} }, false)).toBe(false);
  });
  it("derives the same focus as the server: first missing required, else first unconfirmed, else last", () => {
    expect(focusField(info())).toBe("audience");
    const full = { ...info(), values: { goal: v("a"), audience: v("b"), platform: v("c", "confirmed") } };
    expect(focusField(full)).toBe("goal");
    const done = { ...info(), values: Object.fromEntries(info().schema.map(f => [f.id, v("x", "confirmed")])) };
    expect(focusField(done)).toBe("benchmark");
    expect(focusField({ schema: [] })).toBeUndefined();
  });
});

describe("visible step snapshot", () => {
  it("binds values and the shown update identities", () => {
    const seen = visibleStep(info());
    expect(seen.updates).toEqual({ goal: "e1:h1" });
    expect(seen.values.benchmark).toEqual({ value: "", status: "unknown", nature: "unknown" });
    expect(sameVisibleStep(seen, visibleStep(info()))).toBe(true);
  });
  it("detects a capture, an edit elsewhere, and a new or replaced update", () => {
    const seen = visibleStep(info());
    const captured = info(); captured.values!.audience = v("新记下的");
    expect(sameVisibleStep(seen, visibleStep(captured))).toBe(false);
    const status = info(); status.values!.goal = v("增加到店客流", "confirmed");
    expect(sameVisibleStep(seen, visibleStep(status))).toBe(false);
    const replaced = info(); (replaced.meta!.goal as { suggestion: typeof update }).suggestion.hash = "h2";
    expect(sameVisibleStep(seen, visibleStep(replaced))).toBe(false);
    const added = info(); added.meta!.audience = { suggestion: { ...update, executionId: "e2" } };
    expect(sameVisibleStep(seen, visibleStep(added))).toBe(false);
    const gone = info(); delete (gone.meta!.goal as { suggestion?: unknown }).suggestion;
    expect(sameVisibleStep(seen, visibleStep(gone))).toBe(false);
  });
  it("applies the user's own edits on top of the reviewed baseline only", () => {
    const seen = visibleStep(info());
    const edited = withEdits(seen, { audience: v("附近的自由职业者"), unknown: v("ignored") });
    expect(edited.values.audience!.value).toBe("附近的自由职业者");
    expect(edited.values.unknown).toBeUndefined();
    expect(withEdits(seen, undefined)).toBe(seen);
  });
});

describe("stepConfirmationValues", () => {
  const schema = info().schema;
  it("confirms content, keeps deferral reasons and leaves empty optional fields empty", () => {
    const seen = visibleStep(info(), { ...info().values!, audience: v("还没想好受众", "provisional") });
    const { values, problems } = stepConfirmationValues(schema, seen, new Set(["audience"]));
    expect(problems).toEqual([]);
    expect(values).toEqual({
      goal: v("增加到店客流", "confirmed"), audience: v("还没想好受众", "deferred"),
      platform: v("小红书", "confirmed"), benchmark: { value: "", status: "unknown", nature: "unknown" },
    });
  });
  it("reports missing required items, missing reasons and recorded non-answers", () => {
    const seen = visibleStep(info());
    expect(stepConfirmationValues(schema, seen, new Set()).problems).toEqual([{ fieldId: "audience", reason: "required" }]);
    expect(stepConfirmationValues(schema, seen, new Set(["audience"])).problems).toEqual([{ fieldId: "audience", reason: "reason_required" }]);
    const echoed = visibleStep(info(), { ...info().values!, audience: v("好的。") });
    expect(stepConfirmationValues(schema, echoed, new Set(), ["好的"]).problems).toEqual([{ fieldId: "audience", reason: "non_answer" }]);
    // A deferral reason may repeat the recorded uncertainty.
    const unsure = visibleStep(info(), { ...info().values!, audience: v("不知道") });
    expect(stepConfirmationValues(schema, unsure, new Set(["audience"]), ["不知道"]).problems).toEqual([]);
  });
  it("builds the saved step body from the confirmed values", () => {
    const { values } = stepConfirmationValues(schema, visibleStep(info(), { ...info().values!, audience: v("原因") }), new Set(["audience"]));
    expect(stepBody(schema, values)).toBe("最终目标\n增加到店客流\n\n受众\n（暂缓确认）原因\n\n平台\n小红书");
  });
});

describe("cardStatus", () => {
  const turn = { roundId: "round-1", stepId: "audience" };
  const shown = { roundId: "round-1", stepId: "audience" };
  it("is open on the newest turn of the shown step, whatever the focus became", () => {
    expect(cardStatus({ isLatest: true, reply: null, turn, shown })).toEqual({ answered: false, answer: null, onShownStep: true });
  });
  it("becomes history once a reply in the same step exists or a later turn exists", () => {
    expect(cardStatus({ isLatest: true, reply: { ...turn, input: "刚入行的新人" }, turn, shown }))
      .toMatchObject({ answered: true, answer: "刚入行的新人" });
    expect(cardStatus({ isLatest: false, reply: { ...turn, input: null }, turn, shown })).toMatchObject({ answered: true, answer: null });
  });
  it("is locked on another step or round and never takes their reply as its answer", () => {
    const other = { roundId: "round-1", stepId: "positioning" };
    expect(cardStatus({ isLatest: true, reply: { ...other, input: "x" }, turn, shown })).toMatchObject({ answered: false, answer: null });
    expect(cardStatus({ isLatest: true, reply: null, turn, shown: other }).onShownStep).toBe(false);
    expect(cardStatus({ isLatest: true, reply: null, turn, shown: { ...shown, roundId: "round-2" } }).onShownStep).toBe(false);
    expect(cardStatus({ isLatest: true, reply: null, turn: undefined, shown }).onShownStep).toBe(false);
    expect(cardStatus({ isLatest: true, reply: null, turn: { stepId: "audience" }, shown }).onShownStep).toBe(false);
  });
});

describe("editedValue", () => {
  it("stores typed text like the autosave: provisional, empty is unknown, unknown nature becomes a decision", () => {
    expect(editedValue(v("原因", "deferred", "fact"), "具体答案")).toEqual(v("具体答案", "provisional", "fact"));
    expect(editedValue({ value: "", status: "unknown", nature: "unknown" }, "新")).toEqual(v("新"));
    expect(editedValue(v("x"), "  ")).toEqual({ value: "  ", status: "unknown", nature: "decision" });
  });
});

describe("fieldMeta basis (#702)", () => {
  it("reads the recorded basis of a capture and ignores anything else", () => {
    expect(fieldMeta({ schema: [], meta: { a: { source: "capture", basis: "agent_proposal" } } }, "a")).toEqual({ source: "capture", basis: "agent_proposal" });
    expect(fieldMeta({ schema: [], meta: { a: { source: "capture", basis: "guess" } } }, "a")).toEqual({ source: "capture" });
  });
});
