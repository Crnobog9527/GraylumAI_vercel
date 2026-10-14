/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { confirmConnect, providerPlatform, recordCallback, startConnect } from './connect';
import type { ClientDeps } from './postForMe/client';

const actor = '00000000-0000-4000-8000-0000000b0001';
const account = '00000000-0000-4000-8000-0000000b0002';
const request = '00000000-0000-4000-8000-0000000b0003';
const conn = '00000000-0000-4000-8000-0000000b0004';
const EXTERNAL = 'a'.repeat(32) + '.' + 'b'.repeat(32);

function rpc(results: Record<string, { data?: unknown; error?: { message: string } }>) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  return { calls, db: { rpc: async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    const r = results[name] ?? { error: { message: 'unexpected' } };
    return { data: r.data ?? null, error: r.error ?? null };
  } } as never };
}
function provider(responses: Array<Response>) {
  const urls: string[] = [];
  const bodies: unknown[] = [];
  const deps: ClientDeps = { apiKey: 'pfm_live_TESTKEY0000000000000000', limiter: { acquire: async () => ({ ok: true }) },
    fetchImpl: async (url, init) => {
      urls.push(url); bodies.push(init.body ? JSON.parse(String(init.body)) : null);
      return responses.shift() ?? new Response('{}', { status: 500 });
    } };
  return { deps, urls, bodies };
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

describe('publish-monitor connect flow', () => {
  it('only connects brand platforms whose names match the provider exactly', () => {
    expect(providerPlatform('x')).toBe('x');
    expect(providerPlatform('twitter')).toBeNull();
    expect(providerPlatform('xiaohongshu')).toBeNull();
  });

  it('records the attempt before asking for a read-only link', async () => {
    const db = rpc({ publish_monitor_connect_start: { data: { requestId: request, externalId: EXTERNAL, platform: 'youtube',
      permissions: ['feeds'] } } });
    const p = provider([json(201, { url: 'https://accounts.google.com/o' })]);
    const result = await startConnect(db.db, p.deps, actor, { accountProjectId: account, publish: false });
    expect(result).toEqual({ requestId: request, url: 'https://accounts.google.com/o', combinedAuthorization: false });
    expect(db.calls).toEqual([{ name: 'publish_monitor_connect_start',
      args: { a: actor, p_account_project_id: account, p_permissions: ['feeds'] } }]);
    expect(p.bodies[0]).toMatchObject({ platform: 'youtube', external_id: EXTERNAL, permissions: ['feeds'] });
    expect((p.bodies[0] as { force_reauth?: boolean }).force_reauth).toBeUndefined();
  });

  it('adds publishing only with a forced re-authorisation, and maps database refusals', async () => {
    const db = rpc({ publish_monitor_connect_start: { data: { requestId: request, externalId: EXTERNAL, platform: 'x',
      permissions: ['feeds', 'posts'] } } });
    const p = provider([json(201, { url: 'https://x.com/i/oauth2' })]);
    await startConnect(db.db, p.deps, actor, { accountProjectId: account, publish: true });
    expect(db.calls[0]!.args.p_permissions).toEqual(['feeds', 'posts']);
    expect(p.bodies[0]).toMatchObject({ permissions: ['feeds', 'posts'], force_reauth: true });
    const missing = rpc({ publish_monitor_connect_start: { error: { message: 'PUBLISH_MONITOR_ACCOUNT_NOT_FOUND' } } });
    await expect(startConnect(missing.db, provider([]).deps, actor, { accountProjectId: account, publish: false }))
      .rejects.toThrow('PUBLISH_MONITOR_ACCOUNT_NOT_FOUND');
    const odd = rpc({ publish_monitor_connect_start: { data: { requestId: request, externalId: EXTERNAL,
      platform: 'xiaohongshu', permissions: ['feeds'] } } });
    await expect(startConnect(odd.db, provider([]).deps, actor, { accountProjectId: account, publish: false }))
      .rejects.toThrow('PUBLISH_MONITOR_PLATFORM_UNSUPPORTED');
  });

  it('re-reads every hinted account from the provider and never trusts the callback query', async () => {
    const db = rpc({ publish_monitor_connect_callback: { data: { requestId: request, platform: 'facebook',
      newAccounts: ['spc_new'], ownExisting: [], quarantined: [], ignored: ['spc_other'] } } });
    const p = provider([
      json(200, { id: 'spc_new', platform: 'facebook', status: 'connected', external_id: EXTERNAL }),
      json(200, { id: 'spc_other', platform: 'facebook', status: 'connected', external_id: 'c'.repeat(32) + '.' + 'd'.repeat(32) }),
      json(404, {}),
      json(200, { id: 'spc_off', platform: 'facebook', status: 'disconnected', external_id: EXTERNAL }),
    ]);
    const result = await recordCallback(db.db, p.deps, actor, request,
      ['spc_new', 'spc_other', 'spc_gone', 'spc_off', '../x', 'spc_new']);
    expect(p.urls.map(u => u.split('/').pop())).toEqual(['spc_new', 'spc_other', 'spc_gone', 'spc_off']);
    expect(db.calls[0]!.args.p_candidates).toEqual([
      { providerAccountId: 'spc_new', platform: 'facebook', externalId: EXTERNAL },
      { providerAccountId: 'spc_other', platform: 'facebook', externalId: 'c'.repeat(32) + '.' + 'd'.repeat(32) },
    ]);
    expect(result.newAccounts).toEqual(['spc_new']);
    const busy = provider([json(429, {})]);
    await expect(recordCallback(rpc({}).db, busy.deps, actor, request, ['spc_new'])).rejects.toThrow('PUBLISH_MONITOR_PROVIDER_BUSY');
  });

  it('re-reads the picked account and passes its current facts for the database to check', async () => {
    const live = () => json(200, { id: 'spc_1', platform: 'facebook', status: 'connected', external_id: EXTERNAL });
    const db = rpc({ publish_monitor_connect_confirm: { data: { connectionId: conn, unselected: ['spc_2'] } } });
    expect(await confirmConnect(db.db, provider([live()]).deps, actor, request, 'spc_1', true))
      .toEqual({ connectionId: conn, unselected: ['spc_2'] });
    expect(db.calls[0]!.args).toEqual({ a: actor, p_request_id: request, p_provider_account_id: 'spc_1', p_auto_track: true,
      p_current: { providerAccountId: 'spc_1', platform: 'facebook', externalId: EXTERNAL, status: 'connected' } });
    const changed = rpc({ publish_monitor_connect_confirm: { error: { message: 'PUBLISH_MONITOR_AUTHORIZATION_CHANGED' } } });
    await expect(confirmConnect(changed.db, provider([live()]).deps, actor, request, 'spc_1', false))
      .rejects.toThrow('PUBLISH_MONITOR_AUTHORIZATION_CHANGED');
    await expect(confirmConnect(rpc({}).db, provider([json(404, {})]).deps, actor, request, 'spc_1', false))
      .rejects.toThrow('PUBLISH_MONITOR_AUTHORIZATION_CHANGED');
    await expect(confirmConnect(rpc({}).db, provider([]).deps, actor, request, 'a/b', false)).rejects.toThrow();
  });
});
