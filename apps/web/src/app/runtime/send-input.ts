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
 * The sent text is kept under its own key until the server confirms it, because the draft key is
 * overwritten as soon as the user types the next message. A reload before confirmation then still has it.
 */
export function rememberPending(storage: DraftStorage, sessionId: string, requestId: string, text: string) {
  storage.setItem(pendingKey(sessionId), JSON.stringify({ requestId, text }));
}

export function forgetPending(storage: DraftStorage, sessionId: string) {
  storage.removeItem(pendingKey(sessionId));
}

/** The draft to show when the page opens: an unconfirmed send goes back in front of any newer draft. */
export function openingDraft(storage: DraftStorage, sessionId: string) {
  const draft = storage.getItem(draftKey(sessionId)) ?? '';
  let text: unknown;
  try {
    text = JSON.parse(storage.getItem(pendingKey(sessionId)) ?? 'null')?.text;
  } catch {
    text = undefined;
  }
  if (typeof text !== 'string' || !text) return draft;
  const merged = restoredDraft(draft, text);
  storage.setItem(draftKey(sessionId), merged);
  forgetPending(storage, sessionId);
  return merged;
}
