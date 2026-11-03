/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from "vitest";
import { reportStopChargeNotice, turnReportStop } from "./turn-report-stop";
import { stopStillSaving } from "./stop-reply";

const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("report stop on the turn path (CORE-PATH-V2 V2-7a)", () => {
  it("sends what was shown; drops the stream only once the stop is recorded", async () => {
    const dropStream = vi.fn();
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      return answer(body.confirmed ? { turnId: 9, state: "stopping", chargeable: true, replay: false }
        : { turnId: 9, state: "confirmation_required", chargeable: true, fixedCredits: 500, replay: false });
    });
    const stop = turnReportStop({ fetch: fetch as unknown as typeof globalThis.fetch, dropStream });
    const asked = await stop({ turnId: 9, stopAt: 12 });
    expect(asked.state).toBe("confirmation_required");
    expect(dropStream).not.toHaveBeenCalled();
    const recorded = await stop({ turnId: 9, stopAt: 12, confirmed: true });
    expect(stopStillSaving(recorded)).toBe(true);
    expect(dropStream).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls.map(([url, init]) => [url, JSON.parse(String(init.body))])).toEqual([
      ["/api/turn/stop", { turnId: 9, stopAt: 12 }], ["/api/turn/stop", { turnId: 9, stopAt: 12, confirmed: true }]]);
  });

  it("an unanswered stop throws (the controller keeps the text and offers the same stop again); closed is settled", async () => {
    const dropStream = vi.fn();
    const failing = turnReportStop({ fetch: (async () => answer({ error: "TURN_DATABASE_UNAVAILABLE" }, 503)) as typeof fetch, dropStream });
    await expect(failing({ turnId: 9, stopAt: 3 })).rejects.toThrow("TURN_STOP_FAILED");
    const closed = turnReportStop({ fetch: (async () => answer({ turnId: 9, state: "closed", chargeable: false, closeKind: "completed",
      replay: true })) as typeof fetch, dropStream });
    expect(stopStillSaving(await closed({ turnId: 9, stopAt: 3 }))).toBe(false);
    expect(dropStream).not.toHaveBeenCalled();
  });

  it("the third-stop notice names the report's price", () => {
    expect(reportStopChargeNotice(500)).toBe("今天已停止过 2 次，本次将按已生成部分扣费（不超过 500 积分）");
    expect(reportStopChargeNotice(800)).toBe("今天已停止过 2 次，本次将按已生成部分扣费（不超过 800 积分）");
    expect(reportStopChargeNotice(null)).toBe("今天已停止过 2 次，本次将按已生成部分扣费（不超过报告价格）");
  });
});
