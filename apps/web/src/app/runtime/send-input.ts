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
 * A send not yet confirmed by this page: the box text, the exact request input, its request id and when it left.
 * Kept apart from the draft (which the next keystroke overwrites) until the server history settles it.
 */
export type PendingSend = {
  requestId: string; text: string; input: string; at: number;
  /** Turns with this same input already in the history when it was sent (null: history not loaded then). */
  seen: number | null;
  /** True once the text was put back in front of the draft, so only then may that prefix be removed again. */
  restored?: boolean;
};
type HistoryTurn = { input: string | null; createdAt?: string };

export function rememberPending(storage: DraftStorage, sessionId: string,
  send: { requestId: string; text: string; input: string }, history: ReadonlyArray<HistoryTurn> | undefined,
  now = Date.now()) {
  const seen = history ? history.filter(turn => turn.input === send.input).length : null;
  storage.setItem(pendingKey(sessionId), JSON.stringify({ ...send, at: now, seen }));
  // The sent text now lives only in this record; the draft key keeps just what is typed from here on.
  storage.removeItem(draftKey(sessionId));
}

export function forgetPending(storage: DraftStorage, sessionId: string) {
  storage.removeItem(pendingKey(sessionId));
}

/**
 * After an error whose outcome is unknown (the server may have stored the send and only the reply was lost):
 * the text is back in the box, but the record and its request id stay until the server history settles it.
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
    return ok ? { ...value, seen: typeof value.seen === 'number' ? value.seen : null } : null;
  } catch {
    return null;
  }
}

/** The draft to show when the page opens; an unconfirmed send is settled later against the server history. */
export function openingDraft(storage: DraftStorage, sessionId: string) {
  return storage.getItem(draftKey(sessionId)) ?? '';
}

/**
 * Did the server store this send? Free-chat history carries no request id, so count the turns with the same input:
 * stored only when there are more than when it was sent. A repeated "继续" therefore cannot vouch for a newer one.
 * Without a count from send time, fall back to a turn from about when it left (two minutes of clock slack).
 */
export function pendingWasStored(pending: PendingSend, history: ReadonlyArray<HistoryTurn>) {
  const same = history.filter(turn => turn.input === pending.input);
  if (pending.seen !== null) return same.length > pending.seen;
  return same.some(turn => !turn.createdAt || Date.parse(turn.createdAt) >= pending.at - 120_000);
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
  history: ReadonlyArray<HistoryTurn>, setInput: SetInput) {
  const pending = readPending(storage, sessionId);
  if (!pending) return;
  if (pendingWasStored(pending, history)) {
    // Only text this page put back may be cut from the front; a draft typed after the send is left alone.
    const clean = (value: string) => pending.restored ? withoutSent(value, pending.text) : value;
    // Save the draft without the sent text first; only then is the record (the request id) safe to drop.
    const saved = clean(storage.getItem(draftKey(sessionId)) ?? '');
    if (saved) storage.setItem(draftKey(sessionId), saved);
    else storage.removeItem(draftKey(sessionId));
    forgetPending(storage, sessionId);
    setInput(clean);
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
