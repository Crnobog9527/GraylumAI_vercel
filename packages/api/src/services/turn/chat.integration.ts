/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import { pricingConfig } from '../__tests__/fixtures/runtimePricing';
import { clearTestOpenRouterKey, seedTestOpenRouterKey } from '../models/openRouterKey.testing';
import { clearCatalogCache, withCatalogRequest } from '../runtime/catalogCache';
import type { PositioningClassifier } from '../runtime/positioningGate';
import { runChatTurn, CORE_PATH_SETTING } from './chat';
import { turnClients } from './db';
import type { CounterStore } from './limiter';
import { RUNTIME_PAYG_SETTING } from './quote';
import type { TurnEvent } from './sse';

/*
 * CORE-PATH-V2 V2-4a acceptance on the local database with a synthetic OpenRouter: a free-chat turn end to end, its Postgres
 * round trips, and the disconnect case migrated from streaming.integration.ts (provider id and freeze kept, no second POST,
 * no zero refund).
 */
const connectionString = process.env.V3_LOCAL_DB!;
if (!connectionString?.startsWith('postgres://postgres@127.0.0.1:') || !connectionString.endsWith('/v3_disposable'))
  throw new Error('isolated runner required');
const db = new pg.Client({ connectionString });
const MODEL = 'anthropic/claude-sonnet-5.5', ROUTE = 'anthropic';
const slots: CounterStore = { incr: async () => 1, decr: async () => 0 };
const SETTINGS = [CORE_PATH_SETTING, RUNTIME_PAYG_SETTING, 'primary_model_id', 'billing_credits_per_usd', 'billing_token_price_multiplier',
  'runtime_rw_v2'];
let saved: Array<{ key: string; value: unknown }> = [];
beforeAll(async () => {
  await db.connect();
  saved = (await db.query('select key,value from system_settings where key = any($1)', [SETTINGS])).rows;
});
afterAll(async () => {
  await db.query('delete from system_settings where key = any($1)', [SETTINGS]);
  for (const row of saved) await db.query('insert into system_settings(key,value) values($1,$2)', [row.key, JSON.stringify(row.value)]);
  await clearTestOpenRouterKey(db);
  clearCatalogCache();
  await db.end();
});

// Synthetic evidence for validation only (the shape productionPolicy.test.ts uses); never a real admission profile.
const profile = { model: MODEL, endpointTag: ROUTE, protocol: 'openrouter-chat-v1', profileVersion: 'test-only', evidenceVersion: 'test-only',
  admissionPath: 'empirical', templateTokens: 4096, marginTokens: 4096, maxBytes: 196608, maxMessages: 128, maxTools: 2,
  maxSchemaBytes: 16384, purposes: ['ordinary', 'organizer'], requestFormats: ['serial-tools-v2'],
  reasoningVariants: [{ reasoning: { parameter: 'none' }, outputLimit: 8192, testedOutputLimit: 512, evidenceReference: 'test-only',
    manifestHash: 'b'.repeat(64), outputStressSamples: 2, includesReasoning: true }], outputLimit: 8192,
  evidence: { reference: 'test-only', manifestHash: 'a'.repeat(64), distinctSamples: 60, messageStressSamples: 12,
    maxVerifiedMessages: 128, completeCells: 15, variantsPerCell: 4, maxPromptToBytes: 0.5, maxPromptToUpper: 0.4,
    outputLimit: 8192, testedOutputLimit: 512, outputSemantics: 'max-tokens-includes-reasoning', includesReasoning: true,
    cacheCovered: true, costBoundPassed: true } };

async function setup() {
  const actor = randomUUID(), session = randomUUID(), modelId = randomUUID();
  await db.query('insert into profiles(id,credits) values($1,1000)', [actor]);
  await db.query(`insert into credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,idempotency_key,balance_before,balance_after)
    values($1,1000,'addition','grant','opening_grant','system',$2,0,1000)`, [actor, 'opening_grant:' + actor]);
  await db.query("insert into runtime_sessions(id,actor_id,scope,start_request_id,start_payload) values($1,$2,$3,$4,'{}')",
    [session, actor, JSON.stringify({ kind: 'positioning_draft', probe: randomUUID() }), randomUUID()]);
  const { pricing } = pricingConfig(MODEL, ROUTE, '0.000003', '0.000015');
  const config = { pricing, reasoning: { route: ROUTE, purposes: { interactive: { mode: 'off', wire: 'reasoning_effort' } },
    catalog: { fetchedAt: pricing.fetchedAt, model: MODEL, reasoning: { mandatory: false, defaultEnabled: false, supportedEfforts: ['low', 'high'],
      defaultEffort: 'high', supportsMaxTokens: true },
    endpoints: [{ tag: ROUTE, providerName: 'Anthropic', supportedParameters: ['tools', 'reasoning', 'reasoning_effort'], contextLength: 1050000,
      maxCompletionTokens: 8192 }] } } };
  await db.query(`insert into ai_models(id,name,model_id,provider,is_active,max_tokens,input_limit,config,api_endpoint)
    values($1,'Core path chat',$2,'openrouter','true',8192,1050000,$3,'https://openrouter.ai/api/v1/chat/completions')`,
  [modelId, MODEL, JSON.stringify(config)]);
  const set = (key: string, value: unknown) => db.query(
    'insert into system_settings(key,value) values($1,$2) on conflict(key) do update set value=excluded.value', [key, JSON.stringify(value)]);
  await set(CORE_PATH_SETTING, { enabled: true, stopLoss: { limitUsd: 1000, p: 8, poolSize: 8, uFastUsd: 1, uBigUsd: 5 },
    decisionUpperUsd: '0.001' });
  await set(RUNTIME_PAYG_SETTING, { version: 1, enabled: true, policyVersion: 'core-path-test', profiles: [profile] });
  await set('primary_model_id', modelId);
  await set('billing_credits_per_usd', 100);
  await set('billing_token_price_multiplier', 6);
  await set('runtime_rw_v2', { catalogCache: true });
  await seedTestOpenRouterKey(db, 'LOCAL_SYNTHETIC_OPENROUTER_KEY');
  return { actor, session, modelId };
}

/** A Supabase client that counts its Postgres round trips by REST path. */
function countingAdmin() {
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    if (path.startsWith('/rest/v1/')) calls.push(path.slice('/rest/v1/'.length));
    return fetch(input, init);
  };
  const admin = createClient(process.env.V3_LOCAL_REST!, process.env.V3_LOCAL_SERVICE_JWT!, { auth: { persistSession: false },
    global: { fetch: fetcher } });
  return { admin, calls };
}

const completion = (id: string) => JSON.stringify({ id, object: 'chat.completion', created: 1, model: MODEL,
  choices: [{ index: 0, message: { role: 'assistant', content: 'Synthetic answer' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200, cost: '0.006' } });

// The synthetic Decisions check: allowed, reporting a provider cost of 0.00003 USD.
const allowGate: PositioningClassifier = async ({ onCost }) => { onCost?.(0.00003); return 'allow'; };
async function turn(input: { actor: string; session: string; text: string; transport: typeof fetch; gate?: PositioningClassifier }) {
  const { admin, calls } = countingAdmin(), events: TurnEvent[] = [];
  await withCatalogRequest(() => runChatTurn({ admin, clients: turnClients(admin), slots, transport: input.transport,
    gate: { classify: input.gate ?? allowGate } },
  { actorId: input.actor, sessionId: input.session, requestId: randomUUID(), text: input.text }, e => events.push(e)));
  return { events, calls };
}

it('RUNTIME: CORE-PATH-V2 V2-4a: a free-chat turn opens, calls once in three writes, settles once and appends both messages', async () => {
  const f = await setup();
  let posts = 0;
  const transport: typeof fetch = async () => { posts++; return new Response(completion('gen-core-' + posts), {
    headers: { 'x-generation-id': 'gen-core-' + posts } }); };
  const first = await turn({ actor: f.actor, session: f.session, text: 'Hello', transport });
  expect(first.events.map(e => e.type), JSON.stringify(first.events)).toEqual(['opened', 'result']);
  const result = first.events.at(-1) as Extract<TurnEvent, { type: 'result' }>;
  // n = (1000 x 3 + 200 x 15) / 1e6 = 0.006 USD; N = ceil(100 x 0.006 x 6) = 4 credits.
  expect(result).toMatchObject({ body: 'Synthetic answer', settlement: 'done' });
  expect(result.chargedCredits).toBeGreaterThan(0);
  expect((await db.query('select credits from profiles where id=$1', [f.actor])).rows[0].credits).toBe(1000 - result.chargedCredits!);
  // The positioning check: its real cost on the platform's side (stop-loss), nothing in what the user paid.
  expect((await db.query("select c.status,c.nominal_usd::float8 n,c.upper_usd::float8 u,c.usage->>'chargeUser' charge from turn_calls c join turns t on t.id=c.turn_id and t.actor_id=c.actor_id where t.actor_id=$1 and c.call_kind='decision'", [f.actor])).rows)
    .toEqual([{ status: 'ok', n: 0.00003, u: 0.001, charge: 'false' }]);
  expect((await db.query("select role,content from session_messages where session_id=$1 order by seq", [f.session])).rows)
    .toEqual([{ role: 'user', content: 'Hello' }, { role: 'assistant', content: 'Synthetic answer' }]);
  // The second turn is warm (catalog cache): its round trips are the turn's own.
  const second = await turn({ actor: f.actor, session: f.session, text: 'Again', transport });
  expect(second.events.map(e => e.type)).toEqual(['opened', 'result']);
  // The budget in two lines (plan 2.3 / 3.1, Fable 10-28): the turn's own <= 5 without tools, +2 for the positioning check of an
  // account without a confirmed positioning; plus a fixed 2 per request (catalog version check, the platform key read fresh).
  const own = second.calls.filter(c => c.startsWith('rpc/turn_')), fixed = second.calls.filter(c => !c.startsWith('rpc/turn_'));
  console.log('CORE-PATH-V2 free chat round trips', JSON.stringify({ total: second.calls.length, own: own.length, fixed: fixed.length,
    calls: second.calls }));
  expect(own).toEqual(['rpc/turn_open', 'rpc/turn_call_begin', 'rpc/turn_call_record',
    'rpc/turn_call_begin', 'rpc/turn_call_identity', 'rpc/turn_call_record', 'rpc/turn_close']);
  expect(own.length).toBeLessThanOrEqual(5 + 2);
  expect(fixed).toEqual(['rpc/catalog_versions_snapshot', 'rpc/platform_secret_read']);
  expect(posts).toBe(2);
});

it('RUNTIME: CORE-PATH-V2 V2-4a: a response broken after it started keeps the provider id and the freeze, sends once and is never refunded as zero', async () => {
  const f = await setup();
  let posts = 0;
  const transport: typeof fetch = async () => { posts++; return new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('{"id":"gen-broken","choi')); controller.error(new Error('connection lost'));
  } }), { headers: { 'x-generation-id': 'gen-broken' } }); };
  const out = await turn({ actor: f.actor, session: f.session, text: 'Hello', transport });
  expect(out.events.at(-1)).toMatchObject({ type: 'error', code: 'TURN_CALL_UNKNOWN' });
  expect(posts).toBe(1);
  const call = (await db.query("select c.status,c.cost_pending,c.provider_id from turn_calls c join turns t on t.id=c.turn_id and t.actor_id=c.actor_id where t.actor_id=$1 and c.call_kind='model'", [f.actor])).rows;
  expect(call).toEqual([{ status: 'unknown', cost_pending: true, provider_id: 'gen-broken' }]);
  const t = (await db.query('select close_kind,settlement,charged_credits,reserved_credits from turns where actor_id=$1', [f.actor])).rows[0];
  expect(t).toMatchObject({ close_kind: 'interrupted', settlement: 'pending', charged_credits: null });
  expect((await db.query('select credits from profiles where id=$1', [f.actor])).rows[0].credits).toBe(1000 - t.reserved_credits);
  expect((await db.query('select count(*)::int n from session_messages where session_id=$1', [f.session])).rows[0].n).toBe(0);
});
