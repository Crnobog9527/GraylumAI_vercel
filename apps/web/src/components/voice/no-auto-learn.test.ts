/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Opening the 我的文风 page only reads. Learning is a paid turn: it starts from the user's click on the button, never from an effect.
describe("the voice page never starts learning by itself", () => {
  const source = readFileSync(new URL("./my-voice.tsx", import.meta.url), "utf8");
  it("calls voice.generate in one place, the click handler", () => {
    expect(source.match(/generate\.mutateAsync\(/g)?.length).toBe(1);
    const handler = source.indexOf("async function onGenerate()");
    expect(handler).toBeGreaterThan(-1);
    expect(source.indexOf("generate.mutateAsync(")).toBeGreaterThan(handler);
  });
  it("reaches onGenerate only through onGenerate={() => ...} (a click), not from any useEffect", () => {
    expect(source.match(/onGenerate\(\)/g)?.length).toBe(2); // its definition and the click prop
    for (const effect of source.split("useEffect(").slice(1)) expect(effect.split(/\n  (?:async )?function |\n  const |\n  if /)[0]).not.toMatch(/onGenerate|generate\.mutate/);
  });
});
