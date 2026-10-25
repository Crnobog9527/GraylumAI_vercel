/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from "vitest";
import {
  AUTO_CONTINUE_LIMIT, autoContinueDecision, continuationAfterResult, continuationToSend, isResearchEvent, roundCounts,
  storedUnfinishedRound,
} from "../research-session-model";

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

  it("only a normally completed turn arms its continuation; a stopped, cancelled or paused one never continues", () => {
    expect(continuationAfterResult(continuation, "e1", { state: "completed", completeness: "complete" })).toEqual({ keep: true });
    expect(continuationAfterResult(continuation, "e1", { state: "completed", stopped: true })).toEqual({ keep: false });
    expect(continuationAfterResult(continuation, "e1", { state: "completed", completeness: "stopped" })).toEqual({ keep: false });
    for (const state of ["cancelled", "stopping", "waiting_credits", "waiting_resume", "cost_pending"]) {
      expect(continuationAfterResult(continuation, "e1", { state })).toEqual({ keep: false });
    }
    expect(continuationAfterResult(continuation, "other", { state: "completed" })).toEqual({ keep: false });
    expect(continuationAfterResult(null, "e1", { state: "completed" })).toEqual({ keep: false });
  });

  // A reload or a lost connection mid-round drops the live signal; the host keeps the unfinished round (#1308 staging 10-25:
  // the page was reloaded while the round ran, nothing was ever sent and the user was left to type "继续").
  describe("after a reload the stored unfinished round takes the live signal's place", () => {
    const stored = { discoveryId: "d1", executionId: "e1", replies: 2 };

    it("reads only a well-formed stored round", () => {
      expect(storedUnfinishedRound(stored)).toEqual(stored);
      for (const bad of [null, undefined, {}, { ...stored, replies: "2" }, { ...stored, executionId: 1 }, { ...stored, replies: 0 }, []]) {
        expect(storedUnfinishedRound(bad)).toBeNull();
      }
    });

    it("sends the stored round when no live signal exists, and the live one when both exist", () => {
      expect(continuationToSend(null, null)).toBeNull();
      expect(continuationToSend(null, stored)).toEqual({ executionId: "e1", discoveryId: "d1" });
      expect(continuationToSend(continuation, null)).toEqual(continuation);
      const live = { executionId: "e2", discoveryId: "d1" };
      expect(continuationToSend(live, stored)).toEqual(live);
    });

    it("one turn is never sent twice, whichever path names it", () => {
      const sentFor = new Set(["e1"]);
      expect(autoContinueDecision(continuationToSend(null, stored), sentFor, new Map(), false)).toBe("none");
      expect(autoContinueDecision(continuationToSend(continuation, stored), sentFor, new Map(), false)).toBe("none");
    });

    it("counts the replies the host already saw, so reloading never restarts a round's limit", () => {
      expect(roundCounts(new Map(), null).size).toBe(0);
      expect(roundCounts(new Map(), stored).get("d1")).toBe(1);
      expect(roundCounts(new Map([["d1", 3]]), stored).get("d1")).toBe(3);
      expect(roundCounts(new Map([["d2", 4]]), stored).get("d2")).toBe(4);
      const exhausted = { ...stored, replies: AUTO_CONTINUE_LIMIT + 1 };
      expect(autoContinueDecision(continuationToSend(null, exhausted), new Set(), roundCounts(new Map(), exhausted), false)).toBe("limit");
      expect(autoContinueDecision(continuationToSend(null, stored), new Set(), roundCounts(new Map(), stored), false)).toBe("send");
    });
  });
});
