/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import { pricingConfig } from '../__tests__/fixtures/runtimePricing';
import { clearTestOpenRouterKey, seedTestOpenRouterKey } from '../models/openRouterKey.testing';
import { ensurePositioningProfilePlans } from '../__tests__/fixtures/positioningProfilePlans';
import { clearCatalogCache, withCatalogRequest } from './settings/catalogCache';
import type { PositioningClassifier } from './admission/positioningGate';
import { POSITIONING_MARKER } from './admission/positioningFallback';
import { runChatTurn, CORE_PATH_SETTING, type ChatDeps } from './chat';
import { turnClients } from './db';
import type { CounterStore } from './limiter';
import { RUNTIME_PAYG_SETTING } from './quote';
import type { TurnEvent } from './sse';
import { JPEG_DATA_URL_PREFIX } from './provider/imageInput';
import { syntheticJpeg } from '../__tests__/fixtures/syntheticJpeg';
import { logger } from '../../lib/logger';

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
  await ensurePositioningProfilePlans(db);
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

async function setup(credits = 1000, options: { image?: boolean } = {}) {
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
  // PUBLISH-MONITOR B2: the administrator admits images on a route by giving its profile LIB-2d's allowance.
  await set(RUNTIME_PAYG_SETTING, { version: 1, enabled: true, policyVersion: 'core-path-test',
    profiles: [options.image ? { ...profile, imageInput: { maxDataUrlBytes: 819_223, maxEdge: 2048 } } : profile] });
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
/** The chat photo bucket as Storage answers it (the local stack has no Storage): what was uploaded and what was removed. */
const photoStore = { uploads: [] as Array<{ path: string; bytes: Buffer }>, removed: [] as string[] };
const PHOTO_OBJECT = '/storage/v1/object/chat-photos';
function countingAdmin() {
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    if (path.startsWith('/rest/v1/')) calls.push(path.slice('/rest/v1/'.length));
    if (path.startsWith(`${PHOTO_OBJECT}/`) && init?.method === 'POST') {
      const key = decodeURIComponent(path.slice(PHOTO_OBJECT.length + 1));
      photoStore.uploads.push({ path: key, bytes: Buffer.from(await new Response(init.body).arrayBuffer()) });
      return Response.json({ Key: `chat-photos/${key}`, Id: randomUUID() });
    }
    if (path === PHOTO_OBJECT && init?.method === 'DELETE') {
      const prefixes = (JSON.parse(String(init.body)) as { prefixes: string[] }).prefixes;
      photoStore.removed.push(...prefixes);
      return Response.json(prefixes.map(name => ({ name })));
    }
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
  // A cost inside the call's frozen bound (this fixture's bound is small): above it the model would be blocked (budget_conflict).
  + frame(id, { choices: [], usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1, cost: 0.000003 } }) + 'data: [DONE]\n\n';
const sse = (id: string, parts: string[]) => new Response(parts.map(part => textFrame(id, part)).join('') + endFrames(id),
  { headers: { 'content-type': 'text/event-stream', 'x-generation-id': id } });

// The synthetic Decisions check: allowed, reporting a provider cost of 0.00003 USD.
const allowGate: PositioningClassifier = async ({ onCost }) => { onCost?.(0.00003); return 'allow'; };
// The runtime rate limits and pause (newWorkGate) are Redis-backed; here a stub that admits, or refuses as a case needs.
const admit = async () => ({ ok: true as const });
type NewWork = ChatDeps['newWork'];
type RpcAnswer = PromiseLike<{ data: unknown; error: unknown }>;
/** A turn's turn_close calls in the test's hands: `send` passes the call on to the database. */
type OnClose = (args: Record<string, unknown>, send: () => RpcAnswer) => RpcAnswer;
const LOST: Awaited<RpcAnswer> = { data: null, error: { message: 'TypeError: fetch failed' } };
async function turn(input: { actor: string; session: string; text: string; transport: typeof fetch; gate?: PositioningClassifier;
  onEvent?: (event: TurnEvent) => void; newWork?: NewWork; images?: string[]; requestId?: string; slots?: CounterStore; onClose?: OnClose }) {
  const { admin, calls } = countingAdmin(), events: TurnEvent[] = [];
  const direct = turnClients(admin), { onClose } = input;
  const clients = onClose ? { ...direct, write: { rpc: (name: string, args: Record<string, unknown>) => name === 'turn_close'
    ? onClose(args, () => direct.write.rpc(name, args)) : direct.write.rpc(name, args) } as unknown as typeof direct.write } : direct;
  await withCatalogRequest(() => runChatTurn({ admin, clients, slots: input.slots ?? slots, transport: input.transport,
    gate: { classify: input.gate ?? allowGate }, newWork: input.newWork ?? { message: admit, calls: admit } },
  { actorId: input.actor, sessionId: input.session, requestId: input.requestId ?? randomUUID(), text: input.text,
    ...(input.images ? { images: input.images } : {}) }, e => { events.push(e); input.onEvent?.(e); }));
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
  // n = 1 x 0.000003 = 0.000003 USD; N = ceil(100 x 0.000003 x 6) = 1 credit.
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

// Owner 2026-11-11 and the review of #1860: the part of a cut-off reply the user was shown is saved and the turn closes as delivered,
// charged by its receipt once the cost is known. Before, nothing was saved and (under the 11-11 rule) nothing would have been
// charged: a slow model asked for a very long answer was a free answer every time.
// One frame per read, then the connection is lost: an error raised with frames still queued would drop them unread.
const brokenAfter = (id: string, frames: string[]): typeof fetch => async () => {
  let sent = 0;
  return new Response(new ReadableStream({ pull(controller) {
    if (sent < frames.length) controller.enqueue(new TextEncoder().encode(frames[sent++]!));
    else controller.error(new Error('connection lost'));
  } }), { headers: { 'content-type': 'text/event-stream', 'x-generation-id': id } });
};
const modelCalls = async (actor: string) => (await db.query(`select c.seq,c.status,c.cost_pending,c.provider_id from turn_calls c
  join turns t on t.id=c.turn_id and t.actor_id=c.actor_id where t.actor_id=$1 and c.call_kind='model' order by c.seq`, [actor])).rows;

it('RUNTIME: CORE-PATH-V2 V2-4a: a response broken after text was shown keeps the provider id and the freeze, saves the shown part and is charged by its receipt, once', async () => {
  const f = await setup();
  let posts = 0;
  const broken = brokenAfter('gen-broken', [textFrame('gen-broken', 'Half an ans'), textFrame('gen-broken', 'wer \ud83d')]);
  const transport: typeof fetch = async (...args) => { posts++; return broken(...args); };
  const out = await turn({ actor: f.actor, session: f.session, text: 'Hello', transport });
  expect(out.events.map(e => e.type), JSON.stringify(out.events)).toEqual(['opened', 'text', 'text', 'error']);
  expect(out.events.at(-1)).toMatchObject({ type: 'error', code: 'TURN_REPLY_CUT' });
  expect(posts).toBe(1);
  const calls = await modelCalls(f.actor);
  expect(calls).toEqual([{ seq: calls[0]!.seq, status: 'unknown', cost_pending: true, provider_id: 'gen-broken' }]);
  const t = (await db.query('select id,close_kind,settlement,charged_credits,reserved_credits,delivered,failure_code from turns where actor_id=$1', [f.actor])).rows[0];
  // Delivered: what was shown is the saved answer (without the half emoji the cut left). The cost is not known yet, so the freeze stays.
  expect(t).toMatchObject({ close_kind: 'completed', settlement: 'pending', charged_credits: null, delivered: true, failure_code: 'turn_reply_cut' });
  expect((await db.query('select credits from profiles where id=$1', [f.actor])).rows[0].credits).toBe(1000 - t.reserved_credits);
  expect((await db.query('select role,content from session_messages where session_id=$1 order by seq', [f.session])).rows)
    .toEqual([{ role: 'user', content: 'Hello' }, { role: 'assistant', content: 'Half an answer' }]);
  // The receipt recovery finds: charged what it says, once; settling again changes nothing.
  const admin = countingAdmin().admin, turnId = Number(t.id);
  expect((await admin.rpc('turn_call_record', { p_actor_id: f.actor, p_turn_id: turnId, p_seq: calls[0]!.seq, p_status: 'ok', p_nominal_usd: '0.000003',
    p_actual_usd: '0.000003', p_usage: {}, p_provider_id: 'gen-broken', p_payload_hash: 'c'.repeat(64), p_raw: null })).error).toBeNull();
  const settle = { p_actor_id: f.actor, p_turn_id: turnId, p_action: 'settle' };
  const both = await Promise.all([admin.rpc('turn_recover', settle), countingAdmin().admin.rpc('turn_recover', settle)]);
  expect(both.map(r => r.error)).toEqual([null, null]);
  expect(both.map(r => Boolean((r.data as { skipped?: boolean }).skipped)).sort()).toEqual([false, true]);
  const settled = (await db.query('select close_kind,settlement,charged_credits,delivered from turns where actor_id=$1', [f.actor])).rows[0];
  expect(settled).toMatchObject({ close_kind: 'completed', settlement: 'done', delivered: true });
  expect(settled.charged_credits).toBeGreaterThan(0);
  expect((await db.query('select credits from profiles where id=$1', [f.actor])).rows[0].credits).toBe(1000 - settled.charged_credits);
  expect((await admin.rpc('turn_recover', settle)).data).toMatchObject({ skipped: true });
  expect((await db.query('select credits from profiles where id=$1', [f.actor])).rows[0].credits).toBe(1000 - settled.charged_credits);
});

it('RUNTIME: CORE-PATH-V2 V2-4a: a response broken before any text was shown saves nothing, keeps the freeze for recovery and is then charged nothing', async () => {
  const f = await setup();
  // The role frame carries no text: the user was shown nothing.
  const transport = brokenAfter('gen-empty', [frame('gen-empty', { choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })]);
  const out = await turn({ actor: f.actor, session: f.session, text: 'Hello', transport });
  expect(out.events.map(e => e.type), JSON.stringify(out.events)).toEqual(['opened', 'error']);
  expect(out.events.at(-1)).toMatchObject({ type: 'error', code: 'TURN_CALL_UNKNOWN' });
  const calls = await modelCalls(f.actor);
  expect(calls).toEqual([{ seq: calls[0]!.seq, status: 'unknown', cost_pending: true, provider_id: 'gen-empty' }]);
  const t = (await db.query('select id,close_kind,settlement,charged_credits,reserved_credits,delivered from turns where actor_id=$1', [f.actor])).rows[0];
  expect(t).toMatchObject({ close_kind: 'interrupted', settlement: 'pending', charged_credits: null, delivered: false });
  expect((await db.query('select credits from profiles where id=$1', [f.actor])).rows[0].credits).toBe(1000 - t.reserved_credits);
  expect((await db.query('select count(*)::int n from session_messages where session_id=$1', [f.session])).rows[0].n).toBe(0);
  // Owner 2026-11-11: nothing was shown or saved, so the receipt recovery finds is Graylum's; the whole freeze returns.
  const admin = countingAdmin().admin, turnId = Number(t.id);
  expect((await admin.rpc('turn_call_record', { p_actor_id: f.actor, p_turn_id: turnId, p_seq: calls[0]!.seq, p_status: 'ok', p_nominal_usd: '0.000003',
    p_actual_usd: '0.000003', p_usage: {}, p_provider_id: 'gen-empty', p_payload_hash: 'c'.repeat(64), p_raw: null })).error).toBeNull();
  expect((await admin.rpc('turn_recover', { p_actor_id: f.actor, p_turn_id: turnId, p_action: 'settle' })).data)
    .toMatchObject({ closeKind: 'interrupted', chargedCredits: 0, settlement: 'done' });
  expect((await db.query('select credits from profiles where id=$1', [f.actor])).rows[0].credits).toBe(1000);
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

it('RUNTIME: TURN-STEPS: a chosen social-media Skill is refused for an account without a positioning, before any model call, with nothing charged', async () => {
  const f = await setup(), moduleId = randomUUID(), skillId = randomUUID(), revisionId = randomUUID();
  const entry = (social: boolean) => ({ name: 'Storyboard', description: 'The method', moduleId, skillId, revisionId, packageId: skillId,
    packageHash: 'b'.repeat(64), resultBytes: 10, ...(social ? { social: true as const } : {}) });
  const send = async (social: boolean) => {
    const events: TurnEvent[] = [], bodies: string[] = [], { admin } = countingAdmin();
    const transport: typeof fetch = async (_url, init) => { bodies.push(String(init?.body)); return sse('gen-chosen-' + bodies.length, ['Plain answer']); };
    await withCatalogRequest(() => runChatTurn({ admin, clients: turnClients(admin), slots, transport, gate: { classify: allowGate },
      newWork: { message: admit, calls: admit },
      tools: { skills: async () => ({ catalog: [entry(social)], prepared: new Map([['Storyboard', 'method text']]) }) } },
    { actorId: f.actor, sessionId: f.session, requestId: randomUUID(), text: 'Write a storyboard', chosen: { moduleId } }, e => { events.push(e); }));
    return { events, bodies };
  };
  // The Skill the user chose cannot be loaded for this account (the catalog hides it): the turn ends at once, it does not answer without it.
  const refused = await send(true);
  expect(refused.events.at(-1)).toMatchObject({ type: 'error', code: 'POSITIONING_REQUIRED' });
  expect(refused.bodies).toEqual([]);
  expect(refused.events.some(event => event.type === 'step' || event.type === 'text')).toBe(false);
  expect((await db.query('select credits from profiles where id=$1', [f.actor])).rows[0].credits).toBe(1000);
  expect((await db.query('select failure_code,charged_credits from turns where actor_id=$1', [f.actor])).rows)
    .toEqual([{ failure_code: 'positioning_required', charged_credits: 0 }]);
  // The same choice of a Skill that is not social-media is told to the model and goes on.
  const allowed = await send(false);
  expect(allowed.events.at(-1)).toMatchObject({ type: 'result' });
  expect(allowed.bodies[0]).toContain('call load_skill with that name first');
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

it('RUNTIME: CORE-PATH-V2 3.3.2 item 10: the model call takes its in-flight limit from runtime_payg.modelConcurrency, 150 without one', async () => {
  // A counter that reports `first` live calls on its first take and one after: a call within the limit takes once; a call over it
  // gives the slot back, waits 100 ms and takes again.
  const takesWith = async (first: number, configured?: number) => {
    const f = await setup();
    if (configured !== undefined) await db.query("update system_settings set value=jsonb_set(value,'{modelConcurrency}',$2) where key=$1",
      [RUNTIME_PAYG_SETTING, JSON.stringify({ [MODEL]: configured })]);
    clearCatalogCache();
    let takes = 0;
    const counter: CounterStore = { take: async () => takes++ === 0 ? first : 1, drop: async () => undefined };
    const out = await turn({ actor: f.actor, session: f.session, text: 'Hello', slots: counter,
      transport: async () => sse('gen-limit-' + randomUUID(), ['Synthetic answer']) });
    expect(out.events.at(-1), JSON.stringify(out.events)).toMatchObject({ type: 'result' });
    return takes;
  };
  // No value: 150 in flight is within the limit (the old fixed 20 would have waited), 151 is over it.
  expect(await takesWith(150)).toBe(1);
  expect(await takesWith(151)).toBe(2);
  // The configured value of the model.
  expect(await takesWith(2, 2)).toBe(1);
  expect(await takesWith(3, 2)).toBe(2);
  // A value that is not a usable limit falls back to 150; the turn is still admitted.
  expect(await takesWith(150, 0)).toBe(1);
  expect(await takesWith(151, 0)).toBe(2);
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
  expect(out.events[0]).toMatchObject({ reservedCredits: policy.holdCredits });
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

it('RUNTIME: CORE-PATH-V2 V2-4a: the one-switch pause and the call limits refuse before anything is frozen or sent', async () => {
  const transport = vi.fn<typeof fetch>();
  // Paused by the administrator (stopNewCalls) or over the message limit: refused before the turn opens.
  const paused = await setup();
  const out = await turn({ actor: paused.actor, session: paused.session, text: 'Hello', transport,
    newWork: { message: async () => ({ ok: false, reason: 'paused', retryAfter: 60 }), calls: admit } });
  expect(out.events).toEqual([{ type: 'error', code: 'TURN_NEW_CALLS_PAUSED' }]);
  expect((await db.query('select count(*)::int n from turns where actor_id=$1', [paused.actor])).rows[0].n).toBe(0);
  // Over the daily call limit at the model call: no call row, nothing sent, the turn closes with a full refund.
  const limited = await setup();
  const out2 = await turn({ actor: limited.actor, session: limited.session, text: 'Hello', transport,
    newWork: { message: admit, calls: async () => ({ ok: false, reason: 'call_limited', retryAfter: 3600, window: 'day' }) } });
  expect(out2.events.at(-1)).toMatchObject({ type: 'error', code: 'TURN_RATE_LIMITED' });
  expect(transport).not.toHaveBeenCalled();
  expect((await db.query("select count(*)::int n from turn_calls c join turns t on t.id=c.turn_id and t.actor_id=c.actor_id where t.actor_id=$1 and c.call_kind='model'", [limited.actor])).rows[0].n).toBe(0);
  expect((await db.query('select close_kind,charged_credits from turns where actor_id=$1', [limited.actor])).rows)
    .toEqual([{ close_kind: 'failed', charged_credits: 0 }]);
  expect((await db.query('select credits from profiles where id=$1', [limited.actor])).rows[0].credits).toBe(1000);
});

// A work item as opc_handoff leaves it: a published Skill, the positioning version it came from, its account and item, and its
// conversation with the brief frozen by runtime_material. The item is an article.
async function workItem(actor: string, contentType = 'article') {
  const skillId = randomUUID(), moduleId = randomUUID(), revisionId = randomUUID(), source = randomUUID(), round = randomUUID(), version = randomUUID();
  const account = randomUUID(), item = randomUUID(), key = randomUUID(), plan = randomUUID(), business = randomUUID(), session = randomUUID();
  const hash = 'b'.repeat(64), entry = 'a'.repeat(64);
  await db.query('begin'); // one now(): a published skill must match its revision's time
  await db.query("insert into skills(id,skill_key,content_kind) values($1,$2,'directory')", [skillId, 'work-' + skillId]);
  await db.query("insert into modules(id,title,skill_id,active) values($1,'Work method',$2,true)", [moduleId, skillId]);
  await db.query("insert into skill_revisions(id,skill_id,version,content,content_hash,published_by) values($1,$2,1,'method',$3,$4)", [revisionId, skillId, entry, actor]);
  await db.query(`insert into skill_packages(revision_id,skill_id,request_id,manifest,package_hash,entry_hash,expected_version,actor_id)
    values($1,$2,$3,$4,$5,$6,0,$7)`, [revisionId, skillId, randomUUID(), JSON.stringify({ packageHash: hash }), hash, entry, actor]);
  await db.query(`update skills set status='published',published_version=1,published_content='method',published_content_hash=$2,published_at=now(),
    published_by=$3 where id=$1`, [skillId, entry, actor]);
  await db.query('commit');
  await db.query(`insert into artifact_projects(id,actor_id,module_id,skill_id,account,work_title,current_version) values
    ($1,$4,$5,$6,$7,'source',1),($2,$4,$5,$6,$8,'account',0),($3,$4,$5,$6,$9,'item',0)`,
  [source, account, item, actor, moduleId, skillId, 'source-' + source, 'account-' + account, 'item-' + item]);
  await db.query('update artifact_projects set source_project_id=$2 where id=$1', [item, account]);
  await db.query(`insert into artifact_rounds(id,project_id,revision_id,package_hash,workflow,workflow_hash,template_hash,state,steps)
    values($1,$2,$3,$4,'{}',repeat('c',64),repeat('d',64),'published','{}')`, [round, source, revisionId, hash]);
  await db.query(`insert into artifact_versions(id,project_id,round_id,version,report,report_hash,evidence_ids)
    values($1,$2,$3,1,'{}',repeat('e',64),'[]')`, [version, source, round]);
  const draft = (await db.query('select bill2_create_draft($1) v', [actor])).rows[0].v as string;
  const registration = 'work-' + randomUUID(), start = randomUUID();
  await db.query("insert into runtime_sessions(id,actor_id,scope,start_request_id,start_payload) values($1,$2,$3,$4,'{}')",
    [start, actor, JSON.stringify({ kind: 'positioning_draft', draftId: draft }), randomUUID()]);
  await db.query("insert into artifact_workflows(id,module_id,skill_id,revision_id,workflow,label) values($1,$2,$3,$4,'{}','Work')", [registration, moduleId, skillId, revisionId]);
  await db.query("insert into opc_drafts values($1,$2,$3,$4,$5,$6,$7,'manual')", [draft, actor, source, round, start, randomUUID(), registration]);
  await db.query("insert into opc_businesses(id,actor_id,name,current_source_version_id) values($1,$2,'business',$3)", [business, actor, version]);
  await db.query('insert into opc_draft_businesses values($1,$2)', [draft, business]);
  await db.query("insert into opc_accounts(project_id,actor_id,platform,account_key,source_version_id,business_id) values($1,$2,'fixture',$3,$4,$5)",
    [account, actor, 'work-' + account, version, business]);
  await db.query('insert into opc_plans(id,draft_id,version,source_version_id,request_id,request,body) values($1,$2,1,$3,$4,$5,$6)',
    [plan, draft, version, randomUUID(), JSON.stringify({ sourceVersionId: version }), JSON.stringify([{ id: key, contentType }])]);
  await db.query("insert into opc_items(work_item_id,plan_id,item_key,account_project_id,source_version_id,brief,day) values($1,$2,$3,$4,$5,'brief',current_date)",
    [item, plan, key, account, version]);
  await db.query("insert into runtime_sessions(id,actor_id,scope,start_request_id,start_payload) values($1,$2,$3,$4,'{}')",
    [session, actor, JSON.stringify({ kind: 'work_item', projectId: account, workItemId: item }), randomUUID()]);
  await db.query("insert into runtime_scope_material(session_id,revision,request_id,request,content,content_hash) values($1,1,$2,'{}',$3,repeat('f',64))",
    [session, randomUUID(), JSON.stringify({ brief: 'WORK_BRIEF', material: 'WORK_MATERIAL', work: {} })]);
  return { session, business, item, skill: { moduleId, skillId, revisionId } };
}

it('RUNTIME: CORE-PATH-V2 V2-10b: a work turn reads its checks, brief and bound Skill before opening, and its result saves by the turn', async () => {
  const f = await setup(), w = await workItem(f.actor);
  const entry = { name: 'Work method', description: 'The method', ...w.skill, packageId: w.skill.skillId, packageHash: 'b'.repeat(64), resultBytes: 10 };
  const pins: unknown[] = [], bodies: string[] = [];
  const transport: typeof fetch = async (_url, init) => { bodies.push(String(init?.body)); return sse('gen-work-' + bodies.length, ['Saved ', 'body']); };
  const { admin, calls } = countingAdmin();
  const send = async (text: string, requestId = randomUUID()) => {
    const events: TurnEvent[] = [];
    await withCatalogRequest(() => runChatTurn({ admin, clients: turnClients(admin), slots, transport, gate: { classify: allowGate },
      newWork: { message: admit, calls: admit },
      tools: { skills: async (_actor, pin) => { pins.push(pin); return { catalog: [entry], prepared: new Map([[entry.name, 'method text']]) }; } } },
    { actorId: f.actor, sessionId: w.session, requestId, text, workItem: true, chosen: { moduleId: w.skill.moduleId } }, e => { events.push(e); }));
    return events;
  };
  // Refused before anything opens: a script request on an article.
  expect(await send('[OPC_SCRIPT_V1] draft')).toEqual([{ type: 'error', code: 'OPC_VIDEO_TYPE_REQUIRED' }]);
  expect((await db.query('select count(*)::int n from turns where actor_id=$1', [f.actor])).rows[0].n).toBe(0);
  // Allowed: the bound revision is asked for and frozen, the brief goes to the model as data and is not saved with the message.
  const requestId = randomUUID(), events = await send('Write it', requestId);
  expect(events.at(-1), JSON.stringify(events)).toMatchObject({ type: 'result' });
  expect(pins.at(-1)).toEqual(w.skill);
  expect(bodies[0]).toContain('WORK_BRIEF');
  const turnId = (events.at(-1) as Extract<TurnEvent, { type: 'result' }>).turnId;
  const row = (await db.query('select policy from turns where actor_id=$1 and id=$2', [f.actor, turnId])).rows[0];
  expect(row.policy.workSkill).toEqual(w.skill);
  expect((await db.query('select role,content from session_messages where session_id=$1 order by seq', [w.session])).rows)
    .toEqual([{ role: 'user', content: 'Write it' }, { role: 'assistant', content: 'Saved body' }]);
  // The same request replays: no second turn, no second call to the model.
  expect((await send('Write it', requestId)).at(-1)).toMatchObject({ type: 'error', code: 'TURN_REQUEST_REPLAYED' });
  expect(bodies).toHaveLength(1);
  expect(calls.filter(call => call === 'rpc/opc_work_check').length).toBeGreaterThanOrEqual(3);
  const saved = await admin.rpc('opc_work_result_turn', { p_actor_id: f.actor, p_turn_id: turnId });
  expect(saved.error).toBeNull();
  expect((await admin.rpc('opc_work_result_turn', { p_actor_id: f.actor, p_turn_id: turnId })).data).toEqual(saved.data);
  // Archived: refused before anything opens, nothing sent or frozen.
  await db.query('update opc_businesses set archived_at=now() where id=$1', [w.business]);
  const balance = (await db.query('select credits from profiles where id=$1', [f.actor])).rows[0].credits;
  expect(await send('Again')).toEqual([{ type: 'error', code: 'OPC_BUSINESS_ARCHIVED' }]);
  expect(bodies).toHaveLength(1);
  expect((await db.query('select credits from profiles where id=$1', [f.actor])).rows[0].credits).toBe(balance);
});

it('RUNTIME: CORE-PATH-V2 V2-10b C2: a package needs its claim and freezes its material; a derived Skill reads and freezes its saved source', async () => {
  const f = await setup(), w = await workItem(f.actor, 'video');
  const entry = { name: 'Work method', description: 'The method', ...w.skill, packageId: w.skill.skillId, packageHash: 'b'.repeat(64), resultBytes: 10 };
  const bodies: string[] = [];
  const transport: typeof fetch = async (_url, init) => { bodies.push(String(init?.body)); return sse('gen-c2-' + bodies.length, ['{"storyboard":"S"}']); };
  const { admin } = countingAdmin();
  const send = async (text: string, requestId: string, contentSource?: 'script') => {
    const events: TurnEvent[] = [];
    await withCatalogRequest(() => runChatTurn({ admin, clients: turnClients(admin), slots, transport, gate: { classify: allowGate },
      newWork: { message: admit, calls: admit },
      tools: { skills: async () => ({ catalog: [entry], prepared: new Map([[entry.name, 'method text']]), ...(contentSource ? { contentSource } : {}) }) } },
    { actorId: f.actor, sessionId: w.session, requestId, text, workItem: true, chosen: { moduleId: w.skill.moduleId } }, e => { events.push(e); }));
    return events;
  };
  const policyOf = async (requestId: string) => (await db.query('select policy from turns where actor_id=$1 and request_id=$2', [f.actor, requestId])).rows[0].policy;
  expect(await send('[OPC_VIDEO_PACKAGE_V1] storyboard', randomUUID())).toEqual([{ type: 'error', code: 'OPC_CONTENT_BINDING' }]);
  expect(bodies).toHaveLength(0);
  expect(await send('Derive', randomUUID(), 'script')).toEqual([{ type: 'error', code: 'RUNTIME_CONTENT_SOURCE_MISSING' }]);
  const script = randomUUID(), request = randomUUID();
  await db.query("insert into opc_content_versions(id,actor_id,work_item_id,kind,version,status,body,request_id) values($1,$2,$3,'script',1,'final','SAVED_SCRIPT',$4)",
    [script, f.actor, w.item, randomUUID()]);
  // A derived Skill: the database's version goes to the model, is frozen, and is not saved with the message.
  const derived = randomUUID();
  expect((await send('Derive', derived, 'script')).at(-1)).toMatchObject({ type: 'result' });
  expect(bodies.at(-1)).toContain('SAVED_SCRIPT');
  expect((await policyOf(derived)).workSource).toEqual({ contentId: script, kind: 'script' });
  expect(JSON.stringify((await db.query('select content from session_messages where session_id=$1', [w.session])).rows)).not.toContain('SAVED_SCRIPT');
  // The claim: its revision is what the package reads and freezes.
  const claimed = await admin.rpc('opc_video_material_prepare', { p_actor_id: f.actor, p_work_item_id: w.item, p_request_id: request, p_source_script_id: script,
    p_storyboard: true, p_editing: false, p_expected_storyboard_version: 0, p_expected_editing_version: 0 });
  expect(claimed.error).toBeNull();
  // A claim that has not opened holds nobody back: a turn reads the material and uses none of it up.
  expect((await send('Other', randomUUID())).at(-1)).toMatchObject({ type: 'result' });
  expect((await send('[OPC_VIDEO_PACKAGE_V1] storyboard', request)).at(-1)).toMatchObject({ type: 'result' });
  expect(bodies.at(-1)).toContain('已定稿口播稿：SAVED_SCRIPT');
  const frozen = (await policyOf(request)).workMaterial, revision = (claimed.data as { revision: number }).revision;
  expect(frozen.revision).toBe(revision);
  expect(frozen.hash).toBe((claimed.data as { hash: string }).hash);
});

it('RUNTIME: CONTENT-CONVERSATION-2: a video topic window is given its final script and storyboard on every turn and freezes them as a list', async () => {
  const f = await setup(), w = await workItem(f.actor, 'video');
  const entry = { name: 'Work method', description: 'The method', ...w.skill, packageId: w.skill.skillId, packageHash: 'b'.repeat(64), resultBytes: 10 };
  const bodies: string[] = [];
  const transport: typeof fetch = async (_url, init) => { bodies.push(String(init?.body)); return sse('gen-cc2-' + bodies.length, ['Reply']); };
  const { admin } = countingAdmin();
  const send = async (requestId: string, workItem = true, sessionId = w.session) => {
    const events: TurnEvent[] = [];
    await withCatalogRequest(() => runChatTurn({ admin, clients: turnClients(admin), slots, transport, gate: { classify: allowGate },
      newWork: { message: admit, calls: admit },
      tools: { skills: async () => ({ catalog: [entry], prepared: new Map([[entry.name, 'method text']]) }) } },
    { actorId: f.actor, sessionId, requestId, text: '出分镜', ...(workItem ? { workItem: true } : {}) }, e => { events.push(e); }));
    return events;
  };
  const policyOf = async (requestId: string) => (await db.query('select policy from turns where actor_id=$1 and request_id=$2', [f.actor, requestId])).rows[0].policy;
  // No saved script yet: the turn runs, with the topic-window rule and no source.
  const first = randomUUID();
  expect((await send(first)).at(-1)).toMatchObject({ type: 'result' });
  expect(bodies.at(-1)).toContain('Host rule (topic window)');
  expect((await policyOf(first)).workSources).toBeUndefined();
  const script = randomUUID(), story = randomUUID();
  await db.query("insert into opc_content_versions(id,actor_id,work_item_id,kind,version,status,body,request_id) values($1,$2,$3,'script',1,'final','CC2_SCRIPT',$4)",
    [script, f.actor, w.item, randomUUID()]);
  // The final script, then its storyboard: both go to the model as data, are frozen in order, and are not saved with the message.
  const second = randomUUID();
  expect((await send(second)).at(-1)).toMatchObject({ type: 'result' });
  expect(bodies.at(-1)).toContain('CC2_SCRIPT');
  expect((await policyOf(second)).workSources).toEqual([{ contentId: script, kind: 'script' }]);
  await db.query(`insert into opc_content_versions(id,actor_id,work_item_id,kind,version,status,body,source_content_id,request_id)
    values($1,$2,$3,'storyboard',1,'draft','CC2_STORY',$4,$5)`, [story, f.actor, w.item, script, randomUUID()]);
  const third = randomUUID();
  expect((await send(third)).at(-1)).toMatchObject({ type: 'result' });
  expect(bodies.at(-1)).toContain('CC2_STORY');
  expect((await policyOf(third)).workSources).toEqual([{ contentId: script, kind: 'script' }, { contentId: story, kind: 'storyboard' }]);
  expect(JSON.stringify((await db.query('select content from session_messages where session_id=$1', [w.session])).rows)).not.toMatch(/CC2_SCRIPT|CC2_STORY/);
  // The reply of that turn saves as editing advice reading the listed storyboard.
  const turnId = (await db.query('select id from turns where actor_id=$1 and request_id=$2', [f.actor, third])).rows[0].id;
  const saved = await admin.rpc('opc_content_from_turn', { p_actor_id: f.actor, p_work_item_id: w.item, p_request_id: randomUUID(),
    p_expected_version: 0, p_kind: 'editing', p_status: 'draft', p_turn_id: turnId });
  expect(saved.error).toBeNull();
  expect((await db.query('select source_content_id from opc_content_versions where id=$1', [(saved.data as { id: string }).id])).rows[0].source_content_id).toBe(story);
  // A free chat never gets the topic-window rule.
  const free = randomUUID();
  expect((await send(free, false, f.session)).at(-1)).toMatchObject({ type: 'result' });
  expect(bodies.at(-1)).not.toContain('Host rule (topic window)');
});

// PUBLISH-MONITOR B2: a free chat message with one screenshot. The image goes to the model with that message and is written nowhere.
const screenshot = () => {
  // A header-only JPEG with random filler after the scan header, so its bytes cannot match anything else in the database.
  const jpeg = syntheticJpeg(1170, 2048);
  return JPEG_DATA_URL_PREFIX + Buffer.concat([jpeg.subarray(0, -2), randomBytes(4096), Buffer.from([0xff, 0xd9])]).toString('base64');
};
/** Rows of any public or storage table whose text holds a 48-character piece of the image (base64, or the bytes as hex). */
async function imageTraces(url: string) {
  const payload = url.slice(JPEG_DATA_URL_PREFIX.length), bytes = Buffer.from(payload, 'base64');
  const pieces = [payload.slice(1000, 1048), payload.slice(-200, -152), bytes.subarray(800, 824).toString('hex')];
  const tables = (await db.query(`select quote_ident(table_schema)||'.'||quote_ident(table_name) t from information_schema.tables
    where table_schema in ('public','storage','auth') and table_type='BASE TABLE'`)).rows.map(r => r.t as string);
  const found: string[] = [];
  for (const table of tables)
    for (const piece of pieces)
      if ((await db.query(`select count(*)::int n from ${table} x where strpos(x::text, $1) > 0`, [piece])).rows[0].n) found.push(table);
  return found;
}
const logged = () => {
  const spies = (['debug', 'info', 'warn', 'error'] as const).map(level => vi.spyOn(logger, level));
  return { text: () => JSON.stringify(spies.flatMap(spy => spy.mock.calls)), restore: () => spies.forEach(spy => spy.mockRestore()) };
};

it('RUNTIME: PUBLISH-MONITOR B2: screenshots go to the model with their message, are charged as the turn, and are kept with it in Storage only', async () => {
  const f = await setup(1000, { image: true }), url = screenshot(), second = screenshot(), logs = logged();
  photoStore.uploads.length = 0; photoStore.removed.length = 0;
  const bodies: string[] = [];
  const transport: typeof fetch = async (_url, init) => { bodies.push(String(init?.body)); return sse('gen-image-1', ['看到了', '完播率 42%']); };
  const requestId = randomUUID();
  const sent = await turn({ actor: f.actor, session: f.session, text: '帮我看看这条作品的后台数据', transport, images: [url, second], requestId });
  expect(sent.events.map(e => e.type), JSON.stringify(sent.events)).toEqual(['opened', 'text', 'text', 'result']);
  // The model got the text (marked) and both images in one user message, with OpenRouter told not to charge for an image itself.
  const body = JSON.parse(bodies[0]!);
  const user = body.messages.at(-1);
  expect(user.role).toBe('user');
  expect(user.content).toEqual([{ type: 'text', text: '[截图×2] 帮我看看这条作品的后台数据' }, { type: 'image_url', image_url: { url } },
    { type: 'image_url', image_url: { url: second } }]);
  expect(body.provider.max_price.image).toBe(0);
  // Charged by usage as any turn: N = ceil(q x n x m) of the one receipt, once.
  const result = sent.events.at(-1) as Extract<TurnEvent, { type: 'result' }>;
  // The positioning check of this new account is the platform's (never charged); the user pays the model call.
  const receipt = (await db.query("select nominal_usd,multiplier from turn_calls c join turns t on t.id=c.turn_id where t.actor_id=$1 and c.call_kind='model'",
    [f.actor])).rows;
  expect(receipt).toHaveLength(1);
  expect(result.chargedCredits).toBe(Math.ceil(100 * Number(receipt[0].nominal_usd) * Number(receipt[0].multiplier)));
  expect((await db.query('select credits from profiles where id=$1', [f.actor])).rows[0].credits).toBe(1000 - result.chargedCredits!);
  // The conversation keeps the marked text, never the image.
  expect((await db.query("select content from session_messages where session_id=$1 and role='user'", [f.session])).rows)
    .toEqual([{ content: '[截图×2] 帮我看看这条作品的后台数据' }]);
  // The same request again opens nothing, sends nothing and charges nothing more.
  const again = await turn({ actor: f.actor, session: f.session, text: '帮我看看这条作品的后台数据', transport, images: [url, second], requestId });
  expect(again.events.at(-1)).toMatchObject({ type: 'error', code: 'TURN_REQUEST_REPLAYED' });
  expect(bodies).toHaveLength(1);
  expect((await db.query('select credits from profiles where id=$1', [f.actor])).rows[0].credits).toBe(1000 - result.chargedCredits!);
  // Owner 2026-11-13 (replacing 10-27 "截图不长期保留"): the photos are kept with this message in the chat photo bucket, by turn
  // and position, once (the replayed request uploads nothing more). No table holds any piece of them, and no log line does.
  const turnId = result.turnId, decoded = (data: string) => Buffer.from(data.slice(JPEG_DATA_URL_PREFIX.length), 'base64');
  expect(photoStore.uploads.map(upload => upload.path.replace(/\.[0-9a-f-]{36}\.jpg$/, '')).sort())
    .toEqual([`${f.actor}/${f.session}.${turnId}.0`, `${f.actor}/${f.session}.${turnId}.1`]);
  expect(photoStore.uploads.find(upload => upload.path.includes(`.${turnId}.0.`))!.bytes.equals(decoded(url))).toBe(true);
  expect(photoStore.removed).toEqual([]);
  expect(await imageTraces(url)).toEqual([]);
  expect(await imageTraces(second)).toEqual([]);
  expect(logs.text()).not.toContain(url.slice(JPEG_DATA_URL_PREFIX.length + 1000, JPEG_DATA_URL_PREFIX.length + 1048));
  logs.restore();
});

it('RUNTIME: PUBLISH-MONITOR B2: a model that does not read images, and an image that is not one checked JPEG, are refused before anything opens', async () => {
  const f = await setup(1000), transport = vi.fn<typeof fetch>(async () => sse('never', ['x']));
  const plain = await turn({ actor: f.actor, session: f.session, text: '看图', transport, images: [screenshot()] });
  expect(plain.events).toEqual([{ type: 'error', code: 'TURN_IMAGE_UNSUPPORTED' }]);
  const g = await setup(1000, { image: true });
  const png = 'data:image/png;base64,' + randomBytes(600).toString('base64');
  const huge = JPEG_DATA_URL_PREFIX + Buffer.concat([syntheticJpeg(4000, 3000).subarray(0, -2), Buffer.from([0xff, 0xd9])]).toString('base64');
  for (const images of [[png], [huge], [JPEG_DATA_URL_PREFIX + 'not-base64!'], Array(5).fill(screenshot()), [screenshot(), png]])
    expect((await turn({ actor: g.actor, session: g.session, text: '看图', transport, images })).events)
      .toEqual([{ type: 'error', code: 'TURN_IMAGE_INVALID' }]);
  expect(transport).not.toHaveBeenCalled();
  for (const actor of [f.actor, g.actor]) {
    expect((await db.query('select count(*)::int n from turns where actor_id=$1', [actor])).rows[0].n).toBe(0);
    expect((await db.query('select credits from profiles where id=$1', [actor])).rows[0].credits).toBe(1000);
  }
});

it('RUNTIME: PUBLISH-MONITOR B2: a failed screenshot turn charges nothing and keeps nothing of the image', async () => {
  const f = await setup(1000, { image: true }), url = screenshot();
  photoStore.uploads.length = 0; photoStore.removed.length = 0;
  // Billed, but cut off before any text (as the V2-4a case above): nothing delivered, the user pays nothing.
  const transport: typeof fetch = async () => new Response(
    frame('gen-image-cut', { choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })
    + frame('gen-image-cut', { choices: [{ index: 0, delta: {}, finish_reason: 'length' }] })
    + frame('gen-image-cut', { choices: [], usage: { prompt_tokens: 1000, completion_tokens: 8192, total_tokens: 9192, cost: 0.13 } })
    + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream', 'x-generation-id': 'gen-image-cut' } });
  const failed = await turn({ actor: f.actor, session: f.session, text: '看图', transport, images: [url] });
  expect(failed.events.at(-1)).toMatchObject({ type: 'error' });
  expect((await db.query('select close_kind,charged_credits from turns where actor_id=$1', [f.actor])).rows)
    .toEqual([{ close_kind: 'failed', charged_credits: 0 }]);
  expect((await db.query('select credits from profiles where id=$1', [f.actor])).rows[0].credits).toBe(1000);
  // No message was kept, so its photo is taken back from the chat photo bucket (Owner 2026-11-13: photos go with their message).
  expect(photoStore.uploads).toHaveLength(1);
  expect(photoStore.removed).toEqual([photoStore.uploads[0]!.path]);
  expect(await imageTraces(url)).toEqual([]);
});

/*
 * Deep review 2026-11-11, findings 2 and 9. Owner 2026-11-11: a turn whose answer was not saved does not charge the user; Graylum
 * bears the cost, on record. Finding 2: a NUL or half an emoji in the message made the closing write fail every time (jsonb refuses
 * both), so a request could be built to be answered for free as often as its sender liked; text is now cleaned at both ends.
 */
const turnRow = async (actor: string) => (await db.query(
  `select id,state,close_kind,settlement,charged_credits,absorbed_credits,reserved_credits,delivered,failure_code
   from turns where actor_id=$1`, [actor])).rows[0];
const balance = async (actor: string) => (await db.query('select credits from profiles where id=$1', [actor])).rows[0].credits as number;
const savedMessages = async (session: string) =>
  (await db.query('select role,content from session_messages where session_id=$1 order by seq', [session])).rows;
const ledgerRows = async (actor: string) =>
  (await db.query('select count(*)::int n from credit_transactions where user_id=$1', [actor])).rows[0].n as number;
const closeArgs = (actor: string, turnId: number, kind: string, refundAll = false) => ({ p_actor_id: actor, p_turn_id: turnId,
  p_close_kind: kind, p_messages: [], p_delivered: false, p_refund_all: refundAll, p_failure_code: 'test_close', p_kind_result: null });
const answer: typeof fetch = async () => sse('gen-close-' + randomUUID(), ['Synthetic ', 'answer']);
const unsaved = () => vi.spyOn(logger, 'error').mockImplementation(() => undefined);

it('RUNTIME: CORE-PATH-V2 close: a message with a NUL and half an emoji is answered, saved cleaned and charged once', async () => {
  const f = await setup();
  const out = await turn({ actor: f.actor, session: f.session, text: 'Hel\0lo \ud83d', transport: answer });
  const result = out.events.at(-1) as Extract<TurnEvent, { type: 'result' }>;
  expect(result, JSON.stringify(out.events)).toMatchObject({ type: 'result', body: 'Synthetic answer', settlement: 'done' });
  expect(result.chargedCredits).toBeGreaterThan(0);
  expect(await savedMessages(f.session)).toEqual([{ role: 'user', content: 'Hello �' }, { role: 'assistant', content: 'Synthetic answer' }]);
  expect(await turnRow(f.actor)).toMatchObject({ close_kind: 'completed', settlement: 'done', charged_credits: result.chargedCredits, delivered: true });
  expect(await balance(f.actor)).toBe(1000 - result.chargedCredits!);
});

it('RUNTIME: CORE-PATH-V2 close: a closing write that fails after the whole answer refunds the turn once, keeps the cost on record and is logged', async () => {
  const f = await setup(), closes: unknown[] = [], logged = unsaved();
  try {
    const out = await turn({ actor: f.actor, session: f.session, text: 'Hello', transport: answer,
      onClose: async (args, send) => { closes.push(args.p_close_kind); return args.p_close_kind === 'completed' ? LOST : send(); } });
    // The whole answer reached the user, then the error.
    expect(out.events.map(e => e.type), JSON.stringify(out.events)).toEqual(['opened', 'text', 'text', 'error']);
    expect(out.events.at(-1)).toMatchObject({ type: 'error', code: 'TURN_DATABASE_UNAVAILABLE' });
    expect(closes).toEqual(['completed', 'failed']);
    const t = await turnRow(f.actor);
    expect(t).toMatchObject({ state: 'closed', close_kind: 'failed', settlement: 'done', charged_credits: 0, delivered: false,
      failure_code: 'turn_database_unavailable' });
    // Nothing was saved, so the user pays nothing; the receipt keeps its cost and Graylum bears it.
    expect(await balance(f.actor)).toBe(1000);
    expect(await savedMessages(f.session)).toEqual([]);
    expect(t.absorbed_credits).toBeGreaterThan(0);
    expect((await db.query("select status,actual_usd::float8 a from turn_calls where turn_id=$1 and call_kind='model'", [t.id])).rows)
      .toEqual([{ status: 'ok', a: 0.000003 }]);
    expect(logged).toHaveBeenCalledWith('ai', 'turn_answer_unsaved', { kind: 'chat', turnId: Number(t.id), code: 'TURN_DATABASE_UNAVAILABLE' });
    // Repeated: a later close finds the turn settled and changes nothing (no second refund, no new ledger row).
    const before = await ledgerRows(f.actor);
    const again = await countingAdmin().admin.rpc('turn_close', closeArgs(f.actor, Number(t.id), 'failed', true));
    expect(again.error).toBeNull();
    expect(again.data).toMatchObject({ replay: true, closeKind: 'failed', chargedCredits: 0 });
    expect(await balance(f.actor)).toBe(1000);
    expect(await ledgerRows(f.actor)).toBe(before);
  } finally { logged.mockRestore(); }
});

it('RUNTIME: CORE-PATH-V2 close: a closing write that committed but whose answer was lost is kept: saved and charged once, never refunded', async () => {
  const f = await setup(), closes: unknown[] = [], logged = unsaved();
  try {
    const out = await turn({ actor: f.actor, session: f.session, text: 'Hello', transport: answer,
      onClose: async (args, send) => { closes.push(args.p_close_kind); const done = await send(); return args.p_close_kind === 'completed' ? LOST : done; } });
    expect(out.events.at(-1)).toMatchObject({ type: 'error', code: 'TURN_DATABASE_UNAVAILABLE' });
    expect(closes).toEqual(['completed', 'failed']);
    const t = await turnRow(f.actor);
    // The first close stands: the refund close found the turn closed and wrote nothing.
    expect(t).toMatchObject({ state: 'closed', close_kind: 'completed', settlement: 'done', delivered: true, failure_code: null });
    expect(t.charged_credits).toBeGreaterThan(0);
    expect(await balance(f.actor)).toBe(1000 - t.charged_credits);
    expect(await savedMessages(f.session)).toEqual([{ role: 'user', content: 'Hello' }, { role: 'assistant', content: 'Synthetic answer' }]);
  } finally { logged.mockRestore(); }
});

it('RUNTIME: CORE-PATH-V2 close: a turn left open (both closes lost) is ended by recovery with nothing charged, once, also by two recoveries at once', async () => {
  const f = await setup(), logged = unsaved();
  try {
    const out = await turn({ actor: f.actor, session: f.session, text: 'Hello', transport: answer, onClose: async () => LOST });
    expect(out.events.at(-1)).toMatchObject({ type: 'error', code: 'TURN_DATABASE_UNAVAILABLE' });
  } finally { logged.mockRestore(); }
  const open = await turnRow(f.actor);
  // Nothing refunded, nothing charged yet: the turn is still running with its freeze, as the platform stopping the function leaves it.
  expect(open).toMatchObject({ state: 'running', close_kind: null, charged_credits: null });
  expect(await balance(f.actor)).toBe(1000 - open.reserved_credits);
  // The recovery job ends a turn nobody wrote for 15 minutes. Two instances at once: one closes it, the other finds it closed.
  await db.query("update turns set updated_at=now()-interval '16 minutes' where actor_id=$1 and id=$2", [f.actor, open.id]);
  const recover = { p_actor_id: f.actor, p_turn_id: Number(open.id), p_action: 'interrupt' };
  const both = await Promise.all([countingAdmin().admin.rpc('turn_recover', recover), countingAdmin().admin.rpc('turn_recover', recover)]);
  expect(both.map(r => r.error)).toEqual([null, null]);
  expect(both.map(r => Boolean((r.data as { skipped?: boolean }).skipped)).sort()).toEqual([false, true]);
  const t = await turnRow(f.actor);
  // Owner 2026-11-11: interrupted, no answer saved: the user pays nothing although the receipt is final; the cost is Graylum's.
  expect(t).toMatchObject({ state: 'closed', close_kind: 'interrupted', settlement: 'done', charged_credits: 0, delivered: false });
  expect(t.absorbed_credits).toBeGreaterThan(0);
  expect(await balance(f.actor)).toBe(1000);
  expect(await savedMessages(f.session)).toEqual([]);
  // The freeze came back exactly once.
  const before = await ledgerRows(f.actor);
  const again = await countingAdmin().admin.rpc('turn_close', closeArgs(f.actor, Number(open.id), 'interrupted'));
  expect(again.data).toMatchObject({ replay: true, closeKind: 'interrupted', chargedCredits: 0 });
  expect(await balance(f.actor)).toBe(1000);
  expect(await ledgerRows(f.actor)).toBe(before);
});
