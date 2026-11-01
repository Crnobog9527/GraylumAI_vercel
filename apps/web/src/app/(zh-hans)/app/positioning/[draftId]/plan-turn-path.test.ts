/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from "vitest";
import { planTurnState, readPlanTurn, runPlanTurn, type PlanTurn } from "./plan-turn-path";

const ids = { sessionId: "00000000-0000-4000-8000-000000000001", moduleId: "00000000-0000-4000-8000-000000000002" };
const request = { requestId: "00000000-0000-4000-8000-000000000003", stepId: "s", input: "one week" };
const turn = (over: Partial<PlanTurn> = {}): PlanTurn => ({ turnId: 9, state: "closed", closeKind: "completed", chargedCredits: 7, settlement: "done",
  valid: true, items: [{ id: "x" }], sourceRoundId: "r", sourceVersionId: "v", ...over });
const stream = (...events: unknown[]) => new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
function harness(reads: Array<PlanTurn | null>, post: () => Response) {
  const posts: unknown[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") { posts.push(JSON.parse(init.body as string)); return post(); }
    return new Response(JSON.stringify({ plan: reads.length > 1 ? reads.shift() : reads[0] }));
  }) as unknown as typeof globalThis.fetch;
  return { posts, deps: { fetch, sleep: async () => undefined } };
}

describe("the plan on the turn path (CORE-PATH-V2 V2-10b)", () => {
  it("sends kind=plan once and answers with the plan the server saved", async () => {
    const h = harness([turn()], () => stream({ type: "opened", turnId: 9 }, { type: "result", turnId: 9, body: "[]" }));
    expect(await runPlanTurn(request, ids, null, h.deps)).toEqual({ valid: true, body: [{ id: "x" }], sourceRoundId: "r" });
    expect(h.posts).toEqual([{ kind: "plan", ...ids, requestId: request.requestId, stepId: "s", text: "one week" }]);
  });

  it("a request that already has a turn is never sent again: a retained request or a reload reads it", async () => {
    const h = harness([turn({ state: "running" }), turn()], () => { throw new Error("sent"); });
    expect(await runPlanTurn(request, ids, turn({ state: "running" }), h.deps)).toMatchObject({ valid: true });
    expect(h.posts).toEqual([]);
  });

  it("a dropped stream reads until the turn closes, never resends", async () => {
    const h = harness([null, turn({ state: "running" }), turn()], () => new Response(new ReadableStream({ start(c) { c.close(); } })));
    expect(await runPlanTurn(request, ids, null, h.deps)).toMatchObject({ valid: true });
    expect(h.posts).toHaveLength(1);
  });

  it("no usable plan, or a failed turn, answers invalid so the page can release the request", async () => {
    const bad = harness([turn({ valid: false, items: null })], () => stream({ type: "result", turnId: 9, body: "no" }));
    expect(await runPlanTurn(request, ids, null, bad.deps)).toEqual({ valid: false });
    const failed = harness([turn({ closeKind: "failed", valid: false, items: null })], () => stream({ type: "error", code: "TURN_FAILED", turnId: 9 }));
    expect(await runPlanTurn(request, ids, null, failed.deps)).toEqual({ valid: false });
  });

  it("a refusal before opening is thrown with its code; a read that never answers does not pretend", async () => {
    const credits = harness([null], () => stream({ type: "error", code: "TURN_INSUFFICIENT_CREDITS" }));
    await expect(runPlanTurn(request, ids, null, credits.deps)).rejects.toThrow("TURN_INSUFFICIENT_CREDITS");
    const http = harness([null], () => new Response(JSON.stringify({ error: "TURN_RATE_LIMITED" }), { status: 429 }));
    await expect(runPlanTurn(request, ids, null, http.deps)).rejects.toThrow("TURN_RATE_LIMITED");
    const none = harness([null], () => stream({ type: "result", turnId: 9, body: "[]" }));
    await expect(runPlanTurn(request, ids, null, none.deps)).rejects.toThrow("TURN_PLAN_READ_FAILED");
  });

  it("reads null for a request with no turn, and maps a turn to the recovery state", async () => {
    expect(await readPlanTurn(ids.sessionId, request.requestId, harness([null], () => new Response()).deps)).toBeNull();
    expect(planTurnState(turn())).toEqual({ admitted: true, materialRevoked: false, hasResult: true, state: "completed" });
    expect(planTurnState(turn({ state: "running", valid: false }))).toMatchObject({ hasResult: false, state: "running" });
  });
});
