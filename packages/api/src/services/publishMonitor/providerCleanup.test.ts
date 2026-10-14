/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { cleanupAttempts, runProviderWork, sweepOrphans } from './providerCleanup';
import type { ClientDeps } from './postForMe/client';

const EXT = 'a'.repeat(32) + '.' + 'b'.repeat(32);
const OTHER = 'c'.repeat(32) + '.' + 'd'.repeat(32);
const REQ = '00000000-0000-4000-8000-0000000a0001';
const CONN = '00000000-0000-4000-8000-0000000a0002';
const LEASE = '00000000-0000-4000-8000-0000000a0003';
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const acct = (id: string, external_id: string | null) => ({ id, platform: 'facebook', status: 'connected', external_id });
const page = (accounts: unknown[], offset: number, total: number) =>
  json(200, { data: accounts, meta: { total, offset, limit: 100 } });

function provider(responses: Response[]) {
  const calls: string[] = [];
  const deps: ClientDeps = { apiKey: 'pfm_test_FAKEKEY000000000000', limiter: { acquire: async () => ({ ok: true }) },
    fetchImpl: async (url, init) => {
      calls.push(`${init.method} ${url.replace(/^.*\/v1/, '')}`);
      return responses.shift() ?? new Response('{}', { status: 500 });
    } };
  return { deps, calls };
}
function database(results: Record<string, unknown[]>) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  return { calls, db: { rpc: async (name: string, args: Record<string, unknown>) => {
    calls.push([name, args]);
    const queue = results[name] ?? [];
    return { data: queue.length ? queue.shift() : null, error: null };
  } } as never };
}
const far = Date.now() + 60_000;

describe('publish-monitor provider cleanup', () => {
  it('lists every page before deleting, deletes only what the database marked and still carries the attempt', async () => {
    const d = database({
      publish_monitor_cleanup_claim: [[{ requestId: REQ, lease: LEASE, externalId: EXT, platform: 'facebook', candidateIds: [] }]],
      publish_monitor_cleanup_classify: [[{ providerAccountId: 'spc_1', action: 'delete' },
        { providerAccountId: 'spc_2', action: 'keep' }, { providerAccountId: 'spc_3', action: 'delete' }]],
    });
    const p = provider([page([acct('spc_1', EXT), acct('spc_2', EXT)], 0, 3), page([acct('spc_3', EXT)], 2, 3),
      json(200, acct('spc_1', EXT)), json(200, {}), json(200, acct('spc_3', OTHER))]);
    expect(await cleanupAttempts(d.db, p.deps, far)).toEqual({ processed: 1, settled: 1, deferred: 0 });
    expect(p.calls).toEqual([
      `GET /social-accounts?limit=100&offset=0&external_id=${encodeURIComponent(EXT)}`,
      `GET /social-accounts?limit=100&offset=2&external_id=${encodeURIComponent(EXT)}`,
      'GET /social-accounts/spc_1', 'DELETE /social-accounts/spc_1', 'GET /social-accounts/spc_3']);
    expect(d.calls.at(-1)).toEqual(['publish_monitor_cleanup_finish', { p_request_id: REQ, p_lease: LEASE, p_done: true, p_error: null }]);
  });

  it('a failed listing or deletion leaves the attempt for the next run', async () => {
    const d = database({ publish_monitor_cleanup_claim: [[{ requestId: REQ, lease: LEASE, externalId: EXT, platform: 'facebook',
      candidateIds: [] }]] });
    const p = provider([json(503, {})]);
    expect(await cleanupAttempts(d.db, p.deps, far)).toEqual({ processed: 1, settled: 0, deferred: 1 });
    expect(d.calls.map(c => c[0])).toEqual(['publish_monitor_cleanup_claim', 'publish_monitor_cleanup_finish']);
    expect(d.calls[1]![1]).toEqual({ p_request_id: REQ, p_lease: LEASE, p_done: false, p_error: 'PROVIDER_LIST_FAILED' });
  });

  it('provider work re-reads every account and acts only while the expected owner still holds it', async () => {
    const OWNER = 'c'.repeat(32);
    const mine = (id: string, status = 'connected') => json(200, { ...acct(id, `${OWNER}.${'e'.repeat(32)}`), status });
    const job = (id: string, deleting: boolean, action: string, ownerRef: string | null = OWNER, takeoverPending = false) =>
      ({ connectionId: CONN, lease: LEASE, providerAccountId: id, deleting, action, ownerRef, takeoverPending });
    const jobs = [
      job('spc_del', true, 'delete'), job('spc_gone', true, 'delete'), job('spc_reauthed', true, 'delete'),
      job('spc_hold', true, 'disconnect'), job('spc_back', false, 'disconnect'), job('spc_taken', false, 'disconnect'),
      job('spc_done', false, 'disconnect'), job('spc_denied', true, 'delete'), job('spc_noref', true, 'delete', null),
      job('spc_taken_then_deleted', true, 'delete', OWNER, true),
      job('spc_taken_held', true, 'disconnect', OWNER, true),
      job('spc_held_gone', true, 'disconnect'),
    ];
    const d = database({ publish_monitor_provider_work_claim: [jobs] });
    const p = provider([
      mine('spc_del'), json(200, {}),
      json(404, {}),
      json(200, acct('spc_reauthed', EXT)), json(200, {}),
      mine('spc_hold'), json(200, {}),
      mine('spc_back'),
      json(200, acct('spc_taken', EXT)), json(200, {}),
      json(200, { ...acct('spc_done', EXT), status: 'disconnected' }),
      mine('spc_denied'), json(403, {}),
      mine('spc_noref'),
      json(200, acct('spc_taken_then_deleted', EXT)), json(200, {}),
      json(200, acct('spc_taken_held', EXT)), json(200, {}),
      json(404, {}),
    ]);
    expect(await runProviderWork(d.db, p.deps, far)).toEqual({ processed: 12, settled: 10, deferred: 2 });
    expect(d.calls.slice(1).map(c => [c[1].p_outcome, c[1].p_error])).toEqual([['deleted', null], ['gone', null],
      ['owner_changed', null], ['disconnected', null], ['owner_back', null], ['disconnected', null], ['disconnected', null],
      ['retry', 'PROVIDER_REJECTED_403'], ['retry', 'OWNER_UNKNOWN'], ['owner_changed', null], ['disconnected', null],
      ['disconnected', null]]);
    // With unresolved publishes the record is held after the takeover disconnect, not ended.
    expect(p.calls).toContain('POST /social-accounts/spc_taken_held/disconnect');
    // A deletion record still owing a takeover disconnect clears the overwriting authorization before it ends.
    expect(p.calls).toContain('POST /social-accounts/spc_taken_then_deleted/disconnect');
    // An overwrite behind a deletion record is always disconnected (no other connection can hold that ID), never
    // deleted; nothing is touched for the owner's own re-authorisation, an already disconnected account, or an
    // unknown owner.
    expect(p.calls).toContain('POST /social-accounts/spc_reauthed/disconnect');
    expect(p.calls).not.toContain('DELETE /social-accounts/spc_reauthed');
    for (const id of ['spc_back', 'spc_done', 'spc_noref']) {
      expect(p.calls.filter(c => c.includes(id) && !c.startsWith('GET'))).toEqual([]);
    }
    expect(p.calls).toContain('POST /social-accounts/spc_hold/disconnect');
    expect(p.calls).not.toContain('DELETE /social-accounts/spc_hold');
  });

  it('orphan sweep only reports unless deletion is enabled, and never deletes unknown formats', async () => {
    const listing = () => [page([acct('spc_orphan', EXT), acct('spc_dash', null)], 0, 2)];
    const decision = { delete: ['spc_orphan'], unknownFormat: ['spc_dash'], takenOver: [] };
    const reportOnly = provider(listing());
    expect(await sweepOrphans(database({ publish_monitor_orphan_classify: [decision] }).db, reportOnly.deps, false, far))
      .toEqual({ listed: 2, orphans: 1, deleted: 0, unknownFormat: 1, deferred: 0, takenOver: 0 });
    expect(reportOnly.calls).toHaveLength(1);
    const enabled = provider([...listing(), json(200, acct('spc_orphan', EXT)), json(200, {})]);
    expect(await sweepOrphans(database({ publish_monitor_orphan_classify: [decision] }).db, enabled.deps, true, far))
      .toEqual({ listed: 2, orphans: 1, deleted: 1, unknownFormat: 1, deferred: 0, takenOver: 0 });
    expect(enabled.calls).not.toContain('DELETE /social-accounts/spc_dash');
  });

  it('the sweep starts no listing page after the deadline and decides nothing on a partial list', async () => {
    let t = 0;
    const p = provider([page([acct('spc_1', EXT)], 0, 300)]);
    const d = database({});
    expect(await sweepOrphans(d.db, p.deps, true, 10, () => (t += 6)))
      .toEqual({ listed: 0, orphans: 0, deleted: 0, unknownFormat: 0, deferred: 0, takenOver: 0, incomplete: true });
    expect(p.calls).toHaveLength(1);
    expect(d.calls).toEqual([]);
  });

  it('stops at the time budget and leaves the rest for the next run', async () => {
    const d = database({ publish_monitor_provider_work_claim: [[
      { connectionId: CONN, lease: LEASE, providerAccountId: 'spc_1', deleting: true, action: 'delete', ownerRef: null,
        takeoverPending: false }]] });
    expect(await runProviderWork(d.db, provider([]).deps, 0)).toEqual({ processed: 0, settled: 0, deferred: 0 });
    expect(d.calls).toEqual([]);
  });
});
