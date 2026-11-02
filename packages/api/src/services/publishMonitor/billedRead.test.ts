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
vi.mock('../turn/admission/admissionConfiguration', () => ({ readAdmissionConfiguration: async () => ({ error: null, data: [
  { key: 'core_path_v2', value: { enabled: true, decisionUpperUsd: '0.01', stopLoss: { limitUsd: 100, p: 4, poolSize: 16, uFastUsd: 1, uBigUsd: 5 } } },
  { key: 'billing_payg_start_thresholds', value: { version: '1', thresholds: [{ model: `tikhub:${PROFILE}`, purpose: 'publish_monitor', typicalUsd: '0.01' },
    { model: `tikhub:${POSTS}`, purpose: 'publish_monitor', typicalUsd: '0.01' }] } }] }) }));
vi.mock('../billingUnit', async original => ({ ...(await original<object>()), readMultiplierSnapshot: async () => ({ version: 'bill-unit-v2',
  creditsPerUsd: '100', defaultMultiplier: '6', models: {}, providers: {}, hash: 'f'.repeat(64) }) }));
vi.mock('../billingProviderPrices', async original => ({ ...(await original<object>()), readProviderPrices: async () => ({ config: { entries: [] } }), resolveProviderPrice: () => ({}),
  resolveProviderMultipliers: () => ({}) }));
vi.mock('../turn/provider/toolBilling', async original => ({ ...(await original<object>()),
  toolCallPolicy: (input: { route: string }) => policy(input.route) }));
import { billedTikhubRead } from './billedRead';
import type { ResearchCallResult } from '../research/vendors/types';

const keys = { connectionId: '00000000-0000-4000-8000-0000000000c1', actorId: '00000000-0000-4000-8000-0000000000a1',
  lease: '00000000-0000-4000-8000-0000000000b1', refreshId: '00000000-0000-4000-8000-0000000000d1' };
const RUN = '00000000-0000-4000-8000-0000000000e1';
const SESSION = '00000000-0000-4000-8000-0000000000f1';
const XHS = '61b46d790000000010008153';
const answer = (route: string): ResearchCallResult => ({ vendor: 'tikhub', route, outcome: 'ok', reason: null, httpStatus: 200,
  supplierMayCharge: true, usage: { unit: 'call', units: '1' }, items: [{ fields: { id: 'n1', likes: 3 }, missing: ['views'] }],
  truncated: false, fetchedAt: '2026-10-17T00:00:00.000Z' });

function admin(opts: { stored?: Record<string, ResearchCallResult>; open?: { runId: string; policies: unknown[] };
  recovery?: Array<Record<string, unknown>>; openError?: string; begin?: Record<string, unknown>; finishFails?: boolean; closed?: boolean } = {}) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const tomb = { sessionTombstoned: false, accountErasing: false, voiceSourceRevoked: false };
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
      case 'publish_monitor_billed_step':
        return opts.finishFails && args.p_step === 'finish' ? { data: null, error: { message: 'storage down' } } : ok({ ok: true });
      case 'publish_monitor_billed_closed': return ok(null);
      case 'publish_monitor_session': return ok(SESSION);
      case 'bill2_record': return ok({});
      case 'bill2_read': return ok({ closed: opts.closed === true });
      case 'bill2_close': return ok({});
      case 'bill2_finalize': return ok({ state: 'settled' });
      case 'turn_open':
        if (opts.openError) return { data: null, error: { message: opts.openError } };
        return ok({ turnId: 7, state: 'running', replay: false, reservedCredits: 14, reservedUsd: 0.02, history: [] });
      case 'turn_call_begin': return ok({ state: opts.begin?.paused ? 'paused' : 'running', ...tomb, ...opts.begin });
      case 'turn_call_record': return ok({ status: 'ok', creditsLow: false, ...tomb });
      case 'turn_close': return ok({ turnId: 7, closeKind: args.p_close_kind, chargedCredits: 7, absorbedCredits: 0, settlement: 'done', replay: false });
      default: return { data: null, error: { message: `unexpected ${name}` } };
    }
  });
  const raw = { rpc, from: () => ({ select() { return this; }, eq() { return this; }, maybeSingle: async () => ({ data: null, error: null }) }) };
  return { calls, raw, db: raw as never };
}
const vendors = (seen: string[]) => ({ tikhub: async (call: { kind: string }) => { seen.push(call.kind);
  return answer(call.kind === 'account_profile' ? PROFILE : POSTS); } }) as never;
const deps = (db: never, seen: string[] = []) => ({ admin: db, env: {}, vendors: vendors(seen), secrets: async () => 'key',
  rateCounter: async () => true });
const names = (calls: Array<[string, unknown]>) => calls.map(c => c[0]);
const of = (a: { calls: Array<[string, Record<string, unknown>]> }, name: string) => a.calls.filter(c => c[0] === name).map(c => c[1]);

describe('publish-monitor billed TikHub read (a kind=review turn)', () => {
  it('reads both requests in one paid tool call of one turn and always closes the turn', async () => {
    const a = admin(), seen: string[] = [];
    const read = await billedTikhubRead(deps(a.db, seen), keys, 'xiaohongshu', XHS);
    expect(read).toMatchObject({ kind: 'read', delivered: true });
    expect(seen).toEqual(['account_profile', 'account_posts']);
    const [opened] = of(a, 'turn_open');
    expect(opened).toMatchObject({ p_kind: 'review', p_session_id: SESSION });
    expect(opened!.p_policy).toMatchObject({ review: { mode: 'read', connectionId: keys.connectionId, refreshId: keys.refreshId },
      limits: { model: 2, paidTools: 1, freeTools: 0 }, modelUpperUsd: '0', minCredits: 6 });
    // One receipt row for the whole refresh: begin before the first request, record after the last.
    expect(of(a, 'turn_call_begin')).toHaveLength(1);
    expect(of(a, 'turn_call_begin')[0]).toMatchObject({ p_call_kind: 'tool', p_tool_name: 'publish_monitor_read', p_paid: true });
    expect(of(a, 'turn_call_record')).toHaveLength(1);
    expect(of(a, 'turn_call_record')[0]).toMatchObject({ p_status: 'ok' });
    // The receipt keeps no supplier content (the answers live only in the ledger, which a disconnect wipes).
    expect(JSON.parse(String(of(a, 'turn_call_record')[0]!.p_raw))).toEqual({ subcalls: 2 });
    expect(JSON.stringify(of(a, 'turn_call_record')[0])).not.toContain('n1');
    expect(names(a.calls).slice(-2)).toEqual(['turn_close', 'publish_monitor_billed_closed']);
    expect(of(a, 'turn_close')[0]).toMatchObject({ p_close_kind: 'completed', p_delivered: true });
    expect(names(a.calls).some(n => n.startsWith('bill2_'))).toBe(false);
    expect(of(a, 'publish_monitor_billed_run').find(args => args.p_run_id)).toMatchObject({ p_run_id: expect.any(String) });
  });

  it('re-applies stored answers of the same refresh without any new turn or supplier call', async () => {
    const a = admin({ stored: { [PROFILE]: answer(PROFILE), [POSTS]: answer(POSTS) } }), seen: string[] = [];
    const read = await billedTikhubRead(deps(a.db, seen), keys, 'xiaohongshu', XHS);
    expect(read).toMatchObject({ kind: 'read', delivered: false });
    expect(seen).toEqual([]);
    expect(names(a.calls).some(n => n.startsWith('turn_') || n === 'publish_monitor_session')).toBe(false);
  });

  it('frees a run left open by a killed process before reading again: its live attempts are abandoned, nothing is replayed', async () => {
    const a = admin({ open: { runId: RUN, policies: [policy(POSTS)] }, recovery: [
      { operationId: '00000000-0000-4000-8000-000000000301', live: true }, { operationId: '00000000-0000-4000-8000-000000000305', live: true }] });
    await billedTikhubRead(deps(a.db), keys, 'xiaohongshu', XHS);
    expect(of(a, 'publish_monitor_billed_abandon').map(args => args.p_operation_id))
      .toEqual(['00000000-0000-4000-8000-000000000301', '00000000-0000-4000-8000-000000000305']);
    expect(of(a, 'publish_monitor_billed_closed')[0]).toEqual({ p_run_id: RUN });
    const order = names(a.calls);
    expect(order.indexOf('publish_monitor_billed_closed')).toBeLessThan(order.indexOf('turn_open'));
  });

  it('a run left open on BILL2 before reads moved to turns is still settled there: saved receipts replayed, the rest at zero', async () => {
    const saved = { toolOutcome: 'delivered', cost: '0.01' };
    const a = admin({ open: { runId: RUN, policies: [policy(POSTS)], legacy: true } as never, recovery: [
      { operationId: '00000000-0000-4000-8000-000000000301', callId: '00000000-0000-4000-8000-000000000302',
        model: `tikhub:${POSTS}`, callPending: true, live: true, receipt: null },
      { operationId: '00000000-0000-4000-8000-000000000303', callId: '00000000-0000-4000-8000-000000000304',
        model: `tikhub:${POSTS}`, callPending: true, live: false, receipt: saved }] });
    await billedTikhubRead(deps(a.db), keys, 'xiaohongshu', XHS);
    expect(of(a, 'bill2_record').map(args => (args.p_evidence as { toolOutcome: string }).toolOutcome)).toEqual(['unknown', 'delivered']);
    expect(of(a, 'bill2_close')[0]).toMatchObject({ p_outcome: 'delivered' });
    expect(of(a, 'bill2_finalize')).toHaveLength(1);
    expect(of(a, 'publish_monitor_billed_abandon').map(args => args.p_operation_id)).toEqual(['00000000-0000-4000-8000-000000000301']);
  });

  it('when the answer could not be stored the user is not charged for it: the receipt is the downgraded one, the turn fails', async () => {
    const a = admin({ finishFails: true }), seen: string[] = [];
    await expect(billedTikhubRead(deps(a.db, seen), keys, 'xiaohongshu', XHS)).rejects.toThrow();
    expect(of(a, 'turn_call_record')[0]).toMatchObject({ p_status: 'unusable', p_nominal_usd: null });
    expect(of(a, 'turn_close')[0]).toMatchObject({ p_close_kind: 'failed', p_delivered: false });
  });

  it('a balance that cannot start the read opens nothing and charges nothing', async () => {
    const a = admin({ openError: 'TURN_INSUFFICIENT_CREDITS' }), seen: string[] = [];
    expect(await billedTikhubRead(deps(a.db, seen), keys, 'xiaohongshu', XHS)).toEqual({ kind: 'insufficient_credits', results: {} });
    expect(seen).toEqual([]);
    expect(names(a.calls).some(n => n === 'turn_call_begin' || n === 'turn_close')).toBe(false);
  });

  it('a pause for credits at the tool row stops before anything is sent, and the turn is still closed', async () => {
    const a = admin({ begin: { paused: true } }), seen: string[] = [];
    expect(await billedTikhubRead(deps(a.db, seen), keys, 'xiaohongshu', XHS)).toEqual({ kind: 'insufficient_credits', results: {} });
    expect(seen).toEqual([]);
    expect(of(a, 'turn_close')).toHaveLength(1);
    expect(of(a, 'turn_close')[0]).toMatchObject({ p_close_kind: 'completed', p_delivered: false });
    expect(of(a, 'turn_call_record')).toHaveLength(0);
  });

  it('a key store or supplier limit that is unavailable right now stops the read for today without charging', async () => {
    const a = admin(), seen: string[] = [];
    const d = { ...deps(a.db, seen), secrets: async () => { throw new Error('vault down'); } };
    const read = await billedTikhubRead(d as never, keys, 'xiaohongshu', XHS);
    expect(read.kind).toBe('unavailable');
    expect(seen).toEqual([]);
    expect(of(a, 'turn_close')[0]).toMatchObject({ p_close_kind: 'completed', p_delivered: false });
  });

  it('TikHub switched off: no turn is opened and nothing is held or read', async () => {
    mocks.tools.tikhub = false;
    const a = admin(), seen: string[] = [];
    expect(await billedTikhubRead(deps(a.db, seen), keys, 'xiaohongshu', XHS)).toEqual({ kind: 'unavailable', reason: 'TIKHUB_NOT_ADMITTED' });
    expect(names(a.calls).some(n => n.startsWith('turn_') || n === 'publish_monitor_session')).toBe(false);
    mocks.tools.tikhub = true;
  });

  it('a claim that is no longer current when the turn is bound closes the unused turn', async () => {
    const a = admin();
    const wrapped = { ...a.raw, rpc: async (name: string, args: Record<string, unknown>) =>
      name === 'publish_monitor_billed_run' && args.p_run_id ? { data: null, error: null } : a.raw.rpc(name, args) } as never;
    expect(await billedTikhubRead({ ...deps(wrapped), admin: wrapped }, keys, 'xiaohongshu', XHS)).toEqual({ kind: 'stale' });
    expect(of(a, 'turn_close')[0]).toMatchObject({ p_close_kind: 'failed' });
    expect(of(a, 'turn_call_begin')).toHaveLength(0);
  });
});
