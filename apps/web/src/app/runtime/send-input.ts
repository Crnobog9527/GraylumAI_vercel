/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
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

/**
 * A send not yet confirmed by this page: the box text, the exact request input and its request id.
 * Kept apart from the draft (which the next keystroke overwrites). Only a definite answer from the server
 * (stored, or refused) removes it: free-chat history carries no request id, so it is never used to guess.
 */
export type PendingSend = {
  requestId: string; text: string; input: string; at: number;
  /** True once the text was put back in the box, so a reload does not add it a second time. */
  restored?: boolean;
};

export function rememberPending(storage: DraftStorage, sessionId: string,
  send: { requestId: string; text: string; input: string }, now = Date.now()) {
  storage.setItem(pendingKey(sessionId), JSON.stringify({ ...send, at: now }));
  // The sent text now lives only in this record; the draft key keeps just what is typed from here on.
  storage.removeItem(draftKey(sessionId));
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
    return ok ? value : null;
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
  const draft = storage.getItem(draftKey(sessionId)) ?? '';
  const pending = readPending(storage, sessionId);
  if (!pending || pending.restored) return draft;
  const merged = restoredDraft(draft, pending.text);
  storage.setItem(draftKey(sessionId), merged);
  storage.setItem(pendingKey(sessionId), JSON.stringify({ ...pending, restored: true }));
  return merged;
}

/** Request id for a send: the one already in the address, else the unconfirmed one for the same input, else new. */
export function requestIdFor(fromAddress: string | null, pending: PendingSend | null, input: string,
  fresh: () => string = () => crypto.randomUUID()) {
  return fromAddress ?? (pending && pending.input === input ? pending.requestId : null) ?? fresh();
}
