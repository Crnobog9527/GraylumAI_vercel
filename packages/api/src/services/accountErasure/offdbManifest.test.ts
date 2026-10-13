/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import {
  ERASURE_MANIFEST_TTL_SECONDS, manifestEntry, manifestRedisFromEnv, scheduleErasureManifestSync, syncErasureManifest,
} from './offdbManifest';

const profile = '00000000-0000-4000-8000-000000000001';
const target = '00000000-0000-4000-8000-000000000002';
const now = Date.parse('2026-10-12T00:00:00.000Z');
const row = (n: number, kind = 'answer', confirmedAt = '2026-10-11T08:00:00.123456+00:00') => ({
  id: `00000000-0000-4000-8000-${String(100 + n).padStart(12, '0')}`, kind,
  targetId: n === 0 ? target : `00000000-0000-4000-9000-${String(n).padStart(12, '0')}`, profileId: profile, confirmedAt,
});
type Response = { data: unknown; error: { message?: string } | null };
function database(batches: unknown[][], extra: Record<string, Response> = {}) {
  const queue = [...batches];
  const rpc = vi.fn((name: string, args: Record<string, unknown>): Promise<Response> => {
    if (extra[name]) return Promise.resolve(extra[name]);
    if (name === 'erasure_manifest_pending') return Promise.resolve({ data: queue.shift() ?? [], error: null });
    if (name === 'erasure_manifest_mark_synced') return Promise.resolve({ data: (args.ids as string[]).length, error: null });
    if (name === 'erasure_manifest_cleanup') return Promise.resolve({ data: 3, error: null });
    return Promise.resolve({ data: null, error: { message: 'unexpected' } });
  });
  return { rpc };
}
const marked = (db: ReturnType<typeof database>) => db.rpc.mock.calls
  .filter(([name]) => name === 'erasure_manifest_mark_synced').flatMap(([, args]) => args.ids as string[]);

describe('off-database erasure manifest sync', () => {
  it('writes IDs and times only, with SET NX and EXAT 35 days after confirmation', async () => {
    const db = database([[row(0)]]);
    const redis = { set: vi.fn().mockResolvedValue('OK') };
    expect(await syncErasureManifest(db, { redis, now: () => now })).toEqual({ ok: true, synced: 1, pending: 0, cleaned: 0 });
    const exat = Math.floor(Date.parse('2026-10-11T08:00:00.123Z') / 1000) + 35 * 86400;
    expect(redis.set).toHaveBeenCalledWith(`graylum:erasure-manifest:answer:${target}`, JSON.stringify({
      kind: 'answer', targetId: target, profileId: profile, confirmedAt: '2026-10-11T08:00:00.123456+00:00',
    }), { nx: true, exat });
    expect(ERASURE_MANIFEST_TTL_SECONDS).toBe(35 * 86400);
    expect(Object.keys(JSON.parse(manifestEntry(row(0) as never).value)).sort())
      .toEqual(['confirmedAt', 'kind', 'profileId', 'targetId']);
    expect(marked(db)).toEqual([row(0).id]);
  });

  it('treats an existing key (NX not set) as already synced and never extends it', async () => {
    const db = database([[row(0, 'library_document')]]);
    const redis = { set: vi.fn().mockResolvedValue(null) };
    expect((await syncErasureManifest(db, { redis, now: () => now })).ok).toBe(true);
    expect(redis.set.mock.calls[0][2]).toEqual(expect.objectContaining({ nx: true }));
    expect(marked(db)).toEqual([row(0).id]);
  });

  it('leaves rows unsynced and reports failure when Redis is missing or fails', async () => {
    const missing = database([[row(0)]]);
    expect(await syncErasureManifest(missing, { redis: null, now: () => now }))
      .toEqual({ ok: false, synced: 0, pending: 1, cleaned: 0 });
    expect(marked(missing)).toEqual([]);
    const failing = database([[row(0), row(1), row(2)]]);
    const redis = { set: vi.fn().mockResolvedValueOnce('OK').mockRejectedValueOnce(new Error('down')) };
    const result = await syncErasureManifest(failing, { redis, now: () => now });
    expect(result).toEqual({ ok: false, synced: 1, pending: 2, cleaned: 0 });
    expect(marked(failing)).toEqual([row(0).id]);
    expect(redis.set).toHaveBeenCalledTimes(2);
  });

  it('does not write already-expired rows but marks them done; cleanup runs on request', async () => {
    const db = database([[row(0, 'account', '2026-08-01T00:00:00+00:00')]]);
    const redis = { set: vi.fn() };
    expect(await syncErasureManifest(db, { redis, cleanup: true, now: () => now }))
      .toEqual({ ok: true, synced: 1, pending: 0, cleaned: 3 });
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('continues across full batches and stops on a short batch', async () => {
    const full = Array.from({ length: 100 }, (_, i) => row(i + 1));
    const db = database([full, [row(0)]]);
    const redis = { set: vi.fn().mockResolvedValue('OK') };
    expect((await syncErasureManifest(db, { redis, now: () => now })).synced).toBe(101);
    expect(db.rpc.mock.calls.filter(([name]) => name === 'erasure_manifest_pending')).toHaveLength(2);
  });

  it('never throws: a database error or malformed row is a reported failure', async () => {
    const broken = database([], { erasure_manifest_pending: { data: null, error: { message: 'private detail' } } });
    await expect(syncErasureManifest(broken, { redis: { set: vi.fn() }, cleanup: true }))
      .resolves.toEqual({ ok: false, synced: 0, pending: 0, cleaned: 3 });
    const malformed = database([[{ ...row(0), title: 'PRIVATE_TITLE' }]]);
    const redis = { set: vi.fn() };
    expect((await syncErasureManifest(malformed, { redis })).ok).toBe(false);
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('best-effort scheduling is skipped without Redis and swallows failures', async () => {
    const db = database([[row(0)]]);
    scheduleErasureManifestSync(db, null);
    expect(db.rpc).not.toHaveBeenCalled();
    const rejecting = { rpc: vi.fn(() => Promise.reject(new Error('down'))) };
    expect(() => scheduleErasureManifestSync(rejecting, { set: vi.fn() })).not.toThrow();
    await vi.waitFor(() => expect(rejecting.rpc).toHaveBeenCalled());
    expect(manifestRedisFromEnv({})).toBeNull();
  });
  it('reports a deadline-truncated run as incomplete instead of success', async () => {
    let clock = now;
    const db = database([[row(1), row(2)]]);
    const redis = { set: vi.fn(async () => { clock += 5_000; return 'OK'; }) };
    const result = await syncErasureManifest(db, { redis, now: () => clock, deadline: now + 1_000 });
    expect(result.ok).toBe(false);
    expect(marked(db)).toEqual([row(1).id]);
    expect(result.pending).toBe(1);
  });
});
