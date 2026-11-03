/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { consumeOpeningIntent, grantOpeningIntent, hasOpeningIntent, OPENING_INTENT_TTL_MS, openingIntentKey } from "./opening-intent";

const memory = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null,
  setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) }; };
const at = (stepId: string, roundId: string | null, first = false) => ({ stepId, roundId, first });

describe("the Agent's opening needs the user's action", () => {
  it("a draft that is only opened (old draft, other tab, reload) has no intent, so it starts no paid turn", () => {
    expect(hasOpeningIntent(memory(), "d1", at("s0", "r1", true))).toBe(false);
  });
  it("a start grant (no place) opens only the first step, once, and only for that draft", () => {
    const store = memory();
    grantOpeningIntent(store, "d1");
    expect(hasOpeningIntent(store, "d1", at("s1", "r1"))).toBe(false);
    expect(hasOpeningIntent(store, "d2", at("s0", "r1", true))).toBe(false);
    expect(hasOpeningIntent(store, "d1", at("s0", "r1", true))).toBe(true);
    consumeOpeningIntent(store, "d1");
    expect(hasOpeningIntent(store, "d1", at("s0", "r1", true))).toBe(false);
  });
  it("a confirmation or click grant names its step and round: a later revision or another step cannot use it (review P1)", () => {
    const store = memory();
    grantOpeningIntent(store, "d1", { stepId: "s2", roundId: "r1" });
    expect(hasOpeningIntent(store, "d1", at("s2", "r2"))).toBe(false); // the draft was revised into a new round
    expect(hasOpeningIntent(store, "d1", at("s1", "r1"))).toBe(false); // a step invalidated by an edit
    expect(hasOpeningIntent(store, "d1", at("s2", "r1", true))).toBe(true);
  });
  it("a mark expires, and a mark from the future is dropped", () => {
    const store = memory();
    grantOpeningIntent(store, "d1", { stepId: "s2", roundId: "r1" }, 1_000);
    expect(hasOpeningIntent(store, "d1", at("s2", "r1"), 1_000 + OPENING_INTENT_TTL_MS)).toBe(true);
    expect(hasOpeningIntent(store, "d1", at("s2", "r1"), 1_001 + OPENING_INTENT_TTL_MS)).toBe(false);
    expect(store.getItem(openingIntentKey("d1"))).toBeNull();
    grantOpeningIntent(store, "d1", { stepId: "s2", roundId: "r1" }, 10 * 60_000);
    expect(hasOpeningIntent(store, "d1", at("s2", "r1"), 1_000)).toBe(false);
  });
  it("an unreadable mark or an unavailable storage means no intent, never an opening", () => {
    const store = memory();
    store.setItem(openingIntentKey("d1"), "1");
    expect(hasOpeningIntent(store, "d1", at("s0", null, true))).toBe(false);
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } };
    expect(() => grantOpeningIntent(broken, "d1")).not.toThrow();
    expect(hasOpeningIntent(broken, "d1", at("s0", null, true))).toBe(false);
    expect(openingIntentKey("d1")).toBe("opc-open-intent:d1");
  });
  const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
  it("the page checks the gate before it sends the opening request, and only once (guard against reintroducing the auto-open)", () => {
    const check = source.indexOf("gate.admit("), send = source.indexOf("mentorTurn(openingRequest(");
    expect(check).toBeGreaterThan(-1);
    expect(send).toBeGreaterThan(check);
    expect(source.match(/openingRequest\(/g)?.length).toBe(1);
  });
  it("confirming grants only the next step of the round, never when there is none (the last step), and an opened step drops the offer (review P1, P2)", () => {
    expect(source).toMatch(/&& next\) \{ gate\.grant\(next\.id, d\?\.roundId \?\? null\)/);
    expect(source.match(/gate\.grant\(/g)?.length).toBe(1);
    expect(source).toMatch(/turnPath\.stepOpened\(turns, step\.id, d\.roundId\)\) return gate\.clear\(\)/);
  });
});
