/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Plain field readers for payment audit metadata, moved out of payments.ts unchanged (code-size baseline).

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function getAuditNumber(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
