/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
type SetInput = (update: (current: string) => string) => void;

/**
 * The text to show after a send that was not stored: the failed message comes back,
 * and a new draft the user started meanwhile is kept after it (neither is lost).
 */
export function restoredDraft(current: string, submitted: string) {
  if (current === '' || current === submitted) return submitted;
  if (current.startsWith(submitted)) return current;
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
