/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { isRecord } from "./confirm-envelope";

export type RetainedHandoff = {
  draftId: string;
  planId: string;
  requestId: string;
  accounts: Array<{ platform: string; account: string; expectedRevision: number | null }>;
};

type HandoffStorage = Pick<Storage, "getItem" | "setItem">;

/**
 * The retained handoff request, or null when there is none or it cannot be
 * read. An unreadable value is archived verbatim before the current intent
 * replaces it, so the per-draft key can never become a local dead end.
 */
export function readRetainedHandoff(storage: HandoffStorage, draftId: string): RetainedHandoff | null {
  const raw = storage.getItem("opc-confirm:" + draftId);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) throw new Error("unreadable");
    const { draftId: draft, planId, requestId } = parsed;
    if (typeof draft !== "string" || typeof planId !== "string" || typeof requestId !== "string" || !Array.isArray(parsed.accounts))
      throw new Error("unreadable");
    // Only the fields the strict handoff contract accepts are carried over,
    // so a hand-edited value cannot turn into a permanent schema rejection.
    const accounts = (parsed.accounts as unknown[]).map((entry) => {
      if (!isRecord(entry)) throw new Error("unreadable");
      const { platform, account, expectedRevision } = entry;
      if (typeof platform !== "string" || typeof account !== "string") throw new Error("unreadable");
      if (expectedRevision !== null && typeof expectedRevision !== "number") throw new Error("unreadable");
      return { platform, account, expectedRevision: expectedRevision as number | null };
    });
    return { draftId: draft, planId, requestId, accounts };
  } catch {
    try {
      storage.setItem("opc-confirm-archive:" + draftId + ":" + Date.now(), raw);
    } catch {
      /* The archive is evidence only; it never gates the next confirmation. */
    }
    return null;
  }
}

/**
 * The business intent one handoff request owns: the draft, the plan version
 * and the normalized platform/account set. `expectedRevision` is an
 * optimistic concurrency guard, so it is deliberately not part of it.
 */
export function handoffIntent(value: { draftId: string; planId: string; accounts: readonly unknown[] }) {
  return JSON.stringify([
    value.draftId,
    value.planId,
    value.accounts
      .map((entry) => {
        const account = entry as { platform?: unknown; account?: unknown };
        return [
          typeof account.platform === "string" ? account.platform : "",
          typeof account.account === "string" ? account.account : "",
        ];
      })
      .sort(),
  ]);
}
