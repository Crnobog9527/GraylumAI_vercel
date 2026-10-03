/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// The docked card lives in the composer's scrolling attachment area (overflow-y:auto), where any
// box wider than its parent shows a horizontal scrollbar. Staging measured 684px client width
// against 690px scroll width, caused by the option list's -6px side margins.
const css = readFileSync(fileURLToPath(new URL("./question-card.module.css", import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].map(([, selector, body]) => ({ selector: selector.trim(), body }));

it("has no negative side margin that would widen the card past its scrolling dock", () => {
  for (const { selector, body } of rules) {
    for (const [, value] of body.matchAll(/(?:^|;)\s*margin\s*:\s*([^;]+)/g)) {
      const parts = value.trim().split(/\s+/);
      const sides = parts.length === 1 ? [] : parts.length === 2 || parts.length === 3 ? [parts[1]] : [parts[1], parts[3]];
      for (const side of sides) expect(side.startsWith("-"), `${selector}: margin ${value}`).toBe(false);
    }
    expect(/margin-(?:left|right|inline)\s*:\s*-/.test(body), selector).toBe(false);
  }
});

it("keeps the fold button at least 32px to tap and inside the card", () => {
  const dismiss = rules.find(rule => rule.selector.endsWith(".dismiss"))!.body;
  expect(Number(dismiss.match(/(?:^|;)\s*width:(\d+)px/)?.[1])).toBeGreaterThanOrEqual(32);
  expect(Number(dismiss.match(/(?:^|;)\s*height:(\d+)px/)?.[1])).toBeGreaterThanOrEqual(32);
  expect(dismiss).toMatch(/top:0;right:0/);
});

it("keeps the title and the question line clear of the fold button", () => {
  const size = Number(rules.find(rule => rule.selector.endsWith(".dismiss"))!.body.match(/(?:^|;)\s*width:(\d+)px/)?.[1]);
  for (const part of [".docked .head", ".docked .question"]) {
    const rule = rules.find(candidate => candidate.selector.split(",").map(selector => selector.trim()).includes(part));
    expect(Number(rule?.body.match(/padding-right:(\d+)px/)?.[1]), part).toBeGreaterThanOrEqual(size);
  }
});
