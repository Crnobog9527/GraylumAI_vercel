/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { mergeInformation } from "./information-merge";
import type { Information } from "./confirm-envelope";

export type SaveState = "idle" | "saving" | "saved" | "error";
type Values = Record<string, Information>;
/** One step as the page last read it: its values and the version every write must name. */
export type StepView = { version: number; values: Values };
export type InformationRequest = {
  draftId: string; stepId: string; requestId: string; expectedVersion: number; values: Values;
};
type Fixed = InformationRequest & { editingSnapshot: string };

export type AutosaveIo = {
  draftId: string;
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  /** The step from the page's cached read, without a network round trip. */
  cached: (stepId: string) => StepView | null;
  /** A full read. Only a definite version conflict (or an empty cache) needs one. */
  refetch: (stepId: string) => Promise<StepView | null>;
  write: (request: InformationRequest) => Promise<unknown>;
  /** Put the committed values and version into the cached read. */
  applySaved: (stepId: string, values: Values, version: number) => void;
  /** Low priority refresh of what a write also changed (field sources, later steps), once saves settle. */
  refreshLater: () => void;
  edits: () => Record<string, Values>;
  setEdits: (stepId: string, values: Values | null) => void;
  setSaveState: (stepId: string, state: SaveState) => void;
  setConflict: (stepId: string, conflict: { current: Values; fields: string[] }) => void;
  onError: (message: string) => void;
  newId: () => string;
};

/** sessionStorage, looked up on use: the page also renders where it does not exist. */
export const tabStorage: AutosaveIo["storage"] = {
  getItem: key => sessionStorage.getItem(key), setItem: (key, value) => sessionStorage.setItem(key, value),
  removeItem: key => sessionStorage.removeItem(key),
};
export const AUTOSAVE_DELAY_MS = 400;
export const AUTOSAVE_FAILED = "自动保存暂时失败。内容仍保留在本机，可重试保存。";
const FIELD_CONFLICT = "其他窗口修改了相同信息。你的输入仍保留，请核对后再保存，未覆盖服务器内容。";
const autosaveKey = (draftId: string, stepId: string) => "opc-information-autosave:" + draftId + ":" + stepId;
export const informationBaseKey = (draftId: string, stepId: string) => "opc-information-base:" + draftId + ":" + stepId;
const confirmingKey = (draftId: string, stepId: string) => "opc-confirm-step:" + draftId + ":" + stepId;

function savedVersion(result: unknown) {
  const version = result && typeof result === "object" ? (result as { version?: unknown }).version : undefined;
  return typeof version === "number" && Number.isInteger(version) ? version : null;
}

/**
 * Autosave of the checklist's edits. A save is one write built from the cached
 * read; only a definite version conflict reads again (and retries once with a
 * fresh identity). Saves run one at a time, a step waiting in the queue is not
 * queued twice, and a running save carries on with edits made while it ran.
 */
export function createInformationAutosave(io: () => AutosaveIo) {
  let chain: Promise<void> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const queued = new Map<string, Promise<void>>();
  /** What this page last wrote per step. Versions only grow, so a refresh that lands late cannot roll it back. */
  const written = new Map<string, StepView>();
  function newest(stepId: string, view: StepView | null) {
    const own = written.get(stepId);
    return own && (!view || own.version > view.version) ? own : view;
  }

  async function persist(stepId: string) {
    const x = io(), key = autosaveKey(x.draftId, stepId), baseKey = informationBaseKey(x.draftId, stepId);
    // A queued task may outlive the edit that scheduled it.
    if (!x.edits()[stepId] && !x.storage.getItem(key)) return;
    let wanted = x.edits()[stepId];
    let retriedConflict = false;
    x.setSaveState(stepId, "saving");
    try {
      for (;;) {
        let fixed: Fixed | null = null;
        try {
          const raw = x.storage.getItem(key);
          if (raw) fixed = JSON.parse(raw);
        } catch {
          throw new Error("OPC_AUTOSAVE_IDENTITY_UNREADABLE");
        }
        if (!fixed) {
          if (!wanted) return;
          const current = newest(stepId, x.cached(stepId)) ?? await x.refetch(stepId);
          if (!current) throw new Error("OPC_UNAVAILABLE");
          const rawBase = x.storage.getItem(baseKey);
          if (!rawBase) {
            x.setConflict(stepId, { current: current.values, fields: Object.keys(wanted) });
            throw new Error("OPC_EDIT_BASE_MISSING");
          }
          const merged = mergeInformation(JSON.parse(rawBase), wanted, current.values);
          if (merged.conflicts.length) {
            x.setConflict(stepId, { current: current.values, fields: merged.conflicts });
            throw new Error("OPC_FIELD_CONFLICT:" + merged.conflicts.join(","));
          }
          fixed = { draftId: x.draftId, stepId, requestId: x.newId(), expectedVersion: current.version,
            values: merged.values as Values, editingSnapshot: JSON.stringify(wanted) };
          x.storage.setItem(key, JSON.stringify(fixed));
        }
        let result: unknown;
        try {
          result = await x.write({ draftId: fixed.draftId, stepId: fixed.stepId, requestId: fixed.requestId,
            expectedVersion: fixed.expectedVersion, values: fixed.values });
        } catch (cause) {
          if (!retriedConflict && cause instanceof Error && cause.message.includes("OPC_INFORMATION_CONFLICT")) {
            // A version conflict is a definite rollback. Read again and create a
            // new identity once; ambiguous failures retain the original ID.
            retriedConflict = true;
            x.storage.removeItem(key);
            if (!await x.refetch(stepId)) throw new Error("OPC_UNAVAILABLE");
            continue;
          }
          throw cause;
        }
        x.storage.removeItem(key);
        const version = savedVersion(result);
        if (version === null) await x.refetch(stepId);
        else {
          written.set(stepId, { version, values: fixed.values });
          x.applySaved(stepId, fixed.values, version);
        }
        const latestValues = x.edits()[stepId];
        if (!latestValues || JSON.stringify(latestValues) === fixed.editingSnapshot) {
          x.setEdits(stepId, null);
          x.storage.removeItem(baseKey);
          break;
        }
        // Only edits made after this immutable request become the next request.
        const pending = mergeInformation(JSON.parse(fixed.editingSnapshot), latestValues, fixed.values);
        if (pending.conflicts.length) throw new Error("OPC_FIELD_CONFLICT:" + pending.conflicts.join(","));
        wanted = pending.values as Values;
        x.storage.setItem(baseKey, JSON.stringify(fixed.values));
        x.setEdits(stepId, wanted);
        retriedConflict = false;
      }
      x.setSaveState(stepId, "saved");
      if (!queued.size) x.refreshLater();
    } catch (cause) {
      x.setSaveState(stepId, "error");
      if (cause instanceof Error && /OPC_FIELD_CONFLICT|OPC_EDIT_BASE_MISSING/.test(cause.message)) x.onError(FIELD_CONFLICT);
      throw cause;
    }
  }

  /** One save of the step's latest edits; a save of it that has not started yet already covers them. */
  function enqueue(stepId: string) {
    const waiting = queued.get(stepId);
    if (waiting) return waiting;
    const task = chain.then(() => { queued.delete(stepId); return persist(stepId); });
    queued.set(stepId, task);
    chain = task.catch(() => undefined);
    return task;
  }

  /** Steps whose confirmation is in flight keep their edits for that confirmation. */
  function pendingSteps() {
    const x = io();
    return Object.keys(x.edits()).filter(stepId => !x.storage.getItem(confirmingKey(x.draftId, stepId)));
  }

  function cancel() {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  /** Debounced autosave after an edit; called again on every edit. */
  function schedule() {
    cancel();
    if (!pendingSteps().length) return;
    timer = setTimeout(() => {
      timer = null;
      for (const stepId of pendingSteps()) void enqueue(stepId).catch(() => io().onError(AUTOSAVE_FAILED));
    }, AUTOSAVE_DELAY_MS);
  }

  /** Save now and wait until this step's save (and every earlier one) is done. */
  async function flush(stepId: string) {
    cancel();
    // Any step can be edited in the checklist: the cleared timer also covered the other steps' edits.
    for (const other of pendingSteps())
      if (other !== stepId) void enqueue(other).catch(() => io().onError(AUTOSAVE_FAILED));
    await (io().edits()[stepId] ? enqueue(stepId) : chain);
  }

  return { enqueue, schedule, flush, cancel };
}

type DraftRead = { information?: Record<string, { values?: Values }>; snapshot?: { steps?: Record<string, { version?: number }> } };

/** The step from a read of the draft, or null when the read does not have it. */
export function stepView(read: unknown, stepId: string): StepView | null {
  const version = (read as DraftRead | undefined)?.snapshot?.steps?.[stepId]?.version;
  if (typeof version !== "number") return null;
  return { version, values: (read as DraftRead).information?.[stepId]?.values ?? {} };
}

/** A cached read with one committed write applied; the background refresh brings the rest. */
export function savedRead<T>(read: T, stepId: string, values: Values, version: number): T {
  const old = read as DraftRead | undefined;
  if (!old?.information?.[stepId] || !old.snapshot?.steps?.[stepId]) return read;
  return { ...old,
    information: { ...old.information, [stepId]: { ...old.information[stepId], values } },
    snapshot: { ...old.snapshot, steps: { ...old.snapshot.steps, [stepId]: { ...old.snapshot.steps[stepId], version } } },
  } as T;
}
