/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { it, expect, vi } from 'vitest';
import { inspectProviderBalances, recordProviderBalance } from './stopLossMonitor';
const now = new Date('2026-10-10T12:00:00Z');
function fixture(balance: string | null, createdAt = now.toISOString()) {
  const rpc = vi.fn(async () => ({ error: null }));
  const insert = vi.fn(async () => ({ error: null }));
  const q = { select() { return this; }, eq() { return this; }, order() { return this; }, insert,
    limit: async () => ({ data: [{ details: { balanceUsd: balance }, created_at: createdAt }], error: null }) };
  return { db: { from: () => q, rpc } as never, rpc, insert };
}
it.each([['0.999999999999', 'low'], ['1', 'low'], ['1.000000000001', 'ok'], [null, 'unknown']])(
  'compares exact provider balance %s at threshold', async (balance, status) => {
    const f = fixture(balance);
    const rows = await inspectProviderBalances(f.db, '1', now);
    expect(rows.every(v => v.status === status)).toBe(true);
    expect(f.rpc).toHaveBeenCalledTimes(status === 'ok' ? 0 : 5);
  });
it('expired balances are unknown rather than assumed sufficient', async () => {
  const f = fixture('1000', '2026-10-09T12:00:00Z');
  expect((await inspectProviderBalances(f.db, '1', now))[0]?.status).toBe('unknown');
});
it('records explicitly manual observation without any external request', async () => {
  const f = fixture('1');
  expect(await recordProviderBalance(f.db, { provider: 'openrouter', balanceUsd: '1' }))
    .toMatchObject({ source: 'admin_observation' });
  expect(f.insert).toHaveBeenCalledWith(expect.objectContaining({ run_type: 'manual' }));
});
