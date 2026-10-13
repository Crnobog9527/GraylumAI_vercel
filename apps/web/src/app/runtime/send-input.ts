/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
type SetInput = (update: (current: string) => string) => void;

/**
 * The text to show after a send that was not stored: the failed message comes back,
 * and a new draft the user started meanwhile is kept after it (neither is lost).
 */
export function restoredDraft(current: string, submitted: string) {
  // The box was emptied on send, so anything in it now is new typing, even if it begins like the failed text.
  if (current === '' || current === submitted) return submitted;
  return submitted + '\n\n' + current;
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

/** Once the server stored the message, drop the saved draft only if it is still that message. */
export function forgetSentDraft(storage: Pick<Storage, 'getItem' | 'removeItem'>, key: string, submitted: string) {
  if (storage.getItem(key) === submitted) storage.removeItem(key);
}

type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const draftKey = (sessionId: string) => 'opc-runtime-input:' + sessionId;
const pendingKey = (sessionId: string) => 'opc-runtime-pending:' + sessionId;

/**
 * A send not yet confirmed by this page: the box text, the exact request input, its request id and when it left.
 * Kept apart from the draft (which the next keystroke overwrites) until the server history settles it.
 */
export type PendingSend = { requestId: string; text: string; input: string; at: number; restored?: boolean };

export function rememberPending(storage: DraftStorage, sessionId: string,
  send: { requestId: string; text: string; input: string }, now = Date.now()) {
  storage.setItem(pendingKey(sessionId), JSON.stringify({ ...send, at: now }));
}

export function forgetPending(storage: DraftStorage, sessionId: string) {
  storage.removeItem(pendingKey(sessionId));
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

/** The draft to show when the page opens; an unconfirmed send is settled later against the server history. */
export function openingDraft(storage: DraftStorage, sessionId: string) {
  return storage.getItem(draftKey(sessionId)) ?? '';
}

/**
 * Did the server store this send? Its history has a turn with the same input from about when it left.
 * (Two minutes of clock slack; an older identical message, such as an earlier "继续", does not count.)
 */
export function pendingWasStored(pending: PendingSend, history: ReadonlyArray<{ input: string | null; createdAt?: string }>) {
  return history.some(turn => turn.input === pending.input
    && (!turn.createdAt || Date.parse(turn.createdAt) >= pending.at - 120_000));
}

/** Remove a stored send from the box, keeping anything typed after it. */
export function withoutSent(current: string, text: string) {
  if (current === text) return '';
  return current.startsWith(text + '\n\n') ? current.slice(text.length + 2) : current;
}

/**
 * Settle an unconfirmed send once the server history is loaded. Stored: drop it from the box and storage.
 * Not stored: put it back in front of the draft once, and keep the record so a resend reuses its request id.
 */
export function settlePending(storage: DraftStorage, sessionId: string,
  history: ReadonlyArray<{ input: string | null; createdAt?: string }>, setInput: SetInput) {
  const pending = readPending(storage, sessionId);
  if (!pending) return;
  if (pendingWasStored(pending, history)) {
    forgetPending(storage, sessionId);
    forgetSentDraft(storage, draftKey(sessionId), pending.text);
    setInput(current => withoutSent(current, pending.text));
    return;
  }
  if (pending.restored) return;
  storage.setItem(pendingKey(sessionId), JSON.stringify({ ...pending, restored: true }));
  setInput(current => {
    const next = restoredDraft(current, pending.text);
    storage.setItem(draftKey(sessionId), next);
    return next;
  });
}

/** Request id for a send: the one already in the address, else the unconfirmed one for the same input, else new. */
export function requestIdFor(fromAddress: string | null, pending: PendingSend | null, input: string,
  fresh: () => string = () => crypto.randomUUID()) {
  return fromAddress ?? (pending && pending.input === input ? pending.requestId : null) ?? fresh();
}
