/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Field extraction for third-party research responses (ported from the RESEARCH-0 comparison tooling).
// A value the supplier did not provide stays undefined and is reported as missing; it is never
// coerced to zero, and zero supplied by the supplier is a real value.

/** Read a dotted path; absent, null and empty-string values read as undefined. */
export function get(value: unknown, dotted: string): unknown {
  let current: unknown = value;
  for (const part of dotted.split('.')) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = Array.isArray(current) && /^\d+$/.test(part)
      ? current[Number(part)]
      : (current as Record<string, unknown>)[part];
  }
  return current === null || current === undefined || current === '' ? undefined : current;
}

export function first(value: unknown, paths: readonly string[]): unknown {
  for (const dotted of paths) {
    const found = get(value, dotted);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Try each path in order and keep the first one that yields a valid value (e.g. `views` is an object, `views.count` a number). */
function firstValid<T>(value: unknown, paths: readonly string[], read: (found: unknown) => T | undefined): T | undefined {
  for (const dotted of paths) {
    const found = get(value, dotted);
    if (found === undefined) continue;
    const parsed = read(found);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

/** Non-negative finite numbers or plain numeric strings; anything else is missing. */
export function count(value: unknown, paths: readonly string[]): number | undefined {
  return firstValid(value, paths, readCount);
}

function readCount(found: unknown): number | undefined {
  if (typeof found === 'number' && Number.isFinite(found) && found >= 0) return found;
  if (typeof found === 'string' && /^\d+(\.\d+)?$/.test(found.trim())) {
    const parsed = Number(found);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** "343,369 views" → 343369. Abbreviated labels such as "1.2M" or "50万次观看" stay missing. */
export function displayCount(value: unknown, paths: readonly string[]): number | undefined {
  const exact = count(value, paths);
  if (exact !== undefined) return exact;
  const found = text(value, paths);
  // Plain digits or correctly grouped thousands only ("343,369"); "1,,2" or ", views" stay missing.
  const match = found?.match(/^\s*(\d{1,3}(?:,\d{3})+|\d+)\s*(views?|次观看)?\s*$/i);
  if (!match) return undefined;
  const parsed = Number(match[1].replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Epoch seconds, epoch milliseconds or an absolute date string → ISO. Relative labels are missing. */
export function timestamp(value: unknown, paths: readonly string[]): string | undefined {
  return firstValid(value, paths, readTimestamp);
}

function readTimestamp(found: unknown): string | undefined {
  let ms: number | undefined;
  if (typeof found === 'number' || (typeof found === 'string' && /^\d{9,13}$/.test(found))) {
    const numeric = Number(found);
    ms = numeric < 1e11 ? numeric * 1000 : numeric;
  } else if (typeof found === 'string' && /\d{4}/.test(found)) {
    ms = Date.parse(found);
  }
  // Beyond ±8.64e15 ms a Date is invalid and toISOString() would throw; treat it as missing.
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0 || ms > 8.64e15) return undefined;
  return new Date(ms).toISOString();
}

/** Text values; whitespace-only strings count as not provided. */
export function text(value: unknown, paths: readonly string[]): string | undefined {
  return firstValid(value, paths, readText);
}

function readText(found: unknown): string | undefined {
  if (typeof found === 'string') return found.trim() === '' ? undefined : found;
  if (typeof found === 'number' || typeof found === 'boolean') return String(found);
  return undefined;
}

export function bool(value: unknown, paths: readonly string[]): boolean | undefined {
  const found = first(value, paths);
  return typeof found === 'boolean' ? found : undefined;
}

export function list(value: unknown, paths: readonly string[]): unknown[] {
  const found = first(value, paths);
  return Array.isArray(found) ? found : [];
}

/** Breadth-first search for objects matching `predicate`; matches are not descended into. */
export function findAll(
  root: unknown, predicate: (node: Record<string, unknown>) => boolean, max = 200,
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const queue: unknown[] = [root];
  // A read cursor instead of shift(): shift() re-indexes the array and makes large bodies quadratic.
  let cursor = 0;
  while (cursor < queue.length && out.length < max && cursor < 50_000) {
    const node = queue[cursor];
    cursor += 1;
    if (node === null || typeof node !== 'object') continue;
    if (!Array.isArray(node) && predicate(node as Record<string, unknown>)) {
      out.push(node as Record<string, unknown>);
      continue;
    }
    for (const child of Array.isArray(node) ? node : Object.values(node)) queue.push(child);
  }
  return out;
}

export const has = (object: Record<string, unknown>, ...keys: string[]) =>
  keys.some(key => Object.hasOwn(object, key));

/**
 * Cut to at most `maxBytes` UTF-8 bytes on a code-point boundary, preferring the last paragraph break
 * in the second half of the kept text.
 */
export function clipBytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let used = 0;
  let end = 0;
  for (const char of value) {
    const size = Buffer.byteLength(char, 'utf8');
    if (used + size > maxBytes) break;
    used += size;
    end += char.length;
  }
  const kept = value.slice(0, end);
  const paragraph = kept.lastIndexOf('\n\n');
  return paragraph >= kept.length / 2 ? kept.slice(0, paragraph) : kept;
}

/** Cut to `max` characters on a code-point boundary. */
export function clip(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  const chars = [...value];
  return chars.length <= max ? value : chars.slice(0, max).join('');
}
