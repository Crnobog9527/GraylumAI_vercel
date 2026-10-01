/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { UNSURE_INPUT } from "@repo/api/src/shared/agentTurn";
import { OTHER_LABEL, QuestionCardView } from "./question-card";

const card = { question: "你的内容主要写给谁？", options: ["刚入行的新人", "有经验的同行", "想转行的人"], recommended: null };
type Props = Parameters<typeof QuestionCardView>[0];
const render = (props: Props) => renderToStaticMarkup(createElement(QuestionCardView, props));

/** Clickable elements of the card, found in its element tree (the component has no hooks). */
function clickables(node: ReactNode): Array<{ label: string; click: () => void }> {
  if (Array.isArray(node)) return node.flatMap(clickables);
  if (!isValidElement(node)) return [];
  const props = (node as ReactElement<{ children?: ReactNode; onClick?: () => void }>).props;
  const own = typeof props.onClick === "function" ? [{ label: String(props.children), click: props.onClick }] : [];
  return [...own, ...clickables(props.children)];
}

describe("QuestionCardView: open card", () => {
  it("shows the question, every option and the fixed Other entry, without the old unsure button", () => {
    const html = render({ card, answered: false, onAnswer: () => {} });
    expect(html).toContain('aria-label="导师提问"');
    expect(html).toContain(card.question);
    for (const option of card.options) expect(html).toContain(`>${option}</button>`);
    expect(html).toContain(`>${OTHER_LABEL}</button>`);
    expect(html).not.toContain(UNSURE_INPUT);
    expect(html).not.toContain("推荐");
    expect(html).not.toContain("<textarea");
  });

  it("uses real buttons, so every choice works from the keyboard", () => {
    const html = render({ card, answered: false, onAnswer: () => {} });
    expect(html.match(/<button[^>]*type="button"/g)).toHaveLength(card.options.length + 1);
  });

  it("marks only the recommended option", () => {
    const html = render({ card: { ...card, recommended: 1 }, answered: false, onAnswer: () => {} });
    expect(html.match(/推荐/g)).toHaveLength(1);
    expect(html).toMatch(/有经验的同行<span[^>]*>推荐<\/span><\/button>/);
  });

  it("sends the option text and index; Other sends nothing and asks the page to focus its message box", () => {
    const onAnswer = vi.fn();
    const onOther = vi.fn();
    const buttons = clickables(QuestionCardView({ card: { ...card, recommended: 0 }, answered: false, onAnswer, onOther }));
    expect(buttons).toHaveLength(card.options.length + 1);
    buttons[1].click();
    buttons[3].click();
    expect(onAnswer.mock.calls).toEqual([["有经验的同行", 1]]);
    expect(onOther).toHaveBeenCalledTimes(1);
  });

  it("disables every choice while sending is not possible", () => {
    const html = render({ card, answered: false, disabled: true, onAnswer: () => {} });
    expect(html.match(/<button[^>]*disabled=""/g)).toHaveLength(card.options.length + 1);
  });

  it("keeps long questions and options as wrapping text", () => {
    const long = { question: "问".repeat(500), options: ["甲".repeat(200), "乙"], recommended: null };
    const html = render({ card: long, answered: false, onAnswer: () => {} });
    expect(html).toContain("问".repeat(500));
    expect(html).toContain("甲".repeat(200));
  });
});

describe("QuestionCardView: answered card", () => {
  it("becomes history: no buttons, the chosen option is marked", () => {
    const html = render({ card, answered: true, answer: "想转行的人" });
    expect(html).not.toContain("<button");
    expect(html).toContain('data-question-card="answered"');
    expect(html).toContain("已回答");
    expect(html).toMatch(/想转行的人<span[^>]*>你的选择<\/span>/);
    expect(clickables(QuestionCardView({ card, answered: true, answer: "想转行的人", onAnswer: vi.fn() }))).toEqual([]);
  });

  it("keeps the recommended tag in history next to the user's choice", () => {
    const html = render({ card: { ...card, recommended: 2 }, answered: true, answer: "刚入行的新人" });
    expect(html).toMatch(/想转行的人<span[^>]*>推荐<\/span>/);
    expect(html).toMatch(/刚入行的新人<span[^>]*>你的选择<\/span>/);
  });

  it("records a free-text reply, and an unsure reply sent by an older page", () => {
    expect(render({ card, answered: true, answer: UNSURE_INPUT })).toContain(`你选择了“${UNSURE_INPUT}”`);
    const free = render({ card, answered: true, answer: "都不是，我写给自己看" });
    expect(free).toContain("你用自己的话回答了这个问题");
    expect(free).not.toContain("你的选择");
  });

  it("marks a card closed without a reply as ended", () => {
    const html = render({ card, answered: true, answer: null });
    expect(html).toContain("已结束");
    expect(html).not.toContain("<button");
  });
});

it.each([false,true])('retains the validated recommendation reason (answered=%s)',answered=>{
 const html=render({card:{...card,message:'公开分析',recommended:1,recommendationReason:'已有相关经验'},answered});
 expect(html).toContain('已有相关经验');
 expect(html).not.toContain('公开分析'); // The conversation renders the single canonical message.
});
