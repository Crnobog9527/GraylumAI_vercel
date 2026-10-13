/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Field extraction for third-party research responses (ported from scripts/research0/metrics.mjs).
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

/** Non-negative finite numbers or plain numeric strings; anything else is missing. */
export function count(value: unknown, paths: readonly string[]): number | undefined {
  const found = first(value, paths);
  if (typeof found === 'number' && Number.isFinite(found) && found >= 0) return found;
  if (typeof found === 'string' && /^\d+(\.\d+)?$/.test(found.trim())) return Number(found);
  return undefined;
}

/** "343,369 views" → 343369. Abbreviated labels such as "1.2M" or "50万次观看" stay missing. */
export function displayCount(value: unknown, paths: readonly string[]): number | undefined {
  const exact = count(value, paths);
  if (exact !== undefined) return exact;
  const found = text(value, paths);
  const match = found?.match(/^\s*([\d,]+)\s*(views?|次观看)?\s*$/i);
  return match ? Number(match[1].replace(/,/g, '')) : undefined;
}

/** Epoch seconds, epoch milliseconds or an absolute date string → ISO. Relative labels are missing. */
export function timestamp(value: unknown, paths: readonly string[]): string | undefined {
  const found = first(value, paths);
  if (found === undefined) return undefined;
  let ms: number | undefined;
  if (typeof found === 'number' || (typeof found === 'string' && /^\d{9,13}$/.test(found))) {
    const numeric = Number(found);
    ms = numeric < 1e11 ? numeric * 1000 : numeric;
  } else if (typeof found === 'string' && /\d{4}/.test(found)) {
    ms = Date.parse(found);
  }
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return undefined;
  return new Date(ms).toISOString();
}

export function text(value: unknown, paths: readonly string[]): string | undefined {
  const found = first(value, paths);
  if (typeof found === 'string') return found;
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
  let visited = 0;
  while (queue.length > 0 && out.length < max && visited < 50_000) {
    const node = queue.shift();
    visited += 1;
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

/** Cut to `max` characters on a code-point boundary. */
export function clip(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  const chars = [...value];
  return chars.length <= max ? value : chars.slice(0, max).join('');
}
