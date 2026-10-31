/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
import type { VendorCalls } from '../research/runtime/subcall';
import type { ResearchCallResult } from '../research/vendors/types';
import { parallelRoute } from '../research/vendors/parallel';
import { tikhubRouteId } from '../research/vendors/tikhub';
import { researchSettings } from './tools/__tests__/fixtures';
import { preparedResearch } from './tools/benchmarkStore';
import { RUNTIME_PAYG_SETTING } from './quote';
import { MENTOR, ORGANIZER, organized, prose, tiktokVendors, toolCall } from './__tests__/mentorSynthetic';
import { runTurnRecovery } from './recovery';
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
const ROUTE = 'anthropic';
const slots: CounterStore = { take: async () => 1, drop: async () => undefined };
const SETTINGS = [CORE_PATH_SETTING, RUNTIME_PAYG_SETTING, 'billing_credits_per_usd', 'billing_token_price_multiplier', 'runtime_rw_v2',
  'v3_summary_model_id', 'v3_summary_max_tokens', ...Object.keys(researchSettings())];
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

async function setup(input: { benchmarkStep?: boolean } = {}) {
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
  flow.steps.forEach((s, i) => { s.information = [{ id: i === 0 && input.benchmarkStep ? 'benchmark_findings' : 'goal', title: 'Goal', required: true, profileKey: 'goal_' + i },
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
  organizeAfter?: boolean; newWork?: NewWork; answer?: { sourceSeq: number; optionIndex?: number }; research?: MentorDeps['research'];
  researchRefreshId?: string; afterPrepare?: () => Promise<void>; resumeOf?: number }) {
  const { admin, calls } = countingAdmin(), events: TurnEvent[] = [];
  const clients = turnClients(admin);
  let hook = input.afterPrepare;
  const read = hook ? { rpc: async (name: string, args: unknown) => {
    const result = await clients.read.rpc(name, args as never);
    if (name === 'mentor_turn_prepare' && hook) { const run = hook; hook = undefined; await run(); }
    return result;
  } } as unknown as typeof clients.read : clients.read;
  await withCatalogRequest(() => runMentorTurn({ admin, clients: { ...clients, read }, slots, transport: input.transport,
    newWork: input.newWork ?? { message: admit, calls: admit }, ...(input.research ? { research: input.research } : {}) },
    { actorId: f.actor, sessionId: f.session, requestId: randomUUID(), moduleId: input.moduleId ?? f.moduleId, stepId: 'step-0',
      text: input.text, organizeAfter: input.organizeAfter ?? true, ...(input.answer ? { answer: input.answer } : {}),
      ...(input.researchRefreshId ? { researchRefreshId: input.researchRefreshId } : {}),
      ...(input.resumeOf ? { resumeOf: input.resumeOf } : {}) },
    e => events.push(e)));
  return { events, calls };
}
// V2-5c: the research settings on top of the mentor's, and synthetic suppliers (no network, no paid call).
async function researchOn(limits?: { maxSubcallsPerRound: number; discoverSubcalls: number }) {
  const settings = researchSettings() as Record<string, { thresholds?: unknown[]; limits?: unknown }>;
  if (limits) settings.research_tools_config!.limits = limits;
  settings.billing_payg_start_thresholds!.thresholds!.push({ model: MENTOR, purpose: 'skill', typicalUsd: '0.04' },
    { model: ORGANIZER, purpose: 'attached_organizer', typicalUsd: '0.01' });
  for (const [key, value] of Object.entries(settings)) await db.query(
    'insert into system_settings(key,value) values($1,$2) on conflict(key) do update set value=excluded.value', [key, JSON.stringify(value)]);
  clearCatalogCache();
}
const vendors = (parallel: VendorCalls['parallel']): NonNullable<MentorDeps['research']> => ({ readKey: async () => 'local-synthetic',
  vendors: { parallel, tikhub: () => { throw new Error('not used'); }, firecrawl: () => { throw new Error('not used'); } } as unknown as VendorCalls });
const webResult = (over: Partial<ResearchCallResult> = {}): ResearchCallResult => ({ vendor: 'parallel', route: parallelRoute('fast'), outcome: 'ok', reason: null,
  httpStatus: 200, supplierMayCharge: true, usage: { unit: 'sku_search', units: '1' }, truncated: false, fetchedAt: new Date().toISOString(),
  items: [{ url: 'https://example.test/a', fields: { title: 'a result' }, missing: [] }], ...over });
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
  expect([...fixed].sort()).toEqual(['rpc/catalog_versions_snapshot', 'rpc/mentor_turn_prepare', 'rpc/platform_secret_read']);
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

it('RUNTIME: CORE-PATH-V2 V2-10: a resume at the organizer keeps the reply: it is not written again, and the checklist is organized', async () => {
  const f = await setup();
  const t = transport(async (body, n) => {
    if (body.model === ORGANIZER) return organized('gen-org-' + n, patch('Sell coffee to students'));
    await db.query("update turns set reserved_credits=0 where actor_id=$1 and state='running'", [f.actor]);
    return prose('gen-reply-' + n, 'Good. Who buys it?');
  });
  await turn(f, { text: 'I want to sell coffee to students', transport: t.fn });
  const { id } = (await db.query("select id::int id from turns where actor_id=$1 and state='paused'", [f.actor])).rows[0];
  const before = await db.query('select sum(charged_credits) c from turns where actor_id=$1', [f.actor]);
  const out = await turn(f, { text: 'I want to sell coffee to students', transport: t.fn, resumeOf: id });
  expect(out.events.at(-1), JSON.stringify(out.events)).toMatchObject({ type: 'result' });
  expect(t.bodies.map(b => b.model)).toEqual([MENTOR, ORGANIZER]);
  expect(out.events.filter(e => e.type === 'text').map(e => (e as { delta: string }).delta).join('')).toContain('Good. Who buys it?');
  const saved = await db.query("select content from session_messages where session_id=$1 and role='assistant'", [f.session]);
  expect(saved.rows).toHaveLength(1);
  expect(saved.rows[0].content).toContain('Good. Who buys it?');
  expect((await f.steps())['step-0'].information?.goal?.value ?? '').not.toBe('');
  expect(before.rows[0].c).toBeNull();
  // Two model receipts in all: the reply, charged once through the chain, and the organizer.
  expect((await db.query("select count(*)::int n from turn_calls c join turns t on t.id=c.turn_id where t.actor_id=$1 and c.call_kind='model' and c.status='ok'",
    [f.actor])).rows[0].n).toBe(2);
});

it('RUNTIME: CORE-PATH-V2 V2-5b: a suggestion of a new-path mentor turn is shown by opc_query and can be accepted', async () => {
  const f = await setup();
  // capture.integration.ts reloads the 0159/0182 definitions of the checklist functions and restores only 0199's patches, so a
  // later file in the same database can see an old opc_query; this migration (idempotent) restores the current definitions.
  const migrations = resolve(import.meta.dirname, '../../../../db/migrations');
  await db.query(readFileSync(resolve(migrations, readdirSync(migrations).find(name => name.endsWith('_core_path_v2_mentor_b.sql'))!), 'utf8'));
  // A draft whose fields were initialised (as agentCorePlanB's fixture does): opc_capture_resolve merges into st.information.
  await db.query(`update artifact_rounds r set steps=(select jsonb_object_agg(s.key, s.value || jsonb_build_object('information',
      (select jsonb_object_agg(f->>'id', jsonb_build_object('value','','status','unknown','nature','unknown'))
       from jsonb_array_elements(r.workflow->'steps') w, jsonb_array_elements(w->'information') f where w->>'id'=s.key)))
    from jsonb_each(r.steps) s) where r.id=(select round_id from opc_drafts where draft_id=$1)`, [f.draftId]);
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
  const { content: saved, seq: cardSeq } = (await db.query(
    "select content, seq from session_messages where session_id=$1 and role='assistant' order by seq desc limit 1", [f.session])).rows[0];
  expect(JSON.parse(saved)).toMatchObject({ stepId: 'step-0', card: { options: ['Coffee', 'Tea'] } });
  const next = transport((body, n) => body.model === ORGANIZER ? organized('gen-org-' + n, patch('Tea first'))
    : prose('gen-reply-' + n, 'Tea it is.'));
  const out = await turn(f, { text: 'Tea', transport: next.fn, answer: { sourceSeq: cardSeq, optionIndex: 1 } });
  expect(out.events.at(-1), JSON.stringify(out.events)).toMatchObject({ type: 'result' });
  expect(JSON.stringify(next.bodies.find(b => b.model === ORGANIZER)!.messages)).toContain('answeredCard');
  expect((await db.query("select content from session_messages where session_id=$1 and role='user' order by seq desc limit 1",
    [f.session])).rows[0].content).toBe('Tea');
  // An answer to a card the latest reply does not carry (a stale tab still showing it) is refused, and that turn is refunded.
  const refused = await turn(f, { text: 'Coffee', transport: next.fn, answer: { sourceSeq: cardSeq, optionIndex: 0 } });
  expect(refused.events.at(-1)).toMatchObject({ type: 'error', code: 'TURN_ANSWER_SOURCE_DENIED' });
});

it('RUNTIME: CORE-PATH-V2 V2-5b: the refresh-recovery read shows the running turn, then its saved messages', async () => {
  const f = await setup();
  const view = async (afterSeq = 0) => (await db.query('select turn_session_view($1,$2,$3) v', [f.actor, f.session, afterSeq])).rows[0].v;
  let during: unknown;
  const t = transport(async (body, n) => {
    if (body.model === ORGANIZER) return organized('gen-org-' + n, JSON.stringify({ inputKind: 'answer', patches: [], notes: [] }));
    during = await view();
    return prose('gen-reply-' + n, 'Noted.');
  });
  await turn(f, { text: 'I want to sell coffee', transport: t.fn });
  expect(during).toMatchObject({ activeTurn: { kind: 'mentor', state: 'running' }, messages: [] });
  const after = await view();
  expect(after).toMatchObject({ activeTurn: null, lastTurn: { kind: 'mentor', closeKind: 'completed' } });
  expect(after.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant']);
  expect((await view(after.messages[0].seq)).messages.map((m: { role: string }) => m.role)).toEqual(['assistant']);
  // Another account's conversation is refused; an unknown account is no account at all.
  const other = await setup();
  await expect(db.query('select turn_session_view($1,$2,0) v', [other.actor, f.session])).rejects.toThrow(/TURN_SESSION_DENIED/);
  await expect(db.query('select turn_session_view($1,$2,0) v', [randomUUID(), f.session])).rejects.toThrow(/TURN_ACCOUNT_DENIED/);
  // A disabled account reads nothing, although its sign-in is still valid.
  await db.query("update profiles set status='disabled' where id=$1", [f.actor]);
  try { await expect(view()).rejects.toThrow(/TURN_ACCOUNT_DENIED/); }
  finally { await db.query("update profiles set status='active' where id=$1", [f.actor]); }
  // A revoked draft keeps its conversation out of view, as the other reads of it do, although the conversation is not deleted.
  await db.query('update bill2_drafts set revoked=true where id=$1', [f.draftId]);
  await expect(view()).rejects.toThrow(/TURN_SESSION_DENIED/);
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
  // The host offers a summary no question card; the Skill file tool stays.
  const offered = JSON.stringify(t.bodies[0]!.tools ?? []);
  expect(offered).not.toContain('ask_question');
  expect(offered).toContain('read_skill_file');
  // A summary may not be organized.
  expect((await turn(f, { text: 'HOST_STEP_SUMMARY:v1', transport: t.fn, organizeAfter: true })).events)
    .toEqual([{ type: 'error', code: 'TURN_REQUEST_INVALID' }]);
});

// V2-5d: the narrow check plus mentor_source_check must answer exactly as the old chain, in every state, allowed or refused.
const verdicts = async (f: Awaited<ReturnType<typeof setup>>) => {
  const old = (await db.query("select coalesce(bill2_scope_allowed($1, jsonb_build_object('kind','positioning_draft','draftId',$2::uuid)), false) v",
    [f.actor, f.draftId])).rows[0].v as boolean;
  const narrow = (await db.query('select turn_mentor_draft_allowed($1,$2) v', [f.actor, f.draftId])).rows[0].v as boolean;
  const check = (await db.query('select mentor_source_check($1,$2) v', [f.actor, f.session])).rows[0].v as { allowed: boolean };
  return { old, fresh: narrow && check.allowed, sessionView: (await db.query('select session_view_allowed($1,$2) v', [f.actor, f.session])).rows[0].v as boolean };
};

it('RUNTIME: CORE-PATH-V2 V2-5d: the new checks agree with the old chain, allowed and refused', async () => {
  const allowed = await setup();
  expect(await verdicts(allowed)).toEqual({ old: true, fresh: true, sessionView: true });

  const revoked = await setup();
  await db.query('update bill2_drafts set revoked=true where id=$1', [revoked.draftId]);
  expect(await verdicts(revoked)).toEqual({ old: false, fresh: false, sessionView: false });

  const erased = await setup();
  await db.query("set session_replication_role=replica");
  await db.query('update artifact_projects p set erased_at=now() from opc_drafts d where d.project_id=p.id and d.draft_id=$1', [erased.draftId]);
  await db.query("set session_replication_role=origin");
  expect((await verdicts(erased)).old).toBe(false);
  expect((await verdicts(erased)).fresh).toBe(false);

  const other = await setup();
  const stranger = (await db.query('select count(*) from bill2_drafts where id=$1 and actor_id=$2', [other.draftId, randomUUID()])).rows[0].count;
  expect(stranger).toBe('0');
  expect((await db.query('select turn_mentor_draft_allowed($1,$2) v', [randomUUID(), other.draftId])).rows[0].v).toBe(false);
});

it('RUNTIME: CORE-PATH-V2 V2-5d: a draft whose base source is gone is refused before the turn opens', async () => {
  const f = await setup();
  await db.query('set session_replication_role=replica');
  await db.query(`insert into opc_account_strategy_drafts(account_project_id,draft_id,actor_id,base_source_version_id,root_source_version_id,base_account_revision)
    values($3,$1,$2,$3,$3,1)`, [f.draftId, f.actor, randomUUID()]);
  await db.query('set session_replication_role=origin');
  expect(await verdicts(f)).toEqual({ old: false, fresh: false, sessionView: false });
  const before = await credits(f.actor);
  const t = transport(() => { throw new Error('nothing may be sent'); });
  const out = await turn(f, { text: 'Hello', transport: t.fn });
  // Refused before anything was frozen: no turn row at all, and no second open.
  expect(out.events).toEqual([{ type: 'error', code: 'TURN_MENTOR_DENIED' }]);
  expect(t.bodies).toEqual([]);
  expect(await credits(f.actor)).toBe(before);
  expect((await db.query('select 1 from turns where actor_id=$1', [f.actor])).rows).toEqual([]);
  expect(out.calls.filter(path => path.includes('mentor_turn_prepare')).length).toBe(1);
  await expect(db.query(`select turn_mentor_context($1,$2,$3)`, [f.actor, f.session, JSON.stringify({ moduleId: f.moduleId, stepId: 'step-0' })]))
    .rejects.toThrow('TURN_SOURCE_CHECK_REQUIRED');
});

it('RUNTIME: CORE-PATH-V2 V2-5d: a plain draft makes no source check round trip', async () => {
  const f = await setup();
  const t = transport((body, n) => body.model === ORGANIZER ? organized('gen-org-' + n, JSON.stringify({ inputKind: 'answer', patches: [], notes: [] }))
    : prose('gen-reply-' + n, 'Hello.'));
  const out = await turn(f, { text: 'Hello', transport: t.fn });
  expect(out.events.at(-1)?.type).toBe('result');
  expect(out.calls.filter(path => path.includes('mentor_source_check'))).toEqual([]);
  expect((await db.query('select mentor_turn_prepare($1,$2,false,null) v', [f.actor, f.session])).rows[0].v.source).toBeNull();
});

it('RUNTIME: CORE-PATH-V2 V2-5d: a revoked Skill revision is refused through the catalog cache before any model call, and refunded', async () => {
  const f = await setup();
  const round = (await db.query('select r.revision_id from artifact_rounds r join opc_drafts d on d.round_id=r.id where d.draft_id=$1', [f.draftId])).rows[0];
  await db.query('insert into skill_revision_revocations(revision_id,revoked_by) values($1,$2)', [round.revision_id, f.actor]);
  const before = await credits(f.actor);
  const t = transport(() => { throw new Error('nothing may be sent'); });
  const out = await turn(f, { text: 'Hello', transport: t.fn });
  expect(out.events.at(-1)).toMatchObject({ type: 'error', code: 'TURN_SKILL_UNAVAILABLE' });
  expect(t.bodies).toEqual([]);
  expect(await credits(f.actor)).toBe(before);
});

it('RUNTIME: CORE-PATH-V2 V2-5c: a mentor web search is one receipt mid-turn, and research rows are written only at close, without an execution', async () => {
  const f = await setup();
  await researchOn();
  const t = transport(async (body, n) => {
    if (body.model === ORGANIZER) return organized('gen-org-' + n, JSON.stringify({ inputKind: 'answer', patches: [], notes: [] }));
    if (n === 1) return toolCall('gen-reply-1', 'web_search', { query: 'coffee shops', mode: 'fast' });
    // Between the tool and the reply: the receipt exists, no research row does.
    expect((await db.query('select 1 from research_plans where session_id=$1', [f.session])).rows).toEqual([]);
    return prose('gen-reply-' + n, 'Found one.');
  });
  const out = await turn(f, { text: 'Look up coffee shops', transport: t.fn, research: vendors(async () => webResult()) });
  expect(out.events.at(-1)?.type).toBe('result');
  expect(out.events.filter(e => e.type === 'research_call').map(e => (e as { state: string }).state)).toEqual(['running', 'succeeded']);
  expect((await db.query(`select c.tool_name,c.status from turn_calls c join turns t on t.id=c.turn_id
    where t.actor_id=$1 and c.call_kind='tool'`, [f.actor])).rows).toEqual([{ tool_name: 'web_search', status: 'ok' }]);
  expect((await db.query('select 1 from runtime_executions where session_id=$1', [f.session])).rows).toEqual([]);
  expect((await db.query(`select o.state,p.execution_id,p.turn_id is not null turn from research_operations o join research_plans p on p.id=o.plan_id
    where p.session_id=$1`, [f.session])).rows).toEqual([{ state: 'succeeded', execution_id: null, turn: true }]);
  expect(JSON.stringify(t.bodies.filter(b => b.model === MENTOR)[1]!.messages)).toContain('a result');
  // The page's evidence list sees a turn-keyed operation.
  const evidence = await rest().rpc('research_user_evidence', { a: f.actor, p_limit: 10, p_cursor_time: null, p_cursor_id: null });
  expect((evidence.data as unknown[]).length).toBe(1);
});

it('RUNTIME: CORE-PATH-V2 V2-5c: a keyword card is free, reaches the page at close, and a confirmed card feeds the next turn', async () => {
  const f = await setup();
  await researchOn();
  const t = transport((body, n) => body.model === ORGANIZER ? organized('gen-org-' + n, JSON.stringify({ inputKind: 'answer', patches: [], notes: [] }))
    : n === 1 ? toolCall('gen-reply-1', 'propose_keywords', { keywords: ['coffee', 'latte art', 'cafe', 'beans', 'roasting', 'barista'] })
      : prose('gen-reply-' + n, 'Please pick on the card.'));
  const out = await turn(f, { text: 'Find benchmarks', transport: t.fn, research: vendors(async () => webResult()) });
  expect(out.events.at(-1)?.type).toBe('result');
  const card = out.events.find(e => e.type === 'research_card') as { card: { cardId: string } } | undefined;
  expect(card).toBeTruthy();
  const listed = await rest().rpc('research_user_cards', { a: f.actor, s: f.session });
  expect((listed.data as Array<{ cardId: string }>).map(c => c.cardId)).toEqual([card!.card.cardId]);
  expect((await db.query(`select 1 from turn_calls c join turns t on t.id=c.turn_id where t.actor_id=$1 and c.call_kind='tool'`, [f.actor])).rows).toEqual([]);
  const confirmed = await rest().rpc('research_card_confirm', { a: f.actor, p_card: card!.card.cardId, p: { selected: ['k0', 'k1', 'k2'] } });
  expect(confirmed.error).toBeNull();
  const prepared = await rest().rpc('mentor_turn_prepare', { p_actor_id: f.actor, p_session_id: f.session, p_research: true, p_refresh: null });
  expect((prepared.data as { cards: Array<{ items: string[] }> }).cards[0]!.items).toEqual(['coffee', 'latte art', 'cafe']);
});

it('RUNTIME: CORE-PATH-V2 V2-5c: an unknown supplier result is not the user\'s, and a failed reply keeps what the lookup saved', async () => {
  const f = await setup();
  await researchOn();
  const before = await credits(f.actor);
  const t = transport((body, n) => n === 1 ? toolCall('gen-reply-1', 'web_search', { query: 'coffee', mode: 'fast' }) : new Response('down', { status: 500 }));
  const out = await turn(f, { text: 'Look up coffee', transport: t.fn, research: vendors(async () => webResult()) });
  expect(out.events.at(-1)?.type).toBe('error');
  expect((await db.query('select 1 from research_plans where session_id=$1', [f.session])).rows.length).toBe(1);
  expect(await credits(f.actor)).toBeLessThanOrEqual(before);
  const g = await setup();
  await researchOn();
  const u = transport((body, n) => body.model === ORGANIZER ? organized('gen-org-' + n, JSON.stringify({ inputKind: 'answer', patches: [], notes: [] }))
    : n === 1 ? toolCall('gen-reply-1', 'web_search', { query: 'coffee', mode: 'fast' }) : prose('gen-reply-' + n, 'No answer this time.'));
  const unknown = await turn(g, { text: 'Look up coffee', transport: u.fn, research: vendors(async () => { throw new Error('connection lost'); }) });
  expect(unknown.events.at(-1)?.type).toBe('result');
  const rows = (await db.query(`select c.status from turn_calls c join turns t on t.id=c.turn_id where t.actor_id=$1 and c.call_kind='tool'`, [g.actor])).rows;
  expect(rows.map(r => r.status)).toEqual(['unknown']);
  // Its cost stays on the receipt: the operation does not hold up deleting the conversation.
  expect((await db.query(`select research_operation_settled(o) v from research_operations o join research_plans p on p.id=o.plan_id where p.session_id=$1`,
    [g.session])).rows).toEqual([{ v: true }]);
});

it('RUNTIME: CORE-PATH-V2 V2-5c: a benchmark step without its tools, and a link that cannot be checked, are refused with nothing sent', async () => {
  const f = await setup({ benchmarkStep: true });
  const before = await credits(f.actor);
  const t = transport(() => { throw new Error('nothing may be sent'); });
  const out = await turn(f, { text: 'Find benchmarks', transport: t.fn });
  expect(out.events.at(-1)).toMatchObject({ type: 'error', code: 'RESEARCH_TOOLS_UNAVAILABLE' });
  const g = await setup();
  const link = await turn(g, { text: 'Check https://www.tiktok.com/@somebody please', transport: t.fn });
  expect(link.events).toEqual([{ type: 'error', code: 'RESEARCH_TOOLS_LINK_UNAVAILABLE' }]);
  expect(t.bodies).toEqual([]);
  expect(await credits(f.actor)).toBe(before);
});

it('RUNTIME: CORE-PATH-V2 V2-5c: pasted links settle in batches, make benchmarks at close, count one round, and go with the session', async () => {
  const f = await setup();
  await researchOn();
  const links = ['aa_one', 'bb_two', 'cc_three'];
  const t = transport(async (body, n) => {
    if (body.model === ORGANIZER) return organized('gen-org-' + n, JSON.stringify({ inputKind: 'answer', patches: [], notes: [] }));
    if (n === 1) return toolCall('gen-reply-1', 'benchmark_fetch', { accounts: links.map(account => ({ platform: 'tiktok', account })),
      source: { kind: 'user_message', messageId: null } });
    // Two receipts already (5 + 1 subcalls), and still nothing in research_*.
    expect((await db.query(`select count(*)::int n from turn_calls c join turns t on t.id=c.turn_id where t.actor_id=$1 and c.call_kind='tool'`, [f.actor])).rows[0].n).toBe(2);
    expect((await db.query('select 1 from research_account_fetches where session_id=$1', [f.session])).rows).toEqual([]);
    return prose('gen-reply-' + n, 'Checked.');
  });
  const text = 'Check ' + links.map(a => `https://www.tiktok.com/@${a}`).join(' ');
  const out = await turn(f, { text, transport: t.fn, research: tiktokVendors() });
  expect(out.events.at(-1)?.type).toBe('result');
  const rows = (await db.query('select account,turn_id,execution_id from research_benchmarks where session_id=$1 order by account', [f.session])).rows;
  expect(rows.map(r => r.account)).toEqual(links);
  expect(rows.every(r => r.turn_id !== null && r.execution_id === null)).toBe(true);
  expect((await db.query('select research_rounds,research_qualified from opc_drafts where draft_id=$1', [f.draftId])).rows[0].research_rounds).toBe(1);
  const again = await rest().rpc('research_benchmark_rows', { a: f.actor, s: f.session });
  expect(JSON.stringify(again.data)).toContain('bb_two');
  // A later turn does not pay again for an account already fetched.
  const u = transport((body, n) => body.model === ORGANIZER ? organized('gen-org-' + n, JSON.stringify({ inputKind: 'answer', patches: [], notes: [] }))
    : n === 1 ? toolCall('gen-reply-1', 'benchmark_fetch', { accounts: [{ platform: 'tiktok', account: 'aa_one' }], source: { kind: 'user_message', messageId: null } })
      : prose('gen-reply-' + n, 'Already known.'));
  await turn(f, { text: 'Check https://www.tiktok.com/@aa_one', transport: u.fn, research: tiktokVendors() });
  expect((await db.query(`select count(*)::int n from turn_calls c join turns t on t.id=c.turn_id where t.actor_id=$1 and c.call_kind='tool' and c.status='ok'`, [f.actor])).rows[0].n).toBe(2);
  // Deleting the conversation takes the turn's research with it.
  const preview = (await db.query("select content_erasure_preview($1,'session',$2) v", [f.actor, f.session])).rows[0].v;
  await db.query("select content_erasure_confirm($1,'session',$2,$3)", [f.actor, f.session, preview.previewHash]);
  for (const table of ['research_benchmarks', 'research_account_fetches', 'research_plans']) {
    const left = (await db.query(`select count(*)::int n from ${table} where session_id=$1 and ${table === 'research_plans' ? 'erased_at is null' : 'true'}`, [f.session])).rows[0].n;
    expect([table, left]).toEqual([table, 0]);
  }
});

it('RUNTIME: CORE-PATH-V2 V2-5c: the digest a deleted answer left stops a second payment for that account', async () => {
  const f = await setup();
  await researchOn();
  const check = (name: string) => transport((body, n) => body.model === ORGANIZER ? organized(`${name}-org-${n}`, JSON.stringify({ inputKind: 'answer', patches: [], notes: [] }))
    : n === 1 ? toolCall(`${name}-1`, 'benchmark_fetch', { accounts: [{ platform: 'tiktok', account: 'aa_one' }], source: { kind: 'user_message', messageId: null } })
      : prose(`${name}-${n}`, 'Checked.'));
  const first = await turn(f, { text: 'Check https://www.tiktok.com/@aa_one', transport: check('first').fn, research: tiktokVendors() });
  expect(JSON.stringify(first.events.at(-1))).toContain('"type":"result"');
  // As content_erasure_confirm leaves a charged fetch when only its answer is deleted.
  await db.query(`update research_account_fetches set state='failed_charged',execution_id=null,account=null,evidence=null,last_success=null,
    last_success_execution_id=null,refresh_id=null,attempt=gen_random_uuid() where session_id=$1`, [f.session]);
  const paid = `select count(*)::int n from turn_calls c join turns t on t.id=c.turn_id where t.actor_id=$1 and c.call_kind='tool' and c.status='ok'`;
  const before = (await db.query(paid, [f.actor])).rows[0].n;
  const out = await turn(f, { text: 'Check https://www.tiktok.com/@AA_one', transport: check('second').fn, research: tiktokVendors() });
  expect(JSON.stringify(out.events.at(-1))).toContain('"type":"result"');
  expect((await db.query(paid, [f.actor])).rows[0].n).toBe(before);
  expect((await db.query('select account,state from research_account_fetches where session_id=$1', [f.session])).rows).toEqual([{ account: null, state: 'failed_charged' }]);
});

it('RUNTIME: CORE-PATH-V2 V2-5c: a process killed mid-turn loses nothing receipted: recovery ends the turn and the next turn pays only for the unreceipted call', async () => {
  const f = await setup();
  await researchOn();
  const accounts = ['aa_one', 'bb_two', 'cc_three'];
  const here = resolve(fileURLToPath(import.meta.url), '..'), bundle = resolve(here, `../../../.mentor-crash-${randomUUID()}.mjs`);
  // A real process: bundled, because node cannot import this package's TypeScript by itself.
  createRequire(resolve(here, '../../../../../apps/web/package.json'))('esbuild').buildSync({ entryPoints: [resolve(here, 'mentorCrash.child.ts')],
    bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: bundle, logLevel: 'error' });
  const toolRows = async (status: string) => (await db.query(`select count(*)::int n from turn_calls c join turns t on t.id=c.turn_id
    where t.actor_id=$1 and c.call_kind='tool' and c.status=$2`, [f.actor, status])).rows[0].n as number;
  let child: ReturnType<typeof spawn> | undefined, gone: Promise<unknown> = Promise.resolve();
  try {
    child = spawn(process.execPath, [bundle, JSON.stringify({ rest: process.env.V3_LOCAL_REST, serviceJwt: process.env.V3_LOCAL_SERVICE_JWT,
      actor: f.actor, session: f.session, moduleId: f.moduleId, accounts })], { stdio: ['ignore', 'pipe', 'inherit'] });
    let output = '';
    child.stdout!.on('data', chunk => { output += String(chunk); });
    const running = child;
    gone = new Promise(done => running.once('exit', (_code, signal) => done(signal)));
    await expect.poll(() => output, { timeout: 30000 }).toContain('call 6');
    await expect.poll(() => toolRows('ok'), { timeout: 15000 }).toBe(1);
    child.kill('SIGKILL');
    expect(await gone).toBe('SIGKILL');
  } finally {
    // A failed wait above must not leave the child running: it never ends by itself.
    child?.kill('SIGKILL');
    await gone;
    rmSync(bundle, { force: true });
  }
  expect((await db.query('select state from turns where session_id=$1', [f.session])).rows).toEqual([{ state: 'running' }]);
  expect((await db.query('select 1 from research_account_fetches where session_id=$1', [f.session])).rows).toEqual([]);
  // The job's own claim waits 15 minutes without a write.
  await db.query(`update turns set updated_at=now()-interval '16 minutes' where session_id=$1`, [f.session]);
  expect((await runTurnRecovery(rest(), Date.now() + 15000)).interrupted).toBe(1);
  expect((await db.query('select count(*)::int n from turns where session_id=$1 and closed_at is null', [f.session])).rows[0].n).toBe(0);

  const paid: string[] = [];
  const t = transport((body, n) => body.model === ORGANIZER ? organized('gen-org-' + n, JSON.stringify({ inputKind: 'answer', patches: [], notes: [] }))
    : n === 1 ? toolCall('gen-reply-1', 'benchmark_fetch', { accounts: accounts.map(account => ({ platform: 'tiktok', account })), source: { kind: 'user_message', messageId: null } })
      : prose('gen-reply-' + n, 'Checked.'));
  const out = await turn(f, { text: 'Check ' + accounts.map(a => `https://www.tiktok.com/@${a}`).join(' '), transport: t.fn,
    research: tiktokVendors(async call => { paid.push(`${call.account}:${call.kind}`); }) });
  expect(JSON.stringify(out.events.at(-1))).toContain('"type":"result"');
  // The five receipted calls are reused; only the call in flight when the process died is sent again (a batch is the loss bound).
  expect(paid).toEqual(['cc_three:account_posts']);
  expect((await db.query('select account from research_benchmarks where session_id=$1 order by account', [f.session])).rows.map(r => r.account)).toEqual(accounts);
}, 120000);

it('RUNTIME: CORE-PATH-V2 V2-5c: a discovery round stopped by its limit is continued by the next turn without paying for its searches again', async () => {
  const f = await setup();
  await researchOn();
  const quiet = JSON.stringify({ inputKind: 'answer', patches: [], notes: [] });
  const card = transport((body, n) => body.model === ORGANIZER ? organized('gen-org-' + n, quiet)
    : n === 1 ? toolCall('gen-reply-1', 'propose_keywords', { keywords: ['coffee', 'latte art', 'cafe', 'beans', 'roasting', 'barista'] })
      : prose('gen-reply-' + n, 'Please pick.'));
  const first = await turn(f, { text: 'Find benchmarks', transport: card.fn, research: tiktokVendors() });
  const cardId = (first.events.find(e => e.type === 'research_card') as { card: { cardId: string } }).card.cardId;
  const confirmed = await rest().rpc('research_card_confirm', { a: f.actor, p_card: cardId, p: { selected: ['k0', 'k1', 'k2'] } });
  const confirmationId = (confirmed.data as { confirmationId: string }).confirmationId;
  const calls: string[] = [];
  const route = (kind: string) => tikhubRouteId('tiktok', kind as never);
  const stub: NonNullable<MentorDeps['research']> = { readKey: async () => 'local-synthetic', vendors: {
    parallel: () => { throw new Error('not used'); }, firecrawl: () => { throw new Error('not used'); },
    tikhub: async (call: { kind: string; keyword?: string; account?: string }) => {
      calls.push(call.kind + ':' + (call.keyword ?? call.account));
      const base = { vendor: 'tikhub', route: route(call.kind), outcome: 'ok', reason: null, httpStatus: 200, supplierMayCharge: true,
        usage: { unit: 'call', units: '1' }, truncated: false, fetchedAt: new Date().toISOString() };
      if (call.kind === 'keyword_posts') return { ...base, items: Array.from({ length: 20 }, (_, i) => ({ missing: [], fields: { id: `${call.keyword}-${i}`,
        authorId: `author${call.keyword}${i}`, author: `Author ${i}`, likes: 10, comments: 1, shares: 1, views: 1000, publishedAt: new Date().toISOString() } })) };
      return { ...base, items: [{ missing: [], fields: { followers: 50000, postsCount: 200 } }] };
    } } as unknown as VendorCalls };
  const discover = (args: unknown) => transport((body, n) => body.model === ORGANIZER ? organized('gen-org-' + n, quiet)
    : n === 1 ? toolCall('gen-reply-1', 'benchmark_discover', args) : prose('gen-reply-' + n, 'Still searching.'));
  const second = await turn(f, { text: 'Go on', transport: discover({ keywordConfirmationId: confirmationId, platforms: ['tiktok'], discoveryId: null }).fn,
    research: stub });
  expect(second.events.at(-1)?.type).toBe('result');
  const stopped = second.events.find(e => e.type === 'research_continue') as { discoveryId: string } | undefined;
  expect(stopped).toBeTruthy();
  expect((await db.query('select state,turn_id is not null turn from research_discoveries where id=$1', [stopped!.discoveryId])).rows)
    .toEqual([{ state: 'running', turn: true }]);
  const unfinished = await rest().rpc('research_user_unfinished_round', { a: f.actor, s: f.session });
  expect((unfinished.data as { discoveryId: string }).discoveryId).toBe(stopped!.discoveryId);
  const sent = calls.length;
  expect(sent).toBeGreaterThan(5);
  const third = await turn(f, { text: 'Go on', transport: discover({ keywordConfirmationId: null, platforms: null, discoveryId: stopped!.discoveryId }).fn,
    research: stub });
  expect(third.events.at(-1)?.type).toBe('result');
  // No supplier call was sent twice: the round went on from what the earlier turn paid for.
  expect(calls.slice(sent).filter(c => c.startsWith('keyword_posts'))).toEqual([]);
  expect(new Set(calls).size).toBe(calls.length);
});

it('RUNTIME: CORE-PATH-V2 V2-5c: a round that finishes makes its candidate card at close, and the next turn can follow it up', async () => {
  const f = await setup();
  await researchOn({ maxSubcallsPerRound: 26, discoverSubcalls: 26 });
  const quiet = JSON.stringify({ inputKind: 'answer', patches: [], notes: [] });
  const say = (args: [string, unknown]) => transport((body, n) => body.model === ORGANIZER ? organized('gen-org-' + n, quiet)
    : n === 1 ? toolCall('gen-reply-1', args[0], args[1]) : prose('gen-reply-' + n, 'Done.'));
  const first = await turn(f, { text: 'Find benchmarks', transport: say(['propose_keywords', { keywords: ['coffee', 'latte art', 'cafe', 'beans', 'roasting', 'barista'] }]).fn,
    research: tiktokVendors() });
  const keywordCard = (first.events.find(e => e.type === 'research_card') as { card: { cardId: string } }).card.cardId;
  const keywords = await rest().rpc('research_card_confirm', { a: f.actor, p_card: keywordCard, p: { selected: ['k0', 'k1', 'k2'] } });
  const stub: NonNullable<MentorDeps['research']> = { readKey: async () => 'local-synthetic', vendors: {
    parallel: () => { throw new Error('not used'); }, firecrawl: () => { throw new Error('not used'); },
    tikhub: async (call: { kind: string; keyword?: string; account?: string }) => {
      const base = { vendor: 'tikhub', route: tikhubRouteId('tiktok', call.kind as never), outcome: 'ok', reason: null, httpStatus: 200, supplierMayCharge: true,
        usage: { unit: 'call', units: '1' }, truncated: false, fetchedAt: new Date().toISOString() };
      if (call.kind === 'keyword_posts') return { ...base, items: Array.from({ length: 5 }, (_, i) => ({ missing: [], fields: { id: `${call.keyword}-${i}`,
        authorId: `author${String(call.keyword).replace(/\W/g, '')}${i}`, author: `Author ${i}`, likes: 10, comments: 1, shares: 1, views: 1000, publishedAt: new Date().toISOString() } })) };
      return { ...base, items: [{ missing: [], fields: { followers: 50000, postsCount: 200 } }] };
    } } as unknown as VendorCalls };
  const second = await turn(f, { text: 'Go on', transport: say(['benchmark_discover', { keywordConfirmationId: (keywords.data as { confirmationId: string }).confirmationId,
    platforms: ['tiktok'], discoveryId: null }]).fn, research: stub });
  expect(second.events.at(-1)?.type).toBe('result');
  const candidates = (second.events.find(e => e.type === 'research_card') as { card: { cardId: string; kind: string; options: Array<{ id: string; selectable: boolean }> } }).card;
  expect(candidates.kind).toBe('candidates');
  const discovery = (await db.query("select id,state from research_discoveries where session_id=$1", [f.session])).rows[0];
  expect(discovery.state).toBe('completed');
  const picks = candidates.options.filter(o => o.selectable).slice(0, 3).map(o => o.id);
  expect((await rest().rpc('research_card_confirm', { a: f.actor, p_card: candidates.cardId, p: { selected: picks } })).error).toBeNull();
  const third = await turn(f, { text: 'More please', transport: say(['propose_more_candidates', { discoveryId: discovery.id }]).fn, research: stub });
  expect(third.events.at(-1)?.type).toBe('result');
  expect(JSON.stringify(third.events)).not.toContain('DISCOVERY_NOT_FOUND');
  // Asking for the finished round again sends nothing and charges nothing.
  const rows = async () => (await db.query(`select count(*)::int n from turn_calls c join turns t on t.id=c.turn_id where t.actor_id=$1 and c.call_kind='tool'`, [f.actor])).rows[0].n;
  const paid = await rows();
  const again = await turn(f, { text: 'Search again', transport: say(['benchmark_discover', { keywordConfirmationId: null, platforms: null, discoveryId: discovery.id }]).fn, research: stub });
  expect(again.events.at(-1)?.type).toBe('result');
  expect(await rows()).toBe(paid);
});

it('RUNTIME: CORE-PATH-V2 V2-5c: receipts of a turn that never applied them come back as operations the next turn can parse', async () => {
  const f = await setup();
  await researchOn();
  const t = transport((body, n) => body.model === ORGANIZER ? organized('gen-org-' + n, JSON.stringify({ inputKind: 'answer', patches: [], notes: [] }))
    : n === 1 ? toolCall('gen-reply-1', 'web_search', { query: 'coffee', mode: 'fast' }) : prose('gen-reply-' + n, 'Found.'));
  await turn(f, { text: 'Look up coffee', transport: t.fn, research: vendors(async () => webResult()) });
  // As if the close never wrote them.
  await db.query('update research_plans set turn_id=null where session_id=$1', [f.session]);
  const raw = (await db.query('select mentor_turn_prepare($1,$2,true,null) v', [f.actor, f.session])).rows[0].v;
  const prepared = preparedResearch.parse(raw);
  expect(prepared.unapplied).toHaveLength(1);
  expect(prepared.unapplied[0]![0]).toMatchObject({ state: 'succeeded' });
});

it('RUNTIME: CORE-PATH-V2 V2-5c: a pasted link that failed does not count as a round', async () => {
  const f = await setup();
  await researchOn();
  const stub: NonNullable<MentorDeps['research']> = { readKey: async () => 'local-synthetic', vendors: {
    parallel: () => { throw new Error('not used'); }, firecrawl: () => { throw new Error('not used'); },
    tikhub: async () => ({ vendor: 'tikhub', route: tikhubRouteId('tiktok', 'account_profile'), outcome: 'failed', reason: 'UPSTREAM', httpStatus: 500,
      supplierMayCharge: false, usage: { unit: 'call', units: '0' }, items: [], truncated: false, fetchedAt: new Date().toISOString() }) } as unknown as VendorCalls };
  const t = transport((body, n) => body.model === ORGANIZER ? organized('gen-org-' + n, JSON.stringify({ inputKind: 'answer', patches: [], notes: [] }))
    : n === 1 ? toolCall('gen-reply-1', 'benchmark_fetch', { accounts: [{ platform: 'tiktok', account: 'aa_one' }], source: { kind: 'user_message', messageId: null } })
      : prose('gen-reply-' + n, 'Could not check it.'));
  const out = await turn(f, { text: 'Check https://www.tiktok.com/@aa_one', transport: t.fn, research: stub });
  expect(out.events.at(-1)?.type).toBe('result');
  expect((await db.query('select research_rounds from opc_drafts where draft_id=$1', [f.draftId])).rows[0].research_rounds).toBe(0);
  expect((await db.query('select pasted_turns from research_account_fetches where session_id=$1', [f.session])).rows[0].pasted_turns).toEqual([]);
});

it('RUNTIME: CORE-PATH-V2 V2-5c: Refresh on a turn-made benchmark fetches it again once, and a used grant is refused', async () => {
  const f = await setup();
  await researchOn();
  const quiet = JSON.stringify({ inputKind: 'answer', patches: [], notes: [] });
  const say = (name: string, args: unknown) => transport((body, n) => body.model === ORGANIZER ? organized('gen-org-' + n, quiet)
    : n === 1 ? toolCall('gen-reply-1', name, args) : prose('gen-reply-' + n, 'Done.'));
  await turn(f, { text: 'Check https://www.tiktok.com/@aa_one', research: tiktokVendors(),
    transport: say('benchmark_fetch', { accounts: [{ platform: 'tiktok', account: 'aa_one' }], source: { kind: 'user_message', messageId: null } }).fn });
  const grant = await rest().rpc('research_refresh_create', { a: f.actor, s: f.session, p_platform: 'tiktok', p_account: 'aa_one' });
  expect(grant.error).toBeNull();
  const refreshId = grant.data as string;
  const rows = async () => (await db.query(`select count(*)::int n from turn_calls c join turns t on t.id=c.turn_id where t.actor_id=$1 and c.call_kind='tool' and c.status='ok'`, [f.actor])).rows[0].n;
  const before = await rows();
  const out = await turn(f, { text: 'Refresh it', researchRefreshId: refreshId, research: tiktokVendors(),
    transport: say('benchmark_fetch', { accounts: [{ platform: 'tiktok', account: 'aa_one' }], source: { kind: 'refresh', refreshId } }).fn });
  expect(out.events.at(-1)?.type).toBe('result');
  expect(await rows()).toBeGreaterThan(before);
  expect((await db.query('select used_at is not null used,used_turn_id is not null turn from research_refresh_grants where id=$1', [refreshId])).rows)
    .toEqual([{ used: true, turn: true }]);
  const t = transport(() => { throw new Error('nothing may be sent'); });
  const again = await turn(f, { text: 'Refresh it', researchRefreshId: refreshId, research: tiktokVendors(), transport: t.fn });
  expect(again.events).toEqual([{ type: 'error', code: 'TURN_REFRESH_INVALID' }]);
  expect(t.bodies).toEqual([]);
});

it('RUNTIME: CORE-PATH-V2 V2-5c: a turn that closed after this read makes it stale: it is read again, so nothing is paid twice', async () => {
  const f = await setup();
  await researchOn();
  const quiet = JSON.stringify({ inputKind: 'answer', patches: [], notes: [] });
  const fetch = () => transport((body, n) => body.model === ORGANIZER ? organized('gen-org-' + n, quiet)
    : n === 1 ? toolCall('gen-reply-1', 'benchmark_fetch', { accounts: [{ platform: 'tiktok', account: 'aa_one' }], source: { kind: 'user_message', messageId: null } })
      : prose('gen-reply-' + n, 'Done.'));
  const text = 'Check https://www.tiktok.com/@aa_one';
  const out = await turn(f, { text, transport: fetch().fn, research: tiktokVendors(),
    // The other request of this conversation fetches the account and closes between this read and this open.
    afterPrepare: async () => { await turn(f, { text, transport: fetch().fn, research: tiktokVendors() }); } });
  expect(out.events.at(-1)?.type).toBe('result');
  expect(out.calls.filter(path => path.includes('mentor_turn_prepare')).length).toBe(2);
  const rows = (await db.query(`select c.status from turn_calls c join turns t on t.id=c.turn_id where t.actor_id=$1 and c.call_kind='tool' and c.status='ok'`, [f.actor])).rows;
  expect(rows.length).toBe(1);
});
