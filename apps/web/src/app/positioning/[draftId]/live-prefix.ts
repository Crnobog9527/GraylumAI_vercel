/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { codePoints, startLiveReply, type LiveReply } from "./agent-turn-display";

/**
 * Same-tab reload keeps the part of a streaming reply the user already saw
 * (CHAT-NATIVE-OUTPUT §2.4). Only displayed text and its `rev` are stored, in
 * this tab's sessionStorage; never a card, an option or a private field. The
 * stored prefix is display only: it is never sent to the server and the final
 * result always replaces it.
 *
 * Restoring needs proof that this tab itself reloaded. On `pagehide` the page
 * writes the latest prefix with `reload: true`. A duplicated tab or a window
 * opened by this page copies sessionStorage while the original page is still
 * alive, so its copy has no reload mark and is dropped. The mark has no expiry:
 * a slow reload restores the prefix however long loading takes. The new page
 * consumes the mark at once, so a later copy of this tab cannot reuse it.
 */
export type LivePrefix = { executionId: string; text: string; rev: number; reload?: true };

type PrefixStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Normal growth is written at most this often; snapshots and pagehide write at once. */
export const PREFIX_WRITE_INTERVAL_MS = 1000;

export function livePrefixKey(draftId: string) {
  return "opc-live-prefix:" + draftId;
}

function remove(storage: PrefixStorage, key: string) {
  try {
    storage.removeItem(key);
  } catch {
    /* Storage unavailable: nothing was kept either. */
  }
}

/**
 * Store what `reply` shows. A failed write removes the item, so a reload never
 * restores text that a newer snapshot already replaced. Returns true on success.
 */
export function saveLivePrefix(storage: PrefixStorage, draftId: string, reply: LiveReply, reload = false): boolean {
  const key = livePrefixKey(draftId);
  const value: LivePrefix = { executionId: reply.executionId, text: reply.text, rev: reply.rev, ...(reload ? { reload: true } : {}) };
  try {
    storage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    remove(storage, key);
    return false;
  }
}

export function forgetLivePrefix(storage: PrefixStorage, draftId: string) {
  remove(storage, livePrefixKey(draftId));
}

function parsePrefix(raw: string | null): LivePrefix | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (!value || typeof value.executionId !== "string" || typeof value.text !== "string" ||
      !Number.isSafeInteger(value.rev) || (value.rev as number) < 0) return null;
    return { executionId: value.executionId, text: value.text, rev: value.rev as number, ...(value.reload === true ? { reload: true } : {}) };
  } catch {
    return null;
  }
}

/**
 * On `pagehide`: store the latest shown prefix with the reload mark. When that
 * write fails the item is removed, so the reloaded page only shows the
 * waiting state.
 */
export function markLiveReload(storage: PrefixStorage, draftId: string, reply: LiveReply | null) {
  if (!reply || !reply.text || reply.phase === "incomplete") return;
  saveLivePrefix(storage, draftId, reply, true);
}

/** On `pageshow` from the back/forward cache: the page lived on, so the mark is withdrawn. */
export function unmarkLiveReload(storage: PrefixStorage, draftId: string) {
  let prefix: LivePrefix | null = null;
  try {
    prefix = parsePrefix(storage.getItem(livePrefixKey(draftId)));
  } catch {
    return;
  }
  if (!prefix?.reload) return;
  try {
    storage.setItem(livePrefixKey(draftId), JSON.stringify({ ...prefix, reload: undefined }));
  } catch {
    remove(storage, livePrefixKey(draftId));
  }
}

/**
 * Read the stored prefix once per page load. Only a prefix carrying the
 * reload mark is restored, as a reply that waits without growing; the mark is
 * consumed. Anything else (a copied tab's storage, an unreadable value) is
 * removed and nothing is restored.
 */
export function takeLivePrefix(storage: PrefixStorage, draftId: string): LiveReply | null {
  const key = livePrefixKey(draftId);
  let prefix: LivePrefix | null;
  try {
    prefix = parsePrefix(storage.getItem(key));
  } catch {
    return null;
  }
  if (!prefix?.reload || !prefix.text) {
    remove(storage, key);
    return null;
  }
  const reply: LiveReply = { ...startLiveReply(prefix.executionId), text: prefix.text, points: codePoints(prefix.text),
    rev: prefix.rev, phase: "waiting", stalled: true };
  if (!saveLivePrefix(storage, draftId, reply)) return null;
  return reply;
}

/**
 * React may mount the page twice in one load (development strict mode); the
 * first read consumed the mark, so later mounts reuse its outcome.
 */
const taken = new Map<string, LiveReply | null>();

export function restoreLivePrefix(storage: PrefixStorage, draftId: string): LiveReply | null {
  if (!taken.has(draftId)) taken.set(draftId, takeLivePrefix(storage, draftId));
  return taken.get(draftId) ?? null;
}

/** The restored prefix is superseded (a new stream, a final result or a clear). */
export function releaseRestoredPrefix(draftId: string) {
  taken.set(draftId, null);
}
