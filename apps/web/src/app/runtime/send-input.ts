/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
type SetInput = (update: (current: string) => string) => void;

/**
 * Empty the message box as soon as the user sends (like ChatGPT/Claude.ai).
 * Returns `restore`: if the server does not store the message, the text goes back,
 * unless the user has already typed something new.
 */
export function clearForSend(setInput: SetInput, submitted: string) {
  setInput(() => '');
  return () => setInput(current => current === '' ? submitted : current);
}

/** Once the server stored the message, drop the saved draft only if it is still that message. */
export function forgetSentDraft(storage: Pick<Storage, 'getItem' | 'removeItem'>, key: string, submitted: string) {
  if (storage.getItem(key) === submitted) storage.removeItem(key);
}
