/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { cleanupAttempts, runProviderWork, sweepOrphans } from './providerCleanup';
import type { ClientDeps } from './postForMe/client';

const EXT = 'a'.repeat(32) + '.' + 'b'.repeat(32);
const OTHER = 'c'.repeat(32) + '.' + 'd'.repeat(32);
const REQ = '00000000-0000-4000-8000-0000000a0001';
const CONN = '00000000-0000-4000-8000-0000000a0002';
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
      publish_monitor_cleanup_claim: [[{ requestId: REQ, externalId: EXT, platform: 'facebook', candidateIds: [] }]],
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
    expect(d.calls.at(-1)).toEqual(['publish_monitor_cleanup_finish', { p_request_id: REQ, p_done: true, p_error: null }]);
  });

  it('a failed listing or deletion leaves the attempt for the next run', async () => {
    const d = database({ publish_monitor_cleanup_claim: [[{ requestId: REQ, externalId: EXT, platform: 'facebook',
      candidateIds: [] }]] });
    const p = provider([json(503, {})]);
    expect(await cleanupAttempts(d.db, p.deps, far)).toEqual({ processed: 1, settled: 0, deferred: 1 });
    expect(d.calls.map(c => c[0])).toEqual(['publish_monitor_cleanup_claim', 'publish_monitor_cleanup_finish']);
    expect(d.calls[1]![1]).toEqual({ p_request_id: REQ, p_done: false, p_error: 'PROVIDER_LIST_FAILED' });
  });

  it('provider work: deletes, treats 404 as gone, keeps an owner\'s fresh grant, retries refusals', async () => {
    const jobs = [
      { connectionId: CONN, providerAccountId: 'spc_del', action: 'delete', ownerRef: null },
      { connectionId: CONN, providerAccountId: 'spc_gone', action: 'delete', ownerRef: null },
      { connectionId: CONN, providerAccountId: 'spc_back', action: 'disconnect', ownerRef: 'c'.repeat(32) },
      { connectionId: CONN, providerAccountId: 'spc_taken', action: 'disconnect', ownerRef: 'c'.repeat(32) },
      { connectionId: CONN, providerAccountId: 'spc_denied', action: 'delete', ownerRef: null },
    ];
    const d = database({ publish_monitor_provider_work_claim: [jobs] });
    const p = provider([json(200, {}), json(404, {}), json(200, acct('spc_back', OTHER)),
      json(200, acct('spc_taken', EXT)), json(200, {}), json(403, {})]);
    expect(await runProviderWork(d.db, p.deps, far)).toEqual({ processed: 5, settled: 4, deferred: 1 });
    expect(d.calls.slice(1).map(c => [c[1].p_outcome, c[1].p_error])).toEqual([['deleted', null], ['gone', null],
      ['owner_back', null], ['disconnected', null], ['retry', 'PROVIDER_REJECTED_403']]);
    expect(p.calls).not.toContain('POST /social-accounts/spc_back/disconnect');
  });

  it('orphan sweep only reports unless deletion is enabled, and never deletes unknown formats', async () => {
    const listing = () => [page([acct('spc_orphan', EXT), acct('spc_dash', null)], 0, 2)];
    const decision = { delete: ['spc_orphan'], unknownFormat: ['spc_dash'] };
    const reportOnly = provider(listing());
    expect(await sweepOrphans(database({ publish_monitor_orphan_classify: [decision] }).db, reportOnly.deps, false, far))
      .toEqual({ listed: 2, orphans: 1, deleted: 0, unknownFormat: 1, deferred: 0 });
    expect(reportOnly.calls).toHaveLength(1);
    const enabled = provider([...listing(), json(200, acct('spc_orphan', EXT)), json(200, {})]);
    expect(await sweepOrphans(database({ publish_monitor_orphan_classify: [decision] }).db, enabled.deps, true, far))
      .toEqual({ listed: 2, orphans: 1, deleted: 1, unknownFormat: 1, deferred: 0 });
    expect(enabled.calls).not.toContain('DELETE /social-accounts/spc_dash');
  });

  it('stops at the time budget and leaves the rest for the next run', async () => {
    const d = database({ publish_monitor_provider_work_claim: [[
      { connectionId: CONN, providerAccountId: 'spc_1', action: 'delete', ownerRef: null }]] });
    expect(await runProviderWork(d.db, provider([]).deps, 0)).toEqual({ processed: 0, settled: 0, deferred: 0 });
  });
});
