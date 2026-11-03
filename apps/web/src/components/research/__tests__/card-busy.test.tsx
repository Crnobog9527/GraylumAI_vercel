/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CandidateCardView } from "../candidate-card";
import { KeywordCardView } from "../keyword-card";
import { CANDIDATE_CARD, KEYWORD_CARD } from "./fixtures";

const confirm = async () => { throw new Error("not called"); };

it("a candidate card that appears while the turn is still answering says why nothing can be ticked yet", () => {
  const busy = renderToStaticMarkup(<CandidateCardView card={CANDIDATE_CARD} disabled busy onConfirm={confirm} />);
  expect(busy).toContain("AI 还在整理这一轮的回复，回复完成后就可以勾选");
  expect(busy).toContain("disabled");
  // Disabled for another reason (read-only draft, another step shown): no claim that the AI is answering.
  expect(renderToStaticMarkup(<CandidateCardView card={CANDIDATE_CARD} disabled onConfirm={confirm} />)).not.toContain("AI 还在整理");
  expect(renderToStaticMarkup(<CandidateCardView card={CANDIDATE_CARD} onConfirm={confirm} />)).not.toContain("AI 还在整理");
});

it("a keyword card says the same while it cannot be edited", () => {
  expect(renderToStaticMarkup(<KeywordCardView card={KEYWORD_CARD} disabled busy onConfirm={confirm} />))
    .toContain("AI 还在整理这一轮的回复，回复完成后就可以修改");
  expect(renderToStaticMarkup(<KeywordCardView card={KEYWORD_CARD} onConfirm={confirm} />)).not.toContain("AI 还在整理");
});
