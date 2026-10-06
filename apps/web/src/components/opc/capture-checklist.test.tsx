/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CaptureChecklist, type CaptureChecklistProps } from "./capture-checklist";
import { StepReviewDialog, StepSummaryCard } from "./step-review-dialog";
import { visibleStep, type FieldValue } from "./capture-state";

const v = (value: string, status: FieldValue["status"] = "provisional"): FieldValue => ({ value, status, nature: "decision" });
const update = { executionId: "e1", hash: "h1", value: "……，先试运营一个月。", status: "provisional", nature: "decision" };
const steps = [{ id: "s1", title: "了解你" }, { id: "s2", title: "诊断与平台对标" }, { id: "s3", title: "定位与执行方案" }];
const information = {
  s1: { schema: [{ id: "goal", title: "最终目标与变现方式", required: true }, { id: "audience", title: "想吸引的受众", required: true },
    { id: "resource", title: "可投入的资源", required: true }, { id: "benchmark", title: "对标账号", required: false }],
  values: { goal: v("想增加工作日下午的到店客流，暂不扩店。"), audience: v("附近独自阅读的自由职业者") },
  meta: { goal: { source: "user", protected: true, suggestion: update }, audience: { source: "capture", protected: false } } },
  s2: { schema: [{ id: "platform", title: "平台", required: true }, { id: "rival", title: "竞品", required: false }],
    values: { platform: v("小红书"), rival: v("某咖啡馆") }, meta: { platform: { source: "capture" }, rival: { source: "capture" } } },
  s3: { schema: [{ id: "plan", title: "执行方案", required: true }], values: {} },
};
function props(extra: Partial<CaptureChecklistProps> = {}): CaptureChecklistProps {
  return { steps, information, valid: { s1: false, s2: false, s3: false }, edits: {}, selectedStepId: "s1", editable: true,
    manual: false, locked: false, confirmable: () => true, confirmation: () => "none", saveState: {}, conflicts: {}, resolving: null,
    onEdit: vi.fn(), onComposition: vi.fn(), onResolve: vi.fn(), onReview: vi.fn(), onRecoverConfirmation: vi.fn(),
    onKeepConflict: vi.fn(), onRetrySave: vi.fn(), ...extra };
}
const render = (p: CaptureChecklistProps) => renderToStaticMarkup(createElement(CaptureChecklist, p));

/** Clickable elements, found by expanding function components in the element tree. */
function clickables(node: ReactNode): Array<{ label: string; click: () => void; disabled: boolean }> {
  if (Array.isArray(node)) return node.flatMap(clickables);
  if (!isValidElement(node)) return [];
  const element = node as ReactElement<{ children?: ReactNode; onClick?: () => void; disabled?: boolean }>;
  if (typeof element.type === "function" && !/^(Button|Textarea|ChatInlineNotice)$/.test(element.type.name))
    return clickables((element.type as (p: unknown) => ReactNode)(element.props));
  const own = typeof element.props.onClick === "function"
    ? [{ label: [element.props.children].flat().join(""), click: element.props.onClick, disabled: Boolean(element.props.disabled) }] : [];
  return [...own, ...clickables(element.props.children)];
}
const button = (p: CaptureChecklistProps, label: string) => clickables(CaptureChecklist(p)).filter(item => item.label === label);

describe("CaptureChecklist", () => {
  it("shows every field of every step with its state, never a question number", () => {
    const html = render(props());
    for (const title of ["1. 了解你", "2. 诊断与平台对标", "3. 定位与执行方案", "最终目标与变现方式", "想吸引的受众", "可投入的资源", "平台"])
      expect(html).toContain(title);
    expect(html).toContain("草稿 · 你填写的");
    expect(html).toContain("草稿 · 从对话记下");
    expect(html).toContain("还没聊到");
    expect(html).toContain("已从对话里记下 2 项");
    expect(html).not.toMatch(/\b1\.1\b|当前问题/);
  });
  it("tells how many required items are still missing instead of offering a confirmation", () => {
    const html = render(props());
    expect(html).toContain("还差 1 项必需信息：可投入的资源");
    // Step 2 is complete too, but cannot be confirmed before step 1.
    expect(button(props({ confirmable: id => id === "s1" }), "确认这一步")).toEqual([]);
  });
  it("offers one step confirmation once every required item has content (an unsaved edit counts)", () => {
    const p = props({ edits: { s1: { ...information.s1.values, resource: v("每周 5 小时") } } });
    expect(render(p)).toContain("必需信息都有内容了");
    const [confirm] = button(p, "确认这一步");
    confirm!.click();
    expect(p.onReview).toHaveBeenCalledWith("s1");
    expect(button({ ...p, confirmable: () => false }, "确认这一步")).toEqual([]);
  });
  it("shows a protected update with before/after and adopts or ignores it by its identity", () => {
    const p = props();
    const html = render(p);
    expect(html).toContain("根据对话整理的更新");
    expect(html).toContain("想增加工作日下午的到店客流，暂不扩店。");
    expect(html).toContain("……，先试运营一个月。");
    button(p, "采用")[0]!.click();
    button(p, "忽略")[0]!.click();
    const shown = { executionId: "e1", hash: "h1", value: update.value, status: "provisional", nature: "decision" };
    expect(p.onResolve).toHaveBeenNthCalledWith(1, "s1", "goal", shown, "accept");
    expect(p.onResolve).toHaveBeenNthCalledWith(2, "s1", "goal", shown, "ignore");
  });
  it("locks adopt/ignore while busy, while it is resolving, or while a confirmation is pending", () => {
    for (const extra of [{ locked: true }, { resolving: "s1:goal" }, { confirmation: () => "valid" as const }, { editable: false }])
      expect(button(props(extra), "采用").every(item => item.disabled)).toBe(true);
  });
  it("explains that adopting on a confirmed step sends it back to draft", () => {
    expect(render(props({ valid: { s1: true, s2: false, s3: false } }))).toContain("采用后这一步会回到草稿");
  });
  it("lets a retained confirmation continue and a broken one be recovered", () => {
    const p = props({ confirmation: () => "valid" });
    expect(render(p)).toContain("上次的确认还没完成");
    button(p, "继续完成确认")[0]!.click();
    expect(p.onReview).toHaveBeenCalledWith("s1");
    expect(render(props({ confirmation: () => "malformed" }))).toContain("上次的确认请求无法读取");
  });
  it("marks a confirmed step and a step waiting for review", () => {
    const confirmed = { ...information, s1: { ...information.s1, values: { goal: v("目标", "confirmed") } } };
    expect(render(props({ information: confirmed, valid: { s1: true, s2: false, s3: false }, selectedStepId: "s2" }))).toContain("已确认");
    expect(render(props({ information: confirmed, selectedStepId: "s2" }))).toContain("需要复核");
  });
  it("is read-only after publication", () => {
    const html = render(props({ editable: false }));
    expect(html).not.toContain("确认这一步");
    expect((html.match(/<textarea[^>]*disabled/g) ?? []).length).toBe(7);
  });
});

describe("StepReviewDialog", () => {
  const info = information.s1;
  const reviewed = visibleStep(info);
  const dialog = (extra = {}) => ({ title: "了解你", schema: info.schema, reviewed, updates: { goal: update.value },
    deferred: new Set<string>(), problems: [], changed: false, busy: false,
    onEdit: vi.fn(), onDefer: vi.fn(), onConfirm: vi.fn(), onClose: vi.fn(), ...extra });
  const html = (p: ReturnType<typeof dialog>) => renderToStaticMarkup(createElement(StepReviewDialog, p));
  it("shows every field of what the user is confirming, and the updates that are not part of it", () => {
    const out = html(dialog());
    expect(out).toContain('aria-label="核对并确认：了解你"');
    for (const field of info.schema) expect(out).toContain(field.title);
    expect(out).toContain("有一条根据对话整理的更新尚未处理：……，先试运营一个月。");
    expect(out).toContain("还没处理的“根据对话整理的更新”不会被确认");
  });
  it("asks the user to look again after a change and names each problem", () => {
    const out = html(dialog({ changed: true, problems: [{ fieldId: "resource", reason: "required" }, { fieldId: "audience", reason: "non_answer" }] }));
    expect(out).toContain("内容刚刚有变化");
    expect(out).toContain("这是必需信息：请补充");
    expect(out).toContain("「好的」「不知道」这类回应");
  });
  it("turns a deferred field's text into the reason", () => {
    const out = html(dialog({ deferred: new Set(["resource"]) }));
    expect(out).toContain("写下暂时无法确定的原因");
    expect(out).toMatch(/type="checkbox" checked=""/);
  });
});

describe("StepSummaryCard", () => {
  it("offers review or more conversation, with no model call", () => {
    const onReview = vi.fn(), onMore = vi.fn();
    const out = renderToStaticMarkup(createElement(StepSummaryCard, { title: "了解你", disabled: false, onReview, onMore }));
    expect(out).toContain("“了解你”的信息已经齐了");
    expect(out).toContain("核对并确认");
    expect(out).toContain("我还要补充");
  });
});

describe("autosave status", () => {
  it("shows a light status and never disables editing while saving", () => {
    const html = render(props({ saveState: { s1: "saving" } }));
    expect(html).toContain("保存中…");
    expect(html).not.toMatch(/<textarea[^>]* disabled=""/);
    expect(render(props({ saveState: { s1: "saved" } }))).toContain("已保存 ✓");
    expect(render(props({ saveState: { s1: "saved" }, edits: { s1: { goal: v("新目标") } } }))).toContain("保存中…");
    expect(render(props({ saveState: { s1: "error" }, edits: { s1: { goal: v("新目标") } } }))).toContain("自动保存失败");
    expect(render(props())).not.toContain("保存中…");
  });
});
