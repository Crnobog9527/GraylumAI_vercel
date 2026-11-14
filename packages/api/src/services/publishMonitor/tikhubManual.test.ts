/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const readTikhubClaim = vi.fn();
vi.mock('./tikhubRefresh', () => ({ readTikhubClaim: (...args: unknown[]) => readTikhubClaim(...args) }));
const { DataError } = await import('./data');
const { manualTikhubRead } = await import('./tikhubManual');

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const claim = { connectionId: uuid(1), actorId: uuid(9), businessId: uuid(2), role: 'own', lease: uuid(3), refreshId: uuid(4),
  platform: 'douyin', account: 'ref', knownPosts: 0 };

function db(claimed: { data?: unknown; error?: { message: string } | null } = { data: claim, error: null }) {
  const rpc = vi.fn(async (name: string) => name === 'publish_monitor_tikhub_request' ? { data: claimed.data ?? null, error: claimed.error ?? null }
    : { data: true, error: null });
  return { rpc } as unknown as SupabaseClient & { rpc: typeof rpc };
}

describe('读取最新帖子: one manual billed TikHub read of an own account (VOICE-2)', () => {
  beforeEach(() => readTikhubClaim.mockReset());
  it('claims the connection for the signed-in account and runs the daily job\'s billed read on that claim', async () => {
    readTikhubClaim.mockResolvedValue({ outcome: 'read', fetched: true });
    const client = db();
    expect(await manualTikhubRead(client, {}, uuid(9), { connectionId: uuid(1) })).toEqual({ outcome: 'read' });
    expect(client.rpc).toHaveBeenCalledWith('publish_monitor_tikhub_request', { a: uuid(9), p_connection_id: uuid(1), p_lease_seconds: 300 });
    expect(readTikhubClaim.mock.calls[0]![2]).toEqual(claim);
  });
  it('a read with no posts list (supplier failed, nothing charged for it) is "not fetched"; a stale claim too', async () => {
    readTikhubClaim.mockResolvedValueOnce({ outcome: 'read', fetched: false }).mockResolvedValueOnce({ outcome: 'stale', fetched: false })
      .mockResolvedValueOnce({ outcome: 'failed', fetched: false });
    for (let i = 0; i < 3; i += 1) expect(await manualTikhubRead(db(), {}, uuid(9), { connectionId: uuid(1) })).toEqual({ outcome: 'not_fetched' });
  });
  it('balance too low or reads unavailable: the hour is given back for this claim only', async () => {
    for (const outcome of ['insufficient_credits', 'unavailable'] as const) {
      readTikhubClaim.mockImplementationOnce(async (_db, _deps, _claim, onNothingNew: () => Promise<unknown>) => {
        await onNothingNew(); return { outcome, fetched: false };
      });
      const client = db();
      expect(await manualTikhubRead(client, {}, uuid(9), { connectionId: uuid(1) })).toEqual({ outcome });
      expect(client.rpc).toHaveBeenCalledWith('publish_monitor_tikhub_request_undo', { a: uuid(9), p_connection_id: uuid(1),
        p_lease: uuid(3), p_refresh_id: uuid(4) });
    }
  });
  it('the claim\'s refusals reach the page as their codes; nothing is read', async () => {
    for (const code of ['PUBLISH_MONITOR_REFRESH_TOO_SOON', 'PUBLISH_MONITOR_REFRESH_RUNNING', 'PUBLISH_MONITOR_REFRESH_UNAVAILABLE',
      'PUBLISH_MONITOR_CONNECTION_NOT_FOUND']) {
      const refused = manualTikhubRead(db({ error: { message: code } }), {}, uuid(9), { connectionId: uuid(1) });
      await expect(refused).rejects.toBeInstanceOf(DataError);
      await expect(refused).rejects.toThrow(code);
    }
    expect(readTikhubClaim).not.toHaveBeenCalled();
  });
});
