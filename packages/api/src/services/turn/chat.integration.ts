/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import { pricingConfig } from '../__tests__/fixtures/runtimePricing';
import { clearTestOpenRouterKey, seedTestOpenRouterKey } from '../models/openRouterKey.testing';
import { clearCatalogCache, withCatalogRequest } from '../runtime/catalogCache';
import type { PositioningClassifier } from '../runtime/positioningGate';
import { POSITIONING_MARKER } from '../runtime/positioningFallback';
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
const slots: CounterStore = { take: async () => 1, drop: async () => undefined };
const SETTINGS = [CORE_PATH_SETTING, RUNTIME_PAYG_SETTING, 'primary_model_id', 'billing_credits_per_usd', 'billing_token_price_multiplier',
  'runtime_rw_v2', 'billing_payg_start_thresholds'];
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
  maxSchemaBytes: 16384, purposes: ['ordinary', 'organizer'], requestFormats: ['serial-tools-v6-reasoning'],
  // The variant free chat sends for interactive reasoning 'off' on this route (reasoning_effort none).
  reasoningVariants: [{ reasoning: { effort: 'none' }, outputLimit: 8192, testedOutputLimit: 512, evidenceReference: 'test-only',
    manifestHash: 'b'.repeat(64), outputStressSamples: 2, includesReasoning: true }], outputLimit: 8192,
  evidence: { reference: 'test-only', manifestHash: 'a'.repeat(64), distinctSamples: 60, messageStressSamples: 12,
    maxVerifiedMessages: 128, completeCells: 15, variantsPerCell: 4, maxPromptToBytes: 0.5, maxPromptToUpper: 0.4,
    outputLimit: 8192, testedOutputLimit: 512, outputSemantics: 'max-tokens-includes-reasoning', includesReasoning: true,
    cacheCovered: true, costBoundPassed: true } };

async function setup(credits = 1000) {
  const actor = randomUUID(), session = randomUUID(), modelId = randomUUID();
  await db.query('insert into profiles(id,credits) values($1,$2)', [actor, credits]);
  await db.query(`insert into credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,idempotency_key,balance_before,balance_after)
    values($1,$3::int,'addition','grant','opening_grant','system',$2,0,$3::int)`, [actor, 'opening_grant:' + actor, credits]);
  await db.query("insert into runtime_sessions(id,actor_id,scope,start_request_id,start_payload) values($1,$2,$3,$4,'{}')",
    [session, actor, JSON.stringify({ kind: 'positioning_draft', probe: randomUUID() }), randomUUID()]);
  const { pricing } = pricingConfig(MODEL, ROUTE, '0.000003', '0.000015');
  // A cache-write price: the free chat freezes its prompt cache and marks one history message (PROMPT-CACHE-ALL).
  (pricing.endpoints[0]!.base as Record<string, string>).input_cache_write = '0.00000375';
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
  // L = ceil(0.04 x 100 x 6) = 24 credits for a free chat on this model.
  await set('billing_payg_start_thresholds', { version: 'core-path-test', thresholds: [{ model: MODEL, purpose: 'ordinary', typicalUsd: '0.04' }] });
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

// The streamed OpenRouter response: text frames, the stop frame and the usage frame with the cost.
const frame = (id: string, extra: Record<string, unknown>) =>
  'data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: MODEL, ...extra }) + '\n\n';
const textFrame = (id: string, content: string) => frame(id, { choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] });
const endFrames = (id: string) => frame(id, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
  + frame(id, { choices: [], usage: { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200, cost: 0.006 } }) + 'data: [DONE]\n\n';
const sse = (id: string, parts: string[]) => new Response(parts.map(part => textFrame(id, part)).join('') + endFrames(id),
  { headers: { 'content-type': 'text/event-stream', 'x-generation-id': id } });

// The synthetic Decisions check: allowed, reporting a provider cost of 0.00003 USD.
const allowGate: PositioningClassifier = async ({ onCost }) => { onCost?.(0.00003); return 'allow'; };
async function turn(input: { actor: string; session: string; text: string; transport: typeof fetch; gate?: PositioningClassifier;
  onEvent?: (event: TurnEvent) => void }) {
  const { admin, calls } = countingAdmin(), events: TurnEvent[] = [];
  await withCatalogRequest(() => runChatTurn({ admin, clients: turnClients(admin), slots, transport: input.transport,
    gate: { classify: input.gate ?? allowGate } },
  { actorId: input.actor, sessionId: input.session, requestId: randomUUID(), text: input.text }, e => { events.push(e); input.onEvent?.(e); }));
  return { events, calls };
}

it('RUNTIME: CORE-PATH-V2 V2-4a: a free-chat turn opens, streams, calls once in three writes, settles once and appends both messages', async () => {
  const f = await setup();
  let posts = 0;
  const bodies: string[] = [];
  const transport: typeof fetch = async (_url, init) => { posts++; bodies.push(String(init?.body));
    return sse('gen-core-' + posts, ['Synthetic ', 'answer']); };
  const first = await turn({ actor: f.actor, session: f.session, text: 'Hello', transport });
  expect(first.events.map(e => e.type), JSON.stringify(first.events)).toEqual(['opened', 'text', 'text', 'result']);
  expect(JSON.parse(bodies[0]!).stream).toBe(true);
  const result = first.events.at(-1) as Extract<TurnEvent, { type: 'result' }>;
  // n = (1000 x 3 + 200 x 15) / 1e6 = 0.006 USD; N = ceil(100 x 0.006 x 6) = 4 credits.
  expect(result).toMatchObject({ body: 'Synthetic answer', settlement: 'done' });
  expect(result.chargedCredits).toBeGreaterThan(0);
  // Frozen at open for the recovery job (V2-8): the model and its nominal price table, so a late receipt is priced as a live one.
  const frozen = (await db.query('select policy from turns where actor_id=$1', [f.actor])).rows[0].policy;
  expect(frozen).toMatchObject({ model: MODEL, pricing: { version: 'nominal-v1', endpointTag: ROUTE } });
  expect((await db.query('select credits from profiles where id=$1', [f.actor])).rows[0].credits).toBe(1000 - result.chargedCredits!);
  // The positioning check: its real cost on the platform's side (stop-loss), nothing in what the user paid.
  expect((await db.query("select c.status,c.nominal_usd::float8 n,c.upper_usd::float8 u,c.usage->>'chargeUser' charge from turn_calls c join turns t on t.id=c.turn_id and t.actor_id=c.actor_id where t.actor_id=$1 and c.call_kind='decision'", [f.actor])).rows)
    .toEqual([{ status: 'ok', n: 0.00003, u: 0.001, charge: 'false' }]);
  expect((await db.query("select role,content from session_messages where session_id=$1 order by seq", [f.session])).rows)
    .toEqual([{ role: 'user', content: 'Hello' }, { role: 'assistant', content: 'Synthetic answer' }]);
  // The second turn is warm (catalog cache): its round trips are the turn's own.
  const second = await turn({ actor: f.actor, session: f.session, text: 'Again', transport });
  expect(second.events.map(e => e.type)).toEqual(['opened', 'text', 'text', 'result']);
  // The second request carries the history and one cache marker on it, and the adapter sent it (no TURN_CALL_DENIED).
  const marked = (JSON.parse(bodies[1]!).messages as Array<{ role: string; content: unknown }>)
    .filter(m => m.role !== 'system' && JSON.stringify(m.content).includes('cache_control'));
  expect(marked).toHaveLength(1);
  // Both requests end with the current message, after the history.
  expect(JSON.parse(bodies[0]!).messages.slice(1)).toEqual([{ role: 'user', content: 'Hello' }]);
  expect(JSON.parse(bodies[1]!).messages.slice(1).map((m: { role: string }) => m.role)).toEqual(['user', 'assistant', 'user']);
  expect(JSON.parse(bodies[1]!).messages.at(-1)).toEqual({ role: 'user', content: 'Again' });
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
    controller.enqueue(new TextEncoder().encode(textFrame('gen-broken', 'Half an ans'))); controller.error(new Error('connection lost'));
  } }), { headers: { 'content-type': 'text/event-stream', 'x-generation-id': 'gen-broken' } }); };
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

it('RUNTIME: CORE-PATH-V2 V2-4a: the client gets text before the provider response ends', async () => {
  const f = await setup();
  let shown!: () => void;
  const textShown = new Promise<void>(resolve => { shown = resolve; });
  const encoder = new TextEncoder();
  const transport: typeof fetch = async () => new Response(new ReadableStream({ async start(controller) {
    controller.enqueue(encoder.encode(textFrame('gen-live', 'First words')));
    // The provider sends nothing more until the client has seen the first words.
    await textShown;
    controller.enqueue(encoder.encode(textFrame('gen-live', ', then the rest') + endFrames('gen-live')));
    controller.close();
  } }), { headers: { 'content-type': 'text/event-stream', 'x-generation-id': 'gen-live' } });
  const out = await turn({ actor: f.actor, session: f.session, text: 'Hello', transport,
    onEvent: e => { if (e.type === 'text') shown(); } });
  expect(out.events.map(e => e.type)).toEqual(['opened', 'text', 'text', 'result']);
  expect(out.events.at(-1)).toMatchObject({ body: 'First words, then the rest' });
});

it('RUNTIME: CORE-PATH-V2 V2-4a: an account without a positioning gets the fallback rule; a refusal is never shown, saved or charged', async () => {
  const f = await setup();
  const bodies: string[] = [];
  const transport: typeof fetch = async (_url, init) => { bodies.push(String(init?.body));
    return sse('gen-refuse', [POSITIONING_MARKER.slice(0, 9), POSITIONING_MARKER.slice(9)]); };
  const out = await turn({ actor: f.actor, session: f.session, text: 'Plan my posts for next week', transport });
  expect(out.events.map(e => e.type)).toEqual(['opened', 'error']);
  expect(out.events.at(-1)).toMatchObject({ code: 'POSITIONING_REQUIRED' });
  expect(JSON.stringify(JSON.parse(bodies[0]!).messages[0])).toContain(POSITIONING_MARKER);
  expect((await db.query('select credits from profiles where id=$1', [f.actor])).rows[0].credits).toBe(1000);
  expect((await db.query('select count(*)::int n from session_messages where session_id=$1', [f.session])).rows[0].n).toBe(0);
  expect((await db.query("select failure_code,charged_credits from turns where actor_id=$1", [f.actor])).rows)
    .toEqual([{ failure_code: 'positioning_required', charged_credits: 0 }]);
});

it('RUNTIME: CORE-PATH-V2 V2-4a: a message over the input budget is refused before anything opens or is sent', async () => {
  const f = await setup();
  const transport = vi.fn<typeof fetch>();
  const out = await turn({ actor: f.actor, session: f.session, text: 'x'.repeat(95_000), transport });
  expect(out.events).toEqual([{ type: 'error', code: 'TURN_INPUT_TOO_LARGE' }]);
  expect(transport).not.toHaveBeenCalled();
  expect((await db.query('select count(*)::int n from turns where actor_id=$1', [f.actor])).rows[0].n).toBe(0);
});

it('RUNTIME: CORE-PATH-V2 V2-4a: a billed response truncated before any text is fully refunded and its cost kept', async () => {
  const f = await setup();
  const transport: typeof fetch = async () => new Response(
    frame('gen-trunc', { choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })
    + frame('gen-trunc', { choices: [{ index: 0, delta: {}, finish_reason: 'length' }] })
    + frame('gen-trunc', { choices: [], usage: { prompt_tokens: 1000, completion_tokens: 8192, total_tokens: 9192, cost: 0.13 } })
    + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream', 'x-generation-id': 'gen-trunc' } });
  const out = await turn({ actor: f.actor, session: f.session, text: 'Hello', transport });
  expect(out.events.at(-1)).toMatchObject({ type: 'error' });
  expect((await db.query("select c.status,c.provider_id from turn_calls c join turns t on t.id=c.turn_id and t.actor_id=c.actor_id where t.actor_id=$1 and c.call_kind='model'", [f.actor])).rows)
    .toEqual([{ status: 'ok', provider_id: 'gen-trunc' }]);
  expect((await db.query('select close_kind,charged_credits from turns where actor_id=$1', [f.actor])).rows)
    .toEqual([{ close_kind: 'failed', charged_credits: 0 }]);
  expect((await db.query('select credits from profiles where id=$1', [f.actor])).rows[0].credits).toBe(1000);
  expect((await db.query('select count(*)::int n from session_messages where session_id=$1', [f.session])).rows[0].n).toBe(0);
});

it('RUNTIME: CORE-PATH-V2 V2-4a: a conversation deleted after the turn opened closes its call as unsent, never as unknown', async () => {
  const f = await setup();
  const transport = vi.fn<typeof fetch>();
  // The positioning check runs between turn_open and the model call's begin: the conversation is deleted there.
  const gate: PositioningClassifier = async () => {
    await db.query('update runtime_sessions set content_deleted_at=now() where id=$1', [f.session]);
    return 'allow';
  };
  const out = await turn({ actor: f.actor, session: f.session, text: 'Hello', transport, gate });
  expect(out.events.at(-1)).toMatchObject({ type: 'error', code: 'TURN_TOMBSTONED' });
  expect(transport).not.toHaveBeenCalled();
  expect((await db.query("select c.status,c.cost_pending from turn_calls c join turns t on t.id=c.turn_id and t.actor_id=c.actor_id where t.actor_id=$1 and c.call_kind='model'", [f.actor])).rows)
    .toEqual([{ status: 'not_sent', cost_pending: false }]);
  expect((await db.query('select close_kind,settlement from turns where actor_id=$1', [f.actor])).rows)
    .toEqual([{ close_kind: 'erased', settlement: 'done' }]);
  expect((await db.query('select credits from profiles where id=$1', [f.actor])).rows[0].credits).toBe(1000);
});

it('RUNTIME: CORE-PATH-V2 V2-4a: a payg profile approved for another use does not admit a free chat', async () => {
  const f = await setup();
  await db.query("update system_settings set value=jsonb_set(value,'{profiles,0,purposes}','[\"fusion_review\"]') where key=$1", [RUNTIME_PAYG_SETTING]);
  clearCatalogCache();
  const transport = vi.fn<typeof fetch>();
  const out = await turn({ actor: f.actor, session: f.session, text: 'Hello', transport });
  expect(out.events).toEqual([{ type: 'error', code: 'TURN_MODEL_NOT_ADMITTED' }]);
  expect(transport).not.toHaveBeenCalled();
});

it('RUNTIME: CORE-PATH-V2 V2-4a: the balance is held against the start threshold L and the freeze is min(G, balance)', async () => {
  // Owner 10-28 (10-01): "余额够一轮正常费用就能开始，冻结取上限和余额的较小值". Here a whole turn's bound G is below L (24):
  // a balance of 50 covers L, so the turn opens and freezes G; what the answer costs above G is the platform's.
  const f = await setup(50);
  const transport: typeof fetch = async () => sse('gen-low', ['Short answer']);
  const out = await turn({ actor: f.actor, session: f.session, text: 'Hello', transport });
  expect(out.events.map(e => e.type)).toEqual(['opened', 'text', 'result']);
  const policy = (await db.query('select policy from turns where actor_id=$1', [f.actor])).rows[0].policy;
  expect(policy.minCredits).toBe(24);
  expect(policy.gCredits).toBeLessThan(24);
  expect(out.events[0]).toMatchObject({ reservedCredits: policy.gCredits });
  const result = out.events.at(-1) as Extract<TurnEvent, { type: 'result' }>;
  expect(result.settlement).toBe('done');
  expect(result.chargedCredits).toBeLessThanOrEqual(policy.gCredits);
  expect((await db.query('select credits from profiles where id=$1', [f.actor])).rows[0].credits).toBe(50 - result.chargedCredits!);
  // Below L nothing opens; without a configured threshold the turn is refused, never guessed.
  const poor = await setup(20);
  expect((await turn({ actor: poor.actor, session: poor.session, text: 'Hello', transport })).events)
    .toEqual([{ type: 'error', code: 'TURN_INSUFFICIENT_CREDITS' }]);
  const unset = await setup();
  await db.query("update system_settings set value=jsonb_set(value,'{thresholds,0,purpose}','\"skill\"') where key='billing_payg_start_thresholds'");
  clearCatalogCache();
  expect((await turn({ actor: unset.actor, session: unset.session, text: 'Hello', transport })).events)
    .toEqual([{ type: 'error', code: 'TURN_START_THRESHOLD_UNCONFIGURED' }]);
});
