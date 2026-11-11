/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/*
 * Text PostgreSQL can store (deep review 2026-11-11, finding 2). A NUL character is refused by both `text` and `jsonb`, and `jsonb`
 * also refuses a lone surrogate: half of an emoji, as an input method, a clipboard or a supplier's truncated title leaves it. One
 * such character in a turn's messages made the closing write fail after the whole answer had been streamed.
 *
 * Cleaned, not refused: the user cannot see either character in what they typed, so a refusal would be an error with nothing to fix;
 * nothing readable is lost (the NUL is dropped, the half emoji becomes U+FFFD, the replacement character).
 *
 * Used at the two ends of a turn: the request body (http.ts, fusionHttp.ts), so the model, the hashes and the saved message all see
 * the same text, and every turn write (db.ts `call`), so text that did not come from the user (a supplier's search result, a model's
 * escaped output) cannot fail a write either.
 */
export function storableText(text: string): string {
  const clean = text.includes('\0') ? text.replaceAll('\0', '') : text;
  return clean.isWellFormed() ? clean : clean.toWellFormed();
}

/** The same for every string in a JSON value, keys included. Returns the value itself when nothing had to change. */
export function storable<T>(value: T): T {
  if (typeof value === 'string') return storableText(value) as T;
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item: unknown) => {
      const clean = storable(item);
      if (clean !== item) changed = true;
      return clean;
    });
    return (changed ? next : value) as T;
  }
  if (value === null || typeof value !== 'object') return value;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const cleanKey = storableText(key), clean = storable(item);
    if (cleanKey !== key || clean !== item) changed = true;
    next[cleanKey] = clean;
  }
  return (changed ? next : value) as T;
}
