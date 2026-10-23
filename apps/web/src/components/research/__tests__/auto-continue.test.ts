/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from "vitest";
import { AUTO_CONTINUE_LIMIT, autoContinueDecision, isResearchEvent } from "../research-session-model";

const continuation = { executionId: "e1", discoveryId: "d1" };

describe("benchmark discovery auto-continue (Owner 2026-10-23, 3 A)", () => {
  it("keeps the host's continue signal among the research events", () => {
    expect(isResearchEvent({ type: "research_continue" })).toBe(true);
  });

  it("sends once the turn is over, never twice for one turn, and waits while the conversation is busy", () => {
    expect(autoContinueDecision(null, new Set(), new Map(), false)).toBe("none");
    expect(autoContinueDecision(continuation, new Set(), new Map(), true)).toBe("wait");
    expect(autoContinueDecision(continuation, new Set(), new Map(), false)).toBe("send");
    expect(autoContinueDecision(continuation, new Set(["e1"]), new Map([["d1", 1]]), false)).toBe("none");
    expect(autoContinueDecision({ executionId: "e2", discoveryId: "d1" }, new Set(["e1"]), new Map([["d1", 1]]), false)).toBe("send");
  });

  it("stops sending for a round after the limit, so a stuck round never loops paid replies", () => {
    expect(autoContinueDecision({ executionId: "e9", discoveryId: "d1" }, new Set(), new Map([["d1", AUTO_CONTINUE_LIMIT]]), false))
      .toBe("limit");
    expect(autoContinueDecision({ executionId: "e9", discoveryId: "d2" }, new Set(), new Map([["d1", AUTO_CONTINUE_LIMIT]]), false))
      .toBe("send");
  });
});
