/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUTOSAVE_DELAY_MS, createInformationAutosave, informationBaseKey, savedRead, stepView,
  type AutosaveIo, type InformationRequest, type SaveState, type StepView,
} from "./information-autosave";
import type { Information } from "./confirm-envelope";

const v = (value: string): Information => ({ value, status: "provisional", nature: "decision" });
type Values = Record<string, Information>;

function memoryStorage() {
  const map = new Map<string, string>();
  return { map, getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, x: string) => void map.set(k, x),
    removeItem: (k: string) => void map.delete(k) };
}

/** A fake server and page: one step "s1" with fields a and b. */
function setup(server: StepView = { version: 3, values: { a: v("old"), b: v("old") } }) {
  const storage = memoryStorage();
  let cache: StepView | null = structuredClone(server);
  let edits: Record<string, Values> = {};
  const states: SaveState[] = [];
  const writes: InformationRequest[] = [];
  const gates: Array<() => void> = [];
  let gated = false;
  const io: AutosaveIo = {
    draftId: "d1", storage, newId: (() => { let n = 0; return () => "r" + ++n; })(),
    cached: () => cache && structuredClone(cache),
    refetch: vi.fn(async () => { cache = structuredClone(server); return structuredClone(cache); }),
    write: vi.fn(async (request: InformationRequest) => {
      writes.push(request);
      if (gated) await new Promise<void>(resolve => gates.push(resolve));
      if (request.expectedVersion !== server.version) throw new Error("OPC_INFORMATION_CONFLICT");
      server = { version: server.version + 1, values: request.values };
      return { version: server.version };
    }),
    applySaved: vi.fn((_stepId: string, values: Values, version: number) => { cache = { version, values }; }),
    refreshLater: vi.fn(),
    edits: () => edits,
    setEdits: (stepId, values) => { edits = { ...edits }; if (values) edits[stepId] = values; else delete edits[stepId]; },
    setSaveState: (_stepId, state) => void states.push(state),
    setConflict: vi.fn(),
    onError: vi.fn(),
  };
  const autosave = createInformationAutosave(() => io);
  return {
    io, autosave, storage, states, writes,
    /** The user types: the base is the server values the edit started from. */
    edit(values: Values) {
      if (!storage.getItem(informationBaseKey("d1", "s1"))) storage.setItem(informationBaseKey("d1", "s1"), JSON.stringify(cache!.values));
      edits = { ...edits, s1: { ...(edits.s1 ?? cache!.values), ...values } };
    },
    otherTab(values: Values) { server = { version: server.version + 1, values: { ...server.values, ...values } }; },
    server: () => server,
    edits: () => edits,
    gate() { gated = true; },
    release() { gated = false; gates.splice(0).forEach(resolve => resolve()); },
  };
}

afterEach(() => { vi.useRealTimers(); });

describe("information autosave", () => {
  it("saves with one write from the cached read and no full read", async () => {
    const t = setup();
    t.edit({ a: v("new") });
    await t.autosave.flush("s1");
    expect(t.writes).toEqual([{ draftId: "d1", stepId: "s1", requestId: "r1", expectedVersion: 3, values: { a: v("new"), b: v("old") } }]);
    expect(t.io.refetch).not.toHaveBeenCalled();
    expect(t.io.applySaved).toHaveBeenCalledWith("s1", { a: v("new"), b: v("old") }, 4);
    expect(t.io.refreshLater).toHaveBeenCalledTimes(1);
    expect(t.states).toEqual(["saving", "saved"]);
    expect(t.edits()).toEqual({});
    expect(t.storage.map.size).toBe(0);
  });

  it("reads again only on a version conflict, merges and retries once with a new identity", async () => {
    const t = setup();
    t.edit({ a: v("mine") });
    t.otherTab({ b: v("theirs") });
    await t.autosave.flush("s1");
    expect(t.io.refetch).toHaveBeenCalledTimes(1);
    expect(t.writes.map(w => [w.requestId, w.expectedVersion])).toEqual([["r1", 3], ["r2", 4]]);
    expect(t.server().values).toEqual({ a: v("mine"), b: v("theirs") });
    expect(t.states).toEqual(["saving", "saved"]);
  });

  it("keeps the user's input and reports a same-field conflict without writing over it", async () => {
    const t = setup();
    t.edit({ a: v("mine") });
    t.otherTab({ a: v("theirs") });
    await expect(t.autosave.flush("s1")).rejects.toThrow("OPC_FIELD_CONFLICT:a");
    expect(t.writes).toHaveLength(1);
    expect(t.server().values.a).toEqual(v("theirs"));
    expect(t.io.setConflict).toHaveBeenCalledWith("s1", { current: { a: v("theirs"), b: v("old") }, fields: ["a"] });
    expect(t.edits().s1!.a).toEqual(v("mine"));
    expect(t.states.at(-1)).toBe("error");
  });

  it("stops after a second version conflict instead of retrying again", async () => {
    const t = setup();
    t.edit({ a: v("mine") });
    t.otherTab({});
    (t.io.refetch as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => { t.otherTab({}); return { version: 4, values: t.server().values }; });
    await expect(t.autosave.flush("s1")).rejects.toThrow("OPC_INFORMATION_CONFLICT");
    expect(t.writes).toHaveLength(2);
    expect(t.states.at(-1)).toBe("error");
  });

  it("keeps the same identity after an ambiguous failure so a retry is idempotent", async () => {
    const t = setup();
    t.edit({ a: v("new") });
    (t.io.write as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("network"));
    await expect(t.autosave.flush("s1")).rejects.toThrow("network");
    await t.autosave.flush("s1");
    expect((t.io.write as ReturnType<typeof vi.fn>).mock.calls.map(([r]) => r.requestId)).toEqual(["r1", "r1"]);
  });

  it("merges continuous edits: one debounced save, and edits during a save join one follow-up write", async () => {
    vi.useFakeTimers();
    const t = setup();
    for (const text of ["n", "ne", "new"]) { t.edit({ a: v(text) }); t.autosave.schedule(); vi.advanceTimersByTime(AUTOSAVE_DELAY_MS / 2); }
    expect(t.writes).toHaveLength(0);
    t.gate();
    vi.advanceTimersByTime(AUTOSAVE_DELAY_MS);
    await vi.waitFor(() => expect(t.writes).toHaveLength(1));
    // While the first write is in flight the user keeps typing; every flush and timer shares one queued save.
    t.edit({ b: v("b1") }); const one = t.autosave.enqueue("s1");
    t.edit({ b: v("b2") }); const two = t.autosave.enqueue("s1");
    expect(two).toBe(one);
    t.release();
    await one;
    expect(t.writes.map(w => w.values)).toEqual([{ a: v("new"), b: v("old") }, { a: v("new"), b: v("b2") }]);
    expect(t.writes[1]!.expectedVersion).toBe(4);
    expect(t.io.refetch).not.toHaveBeenCalled();
    expect(t.server().values).toEqual({ a: v("new"), b: v("b2") });
    expect(t.edits()).toEqual({});
  });

  it("flush resolves only after the step's save is committed, so a confirmation waits for it", async () => {
    const t = setup();
    t.edit({ a: v("new") });
    t.gate();
    let flushed = false;
    const flush = t.autosave.flush("s1").then(() => { flushed = true; });
    await vi.waitFor(() => expect(t.writes).toHaveLength(1));
    await Promise.resolve();
    expect(flushed).toBe(false);
    expect(t.states).toEqual(["saving"]);
    t.release();
    await flush;
    expect(flushed).toBe(true);
    expect(t.server().version).toBe(4);
  });

  it("leaves a step whose confirmation is in flight to that confirmation", async () => {
    vi.useFakeTimers();
    const t = setup();
    t.edit({ a: v("new") });
    t.storage.setItem("opc-confirm-step:d1:s1", "{}");
    t.autosave.schedule();
    vi.advanceTimersByTime(AUTOSAVE_DELAY_MS * 2);
    expect(t.writes).toHaveLength(0);
  });

  it("falls back to a read when the write does not return the new version", async () => {
    const t = setup();
    t.edit({ a: v("new") });
    (t.io.write as ReturnType<typeof vi.fn>).mockResolvedValueOnce({});
    await t.autosave.flush("s1");
    expect(t.io.refetch).toHaveBeenCalledTimes(1);
    expect(t.io.applySaved).not.toHaveBeenCalled();
  });
});

describe("cached read helpers", () => {
  const read = { projectId: "p", information: { s1: { schema: [], values: { a: v("x") } } }, snapshot: { state: "draft", steps: { s1: { version: 2, valid: true } } } };
  it("reads one step's version and values", () => {
    expect(stepView(read, "s1")).toEqual({ version: 2, values: { a: v("x") } });
    expect(stepView(read, "s2")).toBeNull();
    expect(stepView(undefined, "s1")).toBeNull();
  });
  it("applies a committed write without dropping the rest of the read", () => {
    const next = savedRead(read, "s1", { a: v("y") }, 3);
    expect(next.information.s1).toEqual({ schema: [], values: { a: v("y") } });
    expect(next.snapshot.steps.s1).toEqual({ version: 3, valid: true });
    expect(next.projectId).toBe("p");
    expect(read.snapshot.steps.s1.version).toBe(2);
    expect(savedRead(undefined, "s1", {}, 3)).toBeUndefined();
    // A replayed request returns its original, older version: the newer cache stays.
    expect(savedRead(read, "s1", { a: v("old") }, 2)).toBe(read);
  });
});

describe("late refresh", () => {
  it("does not let a refresh that started before a save roll the cached version back", async () => {
    const t = setup();
    t.edit({ a: v("one") });
    await t.autosave.flush("s1");
    // A background read that began before the save lands now with version 3.
    t.io.cached = () => ({ version: 3, values: { a: v("old"), b: v("old") } });
    t.edit({ b: v("two") });
    await t.autosave.flush("s1");
    expect(t.writes.map(w => w.expectedVersion)).toEqual([3, 4]);
    expect(t.io.refetch).not.toHaveBeenCalled();
    expect(t.server().values).toEqual({ a: v("one"), b: v("two") });
  });
});

describe("background refresh", () => {
  it("still refreshes once when a redundant queued save ends the queue", async () => {
    const t = setup();
    t.edit({ a: v("one") });
    t.gate();
    const first = t.autosave.enqueue("s1");
    await vi.waitFor(() => expect(t.writes).toHaveLength(1));
    // The user edits again and the timer queues a second save while the first is writing.
    t.edit({ a: v("two") });
    const second = t.autosave.enqueue("s1");
    expect(second).not.toBe(first);
    t.release();
    await first; await second;
    expect(t.writes.map(w => w.values.a)).toEqual([v("one"), v("two")]);
    expect(t.io.refreshLater).toHaveBeenCalledTimes(1);
  });
});

describe("saved fields", () => {
  it("reports only the fields a committed write changed", async () => {
    const t = setup();
    const onSaved = vi.fn();
    t.io.onSaved = onSaved;
    t.edit({ a: v("new") });
    await t.autosave.flush("s1");
    expect(onSaved).toHaveBeenCalledWith("s1", ["a"]);
  });

  it("reports nothing when the write changed nothing and nothing for a failed write", async () => {
    const t = setup();
    const onSaved = vi.fn();
    t.io.onSaved = onSaved;
    t.edit({ a: v("old") });
    await t.autosave.flush("s1");
    t.edit({ b: v("x") });
    (t.io.write as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("network"));
    await expect(t.autosave.flush("s1")).rejects.toThrow("network");
    expect(onSaved).not.toHaveBeenCalled();
  });
});
