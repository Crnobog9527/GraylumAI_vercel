/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import { makePackage, makeWorkflow } from '../__tests__/fixtures/artifacts';
import { pricingConfig } from '../__tests__/fixtures/runtimePricing';
import { clearTestOpenRouterKey, seedTestOpenRouterKey } from '../models/openRouterKey.testing';
import { opcService } from '../opc/service';
import { clearCatalogCache, withCatalogRequest } from '../runtime/catalogCache';
import { publishSkillPackage } from '../skills/publication';
import { CORE_PATH_SETTING } from './chat';
import { turnClients } from './db';
import type { CounterStore } from './limiter';
import { runMentorTurn, type MentorDeps } from './mentor';
import { RUNTIME_PAYG_SETTING } from './quote';
import type { TurnEvent } from './sse';

// The draft is started through the old service (it is not part of a turn); its rate limiter is not under test here.
vi.mock('../runtime/newWorkGate', async importOriginal => ({
  ...await importOriginal<typeof import('../runtime/newWorkGate')>(),
  ...(await import('../__tests__/fixtures/runtimeGates')).testAdmissionGates,
}));

/*
 * CORE-PATH-V2 V2-5 acceptance on the local database with a synthetic OpenRouter: a positioning-mentor turn end to end
 * (opening, a reply that reads one Skill file, the organizer's checklist patch applied at close), its Postgres round trips
 * (plan 3.1: <= 11 of its own, plus the fixed 2 per request), a choice card, a module the draft is not bound to, and an
 * organizer reply that is not a patch object.
 */
const connectionString = process.env.V3_LOCAL_DB!;
if (!connectionString?.startsWith('postgres://postgres@127.0.0.1:') || !connectionString.endsWith('/v3_disposable'))
  throw new Error('isolated runner required');
const db = new pg.Client({ connectionString });
const MENTOR = 'anthropic/claude-sonnet-5.5', ORGANIZER = 'anthropic/claude-opus-5.5', ROUTE = 'anthropic';
const slots: CounterStore = { take: async () => 1, drop: async () => undefined };
const SETTINGS = [CORE_PATH_SETTING, RUNTIME_PAYG_SETTING, 'billing_credits_per_usd', 'billing_token_price_multiplier', 'runtime_rw_v2',
  'v3_summary_model_id', 'v3_summary_max_tokens', 'billing_payg_start_thresholds'];
let saved: Array<{ key: string; value: unknown }> = [];
const rest = () => createClient(process.env.V3_LOCAL_REST!, process.env.V3_LOCAL_SERVICE_JWT!, { auth: { persistSession: false } });
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
const profile = (model: string) => ({ model, endpointTag: ROUTE, protocol: 'openrouter-chat-v1', profileVersion: 'test-only',
  evidenceVersion: 'test-only', admissionPath: 'empirical', templateTokens: 4096, marginTokens: 4096, maxBytes: 196608, maxMessages: 128,
  maxTools: 9, maxSchemaBytes: 16384, purposes: ['skill', 'attached_organizer'], requestFormats: ['agent-turn-v5-stream'],
  reasoningVariants: [{ reasoning: { effort: 'none' }, outputLimit: 8192, testedOutputLimit: 512, evidenceReference: 'test-only',
    manifestHash: 'b'.repeat(64), outputStressSamples: 2, includesReasoning: true }], outputLimit: 8192,
  evidence: { reference: 'test-only', manifestHash: 'a'.repeat(64), distinctSamples: 60, messageStressSamples: 12,
    maxVerifiedMessages: 128, completeCells: 15, variantsPerCell: 4, maxPromptToBytes: 0.5, maxPromptToUpper: 0.4,
    outputLimit: 8192, testedOutputLimit: 512, outputSemantics: 'max-tokens-includes-reasoning', includesReasoning: true,
    cacheCovered: true, costBoundPassed: true } });

async function model(id: string, name: string) {
  const { pricing } = pricingConfig(name, ROUTE, '0.000003', '0.000015');
  (pricing.endpoints[0]!.base as Record<string, string>).input_cache_write = '0.00000375';
  const off = { mode: 'off', wire: 'reasoning_effort' };
  const config = { pricing, reasoning: { route: ROUTE, purposes: { interactive: off, organize: off },
    catalog: { fetchedAt: pricing.fetchedAt, model: name, reasoning: { mandatory: false, defaultEnabled: false, supportedEfforts: ['low', 'high'],
      defaultEffort: 'high', supportsMaxTokens: true },
    endpoints: [{ tag: ROUTE, providerName: 'Anthropic', supportedParameters: ['tools', 'reasoning', 'reasoning_effort'], contextLength: 1050000,
      maxCompletionTokens: 8192 }] } } };
  await db.query(`insert into ai_models(id,name,model_id,provider,is_active,max_tokens,input_limit,config,api_endpoint)
    values($1,$2,$3,'openrouter','true',8192,1050000,$4,'https://openrouter.ai/api/v1/chat/completions')`,
  [id, 'Mentor fixture ' + name, name, JSON.stringify(config)]);
}

async function setup() {
  clearCatalogCache();
  const owner = randomUUID(), mentorId = randomUUID(), organizerId = randomUUID(), moduleId = randomUUID();
  const email = randomUUID() + '@example.test', password = 'Local-' + randomUUID() + '!';
  const admin = rest();
  const made = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (made.error) throw made.error;
  const actor = made.data.user.id;
  await db.query("insert into profiles(id,role,credits) values($1,'admin',10000),($2,'user',1000)", [owner, actor]);
  await db.query(`insert into credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,idempotency_key,balance_before,balance_after)
    values($1,1000,'addition','grant','opening_grant','system',$2,0,1000)`, [actor, 'opening_grant:' + actor]);
  await model(mentorId, MENTOR); await model(organizerId, ORGANIZER);
  const pack = makePackage(), registration = 'mentor-' + randomUUID(), flow = makeWorkflow(3);
  flow.steps.forEach((s, i) => { s.information = [{ id: 'goal', title: 'Goal', required: true, profileKey: 'goal_' + i },
    { id: 'other', title: 'Other', required: false }]; });
  await db.query('insert into skills(id,skill_key,created_by) values($1,$2,$3)', [pack.id, registration, owner]);
  await db.query('insert into modules(id,title,skill_id,model_id,active) values($1,$2,$3,$4,true)', [moduleId, registration, pack.id, mentorId]);
  await publishSkillPackage(admin, owner, pack);
  await db.query('insert into artifact_workflows(id,module_id,skill_id,revision_id,workflow,label,enabled) values($1,$2,$3,$4,$5,$6,true)',
    [registration, moduleId, pack.id, pack.revisionId, flow, registration]);
  const user = createClient(process.env.V3_LOCAL_REST!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
  const login = await user.auth.signInWithPassword({ email, password });
  if (login.error) throw login.error;
  const draft = await opcService(user, admin).start({ requestId: randomUUID(), registration, mode: 'mentor' });
  const session = (await db.query('select session_id from opc_drafts where draft_id=$1', [draft.draftId])).rows[0].session_id as string;
  const set = (key: string, value: unknown) => db.query(
    'insert into system_settings(key,value) values($1,$2) on conflict(key) do update set value=excluded.value', [key, JSON.stringify(value)]);
  await set(CORE_PATH_SETTING, { enabled: true, stopLoss: { limitUsd: 1000, p: 8, poolSize: 8, uFastUsd: 1, uBigUsd: 5 }, decisionUpperUsd: '0.001' });
  await set(RUNTIME_PAYG_SETTING, { version: 1, enabled: true, policyVersion: 'core-path-test', profiles: [profile(MENTOR), profile(ORGANIZER)] });
  await set('billing_credits_per_usd', 100);
  await set('billing_token_price_multiplier', 6);
  await set('runtime_rw_v2', { catalogCache: true });
  await set('v3_summary_model_id', organizerId);
  await set('v3_summary_max_tokens', 2048);
  // The start threshold L of each call's model and purpose: the mentor (skill) and the organizer (attached_organizer).
  await set('billing_payg_start_thresholds', { version: 'core-path-test', thresholds: [
    { model: MENTOR, purpose: 'skill', typicalUsd: '0.04' }, { model: ORGANIZER, purpose: 'attached_organizer', typicalUsd: '0.01' }] });
  await seedTestOpenRouterKey(db, 'LOCAL_SYNTHETIC_OPENROUTER_KEY');
  const steps = async () => (await db.query('select r.steps from artifact_rounds r join opc_drafts d on d.round_id=r.id where d.draft_id=$1',
    [draft.draftId])).rows[0].steps;
  return { actor, session, moduleId, draftId: draft.draftId, steps };
}

/** A Supabase client that counts its Postgres round trips by REST path. */
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

// The synthetic OpenRouter: the mentor streams (text, or one tool call); the organizer answers one JSON completion.
const frame = (id: string, model: string, extra: Record<string, unknown>) =>
  'data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model, ...extra }) + '\n\n';
const usage = (id: string, model: string, finish: string) => frame(id, model, { choices: [{ index: 0, delta: {}, finish_reason: finish }] })
  // A cost inside the call's frozen bound (this fixture's bound is small): above it the model would be blocked (budget_conflict).
  + frame(id, model, { choices: [], usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1, cost: 0.000003 } }) + 'data: [DONE]\n\n';
const streamed = (id: string, body: string) => new Response(body, { headers: { 'content-type': 'text/event-stream', 'x-generation-id': id } });
const prose = (id: string, text: string) => streamed(id, frame(id, MENTOR, { choices: [{ index: 0, delta: { role: 'assistant', content: text },
  finish_reason: null }] }) + usage(id, MENTOR, 'stop'));
const toolCall = (id: string, name: string, args: unknown) => streamed(id, frame(id, MENTOR, { choices: [{ index: 0, delta: { role: 'assistant',
  tool_calls: [{ index: 0, id: 'call-' + id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] })
  + usage(id, MENTOR, 'tool_calls'));
const organized = (id: string, content: string) => new Response(JSON.stringify({ id, object: 'chat.completion', created: 1, model: ORGANIZER,
  choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1, cost: 0.000003 } }),
{ headers: { 'content-type': 'application/json', 'x-generation-id': id } });
const patch = (value: string) => JSON.stringify({ inputKind: 'answer', notes: [],
  patches: [{ stepId: 'step-0', fieldId: 'goal', value, status: 'provisional', nature: 'fact', basis: 'user_statement' }] });

type Reply = (body: { model: string; messages: Array<{ role: string; content: unknown }> }, n: number) => Response | Promise<Response>;
function transport(reply: Reply) {
  const bodies: Array<{ model: string; messages: Array<{ role: string; content: unknown }>; tools?: unknown[]; tool_choice?: string }> = [];
  const fn: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    return reply(body, bodies.length);
  };
  return { fn, bodies };
}
// The runtime rate limits and pause (newWorkGate) are Redis-backed; here a stub that admits, or refuses as a case needs.
const admit = async () => ({ ok: true as const });
type NewWork = MentorDeps['newWork'];
async function turn(f: Awaited<ReturnType<typeof setup>>, input: { text: string; transport: typeof fetch; moduleId?: string;
  organizeAfter?: boolean; newWork?: NewWork; answer?: { optionIndex?: number } }) {
  const { admin, calls } = countingAdmin(), events: TurnEvent[] = [];
  await withCatalogRequest(() => runMentorTurn({ admin, clients: turnClients(admin), slots, transport: input.transport,
    newWork: input.newWork ?? { message: admit, calls: admit } },
    { actorId: f.actor, sessionId: f.session, requestId: randomUUID(), moduleId: input.moduleId ?? f.moduleId, stepId: 'step-0',
      text: input.text, organizeAfter: input.organizeAfter ?? true, ...(input.answer ? { answer: input.answer } : {}) },
    e => events.push(e)));
  return { events, calls };
}
const credits = async (actor: string) => (await db.query('select credits from profiles where id=$1', [actor])).rows[0].credits as number;

it('RUNTIME: CORE-PATH-V2 V2-5: a mentor turn opens with the draft, reads one Skill file, applies the organizer patch at close, in <= 11 round trips', async () => {
  const f = await setup();
  // 1. The host opening: no tool may be called (tool_choice none, same tools), organized, no history marker.
  const open = transport((body, n) => body.model === ORGANIZER ? organized('gen-org-' + n, JSON.stringify({ inputKind: 'answer', patches: [], notes: [] }))
    : prose('gen-open-' + n, 'Welcome. What is your goal?'));
  const opening = await turn(f, { text: 'HOST_OPEN_CURRENT_QUESTION', transport: open.fn });
  expect(opening.events.map(e => e.type), JSON.stringify(opening.events)).toEqual(['opened', 'text', 'result']);
  expect(open.bodies.map(b => b.model)).toEqual([MENTOR, ORGANIZER]);
  expect(open.bodies[0]!.tool_choice).toBe('none');
  expect(JSON.stringify(open.bodies[0]).match(/cache_control/g)).toHaveLength(2);

  // 2. A user turn: the mentor reads its step file, then answers; the organizer patches the goal field.
  const t = transport((body, n) => body.model === ORGANIZER ? organized('gen-org-' + n, patch('Sell coffee to students'))
    : body.messages.some(m => m.role === 'tool') ? prose('gen-reply-' + n, 'Good. Who buys it?')
      // A file outside this step's resources: prepared before the first call, so reading it adds no round trip.
      : toolCall('gen-read-' + n, 'read_skill_file', { path: 'references/step-2.md' }));
  const second = await turn(f, { text: 'I want to sell coffee to students', transport: t.fn });
  expect(second.events.map(e => e.type), JSON.stringify(second.events)).toEqual(['opened', 'text', 'result']);
  const result = second.events.at(-1) as Extract<TurnEvent, { type: 'result' }>;
  expect(JSON.parse(result.body)).toEqual({ format: 'agent-turn.v1', message: 'Good. Who buys it?', card: null });
  expect(result.kindResult).toMatchObject({ result: 'applied', fields: { 'step-0': ['goal'] } });
  expect(t.bodies.map(b => b.model)).toEqual([MENTOR, MENTOR, ORGANIZER]);
  // The Skill file came from the cache: the tool result is in the continuation request.
  expect(JSON.stringify(t.bodies[1]!.messages.at(-1))).toContain('Synthetic resource 2');
  // Three breakpoints on the request with history: SKILL.md end, system end, the last plain history message.
  expect(JSON.stringify(t.bodies[0]).match(/cache_control/g)).toHaveLength(3);
  const first = (b: { messages: Array<{ content: unknown }> }) => (b.messages[0]!.content as Array<{ text: string }>)[0]!.text;
  expect(first(t.bodies[0]!)).toBe(first(open.bodies[0]!));
  const steps = await f.steps();
  expect(steps['step-0'].information.goal).toEqual({ value: 'Sell coffee to students', status: 'provisional', nature: 'fact' });
  expect(steps['step-0'].fieldMeta.goal).toMatchObject({ source: 'capture', basis: 'user_statement' });
  // Both turns charged once each, both messages of each saved.
  // V2-8: the model and price table of each model are frozen per model id for recovery.
  const frozen = (await db.query("select policy from turns where actor_id=$1 order by id desc limit 1", [f.actor])).rows[0].policy;
  expect(Object.values(frozen.models).sort()).toEqual([ORGANIZER, MENTOR].sort());
  expect(Object.keys(frozen.pricings)).toEqual(Object.keys(frozen.models));
  const turns = (await db.query("select kind,close_kind,charged_credits,settlement from turns where actor_id=$1 order by id", [f.actor])).rows;
  expect(turns.map(r => [r.kind, r.close_kind, r.settlement])).toEqual([['mentor', 'completed', 'done'], ['mentor', 'completed', 'done']]);
  expect(await credits(f.actor)).toBe(1000 - turns.reduce((sum, r) => sum + r.charged_credits, 0));
  expect((await db.query('select role,content from session_messages where session_id=$1 order by seq', [f.session])).rows.map(r => r.role))
    .toEqual(['user', 'assistant', 'user', 'assistant']);
  // The budget (plan 3.1): the turn's own <= 11 (open, three calls of three writes, close); plus the fixed 2 per request.
  const own = second.calls.filter(c => c.startsWith('rpc/turn_')), fixed = second.calls.filter(c => !c.startsWith('rpc/turn_'));
  console.log('CORE-PATH-V2 mentor round trips', JSON.stringify({ total: second.calls.length, own: own.length, fixed: fixed.length,
    calls: second.calls }));
  expect(own).toEqual(['rpc/turn_open', ...Array(3).fill(['rpc/turn_call_begin', 'rpc/turn_call_identity', 'rpc/turn_call_record']).flat(),
    'rpc/turn_close']);
  expect(own.length).toBeLessThanOrEqual(11);
  expect(fixed).toEqual(['rpc/catalog_versions_snapshot', 'rpc/platform_secret_read']);
});

it('RUNTIME: CORE-PATH-V2 V2-5: a grounded choice card ends the reply and is saved as the agent-turn card', async () => {
  const f = await setup();
  const t = transport((body, n) => body.model === ORGANIZER ? organized('gen-org-' + n, JSON.stringify({ inputKind: 'answer', patches: [], notes: [] }))
    : toolCall('gen-card-' + n, 'ask_question', { intent: 'grounded_comparison', requestQuote: 'coffee or tea',
      basisQuotes: ['coffee or tea'], question: 'Which one first?', options: [{ text: 'Coffee', reason: 'You named it first' },
        { text: 'Tea', reason: 'Fewer rivals' }], recommended: 0 }));
  const out = await turn(f, { text: 'Should I start with coffee or tea?', transport: t.fn });
  const result = out.events.at(-1) as Extract<TurnEvent, { type: 'result' }>;
  expect(result.type, JSON.stringify(out.events)).toBe('result');
  expect(JSON.parse(result.body).card).toMatchObject({ question: 'Which one first?', options: ['Coffee', 'Tea'], recommended: 0 });
  expect(t.bodies.map(b => b.model)).toEqual([MENTOR, ORGANIZER]);
});

it('RUNTIME: CORE-PATH-V2 V2-5: a module the draft is not bound to is refused before anything is frozen or sent', async () => {
  const f = await setup();
  const other = randomUUID();
  await db.query("insert into modules(id,title,skill_id,model_id,active) select $1,'other',skill_id,model_id,true from modules where id=$2",
    [other, f.moduleId]);
  const t = transport(() => { throw new Error('nothing may be sent'); });
  const out = await turn(f, { text: 'Hello', transport: t.fn, moduleId: other });
  expect(out.events).toEqual([{ type: 'error', code: 'TURN_MENTOR_DENIED' }]);
  expect(t.bodies).toEqual([]);
  expect(await credits(f.actor)).toBe(1000);
  expect((await db.query('select count(*)::int n from turns where actor_id=$1', [f.actor])).rows[0].n).toBe(0);
});

it('RUNTIME: CORE-PATH-V2 V2-5: an organizer reply that is not a patch object keeps the reply and records invalid_output', async () => {
  const f = await setup();
  const t = transport((body, n) => body.model === ORGANIZER ? organized('gen-org-' + n, 'not json')
    : prose('gen-reply-' + n, 'Noted.'));
  const out = await turn(f, { text: 'My goal is coffee', transport: t.fn });
  const result = out.events.at(-1) as Extract<TurnEvent, { type: 'result' }>;
  expect(result.kindResult).toMatchObject({ result: 'invalid_output' });
  expect((await f.steps())['step-0'].information?.goal?.value ?? '').toBe('');
  expect((await db.query("select close_kind from turns where actor_id=$1", [f.actor])).rows).toEqual([{ close_kind: 'completed' }]);
});

it('RUNTIME: CORE-PATH-V2 V2-5: a checklist edited while the turn runs turns the organizer patch into a suggestion, never an overwrite', async () => {
  const f = await setup();
  const t = transport(async (body, n) => {
    if (body.model !== ORGANIZER) return prose('gen-reply-' + n, 'Noted.');
    // The user saves the step by hand while the organizer runs (opc_information bumps the step version).
    await db.query(`update artifact_rounds r set steps=jsonb_set(r.steps,'{step-0,version}',to_jsonb((r.steps->'step-0'->>'version')::int+1))
      from opc_drafts d where d.round_id=r.id and d.draft_id=$1`, [f.draftId]);
    return organized('gen-org-' + n, patch('Sell coffee to students'));
  });
  const out = await turn(f, { text: 'I want to sell coffee to students', transport: t.fn });
  const result = out.events.at(-1) as Extract<TurnEvent, { type: 'result' }>;
  expect(result.kindResult, JSON.stringify(out.events)).toMatchObject({ result: 'suggested' });
  const steps = await f.steps();
  expect(steps['step-0'].information?.goal?.value ?? '').toBe('');
  expect(steps['step-0'].fieldMeta.goal.suggestion).toMatchObject({ value: 'Sell coffee to students', basis: 'user_statement' });
  // The next turn's organizer is shown that suggestion (and only it sees its content); withdrawing it is applied.
  const next = transport((body, n) => body.model !== ORGANIZER ? prose('gen-reply-' + n, 'Understood.')
    : organized('gen-org-' + n, JSON.stringify({ inputKind: 'answer', patches: [], notes: [], withdrawals: [{ stepId: 'step-0', fieldId: 'goal' }] })));
  const again = await turn(f, { text: 'Forget that suggestion, it is wrong', transport: next.fn });
  const shown = JSON.stringify(next.bodies.find(b => b.model === ORGANIZER)!.messages);
  expect(shown).toContain('pendingSuggestion');
  expect(shown).toContain('Sell coffee to students');
  expect(JSON.stringify(next.bodies.find(b => b.model === MENTOR)!.messages)).not.toContain('Sell coffee to students');
  expect((again.events.at(-1) as Extract<TurnEvent, { type: 'result' }>).kindResult).toMatchObject({ withdrawn: { 'step-0': ['goal'] } });
  const after = (await f.steps())['step-0'].fieldMeta.goal;
  expect(after.suggestion).toBeUndefined();
  expect(after.withdrawnSuggestion).toMatchObject({ value: 'Sell coffee to students' });
});

it('RUNTIME: CORE-PATH-V2 V2-5: relation locks of turn_open for a mentor turn against a free chat (measured, plan 3.1)', async () => {
  const f = await setup();
  const policy = { q: 100, uTurnUsd: 0.1, gCredits: 60, minCredits: 10, uModelCredits: 30, historyItems: 100, inputBytes: 1000,
    limits: { model: 3, paidTools: 0, freeTools: 1, decisions: 0 }, stopLoss: { limitUsd: 1000, p: 8, poolSize: 8, uFastUsd: 1, uBigUsd: 5 },
    mentor: { moduleId: f.moduleId, stepId: 'step-0' } };
  const locks = async (kind: string) => {
    await db.query('begin');
    try {
      await db.query('select turn_open($1,$2,$3,$4,$5)', [f.actor, f.session, randomUUID(), kind, JSON.stringify(policy)]);
      return (await db.query(`select c.relname n from pg_locks l join pg_class c on c.oid=l.relation
        where l.pid=pg_backend_pid() and l.locktype='relation' and c.relkind in ('r','p') order by 1`)).rows.map(r => r.n as string);
    } finally { await db.query('rollback'); }
  };
  // Tables only (indexes and TOAST follow them); the mentor's extra tables are the draft context it reads.
  const chat = await locks('chat'), mentor = await locks('mentor');
  console.log('CORE-PATH-V2 turn_open table locks', JSON.stringify({ chat: chat.length, mentor: mentor.length,
    mentorExtra: mentor.filter(t => !chat.includes(t)) }));
  expect(mentor.length).toBeGreaterThanOrEqual(chat.length);
});

it('RUNTIME: CORE-PATH-V2 V2-5: a business archived while the turn runs gets no checklist write; the turn still settles', async () => {
  const f = await setup();
  let business = (await db.query("select opc_target_business($1, jsonb_build_object('draftId',$2::text)) v", [f.actor, f.draftId])).rows[0].v;
  if (!business) {
    business = randomUUID();
    await db.query("insert into opc_businesses(id,actor_id,name) values($1,$2,'Coffee')", [business, f.actor]);
    await db.query('insert into opc_draft_businesses(draft_id,business_id) values($1,$2)', [f.draftId, business]);
  }
  const t = transport(async (body, n) => {
    if (body.model !== ORGANIZER) return prose('gen-reply-' + n, 'Noted.');
    await db.query('update opc_businesses set archived_at=now() where id=$1', [business]);
    return organized('gen-org-' + n, patch('Sell coffee to students'));
  });
  const out = await turn(f, { text: 'I want to sell coffee to students', transport: t.fn });
  const result = out.events.at(-1) as Extract<TurnEvent, { type: 'result' }>;
  expect(result.kindResult, JSON.stringify(out.events)).toEqual({ result: 'archived' });
  expect((await f.steps())['step-0'].information?.goal?.value ?? '').toBe('');
  expect((await db.query('select close_kind,settlement from turns where actor_id=$1', [f.actor])).rows)
    .toEqual([{ close_kind: 'completed', settlement: 'done' }]);
});

it('RUNTIME: CORE-PATH-V2 V2-5: the start threshold is one normal turn (mentor + organizer); a balance below it opens nothing', async () => {
  const f = await setup();
  const t = transport(() => { throw new Error('nothing may be sent'); });
  // L = ceil(2 x 100 x 6) + ceil(0.01 x 100 x 6) = 1206 > the 1000 credits of the account.
  await db.query("update system_settings set value=jsonb_set(value,'{thresholds,0,typicalUsd}','\"2\"') where key='billing_payg_start_thresholds'");
  clearCatalogCache();
  const out = await turn(f, { text: 'Hello', transport: t.fn });
  expect(out.events).toEqual([{ type: 'error', code: 'TURN_INSUFFICIENT_CREDITS' }]);
  expect(t.bodies).toEqual([]);
  expect(await credits(f.actor)).toBe(1000);
  // Not configured for the organizer's purpose: refused, never a guessed threshold.
  await db.query("update system_settings set value=jsonb_set(value,'{thresholds,1,purpose}','\"ordinary\"') where key='billing_payg_start_thresholds'");
  clearCatalogCache();
  expect((await turn(f, { text: 'Hello', transport: t.fn })).events).toEqual([{ type: 'error', code: 'TURN_START_THRESHOLD_UNCONFIGURED' }]);
});

it('RUNTIME: CORE-PATH-V2 V2-5: the one-switch pause refuses before anything opens; a call limit at the reply sends nothing and refunds', async () => {
  const f = await setup();
  const t = transport(() => { throw new Error('nothing may be sent'); });
  const paused = await turn(f, { text: 'Hello', transport: t.fn,
    newWork: { message: async () => ({ ok: false, reason: 'paused', retryAfter: 60 }), calls: admit } });
  expect(paused.events).toEqual([{ type: 'error', code: 'TURN_NEW_CALLS_PAUSED' }]);
  expect((await db.query('select count(*)::int n from turns where actor_id=$1', [f.actor])).rows[0].n).toBe(0);
  const limited = await turn(f, { text: 'Hello', transport: t.fn,
    newWork: { message: admit, calls: async () => ({ ok: false, reason: 'call_limited', retryAfter: 3600, window: 'day' }) } });
  expect(limited.events.at(-1)).toMatchObject({ type: 'error', code: 'TURN_RATE_LIMITED' });
  expect(t.bodies).toEqual([]);
  expect((await db.query('select count(*)::int n from turn_calls c join turns t on t.id=c.turn_id and t.actor_id=c.actor_id where t.actor_id=$1',
    [f.actor])).rows[0].n).toBe(0);
  expect(await credits(f.actor)).toBe(1000);
});

it('RUNTIME: CORE-PATH-V2 V2-5: an organizer the remaining freeze cannot start pauses the turn (waiting for credits), never closes it', async () => {
  const f = await setup();
  // The freeze capped by the balance, made deterministic: while the reply streams, this turn's freeze is set to nothing left, so
  // the organizer's turn_call_begin finds the remaining freeze below min(G_org, L) and pauses the turn.
  const t = transport(async (body, n) => {
    if (body.model === ORGANIZER) return organized('gen-org-' + n, patch('Sell coffee to students'));
    await db.query("update turns set reserved_credits=0 where actor_id=$1 and state='running'", [f.actor]);
    return prose('gen-reply-' + n, 'Good. Who buys it?');
  });
  const out = await turn(f, { text: 'I want to sell coffee to students', transport: t.fn });
  expect(out.events.at(-1), JSON.stringify(out.events)).toMatchObject({ type: 'error', code: 'TURN_PAUSED_FOR_CREDITS' });
  expect(t.bodies.map(b => b.model)).toEqual([MENTOR]);
  expect((await db.query('select state,pause_reason,close_kind from turns where actor_id=$1', [f.actor])).rows)
    .toEqual([{ state: 'paused', pause_reason: 'waiting_credits', close_kind: null }]);
  expect((await f.steps())['step-0'].information?.goal?.value ?? '').toBe('');
});

it('RUNTIME: CORE-PATH-V2 V2-5b: a suggestion of a new-path mentor turn is shown by opc_query and can be accepted', async () => {
  const f = await setup();
  const t = transport(async (body, n) => {
    if (body.model !== ORGANIZER) return prose('gen-reply-' + n, 'Noted.');
    await db.query(`update artifact_rounds r set steps=jsonb_set(r.steps,'{step-0,version}',to_jsonb((r.steps->'step-0'->>'version')::int+1))
      from opc_drafts d where d.round_id=r.id and d.draft_id=$1`, [f.draftId]);
    return organized('gen-org-' + n, patch('Sell coffee to students'));
  });
  const out = await turn(f, { text: 'I want to sell coffee to students', transport: t.fn });
  expect((out.events.at(-1) as Extract<TurnEvent, { type: 'result' }>).kindResult).toMatchObject({ result: 'suggested' });
  const shown = (await db.query('select opc_query($1,$2) v', [f.actor, f.draftId])).rows[0].v;
  const suggestion = shown.information['step-0'].meta.goal.suggestion;
  expect(suggestion).toMatchObject({ value: 'Sell coffee to students' });
  const version = (await f.steps())['step-0'].version;
  const resolved = (await db.query('select opc_capture_resolve($1,$2,$3,$4,$5,$6,$7,$8,$9) v', [f.actor, f.draftId, randomUUID(), 'step-0', 'goal',
    suggestion.executionId, suggestion.hash, 'accept', version])).rows[0].v;
  expect(resolved).toMatchObject({ result: 'accept' });
  expect((await f.steps())['step-0'].information.goal).toMatchObject({ value: 'Sell coffee to students' });
});

it('RUNTIME: CORE-PATH-V2 V2-5b: the next turn answers the card; the chosen option is the words, the organizer sees answeredCard', async () => {
  const f = await setup();
  const first = transport((body, n) => body.model === ORGANIZER ? organized('gen-org-' + n, JSON.stringify({ inputKind: 'answer', patches: [], notes: [] }))
    : toolCall('gen-card-' + n, 'ask_question', { intent: 'grounded_comparison', requestQuote: 'coffee or tea',
      basisQuotes: ['coffee or tea'], question: 'Which one first?', options: [{ text: 'Coffee', reason: 'You named it first' },
        { text: 'Tea', reason: 'Fewer rivals' }], recommended: 0 }));
  await turn(f, { text: 'Should I start with coffee or tea?', transport: first.fn });
  const saved = (await db.query("select content from session_messages where session_id=$1 and role='assistant' order by seq desc limit 1",
    [f.session])).rows[0].content;
  expect(JSON.parse(saved)).toMatchObject({ stepId: 'step-0', card: { options: ['Coffee', 'Tea'] } });
  const next = transport((body, n) => body.model === ORGANIZER ? organized('gen-org-' + n, patch('Tea first'))
    : prose('gen-reply-' + n, 'Tea it is.'));
  const out = await turn(f, { text: 'Tea', transport: next.fn, answer: { optionIndex: 1 } });
  expect(out.events.at(-1), JSON.stringify(out.events)).toMatchObject({ type: 'result' });
  expect(JSON.stringify(next.bodies.find(b => b.model === ORGANIZER)!.messages)).toContain('answeredCard');
  expect((await db.query("select content from session_messages where session_id=$1 and role='user' order by seq desc limit 1",
    [f.session])).rows[0].content).toBe('Tea');
  // An answer to a card the latest reply does not carry is refused, and that turn is refunded.
  const refused = await turn(f, { text: 'Coffee', transport: next.fn, answer: { optionIndex: 0 } });
  expect(refused.events.at(-1)).toMatchObject({ type: 'error', code: 'TURN_ANSWER_SOURCE_DENIED' });
});

it('RUNTIME: CORE-PATH-V2 V2-5b: a step summary turn writes the summary and is never organized', async () => {
  const f = await setup();
  const t = transport(() => prose('gen-summary', 'Step summary: goal is still missing.'));
  const out = await turn(f, { text: 'HOST_STEP_SUMMARY:v1', transport: t.fn, organizeAfter: false });
  expect(out.events.at(-1), JSON.stringify(out.events)).toMatchObject({ type: 'result' });
  expect(t.bodies.map(b => b.model)).toEqual([MENTOR]);
  const system = JSON.stringify(t.bodies[0]!.messages[0]);
  expect(system).toContain('hostTurnContext.stepSummary');
  expect(JSON.parse(t.bodies[0]!.messages.at(-1)!.content as string).hostTurnContext.stepSummary).toMatchObject({ kind: 'step_summary' });
  // A summary may not be organized.
  expect((await turn(f, { text: 'HOST_STEP_SUMMARY:v1', transport: t.fn, organizeAfter: true })).events)
    .toEqual([{ type: 'error', code: 'TURN_REQUEST_INVALID' }]);
});
