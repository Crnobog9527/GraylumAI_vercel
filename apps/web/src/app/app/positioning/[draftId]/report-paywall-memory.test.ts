/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from "vitest";
import { readPaywallFlag, reportPaywallKey, writePaywallFlag } from "./report-paywall-memory";

const memory = () => {
  const map = new Map<string, string>();
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v); },
    removeItem: (k: string) => { map.delete(k); } };
};
const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("full"); },
  removeItem: () => { throw new Error("blocked"); } };

it("keys the flag per draft and round, so a revised round starts clean", () => {
  expect(reportPaywallKey("d", "r1")).not.toBe(reportPaywallKey("d", "r2"));
});

it("remembers and forgets the membership refusal", () => {
  const store = memory();
  const key = reportPaywallKey("d", "r");
  expect(readPaywallFlag(store, key)).toBe(false);
  writePaywallFlag(store, key, true);
  expect(readPaywallFlag(store, key)).toBe(true);
  writePaywallFlag(store, key, false);
  expect(readPaywallFlag(store, key)).toBe(false);
});

it("never throws when storage is blocked or missing", () => {
  expect(readPaywallFlag(broken, "k")).toBe(false);
  expect(() => writePaywallFlag(broken, "k", true)).not.toThrow();
  expect(readPaywallFlag(null, "k")).toBe(false);
});
