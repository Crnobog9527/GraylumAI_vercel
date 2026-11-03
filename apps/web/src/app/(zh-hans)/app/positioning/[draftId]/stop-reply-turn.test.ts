/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from "vitest";
import { startLiveReply } from "./agent-turn-display";
import { hasNoUserStop, stopAvailable } from "./stop-reply";

describe("the stop of an ordinary conversation (Owner 10-28)", () => {
  it("a turn of the new path offers none, an execution of the old path still does", () => {
    expect(stopAvailable(startLiveReply("turn:7"), undefined, false)).toBe(false);
    expect(stopAvailable(startLiveReply("3f9b7a0e-1c2d-4e5f-8a9b-0c1d2e3f4a5b"), undefined, false)).toBe(true);
    expect(hasNoUserStop("turn:7")).toBe(true);
  });
});
