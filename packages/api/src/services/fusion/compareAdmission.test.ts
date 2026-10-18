/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const state = vi.hoisted(() => ({
  compare: {} as Record<string, unknown>, entitlements: {} as Record<string, unknown>, rpcs: [] as Array<{ name: string; args: Record<string, unknown> }>,
  replies: new Map<string, unknown>(), credits: new Map<string, number>(), tooLarge: new Set<string>(), shrink: new Set<string>(),
  admitted: [] as string[], exploding: new Set<string>(), noRoom: new Set<string>(), groupExists: false, clamp: new Map<string, number>(),
}));
vi.mock('./settings', async original => ({ ...(await original<typeof import('./settings')>()),
  readFusionSettings: async () => ({ version: 1, review: {}, compare: state.compare }) }));
vi.mock('../membershipEntitlements', async original => ({ ...(await original<typeof import('../membershipEntitlements')>()),
  readMembershipEntitlements: async () => state.entitlements, assertFusionEntitlement: () => undefined }));
vi.mock('../runtime/stagingPolicy', async original => ({ ...(await original<typeof import('../runtime/stagingPolicy')>()),
  loadStagingPolicy: async () => ({ id: id(900), creditsPerUsd: '100', multiplier: '3',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(), callPolicies: [] }) }));
vi.mock('../runtime/admissionLimits', async original => ({ ...(await original<typeof import('../runtime/admissionLimits')>()),
  admissionDeadline: (at: string) => at }));
vi.mock('../runtime/paygPricing', async original => ({ ...(await original<typeof import('../runtime/paygPricing')>()),
  freezeStagingPaygPricing: async (_a: unknown, policies: unknown[]) => policies }));
vi.mock('../runtime/billingUnitAdmission', async original => ({ ...(await original<typeof import('../runtime/billingUnitAdmission')>()),
  freezeWindowBillingUnit: async () => ({ version: 'bill-unit-v2' }) }));
vi.mock('./models', async original => ({ ...(await original<typeof import('./models')>()),
  admitFusionModel: async (_db: unknown, _w: unknown, row: { id: string }, phase: string, tokens: number) => {
    state.admitted.push(`${row.id}:${phase}:${tokens}`);
    return { quote: {}, policy: { modelId: row.id, model: `m/${row.id}`, providerLimits: { providerSlug: 's' } },
      outputLimit: state.clamp.get(row.id) ?? tokens, reasoning: undefined };
  } }));
vi.mock('./request', async original => ({ ...(await original<typeof import('./request')>()),
  fusionRequestBody: (policy: { modelId: string }, request: unknown, outputLimit: number) => JSON.stringify({ for: policy.modelId, outputLimit, request }) }));
vi.mock('../runtime/paygRuntime', async original => ({ ...(await original<typeof import('../runtime/paygRuntime')>()),
  fitNativeRequestOutput: (body: string, policy: { modelId: string }) => state.shrink.has(policy.modelId) ? body + ' ' : body,
  runtimePaygCall: (_b: string, phase: string, policy: { modelId: string }) => {
    if (state.tooLarge.has(policy.modelId)) throw new Error('BILL2_INPUT_PROFILE_INVALID');
    if (state.exploding.has(policy.modelId)) throw new Error('UNEXPECTED_PRICING_FAILURE');
    if (state.noRoom.has(policy.modelId)) throw new Error('RUNTIME_COMPLETE_REQUEST_EXCEEDS_CAPACITY');
    return { call: { phase, upperUsd: '0.01', model: `m/${policy.modelId}`, runtimeEpoch: 1 }, upperCredits: state.credits.get(policy.modelId) ?? 10 };
  } }));
vi.mock('../bill2/service', async original => ({ ...(await original<typeof import('../bill2/service')>()),
  frozenCallSchema: z.any(), frozenPaygRunSchema: { parse: (value: unknown) => value } }));
import { admitCompareGroup, assertCompareAllowed, assertQuoteCovers, buildCompareColumns, replayCompareGroup } from './compareAdmission';
import { FUSION_INPUT_CAP } from './request';

const models = [id(1), id(2), id(3)];
const rows = models.map(model => ({ id: model, model_id: `m/${model}` }));
const admin = { from: () => ({ select: () => ({ in: async () => ({ data: rows, error: null }) }) }),
  rpc: async (name: string, args: Record<string, unknown>) => {
    state.rpcs.push({ name, args });
    if (name === 'bill2_create_draft') return { data: id(700), error: null };
    // The database answers a probe (no runs) with FUSION_GROUP_INVALID until the group exists.
    if (name === 'fusion_group_admit' && (args.p_runs as unknown[]).length === 0 && !state.groupExists) {
      return { data: null, error: { message: 'FUSION_GROUP_INVALID' } };
    }
    const reply = state.replies.get(name);
    if (reply instanceof Error) return { data: null, error: { message: reply.message } };
    return { data: reply ?? null, error: null };
  } } as unknown as SupabaseClient;
const request = { instructions: 'I', input: 'Q', history: [{ role: 'user' as const, content: 'earlier' }] };
const build = (extra: Record<string, unknown> = {}) => buildCompareColumns({ admin, actorId: id(50), modelIds: models, request, answerTokens: 4096,
  dispatchMinutes: 10, env: {}, ...extra });
const shown = { credits: 30, columns: models.map(() => ({ credits: 10, usd: '0.01' })) };

beforeEach(() => {
  state.compare = { enabled: true, allowedModelIds: models, defaultModelIds: models.slice(0, 2), minModels: 2, answerOutputTokens: 4096,
    maxBudgetUsd: '2', dispatchMinutes: 10, breaker: { platformUsd: '2', noDeliveryCalls: 10 } };
  state.entitlements = { allowFusionCompare: true, fusionCompareMaxModels: 4 };
  state.rpcs = []; state.replies = new Map(); state.credits = new Map(); state.tooLarge = new Set(); state.shrink = new Set(); state.admitted = [];
  state.exploding = new Set(); state.noRoom = new Set(); state.groupExists = false; state.clamp = new Map();
});

describe('compare live rules (FUSION-COMPARE §3.3)', () => {
  const run = (modelIds: string[]) => assertCompareAllowed(admin, id(50), modelIds);
  it('allows an allowed set within [minModels, D3]', async () => {
    await expect(run(models.slice(0, 2))).resolves.toMatchObject({ minModels: 2 });
    await expect(run(models)).resolves.toBeDefined();
  });
  it.each([
    ['the switch is off', () => { state.compare.enabled = false; }, models, 'FUSION_COMPARE_DISABLED'],
    ['the plan forbids it', () => { state.entitlements.allowFusionCompare = false; }, models, 'FUSION_COMPARE_FORBIDDEN'],
    ['fewer than the administrator minimum', () => { state.compare.minModels = 3; }, models.slice(0, 2), 'FUSION_COMPARE_TOO_FEW'],
    ['fewer than two', () => undefined, models.slice(0, 1), 'FUSION_COMPARE_TOO_FEW'],
    ['more than D3', () => { state.entitlements.fusionCompareMaxModels = 2; }, models, 'FUSION_COMPARE_TOO_MANY'],
    ['a duplicate', () => undefined, [models[0]!, models[0]!], 'FUSION_COMPARE_MODEL_NOT_ALLOWED'],
    ['a model outside the allowlist', () => undefined, [models[0]!, id(99)], 'FUSION_COMPARE_MODEL_NOT_ALLOWED'],
  ])('refuses when %s', async (_name, setup, chosen, code) => {
    (setup as () => void)();
    await expect(run(chosen as string[])).rejects.toThrow(code as string);
  });
});

describe('compare columns', () => {
  it('freezes one request per chosen model, in the chosen order, all with the same snapshot and answer limit', async () => {
    const built = await build();
    expect(built.columns.map(column => column.modelId)).toEqual(models);
    expect(built.columns.map(column => column.index)).toEqual([0, 1, 2]);
    for (const column of built.columns) expect(JSON.parse(column.body)).toMatchObject({ request, outputLimit: 4096 });
    expect(state.admitted).toEqual(models.map(model => `${model}:fusion_compare:4096`));
    expect(built.columns.every(column => !('runtimeEpoch' in column.call))).toBe(true);
    expect(built.totalCredits).toBe(30);
  });
  it('lists a model that cannot take the request whole instead of shortening it, never dropping it silently', async () => {
    state.tooLarge.add(models[1]!);
    state.shrink.add(models[2]!); // the answer limit would have to shrink to fit
    const built = await build();
    expect(built.tooLarge).toEqual([models[1], models[2]]);
    expect(built.columns.map(column => column.modelId)).toEqual([models[0]]);
  });
  it('never gives one column a lower answer limit than the others: a model clamped by its own limit cannot take the compare', async () => {
    state.clamp.set(models[1]!, 2048); // its own max is below the configured 4096; admission silently clamps
    const built = await build();
    expect(built.tooLarge).toEqual([models[1]]);
    expect(built.columns.map(column => column.outputLimit)).toEqual([4096, 4096]);
    await expect(admitCompareGroup({ admin, actorId: id(50), requestId: id(60), sourceSessionId: id(61), modelIds: models, request, env: {},
      shown })).rejects.toThrow('FUSION_COMPARE_INPUT_TOO_LARGE');
  });
  it('lists a model whose window has no room even at the smallest answer limit, instead of failing the whole estimate', async () => {
    state.noRoom.add(models[1]!);
    const built = await build();
    expect(built.tooLarge).toEqual([models[1]]);
    expect(built.columns.map(column => column.modelId)).toEqual([models[0], models[2]]);
  });
  it('refuses a snapshot over the interactive cap before pricing anything', async () => {
    await expect(build({ request: { ...request, input: 'x'.repeat(FUSION_INPUT_CAP + 1) } })).rejects.toThrow('FUSION_COMPARE_INPUT_TOO_LARGE');
    expect(state.admitted).toEqual([]);
  });
  it('does not hide an unexpected pricing failure as "too large"', async () => {
    state.exploding.add(models[1]!);
    await expect(build()).rejects.toThrow('UNEXPECTED_PRICING_FAILURE');
  });
});

describe('compare group admission', () => {
  const admit = (extra: Record<string, unknown> = {}) => admitCompareGroup({ admin, actorId: id(50), requestId: id(60), sourceSessionId: id(61),
    modelIds: models, request, env: {}, shown, ...extra });
  const reply = (replayed: boolean) => ({ groupId: id(70), replayed, runs: models.map((model, index) => ({ runId: id(80 + index),
    fusion: { index, phase: 'fusion_compare', body: `b${index}`, call: { phase: 'fusion_compare', model: `m/${model}` } } })) });
  it('sizes the columns with the answer limit given from the recorded request, not the live setting', async () => {
    state.replies.set('fusion_group_admit', reply(false));
    await admit({ answerTokens: 2048 }); // the live setting is 4096
    expect(state.admitted.length).toBeGreaterThan(0);
    expect(state.admitted.every(item => item.endsWith(':2048'))).toBe(true);
  });
  it('admits as kind compare with one run per column: no Skill identity, no session, a draft scope, derived request ids', async () => {
    state.replies.set('fusion_group_admit', reply(false));
    const first = await admit();
    expect(first.runs.map(run => run.index)).toEqual([0, 1, 2]);
    const calls = state.rpcs.filter(call => call.name === 'fusion_group_admit');
    // the replay probe (no runs) comes first, then the real admission
    expect((calls[0]!.args.p_runs as unknown[]).length).toBe(0);
    const real = calls[1]!.args;
    expect(real).toMatchObject({ p_kind: 'compare', p_request_id: id(60), p_source_session_id: id(61) });
    const runs = real.p_runs as Array<{ requestId: string; payload: Record<string, unknown> }>;
    expect(runs).toHaveLength(3);
    expect(new Set(runs.map(run => run.requestId)).size).toBe(3);
    for (const [index, run] of runs.entries()) {
      expect(run.payload).toMatchObject({ contractVersion: 'bill2.v2', mode: 'staging_test', operation: 'question', modelId: models[index],
        scope: { kind: 'positioning_draft', draftId: id(700) } });
      expect(run.payload).not.toHaveProperty('sessionRef');
      for (const key of ['moduleId', 'skillId', 'revisionId']) expect(run.payload).not.toHaveProperty(key);
      expect(run.payload.limits).toMatchObject({ maxCalls: 1, maxPreDeduct: 10 });
      expect((run.payload.input as { fusion: { phase: string } }).fusion.phase).toBe('fusion_compare');
    }
  });
  it('a repeat of the request returns the first frozen runs without pricing again', async () => {
    state.groupExists = true;
    state.replies.set('fusion_group_admit', reply(true));
    const again = await admit();
    expect(again.replayed).toBe(true);
    expect(state.admitted).toEqual([]);
    expect(state.rpcs.filter(call => call.name === 'bill2_create_draft')).toHaveLength(0);
  });
  it('refuses to hold more than the maximum the user was shown: total, per column, or a different column count', async () => {
    state.credits.set(models[0]!, 11); // one column rose above its shown bound while the total still fits
    await expect(admit({ shown: { ...shown, credits: 99 } })).rejects.toThrow('FUSION_COMPARE_PRICE_CHANGED');
    state.credits = new Map();
    await expect(admit({ shown: { ...shown, credits: 29 } })).rejects.toThrow('FUSION_COMPARE_PRICE_CHANGED');
    await expect(admit({ shown: { credits: 30, columns: shown.columns.slice(0, 2) } })).rejects.toThrow('FUSION_COMPARE_PRICE_CHANGED');
    await expect(admit({ shown: { credits: 99, columns: models.map(() => ({ credits: 10, usd: '0.001' })) } }))
      .rejects.toThrow('FUSION_COMPARE_PRICE_CHANGED'); // provider cost above the shown bound
    expect(state.rpcs.filter(call => call.name === 'fusion_group_admit' && (call.args.p_runs as unknown[]).length > 0)).toHaveLength(0);
  });
  it('refuses the whole compare when any chosen model cannot take the request', async () => {
    state.tooLarge.add(models[2]!);
    await expect(admit()).rejects.toThrow('FUSION_COMPARE_INPUT_TOO_LARGE');
  });
  it('maps database refusals to their exact code and anything else to "unavailable"', async () => {
    state.groupExists = true; // so the probe itself reaches the scripted reply
    state.replies.set('fusion_group_admit', new Error('FUSION_COMPARE_GATE_REQUIRED'));
    await expect(admit()).rejects.toThrow('FUSION_COMPARE_GATE_REQUIRED');
    state.replies.set('fusion_group_admit', new Error('relation "secret_table" does not exist'));
    await expect(admit()).rejects.toThrow('FUSION_ADMISSION_UNAVAILABLE');
  });
  it('replays by request alone: null when nothing was admitted', async () => {
    await expect(replayCompareGroup(admin, id(50), id(60), id(61))).resolves.toBeNull();
  });
});

describe('quote coverage (what the user was shown)', () => {
  const columns = [{ index: 0, modelId: id(1), upperCredits: 10, upperUsd: '0.01' }, { index: 1, modelId: id(2), upperCredits: 10, upperUsd: '0.01' }];
  const quote = { credits: 20, columns: [{ modelId: id(1), credits: 10, usd: '0.01' }, { modelId: id(2), credits: 10, usd: '0.01' }] };
  it('accepts a quote that covers every column, with or without model ids', () => {
    expect(() => assertQuoteCovers(columns, quote)).not.toThrow();
    expect(() => assertQuoteCovers(columns, { credits: 25, columns: quote.columns.map(({ credits, usd }) => ({ credits: credits + 1, usd })) })).not.toThrow();
  });
  it.each([
    ['fewer columns', { ...quote, columns: quote.columns.slice(0, 1) }],
    ['more columns', { ...quote, columns: [...quote.columns, quote.columns[0]!] }],
    ['a lower total', { ...quote, credits: 19 }],
    ['a lower column cap', { ...quote, columns: [{ ...quote.columns[0]!, credits: 9 }, quote.columns[1]!] }],
    ['a lower column cost', { ...quote, columns: [{ ...quote.columns[0]!, usd: '0.009' }, quote.columns[1]!] }],
    ['another model order', { ...quote, columns: [quote.columns[1]!, quote.columns[0]!] }],
  ])('refuses %s', (_name, shownQuote) => {
    expect(() => assertQuoteCovers(columns, shownQuote)).toThrow('FUSION_COMPARE_PRICE_CHANGED');
  });
});
