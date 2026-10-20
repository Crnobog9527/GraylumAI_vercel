/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {
  mergeReferences, parseReferences, sameReferences, type LibraryReference,
} from '@/components/opc/composer-references';

type SetInput = (update: (current: string) => string) => void;

/**
 * The text to show after a send that was not stored: the failed message comes back,
 * and a new draft the user started meanwhile is kept after it (neither is lost).
 * The box and the saved draft were emptied on send, so whatever is there now was typed afterwards —
 * even when it reads exactly like the failed text — and is never merged away.
 */
export function restoredDraft(current: string, submitted: string) {
  return current === '' ? submitted : submitted + '\n\n' + current;
}

/**
 * Empty the message box as soon as the user sends (like ChatGPT/Claude.ai).
 * Returns `restore` for a send the server did not store; `save` keeps the restored text as the local draft.
 */
export function clearForSend(setInput: SetInput, submitted: string, save: (text: string) => void = () => {}) {
  setInput(() => '');
  return () => setInput(current => {
    const next = restoredDraft(current, submitted);
    save(next);
    return next;
  });
}


type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const draftKey = (sessionId: string) => 'opc-runtime-input:' + sessionId;
const pendingKey = (sessionId: string) => 'opc-runtime-pending:' + sessionId;
/** UI-B: the library references of the draft, kept next to its text (the text reads them as `@名称`). */
export const draftReferencesKey = (sessionId: string) => 'opc-runtime-references:' + sessionId;

export function readDraftReferences(storage: Pick<Storage, 'getItem'>, sessionId: string) {
  try { return parseReferences(JSON.parse(storage.getItem(draftReferencesKey(sessionId)) ?? '[]')); } catch { return []; }
}

export function saveDraftReferences(storage: Pick<Storage, 'setItem' | 'removeItem'>, sessionId: string,
  references: readonly LibraryReference[]) {
  if (references.length) storage.setItem(draftReferencesKey(sessionId), JSON.stringify(references));
  else storage.removeItem(draftReferencesKey(sessionId));
}

/**
 * A send not yet confirmed by this page: the box text, the exact request input and its request id.
 * Kept apart from the draft (which the next keystroke overwrites). Only a definite answer from the server
 * (stored, or refused) removes it: free-chat history carries no request id, so it is never used to guess.
 */
export type PendingSend = {
  requestId: string; text: string; input: string; at: number;
  /** UI-B: the references sent with it; part of the request, so a different set needs a new request id. */
  references?: LibraryReference[];
  /** True once the text was put back in the box, so a reload does not add it a second time. */
  restored?: boolean;
};

export function rememberPending(storage: DraftStorage, sessionId: string,
  send: { requestId: string; text: string; input: string; references?: LibraryReference[] }, now = Date.now()) {
  const { references, ...rest } = send;
  storage.setItem(pendingKey(sessionId), JSON.stringify(references?.length ? { ...rest, references, at: now } : { ...rest, at: now }));
  // The sent text now lives only in this record; the draft key keeps just what is typed from here on.
  storage.removeItem(draftKey(sessionId));
  storage.removeItem(draftReferencesKey(sessionId));
}

export function forgetPending(storage: DraftStorage, sessionId: string) {
  storage.removeItem(pendingKey(sessionId));
}

/**
 * The text is back in the box (an error whose outcome is unknown: the server may have stored it and only the
 * reply was lost). The record and its request id stay, so resending the same text replays instead of repeating.
 */
export function markPendingRestored(storage: DraftStorage, sessionId: string) {
  const pending = readPending(storage, sessionId);
  if (pending) storage.setItem(pendingKey(sessionId), JSON.stringify({ ...pending, restored: true }));
}

export function readPending(storage: DraftStorage, sessionId: string): PendingSend | null {
  try {
    const value = JSON.parse(storage.getItem(pendingKey(sessionId)) ?? 'null');
    const ok = value && typeof value.requestId === 'string' && typeof value.text === 'string'
      && typeof value.input === 'string' && typeof value.at === 'number';
    return ok ? { ...value, references: parseReferences(value.references) } : null;
  } catch {
    return null;
  }
}

/**
 * The draft to show when the page opens. A send this page never saw answered (reload, or left mid-send) is put
 * back once in front of any newer draft; its record stays, so sending that text unchanged reuses the request id.
 * If the server had in fact stored it, that resend is a replay of the same request: no second turn, no second charge.
 */
export function openingDraft(storage: DraftStorage, sessionId: string) {
  return openingDraftWithReferences(storage, sessionId).text;
}

/** `openingDraft` with the draft's library references (UI-B); a send put back brings its references back too. */
export function openingDraftWithReferences(storage: DraftStorage, sessionId: string) {
  const draft = storage.getItem(draftKey(sessionId)) ?? '';
  const references = readDraftReferences(storage, sessionId);
  const pending = readPending(storage, sessionId);
  if (!pending || pending.restored) return { text: draft, references };
  const merged = restoredDraft(draft, pending.text);
  const mergedReferences = mergeReferences(pending.references ?? [], references);
  storage.setItem(draftKey(sessionId), merged);
  saveDraftReferences(storage, sessionId, mergedReferences);
  storage.setItem(pendingKey(sessionId), JSON.stringify({ ...pending, restored: true }));
  return { text: merged, references: mergedReferences };
}

/**
 * Request id for a send. The same input as an unanswered send reuses that send's id (the server replays it, no
 * second charge). The id left in the address is reused too, unless it belongs to that unanswered send and the user
 * changed the text: then this is a different message and gets a new id (reusing it would be RUNTIME_REQUEST_CONFLICT).
 */
export function requestIdFor(fromAddress: string | null, pending: PendingSend | null, input: string,
  fresh: () => string = () => crypto.randomUUID(), references: readonly LibraryReference[] = []) {
  if (fromAddress && pending?.requestId !== fromAddress) return fromAddress;
  // UI-B: the server stores `references` with the request; the same text with other references is another message.
  if (pending?.input === input && sameReferences(pending.references ?? [], references)) return pending.requestId;
  return fresh();
}
