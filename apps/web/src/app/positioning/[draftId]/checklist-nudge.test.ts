/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from "vitest";
import { checklistUpdatedInput } from "@repo/api/src/shared/opcQuestions";
import { clearSavedFields, freeAnswerSource, isChecklistUpdate, noteSavedFields, nudgeNotice, refusedTurn, savedFields, shownInput } from "./checklist-nudge";

function memory() {
  const map = new Map<string, string>();
  return { map, getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k) };
}
const schema = [{ id: "goal" }, { id: "audience" }, { id: "resource" }];

describe("checklist nudge", () => {
  it("collects saved fields per step, without duplicates, in schema order", () => {
    const storage = memory();
    noteSavedFields(storage, "d1", "s1", ["resource", "goal"]);
    noteSavedFields(storage, "d1", "s1", ["goal"]);
    noteSavedFields(storage, "d1", "s2", ["platform"]);
    expect(savedFields(storage, "d1", "s1", schema)).toEqual(["goal", "resource"]);
    expect(savedFields(storage, "d2", "s1", schema)).toEqual([]);
  });

  it("drops fields that are not in the step's schema", () => {
    const storage = memory();
    noteSavedFields(storage, "d1", "s1", ["gone", "audience"]);
    expect(savedFields(storage, "d1", "s1", schema)).toEqual(["audience"]);
  });

  it("clears every step once the user messages the mentor", () => {
    const storage = memory();
    noteSavedFields(storage, "d1", "s1", ["goal"]);
    noteSavedFields(storage, "d1", "s2", ["x"]);
    clearSavedFields(storage, "d1");
    expect(savedFields(storage, "d1", "s1", schema)).toEqual([]);
  });

  it("survives a malformed local record", () => {
    const storage = memory();
    storage.setItem("opc-checklist-nudge:d1", "{");
    expect(savedFields(storage, "d1", "s1", schema)).toEqual([]);
    noteSavedFields(storage, "d1", "s1", ["goal"]);
    expect(savedFields(storage, "d1", "s1", schema)).toEqual(["goal"]);
  });

  it("offers a click-only action and nothing without saved fields", () => {
    const click = vi.fn();
    expect(nudgeNotice([], click, false)).toBeNull();
    const notice = nudgeNotice(["goal", "audience"], click, true)!;
    expect(notice.text).toBe("你在清单里更新了 2 项");
    expect(notice.actions).toEqual([{ label: "让 AI 教练接着聊", onClick: click, disabled: true }]);
    expect(click).not.toHaveBeenCalled();
  });

  it("never shows the host marker as the user's words", () => {
    const input = checklistUpdatedInput(["goal", "audience"]);
    expect(isChecklistUpdate(input)).toBe(true);
    expect(shownInput(input)).toBe("我在清单里更新了 2 项，请接着聊");
    expect(shownInput("HOST_CHECKLIST_UPDATED:[")).toBe("我更新了清单，请接着聊");
    expect(shownInput("普通消息")).toBe("普通消息");
    expect(shownInput(null)).toBeNull();
    expect(isChecklistUpdate("我更新了清单")).toBe(false);
  });
});

it("hides the prompt as soon as a message is queued, before its saves clear the list", () => {
  expect(nudgeNotice(["goal"], () => undefined, true, true)).toBeNull();
  expect(nudgeNotice(["goal"], () => undefined, true)).toMatchObject({ id: "checklist-nudge" });
});

it("brings the prompt back after an unadmitted checklist turn, and a typed message back into the box", () => {
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
  const schema = [{ id: "goal" }, { id: "audience" }];
  const restore = vi.fn();
  refusedTurn(storage, "d", "s1", checklistUpdatedInput(["audience", "goal"]), restore);
  expect(savedFields(storage, "d", "s1", schema)).toEqual(["goal", "audience"]);
  expect(restore).not.toHaveBeenCalled();
  refusedTurn(storage, "d", "s1", "我的回答", restore);
  expect(restore).toHaveBeenCalledTimes(1);
});

describe("freeAnswerSource", () => {
  const latest = { executionId: "e1", state: "completed", body: JSON.stringify({ format: "agent-turn.v1", text: "hi",
    card: { question: "你每周能拿出多少时间？", options: ["3 小时以内", "3–10 小时"], recommended: 0 } }) };
  const turn = { roundId: "r1", stepId: "s1" };
  const base = { input: "三小时左右", latest, sourceTurn: turn, roundId: "r1", stepId: "s1" };

  it("answers the newest card of this step and round with typed text", () => {
    expect(freeAnswerSource(base)).toEqual({ executionId: "e1" });
  });
  it("keeps an explicit answer source", () => {
    expect(freeAnswerSource({ ...base, answerSource: { executionId: "e0", optionIndex: 1 } })).toEqual({ executionId: "e0", optionIndex: 1 });
  });
  it("a research refresh answers no card", () => {
    expect(freeAnswerSource({ ...base, input: "请重新读取对标账号 抖音 sample_1 的最新数据",
      researchRefreshId: "99999999-9999-4999-8999-999999999999" })).toBeUndefined();
  });
  it("another step or round, a turn without a card and an unfinished turn answer none", () => {
    expect(freeAnswerSource({ ...base, stepId: "s2" })).toBeUndefined();
    expect(freeAnswerSource({ ...base, roundId: "r2" })).toBeUndefined();
    expect(freeAnswerSource({ ...base, latest: { ...latest, body: JSON.stringify({ format: "agent-turn.v1", text: "hi" }) } })).toBeUndefined();
    expect(freeAnswerSource({ ...base, latest: { ...latest, state: "running" } })).toBeUndefined();
    expect(freeAnswerSource({ ...base, latest: null })).toBeUndefined();
  });
});
