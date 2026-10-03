/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { UNSURE_INPUT } from "@repo/api/src/shared/agentTurn";
import { OpenQuestionRecord, OTHER_LABEL, QuestionCardView } from "./question-card";

const card = { question: "你的内容主要写给谁？", options: ["刚入行的新人", "有经验的同行", "想转行的人"], recommended: null };
type Props = Parameters<typeof QuestionCardView>[0];
const render = (props: Props) => renderToStaticMarkup(createElement(QuestionCardView, props));

/** Clickable elements of the card, found in its element tree. */
function clickables(node: ReactNode): Array<{ label: string; click: () => void }> {
  if (Array.isArray(node)) return node.flatMap(clickables);
  if (!isValidElement(node)) return [];
  const props = (node as ReactElement<{ children?: ReactNode; onClick?: () => void }>).props;
  const own = typeof props.onClick === "function" ? [{ label: String(props.children), click: props.onClick }] : [];
  return [...own, ...clickables(props.children)];
}

/** The card's element tree, captured inside a real render so its hooks run. */
function tree(props: Props): ReactNode {
  let captured: ReactNode = null;
  renderToStaticMarkup(createElement(() => (captured = QuestionCardView(props))));
  return captured;
}

describe("QuestionCardView: open card", () => {
  it("shows the question, every option and the fixed Other entry, without the old unsure button", () => {
    const html = render({ card, onAnswer: () => {} });
    expect(html).toContain('aria-label="导师提问"');
    expect(html).toContain(card.question);
    for (const option of card.options) expect(html).toContain(`>${option}</button>`);
    expect(html).toContain(`>${OTHER_LABEL}</button>`);
    expect(html).not.toContain(UNSURE_INPUT);
    expect(html).not.toContain("推荐");
    expect(html).not.toContain("<textarea");
  });

  it("uses real buttons, so every choice works from the keyboard", () => {
    const html = render({ card, onAnswer: () => {} });
    expect(html.match(/<button[^>]*type="button"/g)).toHaveLength(card.options.length + 1);
  });

  it("marks only the recommended option", () => {
    const html = render({ card: { ...card, recommended: 1 }, onAnswer: () => {} });
    expect(html.match(/推荐/g)).toHaveLength(1);
    expect(html).toMatch(/有经验的同行<span[^>]*>推荐<\/span><\/button>/);
  });

  it("sends the option text and index; Other sends nothing and asks the page to focus its message box", () => {
    const onAnswer = vi.fn();
    const onOther = vi.fn();
    const buttons = clickables(tree({ card: { ...card, recommended: 0 }, onAnswer, onOther }));
    expect(buttons).toHaveLength(card.options.length + 1);
    buttons[1].click();
    buttons[3].click();
    expect(onAnswer.mock.calls).toEqual([["有经验的同行", 1]]);
    expect(onOther).toHaveBeenCalledTimes(1);
  });

  it("disables every choice while sending is not possible", () => {
    const html = render({ card, disabled: true, onAnswer: () => {} });
    expect(html.match(/<button[^>]*disabled=""/g)).toHaveLength(card.options.length + 1);
  });

  it("keeps long questions and options as wrapping text", () => {
    const long = { question: "问".repeat(500), options: ["甲".repeat(200), "乙"], recommended: null };
    const html = render({ card: long, onAnswer: () => {} });
    expect(html).toContain("问".repeat(500));
    expect(html).toContain("甲".repeat(200));
  });
});

describe("QuestionCardView: answered questions", () => {
  it("has no answered or history mode: an answered card is simply not rendered", () => {
    const html = render({ card, onAnswer: () => {} });
    expect(html).toContain('data-question-card="open"');
    for (const old of ["已回答", "已结束", "你的回答", "查看选项", "你的选择", "<details"]) expect(html).not.toContain(old);
  });
});

describe("QuestionCardView: recommendation reason", () => {
  const reasoned = { ...card, message: "公开分析", recommended: 1, recommendationReason: "已有相关经验" };
  const reasonAt = /<p id="([^"]+)" class="[^"]*">已有相关经验<\/p>/;

  it("shows the reason directly under the recommended option and describes that option with it", () => {
    const html = render({ card: reasoned, onAnswer: () => {} });
    expect(html.match(/已有相关经验/g)).toHaveLength(1);
    expect(html).not.toContain("公开分析"); // The conversation renders the single canonical message.
    const id = html.match(reasonAt)?.[1];
    expect(id).toBeTruthy();
    expect(html.indexOf(card.question)).toBeLessThan(html.indexOf("已有相关经验"));
    const button = `<button[^>]*aria-describedby="${id}"[^>]*>有经验的同行<span[^>]*>推荐</span></button>`;
    expect(html).toMatch(new RegExp(`${button}<p id="${id}"[^>]*>已有相关经验</p></div><div`));
    expect(html.match(/aria-describedby=/g)).toHaveLength(1);
  });

  it("shows no tag and no reason without a recommendation", () => {
    const html = render({ card: { ...card, message: "公开分析", recommended: null, recommendationReason: null } });
    expect(html).not.toContain("推荐");
    expect(html).not.toContain("<p id=");
    expect(html).not.toContain("aria-describedby");
  });
});

describe("QuestionCardView: docked to the message box", () => {
  it("keeps every option, Other and the recommendation, and adds a fold button after them", () => {
    const html = render({ card: { ...card, recommended: 1, recommendationReason: "已有相关经验" },
      docked: true, onAnswer: () => {}, onDismiss: () => {} });
    expect(html).toContain('data-question-card="open"');
    for (const option of card.options) expect(html).toContain(option);
    expect(html).toMatch(/有经验的同行<span[^>]*>推荐<\/span><\/button><p[^>]*>已有相关经验<\/p>/);
    expect(html.indexOf(`>${OTHER_LABEL}</button>`)).toBeLessThan(html.indexOf('aria-label="收起提问"'));
  });

  it("answers and folds through separate buttons; the first button is still the first option", () => {
    const onAnswer = vi.fn();
    const onDismiss = vi.fn();
    const buttons = clickables(tree({ card, docked: true, onAnswer, onDismiss }));
    expect(buttons).toHaveLength(card.options.length + 2);
    buttons[0].click();
    buttons.at(-1)!.click();
    expect(onAnswer.mock.calls).toEqual([["刚入行的新人", 0]]);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("has no fold button outside the dock or without a handler", () => {
    expect(render({ card, onAnswer: () => {}, onDismiss: () => {} })).not.toContain("收起提问");
    expect(render({ card, docked: true, disabled: true })).not.toContain("收起提问");
  });
});

describe("OpenQuestionRecord", () => {
  const record = (props: Parameters<typeof OpenQuestionRecord>[0]) => renderToStaticMarkup(createElement(OpenQuestionRecord, props));

  it("is a one-line placeholder for a folded unanswered card, without its options", () => {
    const html = record({ card });
    expect(html).toContain('aria-label="导师提问记录"');
    expect(html).toContain(card.question);
    expect(html).toContain("待回答");
    for (const option of card.options) expect(html).not.toContain(option);
  });

  it("offers to show the options again", () => {
    const onShow = vi.fn();
    let captured: ReactNode = null;
    renderToStaticMarkup(createElement(() => (captured = OpenQuestionRecord({ card, onShow }))));
    const buttons = clickables(captured);
    expect(buttons.map(button => button.label)).toEqual(["显示选项"]);
    buttons[0].click();
    expect(onShow).toHaveBeenCalledTimes(1);
  });
});
