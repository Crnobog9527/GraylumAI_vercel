/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { confirmCardModel, StepConfirmCard, type StepConfirmCardProps } from "./step-confirm-card";
import { fieldOrigin, fieldStateLabel, needsLook, type FieldValue, type StepInformation } from "./capture-state";

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
  return { title: "了解你", info: info(), resuming: false, disabled: false, canConfirm: true,
    onConfirm: vi.fn(), onEdit: vi.fn(), onReview: vi.fn(), ...extra };
}
const html = (p: StepConfirmCardProps) => renderToStaticMarkup(createElement(StepConfirmCard, p));
const button = (p: StepConfirmCardProps, label: string) => clickables(StepConfirmCard(p)).find(item => item.label === label);

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
  it("does not promise the next step for an account revision, which stays on the edited step", () => {
    expect(button(props({ revision: true }), "没问题，确认这一步的修改")).toBeDefined();
    expect(button(props({ revision: true }), "没问题，进入下一步")).toBeUndefined();
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
