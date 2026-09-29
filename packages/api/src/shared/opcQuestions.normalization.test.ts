/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { isRecordedNonAnswer } from "./opcQuestions";

// Exercise the actual private function without adding a production export.
const source = stripTypeScriptTypes(readFileSync(
  fileURLToPath(new URL("./opcQuestions.ts", import.meta.url)), "utf8",
)).replace(/^export /gm, "");
const normalize = runInNewContext(`${source}; normalizeUtterance;`) as (value: string) => string;
const punctuation = "。.!！?？,，、~～…";
function legacy(value: string) {
  return value.trim().toLowerCase().replace(/[\s\u3000]+/gu, " ")
    .replace(/[。.!！?？,，、~～…]+$/u, "").trim();
}

const fixtures = [
  "", " ", "\u3000\t\r\n", punctuation, "HELLO World!!!", "中文回答。！？",
  "  中 English\t全角　空格…  ", "a!b", "a! b", "a ! !", "😀𠮷…", "😀𠮷!x",
  "e\u0301…", "İΣ！", "ＡＢＣ１２３，", "a:;；：—·｡．", "\ud800!", "\udc00…",
  "\ud800\udc00！", "a!\r\n", "a!\u2028", "a!\u2029", "a!\u200b", "a!\ufeff",
  "a !\n !\n", "a!\r\nb", "。".repeat(256) + "X",
  ...Array.from(punctuation).flatMap(char => [char, `中A😀${char}`, `${char}X`, `X${char} Y`]),
];

// Fixed seed, including astral code points, lone surrogates and all whitespace forms.
function randomSamples() {
  const alphabet = Array.from(`${punctuation}abcXYZ中文ＡÉİΣ😀𠮷\u0301 :;；：—｡．`)
    .concat(["\t", "\n", "\r", "\u3000", "\u2028", "\u2029", "\u00a0", "\ufeff", "\u200b", "\ud800", "\udc00"]);
  let seed = 0xc6c2026;
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  return Array.from({ length: 2000 }, () => {
    const length = next() % 129;
    let value = "";
    for (let i = 0; i < length; i++) value += alphabet[next() % alphabet.length];
    return value;
  });
}

it("matches the legacy normalization exactly for fixtures and seeded Unicode samples", () => {
  for (const input of [...fixtures, ...randomSamples()]) {
    const expected = legacy(input);
    expect(normalize(input), JSON.stringify(input)).toBe(expected);
    // Also cover the normally imported module's public caller.
    expect(isRecordedNonAnswer(input, [expected])).toBe(Boolean(expected) && legacy(expected) === expected);
    expect(isRecordedNonAnswer(input, [`${expected}不相同`])).toBe(false);
  }
});

// Isolated-realm instrumentation leaves the runner and other tests untouched.
// Count code-point materialization + membership checks. Reject any new regex
// over a large input except the unchanged, linear whitespace normalization.
function measuredNormalizer() {
  return runInNewContext(`
    const counts = { points: 0, visits: 0 };
    const originalFrom = Array.from;
    Array.from = function(value) {
      const result = originalFrom(value);
      counts.points += result.length;
      return result;
    };
    const originalIncludes = String.prototype.includes;
    String.prototype.includes = function(value, position) {
      counts.visits++;
      return originalIncludes.call(this, value, position);
    };
    const originalReplace = RegExp.prototype[Symbol.replace];
    RegExp.prototype[Symbol.replace] = function(value, replacement) {
      if (value.length > 1024 && this.source !== ${JSON.stringify(/[\s\u3000]+/gu.source)}) {
        throw new Error("Unbounded regex input: " + value.length);
      }
      return originalReplace.call(this, value, replacement);
    };
    ${source}
    ({ normalize: normalizeUtterance, counts });
  `) as { normalize: (value: string) => string; counts: { points: number; visits: number } };
}

describe("linear work for adversarial punctuation inputs (no timing thresholds)", () => {
  for (const size of [8000, 16000, 32000]) {
    it(`bounds work for ${size} punctuation characters followed by a non-punctuation code point`, () => {
      for (const ending of ["X", "😀", "𠮷"]) {
        const input = "!".repeat(size) + ending;
        const measured = measuredNormalizer();
        expect(measured.normalize(input)).toBe(input.toLowerCase());
        expect(measured.counts.points).toBe(size + 1);
        expect(measured.counts.visits).toBe(1);
      }
    });
    it(`bounds work when removing ${size} trailing punctuation code points`, () => {
      for (const prefix of ["", "😀", "中"]) {
        const input = prefix + "…".repeat(size);
        const measured = measuredNormalizer();
        expect(measured.normalize(input)).toBe(prefix);
        const points = size + Array.from(prefix).length;
        expect(measured.counts.points).toBe(points);
        expect(measured.counts.visits).toBe(points);
        expect(measured.counts.points + measured.counts.visits).toBeLessThanOrEqual(2 * points);
      }
    });
  }
});
