/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CARD_SETTLE_MS, confirmCardModel, readStepSignal, shownLongEnough, StepConfirmCard, type StepConfirmCardProps } from "./step-confirm-card";
import { stepConfirmation } from "../../../../../packages/api/src/shared/opcStepConfirmation";
import { savedRead } from "@/app/positioning/[draftId]/information-autosave";
import { fieldOrigin, fieldStateLabel, needsLook, sameVisibleStep, visibleStep, type FieldValue, type StepInformation } from "./capture-state";

const v = (value: string, status: FieldValue["status"] = "provisional"): FieldValue => ({ value, status, nature: "decision" });
const info = (): StepInformation => ({
  schema: [
    { id: "goal", title: "最终目标", required: true },
    { id: "audience", title: "受众", required: true },
    { id: "position", title: "定位建议", required: true, elicitation: "agent_proposal" },
    { id: "benchmark", title: "对标账号", required: false },
  ],
  values: { goal: v("增加工作日下午的到店客流"), audience: v("附近独自阅读的自由职业者"), position: v("安静工作的第三空间"), benchmark: v("某书店", "confirmed") },
  meta: {
    goal: { source: "user" }, audience: { source: "capture" }, position: { source: "capture" }, benchmark: { source: "capture" },
    audience_unused: {},
  },
});

describe("field origin", () => {
  it("tells the user's own text, content from the conversation and the mentor's suggestion apart", () => {
    const i = info();
    expect(fieldOrigin(i.schema[0]!, { source: "user" })).toBe("user");
    expect(fieldOrigin(i.schema[1]!, { source: "capture" })).toBe("capture");
    expect(fieldOrigin(i.schema[2]!, { source: "capture" })).toBe("proposal");
    expect(fieldOrigin(i.schema[1]!, {})).toBe("unknown");
    // Since #702 each capture records its basis, which wins over the Skill role.
    expect(fieldOrigin(i.schema[1]!, { source: "capture", basis: "agent_proposal" })).toBe("proposal");
    expect(fieldOrigin(i.schema[2]!, { source: "capture", basis: "user_statement" })).toBe("capture");
    expect(fieldStateLabel(v("x"), { source: "capture" }, i.schema[2]!)).toBe("草稿 · 导师建议");
    expect(fieldStateLabel(v("x"), { source: "capture" }, i.schema[1]!)).toBe("草稿 · 从对话记下");
    expect(fieldStateLabel(v("x"), { source: "user" }, i.schema[2]!)).toBe("草稿 · 你填写的");
  });
  it("asks for a look only at AI-organized or suggested drafts", () => {
    const i = info();
    expect(needsLook(v("x"), i.schema[1]!, { source: "capture" })).toBe(true);
    expect(needsLook(v("x"), i.schema[2]!, { source: "capture" })).toBe(true);
    expect(needsLook(v("x"), i.schema[0]!, { source: "user" })).toBe(false);
    expect(needsLook(v("x"), i.schema[1]!, {})).toBe(false);
    expect(needsLook(v("x", "confirmed"), i.schema[1]!, { source: "capture" })).toBe(false);
    expect(needsLook(v(""), i.schema[1]!, { source: "capture" })).toBe(false);
  });
});

describe("confirmCardModel", () => {
  it("lists every filled field briefly and flags the AI content to look at", () => {
    const model = confirmCardModel(info());
    expect(model.ready).toBe(true);
    expect(model.rows.map(row => row.id)).toEqual(["goal", "audience", "position", "benchmark"]);
    expect(model.look).toEqual(["audience", "position"]);
    expect(model.missing).toEqual([]);
  });
  it("treats a local edit as the user's own and shows long values in full", () => {
    const long = "很长的受众描述".repeat(10);
    const model = confirmCardModel(info(), { ...info().values!, audience: v(long) });
    expect(model.look).toEqual(["position"]);
    // The edit buffer carries unchanged fields too: those keep their origin.
    expect(confirmCardModel(info(), { ...info().values! }).look).toEqual(["audience", "position"]);
    expect(model.rows.find(row => row.id === "audience")!.text).toBe(long);
  });
  it("names the missing required items", () => {
    const i = info(); i.values!.audience = v("");
    const model = confirmCardModel(i);
    expect(model.ready).toBe(false);
    expect(model.missing).toEqual([{ id: "audience", title: "受众" }]);
  });
});

/** Clickable elements of the rendered card. */
function clickables(node: ReactNode): Array<{ label: string; click: () => void; disabled: boolean }> {
  if (Array.isArray(node)) return node.flatMap(clickables);
  if (!isValidElement(node)) return [];
  const element = node as ReactElement<{ children?: ReactNode; onClick?: () => void; disabled?: boolean }>;
  const own = typeof element.props.onClick === "function"
    ? [{ label: [element.props.children].flat().join(""), click: element.props.onClick, disabled: Boolean(element.props.disabled) }] : [];
  return [...own, ...clickables(element.props.children)];
}
function props(extra: Partial<StepConfirmCardProps> = {}): StepConfirmCardProps {
  return { stepId: "step-1", title: "了解你", info: info(), resuming: false, disabled: false, canConfirm: true,
    onConfirm: vi.fn(), onEdit: vi.fn(), onReview: vi.fn(), ...extra };
}
const html = (p: StepConfirmCardProps) => renderToStaticMarkup(createElement(StepConfirmCard, p));
/** The card's element tree, captured inside a real render so its hooks run. */
function tree(p: StepConfirmCardProps): ReactNode {
  let captured: ReactNode = null;
  renderToStaticMarkup(createElement(() => (captured = StepConfirmCard(p))));
  return captured;
}
const button = (p: StepConfirmCardProps, label: string) => clickables(tree(p)).find(item => item.label === label);

describe("StepConfirmCard", () => {
  it("is one card with the values, the items to look at, and one click to confirm", () => {
    const p = props();
    const out = html(p);
    expect(out).toContain('aria-label="本步确认"');
    expect(out).toContain("“了解你”的信息齐了");
    expect(out).toContain("附近独自阅读的自由职业者");
    expect((out.match(/data-look="true"/g) ?? []).length).toBe(2);
    button(p, "没问题，进入下一步")!.click();
    expect(p.onConfirm).toHaveBeenCalledTimes(1);
  });
  it("“我要改” marks the fields to look at in the checklist, and the review stays available", () => {
    const p = props();
    button(p, "我要改")!.click();
    expect(p.onEdit).toHaveBeenCalledWith(["audience", "position"]);
    button(p, "逐项核对或暂缓")!.click();
    expect(p.onReview).toHaveBeenCalled();
    const own = info(); own.meta = { goal: { source: "user" }, audience: { source: "user" }, position: { source: "user" }, benchmark: { source: "user" } };
    const ownOnly = props({ info: own });
    button(ownOnly, "我要改")!.click();
    expect(ownOnly.onEdit).toHaveBeenCalledWith(["goal", "audience", "position", "benchmark"]);
  });
  it("does not promise the next step when confirming stays on it (account revision or last step)", () => {
    expect(button(props({ stays: true }), "没问题，确认这一步")).toBeDefined();
    expect(button(props({ stays: true }), "没问题，进入下一步")).toBeUndefined();
  });
  it("cannot confirm while a reply runs or before upstream steps are confirmed", () => {
    expect(button(props({ canConfirm: false }), "没问题，进入下一步")!.disabled).toBe(true);
    expect(button(props({ canConfirm: false }), "我要改")!.disabled).toBe(false);
    expect(button(props({ disabled: true }), "我要改")!.disabled).toBe(true);
    // The review confirms too, so it waits for the same conditions.
    expect(button(props({ canConfirm: false }), "逐项核对或暂缓")!.disabled).toBe(true);
  });
  it("names what is missing and keeps the deferral entry", () => {
    const i = info(); i.values!.audience = v("");
    const p = props({ info: i });
    const out = html(p);
    expect(out).toContain("还差：受众");
    expect(out).not.toContain("没问题，进入下一步");
    button(p, "去右侧补充")!.click();
    expect(p.onEdit).toHaveBeenCalledWith(["audience"]);
    button(p, "暂时无法确定，写原因暂缓")!.click();
    expect(p.onReview).toHaveBeenCalled();
  });
  it("shows nothing before anything was recorded, and continues a started confirmation", () => {
    expect(html(props({ info: { ...info(), values: {} } }))).toBe("");
    const resume = props({ resuming: true, info: { ...info(), values: {} } });
    expect(html(resume)).toContain("确认还没完成");
    expect(button(resume, "继续完成确认")).toBeDefined();
  });
  it("mentions pending updates are not part of the confirmation", () => {
    const i = info(); i.meta!.goal = { source: "user", suggestion: { executionId: "e", hash: "h", value: "新", status: "provisional", nature: "decision" } };
    expect(html(props({ info: i }))).toContain("还有 1 条“根据对话整理的更新”没处理");
  });
});

describe("server confirmation signal (#713)", () => {
  // The backend's own function, so the card is tested against the real signal shape.
  const signal = (i: StepInformation, valid = false) => stepConfirmation(i as Parameters<typeof stepConfirmation>[0], valid);
  it("reads only a well-formed signal", () => {
    expect(readStepSignal(signal(info()))).toEqual(signal(info()));
    for (const bad of [null, "x", { ...signal(info()), stepReady: "yes" }, { ...signal(info()), needsLookFieldIds: [1] }])
      expect(readStepSignal(bad)).toBeUndefined();
  });
  it("uses the server's readiness and look list while nothing is edited locally", () => {
    const legacy = info(); legacy.meta = {}; // No recorded source: the server conservatively asks for a look.
    const model = confirmCardModel(legacy, undefined, readStepSignal(signal(legacy)));
    expect(model).toMatchObject({ ready: true, current: true });
    expect(model.look).toEqual(["goal", "audience", "position"]);
    const missing = info(); missing.values!.audience = v("");
    expect(confirmCardModel(missing, undefined, readStepSignal(signal(missing))).ready).toBe(false);
  });
  it("never offers one-click confirmation from a signal older than a local edit", () => {
    const i = info();
    const model = confirmCardModel(i, { ...i.values!, goal: v("刚改的目标") }, readStepSignal(signal(i)));
    expect(model.current).toBe(false);
    expect(model.look).toEqual(["audience", "position"]);
    const p = props({ edits: { ...i.values!, goal: v("刚改的目标") }, signal: signal(i) });
    expect(html(p)).toContain("刚改过的内容正在保存");
    expect(button(p, "没问题，进入下一步")!.disabled).toBe(true);
    expect(button(p, "逐项核对或暂缓")!.disabled).toBe(false);
    // An unchanged edit buffer is not a newer edit.
    expect(button(props({ edits: { ...i.values! }, signal: signal(i) }), "没问题，进入下一步")!.disabled).toBe(false);
  });
  it("keeps resuming a started confirmation available", () => {
    const i = info();
    const p = props({ resuming: true, edits: { ...i.values!, goal: v("刚改的目标") }, signal: signal(i) });
    expect(button(p, "继续完成确认")!.disabled).toBe(false);
    // The review would resume the retained confirmation as well, so it is not offered meanwhile.
    expect(button(p, "逐项核对或暂缓")).toBeUndefined();
    expect(button(p, "我要改")).toBeUndefined();
  });
});

describe("a signal older than the cached values", () => {
  it("is marked stale when an autosave writes values into the cached read, and the card waits for the next read", () => {
    const i = info();
    const read = { information: { s1: i }, snapshot: { steps: { s1: { version: 3 } } }, stepConfirmation: { s1: stepConfirmation(i as never, false) } };
    const saved = savedRead(read, "s1", { ...i.values!, audience: v("") }, 4);
    expect(saved.stepConfirmation.s1).toEqual({ stale: true });
    expect(readStepSignal(saved.stepConfirmation.s1)).toBe("stale");
    // The cleared required field shows as missing from the saved values, never as complete from the old signal.
    const model = confirmCardModel(saved.information.s1, undefined, readStepSignal(saved.stepConfirmation.s1));
    expect(model).toMatchObject({ ready: false, current: false, look: [] });
    const filled = confirmCardModel(i, undefined, "stale");
    expect(filled).toMatchObject({ ready: true, current: false, look: [] });
    expect(button(props({ signal: { stale: true } }), "没问题，进入下一步")!.disabled).toBe(true);
    // A read without signals (an older server) keeps the local rules.
    expect(savedRead({ information: { s1: i }, snapshot: { steps: { s1: { version: 3 } } } }, "s1", i.values!, 4)).not.toHaveProperty("stepConfirmation");
  });
});

describe("one click only after the content has been on screen (A5)", () => {
  it("is refused when the card changed or the tab became visible moments before the click", () => {
    // Tab Y saved a new value; returning to tab X refetched the read a moment later, so X's card changed
    // right before the click. The click must open the review, not confirm what the user had no time to see.
    expect(shownLongEnough({ changedAt: 10_000, visibleAt: 0, now: 10_500 })).toBe(false);
    expect(shownLongEnough({ changedAt: 0, visibleAt: 10_000, now: 10_500 })).toBe(false);
    expect(shownLongEnough({ changedAt: 10_000, visibleAt: 9_000, now: 10_000 + CARD_SETTLE_MS })).toBe(true);
  });
  it("without the settle check, the stale-then-refreshed card would confirm the new value unseen", async () => {
    // The click handler sees the refreshed props, and the server still has them: the snapshot comparison
    // alone cannot tell that the user never looked at them.
    const fresh = info(); fresh.values!.audience = v("周边2公里、偏好周六下午体验双人合作桌游");
    const reviewed = visibleStep(fresh);
    expect(sameVisibleStep(reviewed, visibleStep(fresh))).toBe(true);
    expect(shownLongEnough({ changedAt: 1_000, visibleAt: 0, now: 1_300 })).toBe(false);
  });
});
