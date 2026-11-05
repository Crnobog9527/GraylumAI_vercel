/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from "vitest";
import { reportTurnTracker, waitForTurnId } from "./turn-id-wait";
import { turnReportStop } from "./turn-report-stop";

describe("a stop pressed before the turn id has arrived", () => {
  it("answers at once when the id is known", async () => {
    let waits = 0;
    expect(await waitForTurnId(() => 7, async () => { waits++; })).toBe(7);
    expect(waits).toBe(0);
  });
  it("waits for the id of the stream that was just opened, then names that turn", async () => {
    let id: number | null = null, waits = 0;
    expect(await waitForTurnId(() => id, async () => { if (++waits === 3) id = 56; })).toBe(56);
    expect(waits).toBe(3);
  });
  it("gives up after the limit, so the stop stays unconfirmed and can be pressed again", async () => {
    let waits = 0;
    expect(await waitForTurnId(() => null, async () => { waits++; }, 1000, 100)).toBeNull();
    expect(waits).toBe(10);
  });
});

describe("a stop pressed right after 重新生成, before the server opens the new report (staging 11-05, turns 6606 and 6607)", () => {
  const sleep = (clock: { now: number }, onTick?: () => void) => async (ms: number) => { clock.now += ms; onTick?.(); };

  it("names the new report's turn, never the earlier stopped one the page had read, and that stop is recorded before the report runs", async () => {
    const clock = { now: 0 };
    // The page had read the earlier report (6606, closed as stopped) and this tab's last stream left 6606 behind.
    const saved = { turnId: 6606, state: "closed" };
    const tracker = reportTurnTracker(sleep(clock, () => { if (clock.now >= 1300) tracker.opened(6607); }));
    tracker.opened(6606);
    tracker.begin(); // 确认重新生成: the stream is requested, the server opens it 1.3 s later
    const sent: Array<{ turnId: number }> = [];
    const stop = turnReportStop({ dropStream: () => {}, fetch: (async (_url: string, init: { body: string }) => {
      sent.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ turnId: JSON.parse(init.body).turnId, state: "stopping", chargeable: false, replay: false }));
    }) as never });
    const target = await tracker.stopTarget(saved); // pressed 35 ms after the confirmation
    expect(target).toBe(6607);
    const answer = await stop({ turnId: target!, stopAt: 0 });
    expect(sent).toEqual([{ turnId: 6607, stopAt: 0 }]);
    expect(answer.state).toBe("stopping"); // the page and the server agree: the new turn is the one stopping
  });
  it("without a stream of its own, a stop names only a saved report that is still open", async () => {
    const tracker = reportTurnTracker(async () => {});
    expect(await tracker.stopTarget({ turnId: 6606, state: "closed" })).toBeNull();
    expect(await tracker.stopTarget({ turnId: 6607, state: "running" })).toBe(6607);
    expect(await tracker.stopTarget(null)).toBeNull();
  });
  it("a stream that never opens leaves the stop unconfirmed, not aimed at the earlier report", async () => {
    const tracker = reportTurnTracker(async () => {}, 300);
    tracker.opened(6606);
    tracker.begin();
    expect(await tracker.stopTarget({ turnId: 6606, state: "closed" })).toBeNull();
  });
});
