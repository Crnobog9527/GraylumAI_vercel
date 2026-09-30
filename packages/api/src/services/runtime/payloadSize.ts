/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { StagingAccessError } from './stagingErrors';
export const FROZEN_PAYLOAD_BYTES = 262144;
/** PostgreSQL jsonb::text uses a space after each comma and colon, expands
 * numeric exponents, and emits UTF-8 strings. Key order does not affect size.
 * Normalize through JSON first, exactly as the PostgREST request does. */
export function postgresJsonbBytes(value: unknown): number {
  const normalized: unknown = JSON.parse(JSON.stringify(value));
  function size(item: unknown): number {
    if (item === null) return 4;
    if (typeof item === 'string') {
      if (/\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(item))
        throw new StagingAccessError('RUNTIME_FROZEN_PAYLOAD_INVALID');
      return Buffer.byteLength(JSON.stringify(item));
    }
    if (typeof item === 'number') {
      const text = JSON.stringify(item), parts = text.split(/[eE]/);
      if (parts.length === 1) return text.length;
      const negative = parts[0]!.startsWith('-'), mantissa = parts[0]!.replace('-', '');
      const digits = mantissa.replace('.', ''), point = mantissa.split('.')[0]!.length + Number(parts[1]);
      return Number(negative) + (point <= 0 ? 2 - point + digits.length :
        point >= digits.length ? point : digits.length + 1);
    }
    if (typeof item === 'boolean') return item ? 4 : 5;
    if (Array.isArray(item)) return 2 + item.reduce<number>((n, v) => n + size(v), 0) + Math.max(0, item.length - 1) * 2;
    const entries = Object.entries(item as Record<string, unknown>);
    return 2 + entries.reduce((n, [k, v]) => n + size(k) + 2 + size(v), 0) + Math.max(0, entries.length - 1) * 2;
  }
  return size(normalized);
}
export function assertFrozenPayloads(context: unknown, billing: unknown): void {
  if (postgresJsonbBytes(context) > FROZEN_PAYLOAD_BYTES || postgresJsonbBytes(billing) > FROZEN_PAYLOAD_BYTES)
    throw new StagingAccessError('RUNTIME_FROZEN_PAYLOAD_TOO_LARGE');
}
