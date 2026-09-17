/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from "vitest";
import { dedupeHandoffResults } from "./handoff-view";

describe("OPC handoff read view", () => {
  it("keeps request history but exposes a replayed work item only once", () => {
    const view = dedupeHandoffResults({
      draftId: "draft",
      handoffs: [
        {
          requestId: "first",
          result: [
            { workItemId: "work-1", sessionId: "session-1" },
            { workItemId: "work-2", sessionId: "session-2" },
          ],
        },
        {
          requestId: "retry",
          result: [
            { workItemId: "work-1", sessionId: "session-1" },
          ],
        },
      ],
    });

    expect(view.handoffs).toHaveLength(2);
    expect(view.handoffs?.map((handoff) => handoff.requestId)).toEqual([
      "first",
      "retry",
    ]);
    expect(view.handoffs?.flatMap((handoff) => handoff.result)).toEqual([
      { workItemId: "work-1", sessionId: "session-1" },
      { workItemId: "work-2", sessionId: "session-2" },
    ]);
    expect(view.handoffs?.[1].result).toEqual([]);
  });
});
