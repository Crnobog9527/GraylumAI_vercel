/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { boundRequestId, cleanupUnselected, describeCandidates, disconnectTakenOver } from './connectFlow';
import type { ClientDeps } from './postForMe/client';

const EXTERNAL = 'a'.repeat(32) + '.' + 'b'.repeat(32);
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
function provider(responses: Response[]) {
  const urls: string[] = [];
  const deps: ClientDeps = { apiKey: 'pfm_test_FAKEKEY000000000000', limiter: { acquire: async () => ({ ok: true }) },
    fetchImpl: async url => { urls.push(url); return responses.shift() ?? new Response('{}', { status: 500 }); } };
  return { deps, urls };
}
const acct = (id: string, extra: Record<string, unknown> = {}) =>
  json(200, { id, platform: 'facebook', status: 'connected', external_id: EXTERNAL, ...extra });

describe('publish-monitor connect flow helpers', () => {
  it('reads the attempt id only from the exact cookie name', () => {
    const id = '00000000-0000-4000-8000-0000000e0001';
    expect(boundRequestId(`a=1; graylum_pm_connect=${id}`)).toBe(id);
    expect(boundRequestId(`xgraylum_pm_connect=${id}`)).toBeNull();
    expect(boundRequestId('graylum_pm_connect=not-a-uuid')).toBeNull();
    expect(boundRequestId(null)).toBeNull();
  });

  it('cleanup stops at the first provider outage and defers the rest to the sweep', async () => {
    const p = provider([acct('spc_1'), json(200, {}), json(503, {})]);
    expect(await cleanupUnselected(p.deps, EXTERNAL, ['spc_1', 'spc_2', 'spc_3', 'spc_4']))
      .toEqual({ deleted: ['spc_1'], kept: [], deferred: ['spc_2', 'spc_3', 'spc_4'] });
    expect(p.urls).toHaveLength(3);
  });

  it('cleanup defers everything once its time budget is used', async () => {
    let t = 0;
    const p = provider([acct('spc_1'), json(200, {})]);
    const result = await cleanupUnselected(p.deps, EXTERNAL, ['spc_1', 'spc_2'], () => (t += 30_000));
    expect(result).toEqual({ deleted: ['spc_1'], kept: [], deferred: ['spc_2'] });
  });

  it('takeover disconnect re-reads first and clears only an authorization still carrying this attempt', async () => {
    const mine = () => json(200, { id: 'spc_1', platform: 'facebook', status: 'connected', external_id: EXTERNAL });
    const one = [{ id: 'spc_1', externalId: EXTERNAL }];
    const ok = provider([mine(), json(200, {})]);
    expect(await disconnectTakenOver(ok.deps, one)).toEqual({ pending: 0 });
    expect(ok.urls.map(u => u.replace(/^.*\/v1/, ''))).toEqual(['/social-accounts/spc_1', '/social-accounts/spc_1/disconnect']);
    // The original owner re-authorized in between: nothing is revoked.
    const back = provider([json(200, { id: 'spc_1', platform: 'facebook', status: 'connected',
      external_id: 'c'.repeat(32) + '.' + 'd'.repeat(32) })]);
    expect(await disconnectTakenOver(back.deps, one)).toEqual({ pending: 0 });
    expect(back.urls).toHaveLength(1);
    expect(await disconnectTakenOver(provider([json(404, {})]).deps, one)).toEqual({ pending: 0 });
    expect(await disconnectTakenOver(provider([mine(), json(403, {})]).deps, one)).toEqual({ pending: 1 });
    expect(await disconnectTakenOver(provider([mine(), json(401, {})]).deps, one)).toEqual({ pending: 1 });
    // Cannot verify (outage): stop and leave the rest pending.
    const down = provider([json(503, {})]);
    expect(await disconnectTakenOver(down.deps, [...one, { id: 'spc_2', externalId: EXTERNAL }])).toEqual({ pending: 2 });
    expect(down.urls).toHaveLength(1);
  });

  it('names stop after the first provider problem; the page still loads with account IDs', async () => {
    const pending = { requestId: '00000000-0000-4000-8000-0000000e0002', platform: 'facebook', permissions: ['feeds' as const],
      confirmExpiresAt: 'x', target: { accountProjectId: '00000000-0000-4000-8000-0000000e0003', platform: 'facebook',
        accountKey: 'k', businessName: null },
      candidates: ['spc_1', 'spc_2', 'spc_3'].map(id => ({ providerAccountId: id, kind: 'new' as const })) };
    const p = provider([acct('spc_1', { username: 'one' }), json(503, {})]);
    expect((await describeCandidates(p.deps, pending)).map(c => c.username)).toEqual(['one', null, null]);
    expect(p.urls).toHaveLength(2);
  });
});
