/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from "vitest";
import { RESOLVE_FAILED_NOTICE, RESOLVE_STALE_NOTICE, resolveCaptureUpdate, type ResolveInput } from "./use-capture-resolve";

const shown = { executionId: "11111111-1111-4111-8111-111111111111", hash: "h1", value: "先试运营一个月",
  status: "provisional" as const, nature: "decision" as const };
function io(suggestion: Record<string, unknown> | undefined, resolve = vi.fn<(input: ResolveInput) => Promise<unknown>>()) {
  const data = { information: { goal: { schema: [{ id: "goal", title: "目标", required: true }],
    meta: { goal: suggestion ? { source: "user", protected: true, suggestion: { ...suggestion, seq: [] } } : { source: "user" } } } },
  snapshot: { steps: { goal: { version: 7 } } } };
  const order: string[] = [];
  return { order, resolve, io: { draftId: "draft-1", resolve: (input: ResolveInput) => { order.push("resolve"); return resolve(input); },
    flush: vi.fn(async () => { order.push("flush"); }), refetch: vi.fn(async () => { order.push("read"); return { data }; }) } };
}

describe("resolveCaptureUpdate", () => {
  it("saves the user's edits first, then adopts exactly the update they saw at the current version", async () => {
    const t = io(shown);
    expect(await resolveCaptureUpdate(t.io, "goal", "goal", shown, "accept")).toBeNull();
    expect(t.order).toEqual(["flush", "read", "resolve", "read"]);
    expect(t.resolve).toHaveBeenCalledWith(expect.objectContaining({ draftId: "draft-1", stepId: "goal", fieldId: "goal",
      executionId: shown.executionId, hash: "h1", action: "accept", expectedVersion: 7 }));
    expect(t.resolve.mock.calls[0]![0].requestId).toMatch(/^[0-9a-f-]{36}$/);
  });
  it("ignores through the same identity", async () => {
    const t = io(shown);
    expect(await resolveCaptureUpdate(t.io, "goal", "goal", shown, "ignore")).toBeNull();
    expect(t.resolve.mock.calls[0]![0]).toMatchObject({ action: "ignore", hash: "h1" });
  });
  it("never sends when the server's update is gone or was replaced since the user saw it", async () => {
    for (const current of [undefined, { ...shown, hash: "h2" }, { ...shown, executionId: "22222222-2222-4222-8222-222222222222" }]) {
      const t = io(current);
      expect(await resolveCaptureUpdate(t.io, "goal", "goal", shown, "accept")).toBe(RESOLVE_STALE_NOTICE);
      expect(t.resolve).not.toHaveBeenCalled();
    }
  });
  it("refreshes after any failure and only calls a definite refusal stale", async () => {
    for (const code of ["OPC_SUGGESTION_CHANGED", "OPC_INFORMATION_CONFLICT", "OPC_CAPTURE_DENIED"]) {
      const t = io(shown, vi.fn(async () => { throw new Error(code); }));
      expect(await resolveCaptureUpdate(t.io, "goal", "goal", shown, "accept")).toBe(RESOLVE_STALE_NOTICE);
      expect(t.order.at(-1)).toBe("read");
    }
    // A lost reply may have committed: re-read and never claim the content is unchanged.
    const t = io(shown, vi.fn(async () => { throw new Error("timeout"); }));
    expect(await resolveCaptureUpdate(t.io, "goal", "goal", shown, "accept")).toBe(RESOLVE_FAILED_NOTICE);
    expect(t.order).toEqual(["flush", "read", "resolve", "read"]);
    expect(RESOLVE_FAILED_NOTICE).not.toContain("不变");
    const unreadable = { ...io(shown).io, refetch: async () => ({ error: new Error("x") }) };
    expect(await resolveCaptureUpdate(unreadable, "goal", "goal", shown, "accept")).toBe(RESOLVE_FAILED_NOTICE);
  });
  it("dismisses exactly the withdrawn record the user saw, never a pending update", async () => {
    const read = (meta: Record<string, unknown>) => {
      const t = io(undefined);
      const data = { information: { goal: { schema: [{ id: "goal", title: "目标", required: true }], meta: { goal: meta } } },
        snapshot: { steps: { goal: { version: 7 } } } };
      return { ...t, io: { ...t.io, refetch: async () => ({ data }) } };
    };
    const ok = read({ source: "user", withdrawnSuggestion: { ...shown, withdrawnBy: "e2" } });
    expect(await resolveCaptureUpdate(ok.io, "goal", "goal", shown, "dismiss")).toBeNull();
    expect(ok.resolve.mock.calls[0]![0]).toMatchObject({ action: "dismiss", executionId: shown.executionId, hash: "h1" });
    const pendingOnly = read({ source: "user", suggestion: shown });
    expect(await resolveCaptureUpdate(pendingOnly.io, "goal", "goal", shown, "dismiss")).toBe(RESOLVE_STALE_NOTICE);
    expect(pendingOnly.resolve).not.toHaveBeenCalled();
  });
});
