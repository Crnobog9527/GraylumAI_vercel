/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { consumeOpeningIntent, grantOpeningIntent, hasOpeningIntent, openingIntentKey } from "./opening-intent";

const memory = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null,
  setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) }; };

describe("the Agent's opening needs the user's action", () => {
  it("a draft that is only opened (old draft, other tab, reload) has no intent, so it starts no paid turn", () => {
    expect(hasOpeningIntent(memory(), "d1")).toBe(false);
  });
  it("one grant (start, confirm, or the 开始这一步 click) allows exactly one opening, and only for that draft", () => {
    const store = memory();
    grantOpeningIntent(store, "d1");
    expect(hasOpeningIntent(store, "d1")).toBe(true);
    expect(hasOpeningIntent(store, "d2")).toBe(false);
    consumeOpeningIntent(store, "d1");
    expect(hasOpeningIntent(store, "d1")).toBe(false);
  });
  it("an unavailable storage means no intent, never an opening", () => {
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } };
    expect(() => grantOpeningIntent(broken, "d1")).not.toThrow();
    expect(hasOpeningIntent(broken, "d1")).toBe(false);
    expect(openingIntentKey("d1")).toBe("opc-open-intent:d1");
  });
  it("the page checks the intent before it sends the opening request (guard against reintroducing the auto-open)", () => {
    const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
    const check = source.indexOf("gate.admit("), send = source.indexOf("mentorTurn(openingRequest(");
    expect(check).toBeGreaterThan(-1);
    expect(send).toBeGreaterThan(check);
    expect(source.match(/openingRequest\(/g)?.length).toBe(1);
  });
});
