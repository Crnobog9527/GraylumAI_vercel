/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from "vitest";
import { confirmKey, executeConfirmation, prepareConfirmation, type ConfirmationIo, type ConfirmRead } from "./use-step-confirmation";
import { stepConfirmationValues, visibleStep, type FieldValue, type VisibleStep } from "@/components/opc/capture-state";
import type { ConfirmStepEnvelope } from "@/app/positioning/[draftId]/confirm-envelope";

const v = (value: string, status: FieldValue["status"] = "provisional"): FieldValue => ({ value, status, nature: "decision" });
const schema = [{ id: "goal", title: "目标", required: true }, { id: "audience", title: "受众", required: true }];
const step = { id: "s1", title: "了解你" };
const update = { executionId: "e1", hash: "h1", value: "更新", status: "provisional", nature: "decision", seq: [] };

/** A fake draft whose writes behave like the server: information, then save, then confirm. */
function server(values: Record<string, FieldValue>, extra: Partial<ConfirmRead> = {}) {
  const state = { version: 3, reviewVersion: 1, valid: false, body: "", evidenceIds: ["ev"] };
  const read = (): ConfirmRead => ({ projectId: "p", roundId: "r", ...extra,
    information: { s1: { schema, values: { ...values }, meta: { goal: { suggestion: update } } } },
    snapshot: { steps: { s1: { ...state } } } });
  const calls: string[] = [], store = new Map<string, string>();
  const io: ConfirmationIo = {
    draftId: "d", storage: { getItem: k => store.get(k) ?? null, setItem: (k, x) => void store.set(k, x), removeItem: k => void store.delete(k) },
    refetch: vi.fn(async () => ({ data: read() })), flush: vi.fn(async () => { calls.push("flush"); }),
    pendingEdits: () => undefined, releaseEdits: vi.fn(), onConfirmed: vi.fn(),
    writeInformation: vi.fn(async input => {
      calls.push("information"); values = { ...input.values }; state.version++;
    }),
    transition: vi.fn(async input => {
      calls.push(String(input.action));
      if (input.action === "save") { state.body = String(input.body); state.version++; }
      if (input.action === "confirm") state.valid = true;
    }),
  };
  return { io, calls, store, state };
}

describe("prepareConfirmation", () => {
  it("binds the envelope to what the user reviewed and the current version", async () => {
    const s = server({ goal: v("增加客流"), audience: v("自由职业者") });
    const reviewed = visibleStep((await s.io.refetch()).data!.information.s1);
    const { values } = stepConfirmationValues(schema, reviewed, new Set());
    const prepared = await prepareConfirmation(s.io, step, { schema }, reviewed, values);
    expect(s.calls).toEqual(["flush"]);
    if (!("envelope" in prepared)) throw new Error("expected an envelope");
    expect(prepared.envelope).toMatchObject({ phase: "information", finishStep: true,
      information: { draftId: "d", stepId: "s1", expectedVersion: 3, values },
      save: { action: "save", stepId: "s1", expectedVersion: null, body: "目标\n增加客流\n\n受众\n自由职业者", evidenceIds: ["ev"] },
      confirm: { action: "confirm", stepId: "s1", expectedVersion: null, expectedReviewVersion: null } });
    expect(JSON.parse(s.store.get(confirmKey("d", "s1"))!)).toEqual(prepared.envelope);
  });
  it("stops with the fresh content when anything the user did not see arrived", async () => {
    const s = server({ goal: v("增加客流"), audience: v("自由职业者") });
    const seen = visibleStep((await s.io.refetch()).data!.information.s1);
    for (const reviewed of <VisibleStep[]>[
      { ...seen, values: { ...seen.values, audience: v("别的受众") } },
      { ...seen, updates: {} },
      { ...seen, updates: { goal: "e1:h0" } },
    ]) {
      const prepared = await prepareConfirmation(s.io, step, { schema }, reviewed, {});
      expect(prepared).toEqual({ changed: seen });
    }
    const typing = { ...s.io, pendingEdits: () => ({ goal: v("还在打字") }) };
    expect("changed" in await prepareConfirmation(typing, step, { schema }, seen, {})).toBe(true);
    expect(s.store.size).toBe(0);
  });
});

describe("executeConfirmation", () => {
  const envelope = (values: Record<string, FieldValue>, patch: Partial<ConfirmStepEnvelope> = {}): ConfirmStepEnvelope => ({
    phase: "information", finishStep: true, values, editingSnapshot: "null",
    information: { draftId: "d", stepId: "s1", requestId: "i", expectedVersion: 3, values },
    save: { action: "save", projectId: "p", roundId: "r", requestId: "sv", stepId: "s1", expectedVersion: null, body: "B", evidenceIds: [] },
    confirm: { action: "confirm", projectId: "p", roundId: "r", requestId: "cf", stepId: "s1", expectedVersion: null, expectedReviewVersion: null },
    ...patch,
  });
  const confirmed = { goal: v("增加客流", "confirmed"), audience: v("原因", "deferred") };

  it("runs information, save and confirm once, then advances", async () => {
    const s = server({ goal: v("增加客流"), audience: v("") });
    s.store.set(confirmKey("d", "s1"), "x");
    await executeConfirmation(s.io, step, envelope(confirmed));
    expect(s.calls).toEqual(["information", "save", "confirm"]);
    expect(s.io.transition).toHaveBeenLastCalledWith(expect.objectContaining({ action: "confirm", expectedVersion: 5, expectedReviewVersion: 1 }));
    expect(s.io.releaseEdits).toHaveBeenCalledWith("s1", "null");
    expect(s.store.size).toBe(0);
    expect(s.io.onConfirmed).toHaveBeenCalledWith("s1");
  });
  it("resumes a retained envelope from its saved phase with its original identities", async () => {
    const s = server(confirmed);
    await executeConfirmation(s.io, step, envelope(confirmed, { phase: "save" }));
    expect(s.calls).toEqual(["save", "confirm"]);
    expect(s.io.transition).toHaveBeenNthCalledWith(1, expect.objectContaining({ requestId: "sv", expectedVersion: 3 }));
  });
  it("finishes a legacy single-question envelope without confirming the step", async () => {
    const s = server({ goal: v("增加客流"), audience: v("") });
    await executeConfirmation(s.io, step, envelope({ goal: v("增加客流", "confirmed"), audience: v("") }, { finishStep: false, questionId: "goal" }));
    expect(s.calls).toEqual(["information"]);
    expect(s.io.onConfirmed).not.toHaveBeenCalled();
    expect(s.store.size).toBe(0);
  });
  it("refuses to save when the server values are not the ones written", async () => {
    const s = server({ goal: v("另一个窗口改的", "confirmed"), audience: v("原因", "deferred") });
    await expect(executeConfirmation(s.io, step, envelope(confirmed, { phase: "save" }))).rejects.toThrow("OPC_INFORMATION_CONFLICT");
    expect(s.calls).toEqual([]);
  });
  it("keeps an account revision's edited step saved but unconfirmed while upstream steps wait", async () => {
    const s = server(confirmed, { accountRevision: {} });
    await executeConfirmation(s.io, { ...step, dependsOn: ["s0"] }, envelope(confirmed, { phase: "save" }));
    expect(s.calls).toEqual(["save"]);
    expect(s.io.onConfirmed).not.toHaveBeenCalled();
  });
});
