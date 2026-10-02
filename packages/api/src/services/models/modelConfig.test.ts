/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { mergeConnectionState, withStoredManagedKeys } from './modelConfig';

const pricing = { fetchedAt: '2026-10-02T00:00:00.000Z', pricingHash: 'a'.repeat(64) };

describe('withStoredManagedKeys', () => {
  it('drops a client-sent price snapshot and keeps the stored one', () => {
    expect(withStoredManagedKeys({ connection_status: 'ok', pricing: { forged: true } }, { pricing, reasoning: { route: 'x' } }))
      .toEqual({ connection_status: 'ok', pricing, reasoning: { route: 'x' } });
    expect(withStoredManagedKeys({ pricing: { forged: true }, reasoning: { forged: true } }, {})).toEqual({});
  });
});

/** A one-row ai_models table whose writes are conditional on updated_at. */
function table(config: Record<string, unknown>, changeBeforeWrites = 0) {
  let stored = config, version = 1, pending = changeBeforeWrites;
  const writes: Array<Record<string, unknown>> = [];
  const db = { from: () => ({
    select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { config: stored, updated_at: `v${version}` }, error: null }) }) }),
    update(payload: { config: Record<string, unknown> }) {
      const filters: Record<string, unknown> = {};
      const builder = {
        eq(column: string, value: unknown) { filters[column] = value; return builder; },
        select: async () => {
          if (pending > 0) {
            // Another writer stores a new price snapshot between this read and this write.
            pending -= 1; version += 1; stored = { ...stored, pricing: { ...pricing, pricingHash: 'b'.repeat(64) } };
          }
          if (filters.updated_at !== `v${version}`) return { data: [], error: null };
          writes.push(payload.config); stored = payload.config; version += 1;
          return { data: [{ id: 'm' }], error: null };
        },
      };
      return builder;
    },
  }) };
  return { db, writes, stored: () => stored };
}

describe('mergeConnectionState', () => {
  it('writes only its own keys onto the latest config', async () => {
    const t = table({ pricing, connection_status: 'unknown' });
    await expect(mergeConnectionState(t.db as never, 'm', { connection_status: 'connected', last_error: null })).resolves.toBe(true);
    expect(t.stored()).toEqual({ pricing, connection_status: 'connected', last_error: null });
  });

  it('re-reads after a concurrent write and never rolls back the newer snapshot', async () => {
    const t = table({ pricing }, 1);
    await expect(mergeConnectionState(t.db as never, 'm', { connection_status: 'connected' })).resolves.toBe(true);
    expect(t.stored()).toMatchObject({ connection_status: 'connected', pricing: { pricingHash: 'b'.repeat(64) } });
  });

  it('skips the status after a second conflict instead of overwriting', async () => {
    const t = table({ pricing }, 2);
    await expect(mergeConnectionState(t.db as never, 'm', { connection_status: 'connected' })).resolves.toBe(false);
    expect(t.writes).toEqual([]);
  });
});
