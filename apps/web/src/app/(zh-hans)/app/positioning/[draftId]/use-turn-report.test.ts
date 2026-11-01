/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from "vitest";
import { turnReadSettled, turnReportStatus, type TurnReport } from "./use-turn-report";

const report = (over: Partial<TurnReport>): TurnReport => ({ turnId: 3, requestId: "r", state: "running", closeKind: null, delivered: false,
  chargedCredits: null, settlement: null, fixedCredits: 500, body: null, ...over });

describe("a report turn as the page's status", () => {
  it("is known by its request id, the id report_document takes", () => {
    expect(turnReportStatus(report({})).executionId).toBe("r");
  });
  it("maps open states, and holds the price until it settles", () => {
    expect(turnReportStatus(report({}))).toMatchObject({ state: "running", fee: { state: "held", credits: 500 } });
    expect(turnReportStatus(report({ state: "stopping" })).state).toBe("stopping");
    expect(turnReportStatus(report({ state: "paused" })).state).toBe("waiting_credits");
  });
  it("a delivered report is charged; a stop or failure refunds, and only a delivered one can be finalized", () => {
    expect(turnReportStatus(report({ state: "closed", closeKind: "completed", delivered: true, settlement: "done", chargedCredits: 500, body: "x" })))
      .toMatchObject({ state: "completed", candidate: true, completeness: "complete", fee: { state: "charged", chargedCredits: 500 } });
    expect(turnReportStatus(report({ state: "closed", closeKind: "stopped", settlement: "done", chargedCredits: 0, body: "x" })))
      .toMatchObject({ state: "cancelled", candidate: false, completeness: "stopped", fee: { state: "refunded" } });
    expect(turnReportStatus(report({ state: "closed", closeKind: "failed", settlement: "done", chargedCredits: 0 })).completeness).toBeNull();
  });
});

describe("when the old status read may be asked about a report", () => {
  it("waits for a turn read that has not answered, and goes on once it answered (a report or none) or failed", () => {
    expect(turnReadSettled(undefined, false)).toBe(false);
    expect(turnReadSettled(null, false)).toBe(true);
    expect(turnReadSettled(report({}), false)).toBe(true);
    // A turn read that keeps failing must not hide a report of the old path.
    expect(turnReadSettled(undefined, true)).toBe(true);
  });
});
