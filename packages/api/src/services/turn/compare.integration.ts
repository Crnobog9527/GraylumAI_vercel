/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import { pricingConfig } from '../__tests__/fixtures/runtimePricing';
import { DEFAULT_FUSION_SETTINGS, FUSION_SETTINGS_KEY } from '../fusion/settings';
import { clearTestOpenRouterKey, seedTestOpenRouterKey } from '../models/openRouterKey.testing';
import { clearCatalogCache, withCatalogRequest } from '../runtime/catalogCache';
import type { RuntimeCallGate } from '../runtime/newWorkGate';
import type { PositioningClassifier } from '../runtime/positioningGate';
import { POSITIONING_MARKER } from '../runtime/positioningFallback';
import { CORE_PATH_SETTING } from './chat';
import type { ShownQuote } from '../fusion/compareAdmission';
import { loadCompareTurnParts } from '../fusion/compareLoad';
import { runCompareTurn, type CompareEvent } from './compare';
import { turnClients } from './db';
import type { CounterStore } from './limiter';
import { RUNTIME_PAYG_SETTING } from './quote';

/*
 * CORE-PATH-V2 V2-7b acceptance on the local database with a synthetic OpenRouter: a compare turn end to end (Gold, columns in
 * parallel, each bounded on its exact request and accepted by the adapter, receipts with the answers, per-column rounding,
 * adoption), a repeated request, a failed column, the positioning fallback refusal and a response broken after it started.
 */
const connectionString = process.env.V3_LOCAL_DB!;
if (!connectionString?.startsWith('postgres://postgres@127.0.0.1:') || !connectionString.endsWith('/v3_disposable'))
  throw new Error('isolated runner required');
const db = new pg.Client({ connectionString });
const admin = createClient(process.env.V3_LOCAL_REST!, process.env.V3_LOCAL_SERVICE_JWT!, { auth: { persistSession: false } });
const PAIRS = [['anthropic/claude-sonnet-5.5', 'anthropic'], ['openai/gpt-6-luna', 'openai']] as const;
const slots: CounterStore = { take: async () => 1, drop: async () => undefined };
const SETTINGS = [CORE_PATH_SETTING, RUNTIME_PAYG_SETTING, FUSION_SETTINGS_KEY, 'billing_credits_per_usd', 'billing_token_price_multiplier',
  'runtime_rw_v2'];
let saved: Array<{ key: string; value: unknown }> = [];
const models = PAIRS.map(() => randomUUID());
beforeAll(async () => {
  await db.connect();
  saved = (await db.query('select key,value from system_settings where key = any($1)', [SETTINGS])).rows;
  const profiles = PAIRS.map(([model, endpointTag]) => ({ model, endpointTag, protocol: 'openrouter-chat-v1', profileVersion: 'test-only',
    evidenceVersion: 'test-only', admissionPath: 'empirical', templateTokens: 4096, marginTokens: 4096, maxBytes: 196608,
    maxMessages: 128, maxTools: 2, maxSchemaBytes: 16384, purposes: ['fusion_compare'], requestFormats: ['fusion-text-v1-stream'],
    reasoningVariants: [{ reasoning: { effort: 'none' }, outputLimit: 8192, testedOutputLimit: 512, evidenceReference: 'test-only',
      manifestHash: 'b'.repeat(64), outputStressSamples: 2, includesReasoning: true }], outputLimit: 8192,
    evidence: { reference: 'test-only', manifestHash: 'a'.repeat(64), distinctSamples: 60, messageStressSamples: 12,
      maxVerifiedMessages: 128, completeCells: 15, variantsPerCell: 4, maxPromptToBytes: 0.5, maxPromptToUpper: 0.4,
      outputLimit: 8192, testedOutputLimit: 512, outputSemantics: 'max-tokens-includes-reasoning', includesReasoning: true,
      cacheCovered: true, costBoundPassed: true } }));
  for (const [i, [model, tag]] of PAIRS.entries()) {
    // USD per million tokens: 1 prompt, 2 completion (each column's bound is about 0.02 USD on its exact request).
    const { pricing } = pricingConfig(model, tag, '1', '2');
    // PROMPT-CACHE-ALL (#1501): the Anthropic route has a cache-write price, so its compare request carries the breakpoints.
    if (tag === 'anthropic') (pricing.endpoints[0]!.base as Record<string, string>).input_cache_write = '1.25';
    const config = { pricing, reasoning: { route: tag, purposes: { interactive: { mode: 'off', wire: 'reasoning_effort' } },
      catalog: { fetchedAt: pricing.fetchedAt, model, reasoning: { mandatory: false, defaultEnabled: false, supportedEfforts: ['low', 'high'],
        defaultEffort: 'high', supportsMaxTokens: true },
      endpoints: [{ tag, providerName: 'Synthetic', supportedParameters: ['tools', 'reasoning', 'reasoning_effort'], contextLength: 1050000,
        maxCompletionTokens: 8192 }] } } };
    await db.query(`insert into ai_models(id,name,model_id,provider,is_active,max_tokens,input_limit,config,api_endpoint)
      values($1,$2,$2,'openrouter','true',8192,1050000,$3,'https://openrouter.ai/api/v1/chat/completions')`, [models[i], model, JSON.stringify(config)]);
  }
  const set = (key: string, value: unknown) => db.query(
    'insert into system_settings(key,value) values($1,$2) on conflict(key) do update set value=excluded.value', [key, JSON.stringify(value)]);
  await set(CORE_PATH_SETTING, { enabled: true, stopLoss: { limitUsd: 1000, p: 8, poolSize: 8, uFastUsd: 1, uBigUsd: 5 },
    decisionUpperUsd: '0.001' });
  await set(RUNTIME_PAYG_SETTING, { version: 1, enabled: true, policyVersion: 'core-path-test', profiles });
  await set(FUSION_SETTINGS_KEY, { ...DEFAULT_FUSION_SETTINGS, compare: { ...DEFAULT_FUSION_SETTINGS.compare, enabled: true,
    allowedModelIds: models, defaultModelIds: models, minModels: 2, answerOutputTokens: 4096, maxBudgetUsd: '5' } });
  await set('billing_credits_per_usd', 100);
  await set('billing_token_price_multiplier', 6);
  await set('runtime_rw_v2', { catalogCache: true });
  await db.query(`insert into membership_plans(id,name,level,allow_fusion_review,allow_fusion_compare,library_storage_bytes)
    values($1,'Local fixture','gold',true,true,500000000) on conflict(level) do update set allow_fusion_compare=true`, [randomUUID()]);
  await seedTestOpenRouterKey(db, 'LOCAL_SYNTHETIC_OPENROUTER_KEY');
});
afterAll(async () => {
  await db.query('delete from system_settings where key = any($1)', [SETTINGS]);
  for (const row of saved) await db.query('insert into system_settings(key,value) values($1,$2)', [row.key, JSON.stringify(row.value)]);
  await clearTestOpenRouterKey(db);
  clearCatalogCache();
  await db.end();
});

async function member(level = 'gold', credits = 1000) {
  const actor = randomUUID(), session = randomUUID();
  await db.query('insert into profiles(id,credits,membership_level) values($1,$2,$3)', [actor, credits, level]);
  await db.query(`insert into credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,idempotency_key,balance_before,balance_after)
    values($1,$2::int,'addition','grant','opening_grant','system',$3,0,$2::int)`, [actor, credits, 'opening_grant:' + actor]);
  await db.query("insert into runtime_sessions(id,actor_id,scope,start_request_id,start_payload) values($1,$2,$3,$4,'{}')",
    [session, actor, JSON.stringify({ kind: 'positioning_draft', probe: randomUUID() }), randomUUID()]);
  return { actor, session };
}

const frame = (id: string, model: string, extra: Record<string, unknown>) =>
  'data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model, ...extra }) + '\n\n';
const sse = (id: string, model: string, text: string, cost = 0.0021) => new Response(
  frame(id, model, { choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] })
  + frame(id, model, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
  + frame(id, model, { choices: [], usage: { prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050, cost } }) + 'data: [DONE]\n\n',
  { headers: { 'content-type': 'text/event-stream', 'x-generation-id': id } });
const parts = (question: string) => ({ skill: null, workspace: [], references: [], question, replyLocale: 'en' as const });
async function compare(f: { actor: string; session: string }, transport: typeof fetch, input: { requestId?: string; question?: string;
  gate?: PositioningClassifier; calls?: RuntimeCallGate; shown?: ShownQuote } = {}) {
  const events: CompareEvent[] = [];
  await withCatalogRequest(() => runCompareTurn({ admin, clients: turnClients(admin), slots, transport,
    newWork: { message: async () => ({ ok: true }), calls: input.calls ?? (async () => ({ ok: true })) },
    // The synthetic Decisions check: allowed, reporting a provider cost (as the free-chat tests).
    gate: { classify: input.gate ?? (async ({ onCost }) => { onCost?.(0.00002); return 'allow'; }) } },
  { actorId: f.actor, sessionId: f.session, requestId: input.requestId ?? randomUUID(), modelIds: models, ...(input.shown ? { shown: input.shown } : {}),
    parts: parts(input.question ?? 'Which plan?') }, e => events.push(e)));
  return events;
}
const credits = async (actor: string) => (await db.query('select credits from profiles where id=$1', [actor])).rows[0].credits as number;

it('RUNTIME: CORE-PATH-V2 V2-7b: a compare answers in parallel columns, each bounded on its exact request, settled column by column, adopted once', async () => {
  const f = await member();
  const bodies: Array<Record<string, unknown>> = [];
  const transport: typeof fetch = async (_url, init) => { const body = JSON.parse(String(init?.body)); bodies.push(body);
    return sse('gen-cmp-' + randomUUID(), body.model as string, 'Answer of ' + body.model); };
  const events = await compare(f, transport);
  expect(events.map(e => e.type).filter(t => t !== 'column'), JSON.stringify(events)).toEqual(['opened', 'answer', 'answer', 'result']);
  expect(bodies.map(b => b.model).sort()).toEqual(PAIRS.map(p => p[0]).sort());
  const result = events.at(-1) as Extract<CompareEvent, { type: 'result' }>;
  // The columns stream the answers' text, not provider frames (#1522 review).
  for (const [index] of models.entries()) {
    const text = events.filter(e => e.type === 'column' && e.index === index).map(e => (e as { delta: string }).delta).join('');
    expect(PAIRS.map(p => 'Answer of ' + p[0])).toContain(text);
  }
  // Each column: n = (1000 x 0.000001 + 50 x 0.000002) = 0.0011 USD; ceil(100 x 0.0011 x 6) = 1 credit per column.
  expect(result).toMatchObject({ chargedCredits: 2, settlement: 'done' });
  expect(await credits(f.actor)).toBe(998);
  const calls = (await db.query(`select c.seq,c.status,c.call_kind from turn_calls c join turns t on t.id=c.turn_id and t.actor_id=c.actor_id
    where t.actor_id=$1 order by c.seq`, [f.actor])).rows;
  // The positioning check first (an account without a confirmed positioning; never charged), then the two columns.
  expect(calls.map(c => c.call_kind + ':' + c.status)).toEqual(['decision:ok', 'model:ok', 'model:ok']);
  const outputs = (await db.query('select seq,body,verdict from fusion_turn_outputs where actor_id=$1 order by seq', [f.actor])).rows;
  expect(outputs.map(o => o.verdict)).toEqual(['usable', 'usable']);
  const adopted = await admin.rpc('fusion_compare_turn_adopt', { p_actor_id: f.actor, p_compare_id: result.compareId, p_seq: outputs[0].seq });
  expect(adopted.error).toBeNull();
  expect((await db.query('select role,content from session_messages where session_id=$1 order by seq', [f.session])).rows)
    .toEqual([{ role: 'user', content: 'Which plan?' }, { role: 'assistant', content: outputs[0].body }]);
  // The next compare sees that history, as plain messages after the system message; on the Anthropic route the system message
  // and the last earlier turn are the cache breakpoints (#1501), and the adapter sends that request.
  bodies.length = 0;
  const next = await compare(f, transport, { question: 'And then?' });
  expect(next.at(-1)).toMatchObject({ type: 'result' });
  for (const body of bodies) expect((body.messages as Array<{ role: string }>).map(m => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
  const anthropic = bodies.find(b => b.model === PAIRS[0][0])!.messages as Array<{ content: unknown }>;
  expect(JSON.stringify(anthropic[0]!.content)).toContain('cache_control');
  expect(JSON.stringify(anthropic[2]!.content)).toContain('cache_control');
  expect(JSON.stringify(anthropic[3]!.content)).not.toContain('cache_control');
  expect(JSON.stringify(bodies.find(b => b.model === PAIRS[1][0]))).not.toContain('cache_control');
});

it('RUNTIME: CORE-PATH-V2 V2-7b: the parts POST /api/turn reads are what a column is sent, on a conversation of the turn path', async () => {
  const f = await member();
  const read = await loadCompareTurnParts({ admin, user: admin, actorId: f.actor }, { sessionId: f.session, question: 'Which plan?' });
  expect(read).toMatchObject({ skill: null, workspace: [], references: [], question: 'Which plan?' });
  expect('scopeMaterial' in read).toBe(false);
});

it('RUNTIME: CORE-PATH-V2 V2-7b: a quote the user saw below the real bound refuses before anything is frozen; a covering one opens', async () => {
  const f = await member();
  const transport: typeof fetch = async () => { throw new Error('nothing may be sent'); };
  const bound = (await compare(f, async (_url, init) => sse('gen-cmp-' + randomUUID(), JSON.parse(String(init?.body)).model, 'A'))).at(-1);
  expect(bound).toMatchObject({ type: 'result' });
  const row = (await db.query('select reserved_credits g from turns where actor_id=$1', [f.actor])).rows[0];
  const columns = (credits: number) => models.map(modelId => ({ modelId, credits, usd: '1' }));
  const g = await member();
  const low = await compare(g, transport, { shown: { credits: row.g - 1, columns: columns(1) } });
  expect(low).toEqual([{ type: 'error', code: 'FUSION_COMPARE_PRICE_CHANGED' }]);
  expect(await credits(g.actor)).toBe(1000);
  expect((await db.query('select count(*)::int n from turns where actor_id=$1', [g.actor])).rows[0].n).toBe(0);
});

it('RUNTIME: CORE-PATH-V2 V2-7b: a repeated compare request never calls again; only Gold compares', async () => {
  const f = await member();
  let posts = 0;
  const transport: typeof fetch = async (_url, init) => { posts++; const body = JSON.parse(String(init?.body));
    return sse('gen-cmp-' + randomUUID(), body.model, 'Answer'); };
  const requestId = randomUUID();
  const first = await compare(f, transport, { requestId });
  expect(first.at(-1)).toMatchObject({ type: 'result', chargedCredits: 2 });
  expect(posts).toBe(2);
  const again = await compare(f, transport, { requestId });
  expect(again.at(-1)).toMatchObject({ type: 'error', code: 'TURN_REQUEST_REPLAYED' });
  expect(posts).toBe(2);
  expect(await credits(f.actor)).toBe(998);
  const pro = await member('pro');
  const refused = await compare(pro, transport);
  expect(refused).toHaveLength(1);
  expect(refused[0]).toMatchObject({ type: 'error' });
  expect(['FUSION_COMPARE_FORBIDDEN', 'FUSION_MEMBERSHIP_REQUIRED', 'TURN_MEMBERSHIP_REQUIRED']).toContain((refused[0] as { code: string }).code);
  expect(await credits(pro.actor)).toBe(1000);
});

it('RUNTIME: CORE-PATH-V2 V2-7b: without a positioning the fallback rule goes to every column; a refusing column is neither shown nor charged', async () => {
  const f = await member();
  const bodies: string[] = [];
  const transport: typeof fetch = async (_url, init) => { bodies.push(String(init?.body)); const body = JSON.parse(String(init?.body));
    return sse('gen-cmp-' + randomUUID(), body.model, body.model === PAIRS[0][0] ? POSITIONING_MARKER : 'A real answer'); };
  const events = await compare(f, transport, { gate: async ({ onCost }) => { onCost?.(0.00002); return 'allow'; } });
  expect(bodies.every(b => b.includes(POSITIONING_MARKER.slice(0, 12)))).toBe(true);
  expect(events.filter(e => e.type === 'answer').map(e => (e as { ok: boolean }).ok).sort()).toEqual([false, true]);
  expect(events.at(-1)).toMatchObject({ type: 'result', chargedCredits: 1 });
  // The refusing column never streams its marker (#1522 review); the other column's answer does.
  const shown = events.filter(e => e.type === 'column').map(e => (e as { delta: string }).delta).join('');
  expect(shown).toBe('A real answer');
  expect((await db.query(`select c.call_kind,c.status from turn_calls c join turns t on t.id=c.turn_id and t.actor_id=c.actor_id
    where t.actor_id=$1 order by c.seq`, [f.actor])).rows.map(r => r.call_kind + ':' + r.status).sort())
    .toEqual(['decision:ok', 'model:ok', 'model:unusable']);
});

it('RUNTIME: CORE-PATH-V2 V2-7b: the single-compare budget also bounds what the user may pay, not only the provider cost', async () => {
  // The bounds of one compare as admitted: U (USD, the columns plus the positioning check) and G (credits, at q = 100, m = 6).
  const probe = await member();
  await compare(probe, async (_url, init) => sse('gen-cmp-' + randomUUID(), JSON.parse(String(init?.body)).model, 'A'));
  const bounds = (await db.query('select reserved_usd::float8 u,reserved_credits g from turns where actor_id=$1', [probe.actor])).rows[0];
  // A budget above the provider cost bounds but below what the credits cost: refused (G > budget x q).
  const usd = Math.ceil(bounds.u * 1.5 * 1e6) / 1e6;
  expect(bounds.g).toBeGreaterThan(usd * 100);
  const f = await member();
  const transport: typeof fetch = async () => { throw new Error('nothing may be sent'); };
  const budget = (value: string) => db.query(`update system_settings set value=jsonb_set(value,'{compare,maxBudgetUsd}',to_jsonb($1::text))
    where key=$2`, [value, FUSION_SETTINGS_KEY]).then(() => clearCatalogCache());
  await budget(usd.toFixed(6));
  try {
    expect(await compare(f, transport)).toEqual([{ type: 'error', code: 'FUSION_BUDGET_EXCEEDED' }]);
    expect((await db.query('select count(*)::int n from turns where actor_id=$1', [f.actor])).rows[0].n).toBe(0);
  } finally { await budget('5'); }
});

it('RUNTIME: CORE-PATH-V2 V2-7b: the platform pause or a call limit sends no column and refunds everything (#1522 review)', async () => {
  const f = await member();
  let posts = 0;
  const transport: typeof fetch = async () => { posts++; throw new Error('nothing may be sent'); };
  const events = await compare(f, transport, { calls: async () => ({ ok: false, reason: 'paused' }) as never });
  expect(posts).toBe(0);
  expect(events.filter(e => e.type === 'answer').map(e => (e as { code?: string }).code)).toEqual(['TURN_NEW_CALLS_PAUSED', 'TURN_NEW_CALLS_PAUSED']);
  expect((await db.query("select count(*)::int n from turn_calls c join turns t on t.id=c.turn_id and t.actor_id=c.actor_id where t.actor_id=$1 and c.call_kind='model'",
    [f.actor])).rows[0].n).toBe(0);
  expect(await credits(f.actor)).toBe(1000);
});

it('RUNTIME: CORE-PATH-V2 V2-7b: every column refusing under the fallback rule is a positioning refusal, counted toward the cap', async () => {
  const f = await member();
  const transport: typeof fetch = async (_url, init) => { const body = JSON.parse(String(init?.body));
    return sse('gen-cmp-' + randomUUID(), body.model, POSITIONING_MARKER); };
  const events = await compare(f, transport);
  expect(events.at(-1)).toMatchObject({ type: 'error', code: 'POSITIONING_REQUIRED' });
  expect(events.filter(e => e.type === 'column')).toEqual([]);
  expect((await db.query('select failure_code,charged_credits from turns where actor_id=$1', [f.actor])).rows)
    .toEqual([{ failure_code: 'positioning_required', charged_credits: 0 }]);
  expect(await credits(f.actor)).toBe(1000);
});

it('RUNTIME: CORE-PATH-V2 V2-7b: a complete column whose cost is not final yet keeps its answer; only its cost waits (#1522 review)', async () => {
  const f = await member();
  const transport: typeof fetch = async (_url, init) => { const body = JSON.parse(String(init?.body));
    if (body.model !== PAIRS[1][0]) return sse('gen-cmp-' + randomUUID(), body.model, 'Settled');
    // A normal end without the usage frame: the answer is complete, its cost unknown.
    return new Response(frame('gen-nocost', body.model, { choices: [{ index: 0, delta: { role: 'assistant', content: 'Kept answer' },
      finish_reason: null }] }) + frame('gen-nocost', body.model, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
      + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream', 'x-generation-id': 'gen-nocost' } }); };
  const events = await compare(f, transport);
  expect(events.filter(e => e.type === 'answer').map(e => (e as { ok: boolean }).ok)).toEqual([true, true]);
  expect(events.at(-1)).toMatchObject({ type: 'result', settlement: 'pending' });
  expect((await db.query(`select o.body,c.status from fusion_turn_outputs o join turn_calls c using(turn_id,seq)
    where o.actor_id=$1 order by o.seq`, [f.actor])).rows.map(r => r.body + ':' + r.status).sort())
    .toEqual(['Kept answer:unknown', 'Settled:ok']);
});

it('RUNTIME: CORE-PATH-V2 V2-7b: a refusing column whose cost is not final is saved as refused, so recovery never charges it (#1522 review)', async () => {
  const f = await member();
  const transport: typeof fetch = async (_url, init) => { const body = JSON.parse(String(init?.body));
    if (body.model !== PAIRS[0][0]) return sse('gen-cmp-' + randomUUID(), body.model, 'A real answer');
    return new Response(frame('gen-refused', body.model, { choices: [{ index: 0, delta: { role: 'assistant', content: POSITIONING_MARKER },
      finish_reason: null }] }) + frame('gen-refused', body.model, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
      + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream', 'x-generation-id': 'gen-refused' } }); };
  const events = await compare(f, transport, { gate: async ({ onCost }) => { onCost?.(0.00002); return 'allow'; } });
  expect(events.at(-1)).toMatchObject({ type: 'result', settlement: 'pending' });
  expect((await db.query(`select o.verdict,c.status from fusion_turn_outputs o join turn_calls c using(turn_id,seq)
    where o.actor_id=$1`, [f.actor])).rows.map(r => r.verdict + ':' + r.status).sort()).toEqual(['no_delivery:unknown', 'usable:ok']);
});

it('RUNTIME: CORE-PATH-V2 V2-7b: an empty column whose cost is not final is saved as undelivered, so recovery never charges it (#1522 review)', async () => {
  const f = await member();
  const transport: typeof fetch = async (_url, init) => { const body = JSON.parse(String(init?.body));
    if (body.model !== PAIRS[0][0]) return sse('gen-cmp-' + randomUUID(), body.model, 'A real answer');
    return new Response(frame('gen-empty', body.model, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream', 'x-generation-id': 'gen-empty' } }); };
  const events = await compare(f, transport);
  expect(events.at(-1)).toMatchObject({ type: 'result', settlement: 'pending' });
  expect((await db.query(`select o.verdict from fusion_turn_outputs o where o.actor_id=$1`, [f.actor])).rows.map(r => r.verdict).sort())
    .toEqual(['no_delivery', 'usable']);
});

it('RUNTIME: CORE-PATH-V2 V2-7b: a column broken after it started keeps its freeze for recovery and is never sent again', async () => {
  const f = await member();
  let posts = 0;
  const transport: typeof fetch = async (_url, init) => { posts++; const body = JSON.parse(String(init?.body));
    if (body.model !== PAIRS[1][0]) return sse('gen-cmp-' + randomUUID(), body.model, 'Fine');
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(frame('gen-broken-cmp', body.model, { choices: [{ index: 0, delta: { content: 'Half' } }] })));
      controller.error(new Error('connection lost'));
    } }), { headers: { 'content-type': 'text/event-stream', 'x-generation-id': 'gen-broken-cmp' } }); };
  const events = await compare(f, transport);
  expect(posts).toBe(2);
  expect(events.at(-1)).toMatchObject({ type: 'result', settlement: 'pending', chargedCredits: null });
  expect((await db.query(`select c.status,c.cost_pending,c.provider_id from turn_calls c join turns t on t.id=c.turn_id and t.actor_id=c.actor_id
    where t.actor_id=$1 and c.status<>'ok' and c.call_kind='model'`, [f.actor])).rows).toEqual([{ status: 'unknown', cost_pending: true, provider_id: 'gen-broken-cmp' }]);
  expect(await credits(f.actor)).toBeLessThan(1000);
});
