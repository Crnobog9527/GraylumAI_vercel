/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { CHECKLIST_UPDATED_INPUT, readChecklistUpdatedInput } from "@repo/api/src/shared/opcQuestions";
import type { ChatNotice } from "@/components/chat/ChatInlineNotice";

/**
 * Fields the user changed in the checklist and saved since their last message, per step.
 * The mentor is told about them only when the user clicks "让导师接着聊": saving never
 * calls the model by itself, and any message the user sends clears the list.
 */
type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;
const key = (draftId: string) => "opc-checklist-nudge:" + draftId;

function read(storage: Storage, draftId: string): Record<string, string[]> {
  try {
    const value = JSON.parse(storage.getItem(key(draftId)) ?? "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

export function noteSavedFields(storage: Storage, draftId: string, stepId: string, fieldIds: readonly string[]) {
  if (!fieldIds.length) return;
  const all = read(storage, draftId);
  const ids = Array.isArray(all[stepId]) ? all[stepId] : [];
  storage.setItem(key(draftId), JSON.stringify({ ...all, [stepId]: [...new Set([...ids, ...fieldIds])] }));
}

/** The saved fields of one step that still exist in its schema, in schema order. */
export function savedFields(storage: Storage, draftId: string, stepId: string, schema: readonly { id: string }[]) {
  const ids = new Set(read(storage, draftId)[stepId] ?? []);
  return schema.map(field => field.id).filter(id => ids.has(id)).slice(0, 100);
}

/** Any message to the mentor (typed, a card answer, or the button itself) carries the current checklist. */
export function clearSavedFields(storage: Storage, draftId: string) {
  storage.removeItem(key(draftId));
}

/**
 * A turn the server did not admit (Q1, nothing stored): a checklist turn notes its fields again so the prompt
 * returns for a retry; a typed message goes back into the box (`restoreInput`), never the raw host marker.
 */
export function refusedTurn(storage: Storage, draftId: string, stepId: string, input: string, restoreInput: () => void) {
  if (!isChecklistUpdate(input)) { restoreInput(); return; }
  let ids: string[] | undefined;
  try { ids = readChecklistUpdatedInput(input); } catch { ids = undefined; }
  if (ids?.length) noteSavedFields(storage, draftId, stepId, ids);
}

export const isChecklistUpdate = (input: string | null | undefined) => (input ?? "").startsWith(CHECKLIST_UPDATED_INPUT);

/** What the conversation shows for a turn's input: the update marker is the user's click, never shown raw. */
export function shownInput(input: string | null | undefined) {
  if (!isChecklistUpdate(input)) return input;
  let count = 0;
  try { count = readChecklistUpdatedInput(input!)?.length ?? 0; } catch { /* Malformed: still never shown raw. */ }
  return count ? `我在清单里更新了 ${count} 项，请接着聊` : "我更新了清单，请接着聊";
}

/**
 * The one-line prompt above the message box; only a click sends anything. It disappears as soon as any
 * message is queued (`queued`), even before that message's pending saves finish and clear the list.
 */
export function nudgeNotice(fieldIds: readonly string[], onClick: () => void, disabled: boolean, queued = false): ChatNotice | null {
  if (!fieldIds.length || queued) return null;
  return { id: "checklist-nudge", tone: "status", text: `你在清单里更新了 ${fieldIds.length} 项`,
    actions: [{ label: "让导师接着聊", onClick, disabled }] };
}
