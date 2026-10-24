/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import { resolveTicketNumber } from './ticketReference';

function db(rows: Array<{ id: string }> | null, error: unknown = null) {
  const calls: Array<[string, ...unknown[]]> = [];
  const chain: Record<string, unknown> = {};
  for (const name of ['select', 'gte', 'lte', 'lt', 'eq']) chain[name] = (...args: unknown[]) => { calls.push([name, ...args]); return chain; };
  chain.limit = vi.fn(async (n: number) => { calls.push(['limit', n]); return { data: rows, error }; });
  return { client: { from: (table: string) => { calls.push(['from', table]); return chain; } } as never, calls };
}

describe('refund form ticket number lookup', () => {
  it('finds the one ticket created that UTC day whose ID starts with the number, never deleted ones', async () => {
    const f = db([{ id: '98e52e9d-97dc-4661-bac3-08feb4875650' }]);
    await expect(resolveTicketNumber(f.client, 'TK-20261023-98E52E')).resolves.toEqual({ ticketId: '98e52e9d-97dc-4661-bac3-08feb4875650' });
    expect(f.calls).toEqual([['from', 'tickets'], ['select', 'id'],
      ['gte', 'id', '98e52e00-0000-0000-0000-000000000000'], ['lte', 'id', '98e52eff-ffff-ffff-ffff-ffffffffffff'],
      ['gte', 'created_at', '2026-10-23T00:00:00.000Z'], ['lt', 'created_at', '2026-10-24T00:00:00.000Z'],
      ['eq', 'is_deleted', false], ['limit', 2]]);
  });

  it('accepts lower case and surrounding spaces', async () => {
    await expect(resolveTicketNumber(db([{ id: '98e52e9d-97dc-4661-bac3-08feb4875650' }]).client, '  tk-20261023-98e52e '))
      .resolves.toEqual({ ticketId: '98e52e9d-97dc-4661-bac3-08feb4875650' });
  });

  it('asks for the full ID instead of guessing when none or two tickets match', async () => {
    await expect(resolveTicketNumber(db([]).client, 'TK-20261023-98E52E')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(resolveTicketNumber(db([{ id: '98e52e9d-0000-4000-8000-000000000001' }, { id: '98e52e9d-0000-4000-8000-000000000002' }]).client,
      'TK-20261023-98E52E')).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('rejects malformed numbers before reading, and hides database errors', async () => {
    const f = db([]);
    for (const value of ['98e52e9d-97dc-4661-bac3-08feb4875650', 'TK-2026102-98E52E', 'TK-20261023-98E52', 'TK-20261023-98E52G'])
      await expect(resolveTicketNumber(f.client, value)).rejects.toThrow();
    expect(f.calls).toEqual([]);
    await expect(resolveTicketNumber(db(null, { message: 'private detail' }).client, 'TK-20261023-98E52E'))
      .rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });
});
