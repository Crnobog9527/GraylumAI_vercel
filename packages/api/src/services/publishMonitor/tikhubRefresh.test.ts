/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ read: vi.fn(), settleOpen: vi.fn(), apply: vi.fn() }));
vi.mock('./billedRead', () => ({ billedTikhubRead: mocks.read, settleLeftOpenRun: mocks.settleOpen }));
vi.mock('./tikhub', async original => ({ ...(await original<object>()), applyTikhubRead: mocks.apply }));
import { runTikhubRefresh } from './tikhubRefresh';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const claim = (n: number, role: 'own' | 'benchmark', actor = id(900)) => ({ connectionId: id(n), actorId: actor, businessId: id(800),
  role, lease: id(700), refreshId: id(600 + n), platform: 'xiaohongshu', account: '61b46d790000000010008153', knownPosts: 0 });
function db(batches: unknown[][]) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  return { calls, db: { rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
    calls.push([name, args]);
    if (name === 'publish_monitor_billed_orphans') return { data: [], error: null };
    if (name === 'publish_monitor_tikhub_claim') return { data: batches.shift() ?? [], error: null };
    return { data: true, error: null };
  }) } as never };
}
const outcomes = (calls: Array<[string, Record<string, unknown>]>) =>
  calls.filter(c => c[0] === 'publish_monitor_refresh_finish').map(c => c[1].p_outcome);
const posts = { vendor: 'tikhub', route: 'r', outcome: 'ok', reason: null, items: [] };

describe('publish-monitor daily TikHub step', () => {
  it('checks the entitlement per claim: own needs a data window, a benchmark needs Gold', async () => {
    mocks.read.mockResolvedValue({ kind: 'read', results: { account_posts: posts }, delivered: true });
    mocks.apply.mockResolvedValue(true);
    const d = db([[claim(1, 'own'), claim(2, 'benchmark')]]);
    const report = await runTikhubRefresh(d.db, { env: {} }, async () => ({ windowDays: 30, benchmark: false }), Date.now() + 60_000);
    expect(report.outcomes).toEqual({ read: 1, entitlement: 1 });
    expect(mocks.read).toHaveBeenCalledTimes(1);
  });

  it('a low balance settles as insufficient credits; an unavailable TikHub releases and stops the step', async () => {
    mocks.read.mockReset();
    mocks.read.mockResolvedValueOnce({ kind: 'insufficient_credits' }).mockResolvedValueOnce({ kind: 'unavailable', reason: 'X' });
    const d = db([[claim(1, 'own'), claim(2, 'own'), claim(3, 'own')], [claim(4, 'own')]]);
    const report = await runTikhubRefresh(d.db, { env: {} }, async () => ({ windowDays: 30, benchmark: true }), Date.now() + 60_000);
    expect(report.outcomes).toEqual({ insufficient_credits: 1, release: 2 });
    expect(d.calls.some(c => c[0] === 'publish_monitor_refresh_insufficient')).toBe(true);
    expect(d.calls.filter(c => c[0] === 'publish_monitor_tikhub_claim').length).toBe(1);
    expect(mocks.read).toHaveBeenCalledTimes(2);
  });

  it('an unreadable entitlement reads nothing and stops; a read without a post list is a failed read', async () => {
    mocks.read.mockReset();
    const d = db([[claim(1, 'own')]]);
    expect((await runTikhubRefresh(d.db, { env: {} }, async () => { throw new Error('down'); }, Date.now() + 60_000)).outcomes)
      .toEqual({ release: 1 });
    expect(mocks.read).not.toHaveBeenCalled();
    mocks.read.mockResolvedValue({ kind: 'read', results: {}, delivered: false });
    const e = db([[claim(1, 'own')]]);
    await runTikhubRefresh(e.db, { env: {} }, async () => ({ windowDays: 30, benchmark: true }), Date.now() + 60_000);
    expect(outcomes(e.calls)).toEqual(['failed']);
  });
});
