/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { UNSURE_INPUT } from "@repo/api/src/shared/agentTurn";
import { QuestionCardView } from "./question-card";

const card = { question: "你的内容主要写给谁？", options: ["刚入行的新人", "有经验的同行", "想转行的人"] };
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
  it("shows the question, every option, the fixed unsure button and the free-input hint", () => {
    const html = render({ card, answered: false, onAnswer: () => {} });
    expect(html).toContain('aria-label="导师提问"');
    expect(html).toContain(card.question);
    for (const option of card.options) expect(html).toContain(`>${option}</button>`);
    expect(html).toContain(`>${UNSURE_INPUT}</button>`);
    expect(html).toContain("也可以在下方输入框直接回答");
    expect(html).not.toContain("<textarea");
  });

  it("uses real buttons, so every choice works from the keyboard", () => {
    const html = render({ card, answered: false, onAnswer: () => {} });
    expect(html.match(/<button[^>]*type="button"/g)).toHaveLength(card.options.length + 1);
  });

  it("sends the option text itself, or UNSURE_INPUT for the fixed button", () => {
    const onAnswer = vi.fn();
    const buttons = clickables(QuestionCardView({ card, answered: false, onAnswer }));
    expect(buttons.map(button => button.label)).toEqual([...card.options, UNSURE_INPUT]);
    buttons[1].click();
    buttons[3].click();
    expect(onAnswer.mock.calls).toEqual([["有经验的同行"], [UNSURE_INPUT]]);
  });

  it("disables every choice while sending is not possible", () => {
    const html = render({ card, answered: false, disabled: true, onAnswer: () => {} });
    expect(html.match(/<button[^>]*disabled=""/g)).toHaveLength(card.options.length + 1);
  });

  it("keeps long questions and options as wrapping text", () => {
    const long = { question: "问".repeat(500), options: ["甲".repeat(200), "乙"] };
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

  it("records an unsure reply and a free-text reply", () => {
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
