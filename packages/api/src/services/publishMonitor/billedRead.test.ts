/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

const policy = (route: string) => ({ provider: 'tikhub', account: 'tikhub-main', model: `tikhub:${route}`, protocol: 'research-tool-v1',
  modelId: createHash('md5').update(`bill2-research-tool:tikhub:${route}`).digest('hex')
    .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5'), multiplier: '6', lookupSupported: false,
  upperUsd: '0.01', purposes: ['publish_monitor'], toolPricing: { unit: 'call', currency: 'USD', price: '0.01', unitsPerPrice: '1',
    usdPerCurrency: null, entryHash: 'e'.repeat(64), validUntil: '2099-01-01T00:00:00.000Z', maxUnitsPerCall: '1' } });
const PROFILE = '/xiaohongshu/app_v2/get_user_info';
const POSTS = '/xiaohongshu/app_v2/get_user_posted_notes';
const mocks = vi.hoisted(() => ({ tools: { enabled: true, tikhub: true } }));
vi.mock('../research/vendors/config', async original => ({ ...(await original<object>()), readResearchToolsConfig: async () => ({ config: { enabled: mocks.tools.enabled,
  vendors: { tikhub: { enabled: mocks.tools.tikhub } } } }) }));
vi.mock('../runtime/stagingPolicy', async original => ({ ...(await original<object>()), loadStagingPolicy: async () => ({ id: '00000000-0000-4000-8000-0000000000aa',
  callPolicies: [], creditsPerUsd: '100', multiplier: '6', expiresAt: '2099-01-01T00:00:00.000Z',
  toolPolicies: [policy(PROFILE), policy(POSTS)] }) }));
vi.mock('../runtime/billingUnitAdmission', async original => ({ ...(await original<object>()), freezeWindowBillingUnit: async () => ({ version: 'bill-unit-v2',
  creditsPerUsd: '100', defaultMultiplier: '6', models: {}, providers: {}, hash: 'f'.repeat(64) }) }));
vi.mock('../billingProviderPrices', async original => ({ ...(await original<object>()), readProviderPrices: async () => ({ config: { entries: [] } }), resolveProviderPrice: () => ({}) }));
vi.mock('../bill2/toolBilling', async original => ({ ...(await original<object>()),
  toolCallPolicy: (input: { route: string }) => policy(input.route) }));
import { billedTikhubRead } from './billedRead';
import type { ResearchCallResult } from '../research/vendors/types';

const keys = { connectionId: '00000000-0000-4000-8000-0000000000c1', actorId: '00000000-0000-4000-8000-0000000000a1',
  lease: '00000000-0000-4000-8000-0000000000b1', refreshId: '00000000-0000-4000-8000-0000000000d1' };
const RUN = '00000000-0000-4000-8000-0000000000e1';
const XHS = '61b46d790000000010008153';
const answer = (route: string): ResearchCallResult => ({ vendor: 'tikhub', route, outcome: 'ok', reason: null, httpStatus: 200,
  supplierMayCharge: true, usage: { unit: 'call', units: '1' }, items: [{ fields: { id: 'n1', likes: 3 }, missing: ['views'] }],
  truncated: false, fetchedAt: '2026-10-17T00:00:00.000Z' });

function admin(opts: { stored?: Record<string, ResearchCallResult>; open?: { runId: string; policies: unknown[] };
  recovery?: Array<Record<string, unknown>>; claimState?: string } = {}) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  let claims = 0;
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    calls.push([name, args]);
    const ok = (data: unknown) => ({ data, error: null });
    switch (name) {
      case 'publish_monitor_billed_run':
        if (args.p_run_id) return ok({ runId: args.p_run_id, policies: [] });
        return ok(opts.open ?? { runId: null });
      case 'publish_monitor_billed_lookup': {
        const hit = Object.values(opts.stored ?? {}).length ? opts.stored : undefined;
        const found = hit && Object.entries(hit).find(([route]) => calls.filter(c => c[0] === name).length === 1 ? route === PROFILE : route === POSTS);
        return ok(found ? { stale: false, found: true, state: 'answered', result: found[1] } : { stale: false, found: false });
      }
      case 'publish_monitor_billed_recovery': return ok(opts.recovery ?? []);
      case 'publish_monitor_billed_abandon': return ok(true);
      case 'publish_monitor_billed_step': return ok({ ok: true });
      case 'publish_monitor_billed_closed': return ok(null);
      case 'bill2_create_draft': return ok('00000000-0000-4000-8000-0000000000f1');
      case 'bill2_prepare': return ok({ id: RUN });
      case 'bill2_claim':
        claims += 1;
        return ok(opts.claimState === 'waiting_credits' ? { state: 'waiting_credits' }
          : { id: `00000000-0000-4000-8000-00000000010${claims}`, state: 'prepared', dispatchToken: '00000000-0000-4000-8000-000000000201' });
      case 'bill2_dispatch': return ok({ dispatch: true });
      case 'bill2_record': return ok({});
      case 'bill2_close': case 'bill2_finalize': return ok({});
      default: return { data: null, error: { message: `unexpected ${name}` } };
    }
  });
  const from = () => ({ select() { return this; }, eq() { return this; },
    maybeSingle: async () => ({ data: { value: { thresholds: [{ model: `tikhub:${PROFILE}`, purpose: 'publish_monitor' },
      { model: `tikhub:${POSTS}`, purpose: 'publish_monitor' }] } }, error: null }) });
  return { calls, db: { rpc, from } as never };
}
const vendors = (seen: string[]) => ({ tikhub: async (call: { kind: string }) => { seen.push(call.kind);
  return answer(call.kind === 'account_profile' ? PROFILE : POSTS); } }) as never;
const deps = (db: never, seen: string[] = []) => ({ admin: db, env: {}, vendors: vendors(seen), secrets: async () => 'key',
  rateCounter: async () => true });
const names = (calls: Array<[string, unknown]>) => calls.map(c => c[0]);

describe('publish-monitor billed TikHub read', () => {
  it('bills each request once on a tool-only run and always closes the run', async () => {
    const a = admin(), seen: string[] = [];
    const read = await billedTikhubRead(deps(a.db, seen), keys, 'xiaohongshu', XHS);
    expect(read).toMatchObject({ kind: 'read', delivered: true });
    expect(seen).toEqual(['account_profile', 'account_posts']);
    const prepared = a.calls.find(c => c[0] === 'bill2_prepare')![1].p_payload as Record<string, unknown>;
    expect(prepared).toMatchObject({ contractVersion: 'bill2.v2', mode: 'staging_test', input: { publishMonitor: keys.connectionId ? expect.any(Object) : null } });
    expect((prepared.callPolicy as unknown[]).every(p => (p as { protocol: string }).protocol === 'research-tool-v1')).toBe(true);
    expect(a.calls.filter(c => c[0] === 'bill2_claim').map(c => c[1].p_sequence)).toEqual([1, 2]);
    expect(names(a.calls).slice(-3)).toEqual(['bill2_close', 'bill2_finalize', 'publish_monitor_billed_closed']);
    expect(a.calls.find(c => c[0] === 'bill2_close')![1].p_outcome).toBe('delivered');
  });

  it('re-applies stored answers of the same refresh without any new run, claim or supplier call', async () => {
    const a = admin({ stored: { [PROFILE]: answer(PROFILE), [POSTS]: answer(POSTS) } }), seen: string[] = [];
    const read = await billedTikhubRead(deps(a.db, seen), keys, 'xiaohongshu', XHS);
    expect(read).toMatchObject({ kind: 'read', delivered: false });
    expect(seen).toEqual([]);
    expect(names(a.calls).some(n => n.startsWith('bill2_'))).toBe(false);
  });

  it('settles a run left open by a killed process before reading again: saved receipts replayed, the rest at zero', async () => {
    const saved = { toolOutcome: 'delivered', cost: '0.01' };
    const a = admin({ open: { runId: RUN, policies: [policy(POSTS)] }, recovery: [
      { operationId: '00000000-0000-4000-8000-000000000301', callId: '00000000-0000-4000-8000-000000000302',
        model: `tikhub:${POSTS}`, callPending: true, live: true, receipt: null },
      { operationId: '00000000-0000-4000-8000-000000000303', callId: '00000000-0000-4000-8000-000000000304',
        model: `tikhub:${POSTS}`, callPending: true, live: false, receipt: saved },
      { operationId: '00000000-0000-4000-8000-000000000305', callId: null, model: `tikhub:${POSTS}`, callPending: false,
        live: true, receipt: null }] });
    await billedTikhubRead(deps(a.db), keys, 'xiaohongshu', XHS);
    const records = a.calls.filter(c => c[0] === 'bill2_record').slice(0, 2).map(c => (c[1].p_evidence as { toolOutcome: string }).toolOutcome);
    expect(records).toEqual(['unknown', 'delivered']);
    expect(a.calls.filter(c => c[0] === 'publish_monitor_billed_abandon').map(c => c[1].p_operation_id))
      .toEqual(['00000000-0000-4000-8000-000000000301', '00000000-0000-4000-8000-000000000305']);
    const order = names(a.calls);
    expect(a.calls.find(c => c[0] === 'bill2_close')![1].p_outcome).toBe('delivered');
    expect(order.indexOf('bill2_finalize')).toBeLessThan(order.indexOf('bill2_prepare'));
  });

  it('a balance too low for the next call stops with nothing sent, and the run is still closed', async () => {
    const a = admin({ claimState: 'waiting_credits' }), seen: string[] = [];
    expect(await billedTikhubRead(deps(a.db, seen), keys, 'xiaohongshu', XHS)).toEqual({ kind: 'insufficient_credits' });
    expect(seen).toEqual([]);
    expect(a.calls.find(c => c[0] === 'bill2_close')![1].p_outcome).toBe('cancelled');
  });

  it('TikHub switched off: nothing is prepared, held or read', async () => {
    mocks.tools.tikhub = false;
    const a = admin(), seen: string[] = [];
    expect(await billedTikhubRead(deps(a.db, seen), keys, 'xiaohongshu', XHS)).toEqual({ kind: 'unavailable', reason: 'TIKHUB_NOT_ADMITTED' });
    expect(names(a.calls).some(n => n.startsWith('bill2_'))).toBe(false);
    mocks.tools.tikhub = true;
  });
});
