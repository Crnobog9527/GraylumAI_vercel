/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from "vitest";
import { readStartEntry, START_TEXT, startEntryHref } from "./start-entry";

const intent = "11111111-2222-4333-8444-555555555555";

it("builds and reads a one-click entry for both modes (我已有定位 is a manual draft, R15)", () => {
  for (const mode of ["mentor", "manual"] as const) {
    const href = startEntryHref(mode, intent);
    expect(readStartEntry(new URL(href, "http://x").search)).toEqual({ mode, intent });
  }
});

it("ignores other or missing modes and unusable intents", () => {
  expect(readStartEntry("")).toBeNull();
  expect(readStartEntry("?start=library")).toBeNull();
  expect(readStartEntry("?start=manual")).toEqual({ mode: "manual", intent: null });
  expect(readStartEntry("?start=manual&intent=not-a-uuid")).toEqual({ mode: "manual", intent: null });
});

it("names the existing-positioning entry without sending the user to the library", () => {
  expect(START_TEXT.manual.action).toBe("我已有定位");
  expect(START_TEXT.manual.title).toBe("核对已有定位");
});
