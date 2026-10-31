/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import { pricingConfig } from '../__tests__/fixtures/runtimePricing';
import { clearTestOpenRouterKey, seedTestOpenRouterKey } from '../models/openRouterKey.testing';
import { clearCatalogCache, withCatalogRequest } from '../runtime/catalogCache';
import { LIBRARY_AGENT_READ_KEY, LIBRARY_RETRIEVAL_KEY } from '../runtime/libraryAdmission';
import type { PositioningClassifier } from '../runtime/positioningGate';
import type { VendorCalls } from '../research/runtime/subcall';
import type { ResearchCallResult } from '../research/vendors/types';
import { runResumedTurn } from './resumeTurn';
import { runChatTurn, CORE_PATH_SETTING } from './chat';
import { turnClients } from './db';
import type { CounterStore } from './limiter';
import { RUNTIME_PAYG_SETTING } from './quote';
import type { TurnEvent } from './sse';
import { researchSettings } from './tools/__tests__/fixtures';
import { tikhubRouteId } from '../research/vendors/tikhub';

/*
 * CORE-PATH-V2 V2-6 acceptance on the local database with a synthetic OpenRouter and synthetic suppliers (no network, no paid
 * call): a free chat that searches once (the research-tools and runnerRetrieval scenarios: one tool row, its continuation in
 * three writes, both inside the turn's freeze), a search that returns nothing (not charged), an unknown supplier result
 * (0 to the user, cost pending), and the route profile's tool ceiling (payg-three-tools).
 */
const connectionString = process.env.V3_LOCAL_DB!;
if (!connectionString?.startsWith('postgres://postgres@127.0.0.1:') || !connectionString.endsWith('/v3_disposable'))
  throw new Error('isolated runner required');
const db = new pg.Client({ connectionString });
const MODEL = 'anthropic/claude-sonnet-5.5', ROUTE = 'anthropic';
const slots: CounterStore = { take: async () => 1, drop: async () => undefined };
const RESEARCH_KEYS = Object.keys(researchSettings());
const SETTINGS = [CORE_PATH_SETTING, RUNTIME_PAYG_SETTING, 'primary_model_id', 'billing_credits_per_usd', 'billing_token_price_multiplier',
  'runtime_rw_v2', LIBRARY_AGENT_READ_KEY, LIBRARY_RETRIEVAL_KEY, ...RESEARCH_KEYS];
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

// Synthetic evidence for validation only (as chat.integration.ts); never a real admission profile.
const profile = (maxTools: number) => ({ model: MODEL, endpointTag: ROUTE, protocol: 'openrouter-chat-v1', profileVersion: 'test-only',
  evidenceVersion: 'test-only', admissionPath: 'empirical', templateTokens: 4096, marginTokens: 4096, maxBytes: 196608, maxMessages: 128,
  maxTools, maxSchemaBytes: 16384, purposes: ['ordinary', 'organizer'], requestFormats: ['serial-tools-v6-reasoning'],
  reasoningVariants: [{ reasoning: { effort: 'none' }, outputLimit: 8192, testedOutputLimit: 512, evidenceReference: 'test-only',
    manifestHash: 'b'.repeat(64), outputStressSamples: 2, includesReasoning: true }], outputLimit: 8192,
  evidence: { reference: 'test-only', manifestHash: 'a'.repeat(64), distinctSamples: 60, messageStressSamples: 12,
    maxVerifiedMessages: 128, completeCells: 15, variantsPerCell: 4, maxPromptToBytes: 0.5, maxPromptToUpper: 0.4,
    outputLimit: 8192, testedOutputLimit: 512, outputSemantics: 'max-tokens-includes-reasoning', includesReasoning: true,
    cacheCovered: true, costBoundPassed: true } });

async function setup(maxTools = 9, account: { credits?: number; typicalUsd?: string } = {}) {
  const credits = account.credits ?? 1000;
  const actor = randomUUID(), session = randomUUID(), modelId = randomUUID();
  await db.query('insert into profiles(id,credits) values($1,$2)', [actor, credits]);
  await db.query(`insert into credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,idempotency_key,balance_before,balance_after)
    values($1,$3::int,'addition','grant','opening_grant','system',$2,0,$3::int)`, [actor, 'opening_grant:' + actor, credits]);
  await db.query("insert into runtime_sessions(id,actor_id,scope,start_request_id,start_payload) values($1,$2,$3,$4,'{}')",
    [session, actor, JSON.stringify({ kind: 'positioning_draft', probe: randomUUID() }), randomUUID()]);
  const { pricing } = pricingConfig(MODEL, ROUTE, '0.000003', '0.000015');
  (pricing.endpoints[0]!.base as Record<string, string>).input_cache_write = '0.00000375';
  const config = { pricing, reasoning: { route: ROUTE, purposes: { interactive: { mode: 'off', wire: 'reasoning_effort' } },
    catalog: { fetchedAt: pricing.fetchedAt, model: MODEL, reasoning: { mandatory: false, defaultEnabled: false, supportedEfforts: ['low', 'high'],
      defaultEffort: 'high', supportsMaxTokens: true },
    endpoints: [{ tag: ROUTE, providerName: 'Anthropic', supportedParameters: ['tools', 'reasoning', 'reasoning_effort'], contextLength: 1050000,
      maxCompletionTokens: 8192 }] } } };
  await db.query(`insert into ai_models(id,name,model_id,provider,is_active,max_tokens,input_limit,config,api_endpoint)
    values($1,'Core path tools',$2,'openrouter','true',8192,1050000,$3,'https://openrouter.ai/api/v1/chat/completions')`,
  [modelId, MODEL, JSON.stringify(config)]);
  const set = (key: string, value: unknown) => db.query(
    'insert into system_settings(key,value) values($1,$2) on conflict(key) do update set value=excluded.value', [key, JSON.stringify(value)]);
  await set(CORE_PATH_SETTING, { enabled: true, stopLoss: { limitUsd: 1000, p: 8, poolSize: 8, uFastUsd: 1, uBigUsd: 5 },
    decisionUpperUsd: '0.001' });
  await set(RUNTIME_PAYG_SETTING, { version: 1, enabled: true, policyVersion: 'core-path-test', profiles: [profile(maxTools)] });
  await set('primary_model_id', modelId);
  await set(LIBRARY_AGENT_READ_KEY, true);
  await set(LIBRARY_RETRIEVAL_KEY, true);
  await set('billing_credits_per_usd', 100);
  await set('billing_token_price_multiplier', 6);
  await set('runtime_rw_v2', { catalogCache: true });
  const research = researchSettings() as Record<string, { thresholds?: unknown[] }>;
  // The research routes' thresholds and the chat model's own start threshold L (Owner 10-28) in one setting.
  research.billing_payg_start_thresholds!.thresholds!.push({ model: MODEL, purpose: 'ordinary', typicalUsd: account.typicalUsd ?? '0.04' });
  for (const [key, value] of Object.entries(research)) await set(key, value);
  await seedTestOpenRouterKey(db, 'LOCAL_SYNTHETIC_OPENROUTER_KEY');
  clearCatalogCache();
  return { actor, session };
}

function countingAdmin() {
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    if (path.startsWith('/rest/v1/')) calls.push(path.slice('/rest/v1/'.length));
    return fetch(input, init);
  };
  return { admin: createClient(process.env.V3_LOCAL_REST!, process.env.V3_LOCAL_SERVICE_JWT!, { auth: { persistSession: false },
    global: { fetch: fetcher } }), calls };
}

const frame = (id: string, extra: Record<string, unknown>) =>
  'data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: MODEL, ...extra }) + '\n\n';
// A cost inside the call's frozen bound (this fixture's bound is small; above it the receipt is refused), as chat.integration.ts.
const usage = (id: string) => frame(id, { choices: [], usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1, cost: 0.000003 } })
  + 'data: [DONE]\n\n';
const respond = (id: string, body: string) => new Response(body, { headers: { 'content-type': 'text/event-stream', 'x-generation-id': id } });
/** The first response calls `tool` (web_search by default); the next one answers. The request bodies are kept for inspection. */
function searchingModel(bodies: string[],
  tool: { name: string; args: Record<string, unknown> } = { name: 'web_search', args: { query: 'coffee shop positioning', mode: 'fast' } }): typeof fetch {
  return async (_url, init) => {
    bodies.push(String(init?.body));
    const n = bodies.length, id = `gen-tools-${randomUUID()}`;
    if (n === 1) return respond(id, frame(id, { choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call-1',
      type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] },
    finish_reason: null }] }) + frame(id, { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }) + usage(id));
    return respond(id, frame(id, { choices: [{ index: 0, delta: { role: 'assistant', content: 'Answer from the search.' }, finish_reason: null }] })
      + frame(id, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + usage(id));
  };
}
const searchResult = (over: Partial<ResearchCallResult> = {}): ResearchCallResult => ({ vendor: 'parallel', route: 'parallel:search:fast',
  outcome: 'ok', reason: null, httpStatus: 200, supplierMayCharge: true, usage: { unit: 'sku_search', units: '1' }, truncated: false,
  fetchedAt: new Date().toISOString(), items: [{ url: 'https://example.com/coffee', fields: { title: 'Coffee guide' }, missing: [] }], ...over });
const suppliers = (parallel: VendorCalls['parallel']): VendorCalls => ({ parallel, tikhub: vi.fn(), firecrawl: vi.fn() });

const allowGate: PositioningClassifier = async ({ onCost }) => { onCost?.(0.00003); return 'allow'; };
const admit = async () => ({ ok: true as const });
type NewWork = Parameters<typeof runChatTurn>[0]['newWork'];
async function turn(f: { actor: string; session: string }, transport: typeof fetch, vendors: VendorCalls, library = false,
  newWork: NewWork = { message: admit, calls: admit }, text = 'How should a coffee shop position itself?', resumeOf?: number) {
  const { admin, calls } = countingAdmin(), events: TurnEvent[] = [];
  const deps = { admin, clients: turnClients(admin), slots, transport, gate: { classify: allowGate }, newWork,
    tools: { readKey: async () => 'SYNTHETIC_VENDOR_KEY', vendors, library } };
  const ids = { actorId: f.actor, sessionId: f.session, requestId: randomUUID() };
  await withCatalogRequest(() => resumeOf ? runResumedTurn(deps, { ...ids, resumeOf }, e => events.push(e))
    : runChatTurn(deps, { ...ids, text }, e => events.push(e)));
  return { events, calls };
}
/** N = ceil(q x sum(n x m)) over the receipts the user pays for: ok rows except the positioning check (q 100, m 6 here). */
const expectedCredits = (actor: string) => db.query(`select ceil(100 * coalesce(sum(c.nominal_usd * c.multiplier), 0))::int n
  from turn_calls c join turns t on t.id=c.turn_id and t.actor_id=c.actor_id where t.actor_id=$1 and c.status='ok'
  and c.call_kind<>'decision'`, [actor]).then(r => r.rows[0].n as number);
const modelCredits = (actor: string) => db.query(`select ceil(100 * coalesce(sum(c.nominal_usd * c.multiplier), 0))::int n
  from turn_calls c join turns t on t.id=c.turn_id and t.actor_id=c.actor_id where t.actor_id=$1 and c.call_kind='model'`, [actor])
  .then(r => r.rows[0].n as number);
const rows = (actor: string) => db.query(`select c.seq,c.call_kind,c.tool_name,c.status,c.nominal_usd::float8 n,c.actual_usd::float8 c,
  c.upper_usd::float8 u,c.cost_pending from turn_calls c join turns t on t.id=c.turn_id and t.actor_id=c.actor_id where t.actor_id=$1
  order by c.seq`, [actor]).then(r => r.rows);

it('RUNTIME: CORE-PATH-V2 V2-6: a free chat searches once: one tool row, the continuation in three writes, all inside the freeze', async () => {
  const f = await setup(), bodies: string[] = [];
  const parallel = vi.fn(async () => searchResult());
  const out = await turn(f, searchingModel(bodies), suppliers(parallel));
  expect(out.events.at(-1), JSON.stringify(out.events)).toMatchObject({ type: 'result', body: 'Answer from the search.' });
  const opened = out.events[0] as Extract<TurnEvent, { type: 'opened' }>;
  expect(opened.tools).toEqual({ available: ['social_search', 'social_account', 'web_search', 'web_fetch'], trimmed: [] });
  expect(parallel).toHaveBeenCalledTimes(1);
  expect(await rows(f.actor)).toEqual([
    { seq: 1, call_kind: 'decision', tool_name: null, status: 'ok', n: 0.00003, c: 0.00003, u: 0.001, cost_pending: false },
    expect.objectContaining({ seq: 2, call_kind: 'model', status: 'ok' }),
    { seq: 3, call_kind: 'tool', tool_name: 'web_search', status: 'ok', n: 0.01, c: 0.01, u: 0.01, cost_pending: false },
    expect.objectContaining({ seq: 4, call_kind: 'model', status: 'ok' }),
  ]);
  // The tool definitions are on both requests (the same bytes); the second carries the tool result.
  const tools = bodies.map(b => JSON.stringify(JSON.parse(b).tools));
  expect(tools[0]).toBe(tools[1]);
  expect(bodies[1]).toContain('Coffee guide');
  expect(bodies[1]).toContain('How should a coffee shop position itself?');
  const t = (await db.query('select reserved_credits,charged_credits,settlement from turns where actor_id=$1', [f.actor])).rows[0];
  // Both model calls and the search (0.01 x m 6 x q 100 = 6 credits of it), within the freeze.
  const n = await expectedCredits(f.actor);
  expect(n).toBeGreaterThanOrEqual(6 + 1);
  expect(t).toMatchObject({ charged_credits: n, settlement: 'done' });
  expect(t.reserved_credits).toBeGreaterThanOrEqual(n);
  expect((await db.query('select credits from profiles where id=$1', [f.actor])).rows[0].credits).toBe(1000 - n);
  // Round trips of the turn's own: the V2-4a seven plus two for the tool row and three for the model call that reads it.
  const own = out.calls.filter(c => c.startsWith('rpc/turn_'));
  console.log('CORE-PATH-V2 free chat with one search, round trips', JSON.stringify({ total: out.calls.length, own: own.length, calls: out.calls }));
  expect(own).toEqual(['rpc/turn_open', 'rpc/turn_call_begin', 'rpc/turn_call_record',
    'rpc/turn_call_begin', 'rpc/turn_call_identity', 'rpc/turn_call_record',
    'rpc/turn_call_begin', 'rpc/turn_call_record',
    'rpc/turn_call_begin', 'rpc/turn_call_identity', 'rpc/turn_call_record', 'rpc/turn_close']);
});

it('RUNTIME: CORE-PATH-V2 V2-5c: the daily summary counts old charges and turn tool receipts once each, and settled credits add up', async () => {
  const f = await setup(), g = await setup(), bodies: string[] = [];
  // The database's clock, after the turns of the cases before this one.
  const start = (await db.query('select clock_timestamp() t')).rows[0].t as Date;
  // An old-path operation charged 7 credits, next to the turn's own operations, which carry no charge.
  const plan = randomUUID();
  await db.query(`insert into research_plans(id,actor_id,budget_units,max_operations,operations) values($1,$2,1,1,'["x"]')`, [plan, f.actor]);
  await db.query(`insert into research_operations(id,plan_id,identity_hash,quote_units,dispatch_token,state,charged_credits,charged_at)
    values($1,$2,$3,0,$4,'succeeded',7,now())`, [randomUUID(), plan, 'a'.repeat(64), randomUUID()]);
  await turn(f, searchingModel(bodies), suppliers(vi.fn(async () => searchResult())));
  const summary = async () => (await db.query('select research_billing_summary($1,$2) v', [start, new Date(start.getTime() + 3600000)])).rows[0].v;
  const settled = async () => (await db.query(`select coalesce(-sum(amount),0)::int n from billing_history where operation_type='settle' and created_at>=$1`, [start])).rows[0].n as number;
  const charged = await expectedCredits(f.actor), paid = await summary();
  // The search: 0.01 x m 6 x q 100 = 6 credits, one successful subcall, and 7 + 6 with the old charge.
  expect(paid).toEqual({ count: 2, credits: 13, turnOtherCredits: charged - 6 });
  expect(paid.credits - 7 + paid.turnOtherCredits).toBe(await settled());
  expect(await summary()).toEqual(paid);
  // As the meter charges: a partial result with data counts, an empty one does not.
  const results = [{ outcome: 'partial', items: 2 }, { outcome: 'ok', items: 0 }, { outcome: 'ok', items: 1 }];
  const receipt = (usage: unknown) => db.query(`update turn_calls set usage=usage||$1 where actor_id=$2 and call_kind='tool'`, [JSON.stringify(usage), f.actor]);
  await receipt({ results });
  expect(await summary()).toEqual({ ...paid, count: 3 });
  await receipt({ results: results.slice(2) });
  // A search that returned nothing is not charged: only the turn's model calls move.
  await turn(g, searchingModel([]), suppliers(vi.fn(async () => searchResult({ items: [], reason: 'NO_RESULTS' }))));
  expect(await summary()).toEqual({ count: 2, credits: 13, turnOtherCredits: charged - 6 + await modelCredits(g.actor) });
  expect((await summary()).credits - 7 + (await summary()).turnOtherCredits).toBe(await settled());
  // The search returned data, then the model failed and the whole turn was refunded: the platform bore that search.
  const h = await setup(), before = await summary(), searched = searchingModel([]);
  let modelCall = 0;
  const failing: typeof fetch = async (url, init) => (++modelCall === 1 ? searched(url, init)
    : new Response(JSON.stringify({ error: { code: 402, message: 'Insufficient credits', metadata: { limit_source: 'openrouter_credits' } } }), { status: 402, headers: { 'content-type': 'application/json' } }));
  await turn(h, failing, suppliers(vi.fn(async () => searchResult()))).catch(() => undefined);
  expect((await rows(h.actor)).find(r => r.call_kind === 'tool')).toMatchObject({ status: 'ok' });
  expect((await db.query(`select amount from billing_history where user_id=$1 and operation_type='settle'`, [h.actor])).rows).toEqual([{ amount: 0 }]);
  expect(await summary()).toEqual(before);
  // Account erasure scrubs the ledger row after the settlement: the day's numbers do not move.
  await db.query(`update profiles set status='deleted',is_deleted='true',deleted_at=now() where id=$1`, [f.actor]);
  await db.query(`insert into account_erasure_requests(profile_id,request_id,confirmed_at) values($1,$2,now())`, [f.actor, randomUUID()]);
  expect((await db.query(`select account_erasure_scrub_ledger($1,'billing_history') v`, [f.actor])).rows[0].v).toMatchObject({ manualReview: 0, remaining: 0 });
  expect((await db.query(`select metadata ? 'turnId' kept from billing_history where user_id=$1 and operation_type='settle'`, [f.actor])).rows).toEqual([{ kept: false }]);
  expect(await summary()).toEqual(before);
});

it('RUNTIME: CORE-PATH-V2 V2-6: a search that returns nothing is said plainly and not charged; the platform cost is kept', async () => {
  const f = await setup(), bodies: string[] = [];
  const out = await turn(f, searchingModel(bodies), suppliers(vi.fn(async () => searchResult({ items: [], reason: 'NO_RESULTS' }))));
  expect(out.events.at(-1)).toMatchObject({ type: 'result' });
  expect(bodies[1]).toContain('NO_DATA_RETURNED');
  const tool = (await rows(f.actor)).find(r => r.call_kind === 'tool');
  expect(tool).toMatchObject({ status: 'unusable', n: 0, c: 0.01 });
  // Only the two model calls.
  expect((await db.query('select charged_credits from turns where actor_id=$1', [f.actor])).rows[0].charged_credits)
    .toBe(await modelCredits(f.actor));
});

it('RUNTIME: CORE-PATH-V2 V2-6: an unknown supplier result costs the user nothing and keeps the provider cost pending', async () => {
  const f = await setup(), bodies: string[] = [];
  const parallel = vi.fn(async () => { throw new Error('socket hang up'); });
  const out = await turn(f, searchingModel(bodies), suppliers(parallel));
  expect(out.events.at(-1)).toMatchObject({ type: 'result' });
  expect(parallel).toHaveBeenCalledTimes(1);
  expect(bodies[1]).toContain('PROVIDER_RESULT_UNKNOWN');
  expect((await rows(f.actor)).find(r => r.call_kind === 'tool')).toMatchObject({ status: 'unknown', cost_pending: true, u: 0.01 });
  const t = (await db.query('select charged_credits,settlement from turns where actor_id=$1', [f.actor])).rows[0];
  // The user is settled now for the two model calls only; the turn stays pending for the supplier cost (recovery).
  expect(t).toEqual({ charged_credits: await modelCredits(f.actor), settlement: 'pending' });
});

it('RUNTIME: CORE-PATH-V2 V2-6: a route profile allowing two tools never carries the research group (payg-three-tools)', async () => {
  const f = await setup(2), bodies: string[] = [];
  const transport: typeof fetch = async (_url, init) => { bodies.push(String(init?.body)); const id = 'gen-plain';
    return respond(id, frame(id, { choices: [{ index: 0, delta: { role: 'assistant', content: 'Plain.' }, finish_reason: null }] })
      + frame(id, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + usage(id)); };
  const out = await turn(f, transport, suppliers(vi.fn()));
  expect(out.events.at(-1)).toMatchObject({ type: 'result', body: 'Plain.' });
  expect((out.events[0] as Extract<TurnEvent, { type: 'opened' }>).tools).toEqual({ available: [], trimmed: [] });
  expect(JSON.parse(bodies[0]!).tools).toBeUndefined();
});

it('RUNTIME: CORE-PATH-V2 V2-6: read_source reads the user\'s own library once, read-only, with no tool row', async () => {
  const f = await setup(), bodies: string[] = [], doc = randomUUID();
  await db.query(`insert into library_documents(id,actor_id,request_id,kind,format,purpose,filename,status,original_bytes,text_bytes)
    values($1,$2,$3,'document','md','reference','coffee-notes.md','ready',10,10)`, [doc, f.actor, randomUUID()]);
  await db.query(`insert into library_document_segments(document_id,actor_id,ordinal,title,body,source)
    values($1,$2,0,'Intro','Our coffee shop sells single origin beans.','extracted')`, [doc, f.actor]);
  const out = await turn(f, searchingModel(bodies, { name: 'read_source', args: { query: 'search:coffee' } }), suppliers(vi.fn()), true);
  expect(out.events.at(-1), JSON.stringify(out.events)).toMatchObject({ type: 'result' });
  expect(bodies[1]).toContain('single origin beans');
  expect(bodies[1]).toContain('doc-1');
  expect(bodies[1]).not.toContain(doc);
  // No tool row: the decision check and the two model calls only.
  expect((await rows(f.actor)).map(r => r.call_kind)).toEqual(['decision', 'model', 'model']);
  const own = out.calls.filter(c => c.startsWith('rpc/turn_') || c === 'rpc/library_turn_read');
  expect(own).toEqual(['rpc/turn_open', 'rpc/turn_call_begin', 'rpc/turn_call_record',
    'rpc/turn_call_begin', 'rpc/turn_call_identity', 'rpc/turn_call_record', 'rpc/library_turn_read',
    'rpc/turn_call_begin', 'rpc/turn_call_identity', 'rpc/turn_call_record', 'rpc/turn_close']);
  // Another account never reads this library: not by search, not by listing, not with this document's reference.
  const other = await setup();
  const ref = JSON.stringify([{ ref: 'doc-1', documentId: doc, version: 1 }]);
  const steal = (query: string) => db.query('select library_turn_read($1,$2,$3,$4::jsonb) r', [other.actor, other.session, query, ref])
    .then(r => r.rows[0].r);
  expect(await steal('search:coffee')).toMatchObject({ kind: 'library_search', hits: [] });
  expect(await steal('library')).toMatchObject({ kind: 'library_index', documents: [] });
  expect(await steal('doc-1/segment-1')).toEqual({ kind: 'unavailable', reason: 'source_deleted', ref: 'doc-1' });
  expect(await steal('doc-1')).toEqual({ kind: 'unavailable', reason: 'source_deleted', ref: 'doc-1' });
  // Nor through someone else's conversation.
  expect(await db.query("select library_turn_read($1,$2,'search:coffee','[]') r", [other.actor, f.session]).then(r => r.rows[0].r))
    .toEqual({ kind: 'unavailable', reason: 'source_deleted' });
  // A deleted conversation reads nothing.
  await db.query('update runtime_sessions set content_deleted_at=now() where id=$1', [f.session]);
  const read = await db.query("select library_turn_read($1,$2,'search:coffee','[]') r", [f.actor, f.session]);
  expect(read.rows[0].r).toEqual({ kind: 'unavailable', reason: 'source_deleted' });
});

it('RUNTIME: CORE-PATH-V2 V2-6: the call limits refuse a research call before anything is written or sent', async () => {
  const f = await setup(), bodies: string[] = [], counts: number[] = [];
  const parallel = vi.fn(async () => searchResult());
  // The model call passes the gate; the research call (one subcall) is refused.
  const calls: NewWork['calls'] = async (_actor, count) => { counts.push(count);
    return counts.length === 1 ? { ok: true as const } : { ok: false as const, reason: 'call_limited' as const, retryAfter: 60 }; };
  const out = await turn(f, searchingModel(bodies), suppliers(parallel), false, { message: admit, calls });
  expect(out.events.at(-1)).toMatchObject({ type: 'error', code: 'TURN_RATE_LIMITED' });
  expect(counts).toEqual([1, 1]);
  expect(parallel).not.toHaveBeenCalled();
  expect((await rows(f.actor)).map(r => r.call_kind)).toEqual(['decision', 'model']);
  expect((await db.query('select state,close_kind from turns where actor_id=$1', [f.actor])).rows[0]).toEqual({ state: 'closed', close_kind: 'failed' });
});

it('RUNTIME: CORE-PATH-V2 V2-6: a balance that opens the turn but not the continuation after a search pauses it there', async () => {
  // L = max(1, ceil(0.001 x 100 x 6)) = 1 credit; the balance 3 opens the turn and freezes H = min(G, 3) = 3. The first model
  // call and the search (its bound held) use it up, so the model call that would read the result pauses for credits.
  const f = await setup(9, { credits: 3, typicalUsd: '0.001' }), bodies: string[] = [];
  const parallel = vi.fn(async () => searchResult());
  const out = await turn(f, searchingModel(bodies), suppliers(parallel));
  expect(out.events.at(-1), JSON.stringify(out.events)).toMatchObject({ type: 'error', code: 'TURN_PAUSED_FOR_CREDITS' });
  expect(parallel).toHaveBeenCalledTimes(1);
  expect(bodies).toHaveLength(1);
  const t = (await db.query('select state,pause_reason,reserved_credits from turns where actor_id=$1', [f.actor])).rows[0];
  expect(t).toEqual({ state: 'paused', pause_reason: 'waiting_credits', reserved_credits: 3 });
  // The search is recorded with its cost; nothing was sent for the continuation.
  expect((await rows(f.actor)).map(r => [r.call_kind, r.status])).toEqual([['decision', 'ok'], ['model', 'ok'], ['tool', 'ok']]);
  expect((await db.query('select credits from profiles where id=$1', [f.actor])).rows[0].credits).toBe(0);
});

it('RUNTIME: CORE-PATH-V2 V2-10: a resume continues from the receipts: no model call or search again, the work charged once', async () => {
  const f = await setup(9, { credits: 3, typicalUsd: '0.001' }), bodies: string[] = [];
  const parallel = vi.fn(async () => searchResult());
  await turn(f, searchingModel(bodies), suppliers(parallel));
  const { id } = (await db.query("select id::int id from turns where actor_id=$1 and state='paused'", [f.actor])).rows[0];
  await db.query('update profiles set credits=100 where id=$1', [f.actor]);
  const out = await turn(f, searchingModel(bodies), suppliers(parallel), false, undefined, undefined, id);
  expect(out.events.at(-1), JSON.stringify(out.events)).toMatchObject({ type: 'result', body: 'Answer from the search.' });
  expect(parallel).toHaveBeenCalledTimes(1);
  // The first answer came from its receipt: only the continuation reached the model, carrying the stored search result.
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toContain('Coffee guide');
  // One decision, one model call and one search on the paused turn; one model call on the resumed one (by seq, per turn).
  expect((await rows(f.actor)).map(r => [r.call_kind, r.status]))
    .toEqual([['decision', 'ok'], ['model', 'ok'], ['model', 'ok'], ['tool', 'ok']]);
  // Every receipt counted once: the user pays what the freeze held (D = min(N, H), 2.5.4), the platform bears the rest, as recorded.
  // Each turn rounds its own receipts up, so the two turns can come to one credit more than the sum rounded once; never a call's worth.
  const paid = (await db.query('select sum(coalesce(charged_credits,0))::int c, sum(coalesce(absorbed_credits,0))::int a from turns where actor_id=$1',
    [f.actor])).rows[0];
  const once = await expectedCredits(f.actor);
  expect(paid.c + paid.a).toBeGreaterThanOrEqual(once);
  expect(paid.c + paid.a).toBeLessThanOrEqual(once + 1);
  expect((await db.query("select state,close_kind,failure_code from turns where actor_id=$1 and id=$2", [f.actor, id])).rows[0])
    .toEqual({ state: 'closed', close_kind: 'failed', failure_code: 'resumed' });
  // Someone else's, or a turn no longer paused, is refused before anything opens.
  const again = await turn(f, searchingModel(bodies), suppliers(parallel), false, undefined, undefined, id);
  expect(again.events).toEqual([{ type: 'error', code: 'TURN_RESUME_DENIED' }]);
  expect(bodies).toHaveLength(2);
});

it('RUNTIME: CORE-PATH-V2 V2-6: a message above the interactive ceiling opens when research is usable, never above the research one', async () => {
  const f = await setup(), bodies: string[] = [];
  const plain: typeof fetch = async (_url, init) => { bodies.push(String(init?.body)); const id = `gen-big-${bodies.length}`;
    return respond(id, frame(id, { choices: [{ index: 0, delta: { role: 'assistant', content: 'Read.' }, finish_reason: null }] })
      + frame(id, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + usage(id)); };
  // 100,000 bytes: over the 90,000 interactive ceiling, inside the 150,000 research one with the tool definitions and reserve.
  const big = await turn(f, plain, suppliers(vi.fn()), false, undefined, 'x'.repeat(100_000));
  expect(big.events.at(-1), JSON.stringify(big.events.map(e => e.type))).toMatchObject({ type: 'result', body: 'Read.' });
  const tooBig = await turn(f, plain, suppliers(vi.fn()), false, undefined, 'x'.repeat(149_000));
  expect(tooBig.events).toEqual([{ type: 'error', code: 'TURN_INPUT_TOO_LARGE' }]);
  expect(bodies).toHaveLength(1);
});

it('RUNTIME: CORE-PATH-V2 V2-6: a mixed search charges the user for the data only, the stop-loss counts every known cost', async () => {
  const f = await setup(), bodies: string[] = [];
  const bucket = (await db.query("select abs(hashtext($1::text)) % 16 b, (now() at time zone 'UTC')::date d", [f.actor])).rows[0];
  const spent = () => db.query('select coalesce(sum(spent_usd), 0)::numeric s from daily_spend where day=$1 and bucket=$2', [bucket.d, bucket.b])
    .then(r => Number(r.rows[0].s));
  const before = await spent();
  // Two keywords: the first returns data, the second fails and TikHub still bills it (failed_charged, 0.01 each).
  const route = tikhubRouteId('tiktok', 'keyword_posts')!;
  const tikhub: VendorCalls['tikhub'] = async call => searchResult({ vendor: 'tikhub', route, usage: { unit: 'call', units: '1' },
    ...(call.keyword === 'a' ? {} : { outcome: 'failed', reason: 'UPSTREAM_ERROR', supplierMayCharge: true, items: [] }) });
  const vendors: VendorCalls = { tikhub, parallel: vi.fn(), firecrawl: vi.fn() };
  const out = await turn(f, searchingModel(bodies, { name: 'social_search', args: { platform: 'tiktok', keywords: ['a', 'b'], limit: null } }),
    vendors);
  expect(out.events.at(-1), JSON.stringify(out.events)).toMatchObject({ type: 'result' });
  const tool = (await rows(f.actor)).find(r => r.call_kind === 'tool');
  expect(tool).toMatchObject({ status: 'ok', n: 0.01, c: 0.02 });
  const others = (await db.query(`select coalesce(sum(c.nominal_usd), 0)::float8 n from turn_calls c join turns t on t.id=c.turn_id
    and t.actor_id=c.actor_id where t.actor_id=$1 and c.call_kind <> 'tool' and c.status='ok'`, [f.actor])).rows[0].n as number;
  // The user's credits count the data subcall only; the stop-loss counts both subcalls.
  expect((await db.query('select charged_credits from turns where actor_id=$1', [f.actor])).rows[0].charged_credits)
    .toBe(await expectedCredits(f.actor));
  expect(await spent() - before).toBeCloseTo(others + 0.02, 9);
});
