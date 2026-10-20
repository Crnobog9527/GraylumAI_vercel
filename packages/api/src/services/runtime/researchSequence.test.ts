/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { researchExecution, responseAfterResearch } from './researchExecution';
import { frozenResearchTurn, RESEARCH_PHASE, RESEARCH_RESULT_RESERVE_BYTES, RESEARCH_TURN_VERSION } from './researchTurn';
import { toolCallPolicy } from '../bill2/toolBilling';
import { tikhubRouteId, type TikhubCall } from '../research/vendors/tikhub';
import type { ResearchCallResult } from '../research/vendors/types';

const supplier = vi.hoisted(() => vi.fn());
vi.mock('../redisRateLimiter', () => ({ checkVendorRateLimit: vi.fn(async () => true) }));
vi.mock('../research/runtime/secrets', () => ({ platformSecretReader: () => async () => 'local-fixture-key' }));
vi.mock('../research/vendors/tikhub', async importOriginal => ({
  ...await importOriginal<typeof import('../research/vendors/tikhub')>(), callTikhub: supplier,
}));

const actorId = '11111111-1111-4111-8111-111111111111';
const runId = '22222222-2222-4222-8222-222222222222';
const sessionId = '33333333-3333-4333-8333-333333333333';
const executionId = '44444444-4444-4444-8444-444444444444';
const id = (n: number) => `55555555-5555-4555-8555-${String(n).padStart(12, '0')}`;
const now = new Date('2026-10-20T00:00:00Z');
const routes = (['keyword_posts', 'account_profile', 'account_posts'] as const).map(kind => ({
  platform: 'x' as const, kind, vendor: 'tikhub' as const, route: tikhubRouteId('x', kind)!,
  backup: null, maxUnitsPerCall: '1' as const,
}));
const research = frozenResearchTurn.parse({
  version: RESEARCH_TURN_VERSION, configRevision: 1, phase: RESEARCH_PHASE, subcalls: 12,
  reserve: RESEARCH_RESULT_RESERVE_BYTES, vendors: ['tikhub'], verifiedPlatforms: ['x'], benchmarkPlatforms: ['x'],
  routes, discoverSubcalls: 3, recentGrowth: { maxFirstPostAgeDays: 90, minViewsToFollowers: '1' },
});
const policies = routes.map(({ route }) => toolCallPolicy({
  vendor: 'tikhub', account: 'research-local', route, purposes: [RESEARCH_PHASE], maxUnitsPerCall: '1',
  price: { entryHash: 'e'.repeat(64), matchedBy: 'route', multiplier: '6', multiplierSource: 'global',
    entry: { provider: 'tikhub', route, appliesToUnlistedRoutes: false, currency: 'USD', usageUnit: 'call',
      unitsPerPrice: '1', price: '0.005', usdPerCurrency: null, fxSourceUrl: null, fxEffectiveAt: null, fxValidUntil: null,
      pricingBasis: 'list', sourceUrl: 'https://example.com/tikhub-price', evidenceHash: 'a'.repeat(64),
      verifiedAt: '2026-10-01T00:00:00Z', validUntil: '2026-11-01T00:00:00Z', chargeCondition: 'per call',
      includedInReceipt: false, priceMultiplier: null } },
}));

type ClaimMode = 'claimed' | 'waiting' | 'replayed' | 'unknown';
type StoredCall = { id: string; sequence: number; providerId: string | null; tool: boolean };
/** Only RPC boundaries are faked: discovery, supplier admission, BILL2 wrappers and evidence writes stay real. */
function fixture(modes: ClaimMode[] = []) {
  const calls: StoredCall[] = [{ id: id(1), sequence: 1, providerId: 'generation-1', tool: false }];
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === 'bill2_read') return { data: { id: runId, calls: calls.map(call => ({ ...call })) }, error: null };
    if (name === 'research_runtime_read') {
      const discovery = { discoveryId: args.p_id, keywords: ['coffee', 'tea', 'cocoa'], platforms: ['x'],
        cursor: {}, state: 'running' };
      return { data: args.p_kind === 'discovery' ? discovery : null, error: null };
    }
    if (name === 'bill2_claim') {
      const mode = modes.shift() ?? 'claimed';
      if (mode === 'waiting') return { data: { id: null, state: 'waiting_credits' }, error: null };
      const sequence = Number(args.p_sequence);
      const call = { id: id(sequence), sequence, providerId: null, tool: true };
      calls.push(call);
      // Simulates an ambiguous committed claim: local code must not infer a successful capability.
      if (mode === 'unknown') return { data: null, error: { message: 'synthetic lost commit response' } };
      return { data: { id: call.id, state: 'prepared', dispatchToken: mode === 'replayed' ? null : id(900) }, error: null };
    }
    if (name === 'bill2_dispatch') return { data: { dispatch: true }, error: null };
    if (name === 'bill2_record') return { data: { accountClosed: false, contentDeleted: false }, error: null };
    if (name === 'research_runtime_plan_create' || name === 'research_runtime_link') return { data: null, error: null };
    if (name === 'research_transition') return { data: { claimed: true, token: id(901), dispatch: true }, error: null };
    if (name === 'research_discovery_save') return { data: {}, error: null };
    if (name === 'research_benchmark_shortfall_offer') {
      return { data: null, error: { message: 'RESEARCH_SHORTFALL_NOT_DUE' } };
    }
    if (name === 'research_runtime_call_charge') {
      return { data: calls.some(call => call.id === args.p_call && call.tool) ? { credits: '0.3' } : null, error: null };
    }
    throw new Error(`unexpected RPC ${name}`);
  });
  const count = (name: string) => rpc.mock.calls.filter(([called]) => called === name).length;
  const sequences = () => rpc.mock.calls.filter(([name]) => name === 'bill2_claim').map(([, args]) => args.p_sequence);
  return { rpc, calls, count, sequences };
}

function build(db: ReturnType<typeof fixture>, live = true) {
  const onPause = vi.fn();
  const callGate = vi.fn(async () => {});
  const built = researchExecution({ research, tools: ['benchmark_discover'], executionId, actorId, database: db,
    execution: { sessionId, runId, epoch: 4, live, billing: { callPolicy: policies } } as never,
    emit: () => {}, onClosed: vi.fn(), onPause, canSend: () => true, callGate, now: () => now })!;
  const discover = (discovery = id(700)) => built.tools[0]!.execute({ discoveryId: discovery }, `tool-${discovery}`);
  return { built, discover, onPause, callGate };
}

beforeEach(() => {
  supplier.mockReset();
  supplier.mockImplementation(async (call: TikhubCall): Promise<ResearchCallResult> => ({
    vendor: 'tikhub', route: tikhubRouteId(call.platform, call.kind)!, outcome: 'ok', reason: null, httpStatus: 200,
    supplierMayCharge: true, usage: { unit: 'call', units: '1' }, items: [], truncated: false, fetchedAt: now.toISOString(),
  }));
});

describe('research sequence metadata within the owning invocation', () => {
  it('reads the run once for a three-subcall discovery while preserving every claim, dispatch and receipt', async () => {
    const db = fixture();
    const { built, discover, callGate } = build(db);
    await discover();
    expect(db.count('bill2_read')).toBe(1);
    expect(db.sequences()).toEqual([2, 3, 4]);
    expect(db.count('bill2_dispatch')).toBe(3);
    expect(db.count('bill2_record')).toBe(3);
    expect(db.count('research_runtime_plan_create')).toBe(3);
    expect(db.count('research_runtime_link')).toBe(3);
    expect(db.count('research_transition')).toBe(9);
    expect(supplier).toHaveBeenCalledTimes(3);
    expect(callGate).toHaveBeenCalledTimes(3);
    expect([1, 2, 3, 4, 5].map(n => built.claimedSubcall!(n))).toEqual([false, true, true, true, false]);
    for (const [, args] of db.rpc.mock.calls.filter(([name]) => name === 'bill2_claim')) {
      expect(args).toMatchObject({ p_actor_id: actorId, p_run_id: runId,
        p_payload: { runtimeEpoch: 4, phase: RESEARCH_PHASE, protocol: 'research-tool-v1' } });
    }
  });

  it('refreshes at the next tool boundary so an intervening model call keeps its sequence', async () => {
    const db = fixture();
    const { built, discover } = build(db);
    await discover();
    db.calls.push({ id: id(5), sequence: 5, providerId: 'generation-5', tool: false });
    await discover(id(701));
    expect(db.count('bill2_read')).toBe(2);
    expect(db.sequences()).toEqual([2, 3, 4, 6, 7, 8]);
    expect(built.claimedSubcall!(5)).toBe(false);
    expect(built.claimedSubcall!(8)).toBe(true);
    expect(db.count('bill2_dispatch')).toBe(6);
    expect(db.count('bill2_record')).toBe(6);
  });

  it.each(['waiting', 'replayed', 'unknown'] as const)('does not trust a %s claim as a locally known tool slot', async mode => {
    const db = fixture([mode]);
    const { built, discover } = build(db);
    if (mode === 'waiting') await expect(discover()).rejects.toThrow('RUNTIME_WAITING_CREDITS');
    else if (mode === 'unknown') await expect(discover()).rejects.toThrow();
    else await discover();
    expect(built.claimedSubcall!(2)).toBe(false);
    expect(db.count('bill2_dispatch')).toBe(0);
    expect(db.count('bill2_record')).toBe(0);
    expect(supplier).not.toHaveBeenCalled();
  });

  it.each(['waiting', 'unknown'] as const)('a new invocation after %s starts from persisted calls, without inherited shortcuts', async mode => {
    const db = fixture(['claimed', mode]);
    const original = build(db);
    await expect(original.discover()).rejects.toThrow();
    expect(original.built.claimedSubcall!(2)).toBe(true);
    expect(original.built.claimedSubcall!(3)).toBe(false);
    const before = db.count('bill2_read');
    const restored = build(db);
    expect(restored.built.claimedSubcall!(2)).toBe(false);
    expect(restored.built.claimedSubcall!(3)).toBe(false);
    const expected = db.calls.length + 1;
    await restored.discover(id(702));
    expect(db.count('bill2_read')).toBe(before + 1);
    expect(db.sequences().slice(-3)).toEqual([expected, expected + 1, expected + 2]);
    expect(restored.built.claimedSubcall!(2)).toBe(false);
  });

  it('clears the per-tool cursor after a pause even if the same instance is invoked again', async () => {
    const db = fixture(['waiting']);
    const { discover, onPause } = build(db);
    await expect(discover()).rejects.toThrow('RUNTIME_WAITING_CREDITS');
    expect(onPause).toHaveBeenCalledWith(expect.objectContaining({ sequence: 2 }), 'waiting_credits');
    db.calls.push({ id: id(2), sequence: 2, providerId: 'generation-2', tool: false });
    await discover(id(703));
    expect(db.count('bill2_read')).toBe(2);
    expect(db.sequences()).toEqual([2, 3, 4, 5]);
  });
});

describe('responseAfterResearch uses only confirmed local sequence shortcuts', () => {
  it('skips freshly claimed tool slots before response lookup and leaves the model slot authoritative', async () => {
    const db = fixture();
    const { built, discover } = build(db);
    await discover();
    db.rpc.mockClear();
    const isSubcall = vi.spyOn(built, 'isSubcall');
    const respond = vi.fn(async () => null);
    expect(await responseAfterResearch(respond, 2, built, 12)).toEqual({ sequence: 5, existing: null });
    expect(respond).toHaveBeenCalledExactlyOnceWith(5);
    expect(isSubcall).not.toHaveBeenCalled();
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it('a recovery invocation scans unknown slots through the scoped database and never sends suppliers', async () => {
    const db = fixture();
    await build(db).discover();
    const restored = build(db, false);
    db.rpc.mockClear();
    supplier.mockClear();
    const respond = vi.fn(async (sequence: number) => {
      if (sequence < 5) throw new Error('RUNTIME_RESPONSE_CONFLICT');
      return { rawBody: 'persisted model response' };
    });
    expect(await responseAfterResearch(respond, 2, restored.built, 12))
      .toEqual({ sequence: 5, existing: { rawBody: 'persisted model response' } });
    expect(respond.mock.calls.map(([sequence]) => sequence)).toEqual([2, 3, 4, 5]);
    expect(db.count('bill2_read')).toBe(3);
    expect(db.count('research_runtime_call_charge')).toBe(3);
    expect(db.count('bill2_claim')).toBe(0);
    expect(db.count('bill2_dispatch')).toBe(0);
    expect(db.count('bill2_record')).toBe(0);
    expect(supplier).not.toHaveBeenCalled();
  });

  it('does not skip a model conflict or bypass the run ceiling using local knowledge', async () => {
    const db = fixture();
    const { built, discover } = build(db);
    await discover();
    const conflict = vi.fn(async () => { throw new Error('RUNTIME_RESPONSE_CONFLICT'); });
    await expect(responseAfterResearch(conflict, 1, built, 12)).rejects.toThrow('RUNTIME_RESPONSE_CONFLICT');
    expect(conflict).toHaveBeenLastCalledWith(1);
    conflict.mockClear();
    await expect(responseAfterResearch(conflict, 2, built, 4)).rejects.toThrow('RUNTIME_RESPONSE_CONFLICT');
    expect(conflict).toHaveBeenCalledExactlyOnceWith(4);
  });
});
