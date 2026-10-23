/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { afterAll, beforeAll, expect, it } from 'vitest';
import pg from 'pg';
import { createHash, randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { authoritativeBilling, type BillingRpc } from '../bill2/service';
import { openRouterAdapter } from '../bill2/openRouterAdapter';
import { openRouterBound } from '../bill2/openRouterPolicy';
import { createRuntimeBudget } from '../runtime/budget';
import { pricingConfig } from '../__tests__/fixtures/runtimePricing';
import { seedTestOpenRouterKey } from '../models/openRouterKey.testing';
import { adoptCompare } from './compareAdopt';
import { compareRpc } from './compareAdmission';
import { streamCompareColumn, type ColumnEvent } from './compareColumn';
import { loadCompareChoice } from './compareLoad';
import { estimateCompare, startCompare, type CompareDeps } from './compareStart';
import { fusionExecutor } from './executor';
import { DEFAULT_FUSION_SETTINGS, FUSION_SETTINGS_KEY } from './settings';

// FUSION-COMPARE PR-2c: real loading, start, per-column streaming, adoption and stop -> PostgREST -> PostgreSQL
// (0290/0313/0337) with a synthetic OpenRouter stream. No network.
const db = new pg.Client({ connectionString: process.env.V3_LOCAL_DB! });
const admin = createClient(process.env.V3_LOCAL_REST!, process.env.V3_LOCAL_SERVICE_JWT!, { auth: { persistSession: false } });
const staging = process.env.V3_LOCAL_STAGING_SCHEMA === 'true';
const windowId = randomUUID();
const pairs = [['anthropic/claude-sonnet-5.5', 'anthropic'], ['google/gemini-3.8-flash', 'google-ai-studio']] as const;
const models = pairs.map(() => randomUUID());
// Synthetic local key; the window binds its hash exactly as staging does. Never a real credential.
const syntheticKey = 'SYNTHETIC_LOCAL_ONLY_FUSION_COMPARE';
const account = 'openrouter-key:' + createHash('sha256').update(syntheticKey).digest('hex');
const env = { VERCEL: '1', VERCEL_PROJECT_PRODUCTION_URL: 'auth-staging.graylum.com', VERCEL_GIT_COMMIT_REF: 'staging',
  VERCEL_GIT_REPO_OWNER: 'Crnobog9527', VERCEL_GIT_REPO_SLUG: 'GraylumAI_vercel', VERCEL_PROJECT_ID: 'synthetic',
  V3_RUNTIME_STAGING_PROJECT_ID: 'synthetic', V3_RUNTIME_STAGING_DATABASE_HOST: 'synthetic.supabase.co',
  NEXT_PUBLIC_SUPABASE_URL: 'https://synthetic.supabase.co', V3_RUNTIME_STAGING_WINDOW_ID: windowId, V3_RUNTIME_STAGING_ENABLED: 'true' };
const sent: Array<Record<string, unknown>> = [];
const answer = (model: string) => `来自 ${model} 的回答`;
const stream = (model: string, id: string) => [
  `data: ${JSON.stringify({ id, model, choices: [{ index: 0, delta: { role: 'assistant', content: answer(model) }, finish_reason: null }] })}\n\n`,
  `data: ${JSON.stringify({ id, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 40, completion_tokens: 6, total_tokens: 46, cost: 0.0004 } })}\n\n`, 'data: [DONE]\n\n'].join('');
const adapter = openRouterAdapter({ credential: async () => 'SYNTHETIC_LOCAL_ONLY', transport: async (_url, init) => {
  const body = JSON.parse(String(init?.body));
  sent.push(body);
  const id = 'gen-compare-' + randomUUID();
  return new Response(stream(body.model, id), { headers: { 'content-type': 'text/event-stream', 'x-generation-id': id } });
} });
const wallet = async (actor: string) => (await db.query('select credits from profiles where id=$1', [actor])).rows[0].credits as number;
let judgements = 0;
const deps = (actor: string): CompareDeps => ({ admin, actorId: actor, env,
  refusePositioning: () => { throw new Error('POSITIONING_REQUIRED'); }, decisionsKey: async () => undefined,
  classify: async () => { judgements++; return 'clear'; }, rateLimit: async () => undefined });
const executorFor = (actor: string) => {
  const budget = createRuntimeBudget();
  const billing = authoritativeBilling({ admin: admin as unknown as BillingRpc, actor: async () => actor, adapter, budget });
  return fusionExecutor({ billing, admin, actorId: actor, callGate: async () => ({ ok: true as const }), budget });
};
const collect = async (events: AsyncGenerator<ColumnEvent>) => { const out: ColumnEvent[] = []; for await (const e of events) out.push(e); return out; };

async function member(credits = 1000) {
  const actor = randomUUID();
  await db.query("insert into profiles(id,credits,membership_level) values($1,$2,'gold')", [actor, credits]);
  await db.query(`insert into credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,idempotency_key,
    balance_before,balance_after) values($1,$2,'addition','grant','opening_grant','system',$3,0,$4)`, [actor, credits, 'opening:' + actor, credits]);
  await db.query('update runtime_test_windows set actor_ids=array_append(actor_ids,$2) where id=$1', [windowId, actor]);
  const session = await admin.rpc('runtime_start', { p_actor_id: actor, p_request_id: randomUUID(), p_payload: { scope: { kind: 'positioning_draft' } } });
  if (session.error) throw new Error(session.error.message);
  return { actor, session: session.data.sessionId as string };
}
/** Estimate, then start with exactly what the user was shown. */
async function begin(actor: string, session: string, question: string, requestId = randomUUID()) {
  const choice = await loadCompareChoice({ admin, user: admin, actorId: actor }, { sessionId: session, question, modelIds: models });
  const shown = await estimateCompare(deps(actor), choice);
  return { requestId, choice, shown, started: await startCompare(deps(actor), { ...choice, requestId, shown }) };
}
const read = (actor: string, compareId: string) => compareRpc<{ state: string; chargedCredits: number;
  columns: Array<{ column: number; body: string | null; billing: { chargedCredits: number | null } }> }>(admin, 'fusion_compare_read',
  { p_actor_id: actor, p_compare_id: compareId });

beforeAll(async () => {
  await db.connect();
  if (!staging) return;
  const expiresAt = new Date(Date.now() + 7200000).toISOString();
  const policies = pairs.map(([model, providerSlug], i) => {
    const providerLimits = { providerSlug, contextTokens: 250000, promptUsdPerMillion: '1', completionUsdPerMillion: '1', requestUsd: '0' };
    return { modelId: models[i], model, provider: 'openrouter', account, protocol: 'openrouter-chat-v1', providerLimits,
      upperUsd: openRouterBound(providerLimits, 8192).upperUsd, inputLimit: 196608, outputLimit: 8192, multiplier: '3',
      automaticRetry: false, hiddenTools: false, lookupSupported: true };
  });
  for (const [i, [model, tag]] of pairs.entries()) {
    const config = pricingConfig(model, tag, '1', '1');
    config.reasoning.catalog.endpoints[0]!.supportedParameters = ['tools', 'reasoning_effort'];
    const catalog = { ...config.reasoning.catalog, reasoning: { mandatory: false, defaultEnabled: false, supportedEfforts: ['low'],
      defaultEffort: null, supportsMaxTokens: false } };
    const reasoning = { ...config.reasoning, catalog, purposes: { interactive: { mode: 'effort', effort: 'low', wire: 'reasoning_effort' } } };
    await db.query(`insert into ai_models(id,name,model_id,provider,is_active,input_limit,max_tokens,config,api_endpoint)
      values($1,$2,$2,'openrouter','true',250000,8192,$3,'https://openrouter.ai/api/v1')`, [models[i], model, { ...config, reasoning }]);
  }
  await seedTestOpenRouterKey(db, syntheticKey);
  const profiles = pairs.map(([model, endpointTag]) => ({ model, endpointTag, protocol: 'openrouter-chat-v1', profileVersion: 'synthetic-only',
    evidenceVersion: 'synthetic-only', admissionPath: 'empirical', templateTokens: 4096, marginTokens: 4096, maxBytes: 196608,
    maxMessages: 128, maxTools: 2, maxSchemaBytes: 16384, purposes: ['ordinary', 'fusion_compare'],
    requestFormats: ['serial-tools-v6-reasoning', 'fusion-text-v1-stream'],
    reasoningVariants: [{ parameter: 'none' }, { effort: 'low' }].map(variant => ({ reasoning: variant, outputLimit: 8192, testedOutputLimit: 512,
      evidenceReference: 'synthetic-only', manifestHash: 'b'.repeat(64), outputStressSamples: 2, includesReasoning: true })),
    outputLimit: 8192, expiresAt, evidence: { reference: 'synthetic-only', manifestHash: 'a'.repeat(64), distinctSamples: 60,
      messageStressSamples: 12, maxVerifiedMessages: 128, completeCells: 15, variantsPerCell: 4, maxPromptToBytes: 0.5,
      maxPromptToUpper: 0.4, outputLimit: 8192, testedOutputLimit: 512, outputSemantics: 'max-tokens-includes-reasoning',
      includesReasoning: true, cacheCovered: true, costBoundPassed: true } }));
  const compare = { ...DEFAULT_FUSION_SETTINGS.compare, enabled: true, allowedModelIds: models, defaultModelIds: models, minModels: 2,
    answerOutputTokens: 8192, maxBudgetUsd: '5' };
  const values: Record<string, unknown> = { runtime_payg_staging: { version: 1, enabled: true, windowId, profiles },
    billing_credits_per_usd: '100', billing_token_price_multiplier: '3', fusion_compare_max_models: 4,
    [FUSION_SETTINGS_KEY]: { ...DEFAULT_FUSION_SETTINGS, compare } };
  for (const [key, value] of Object.entries(values)) await db.query(
    'insert into system_settings(key,value) values($1,$2) on conflict(key) do update set value=excluded.value', [key, JSON.stringify(value)]);
  await db.query(`insert into membership_plans(id,name,level,allow_fusion_review,allow_fusion_compare,library_storage_bytes)
    values($1,'Local fixture','gold',true,true,500000000) on conflict(level) do update set allow_fusion_compare=true`, [randomUUID()]);
  await db.query(`insert into runtime_test_windows(id,enabled,actor_ids,call_policies,credits_per_usd,multiplier,max_cost_usd,max_calls,expires_at)
    values($1,true,$2,$3,100,3,10,100,$4)`, [windowId, [randomUUID()], JSON.stringify(policies), expiresAt]);
  Object.assign(process.env, env);
});
afterAll(async () => { await db.end(); });

it.runIf(staging)('RUNTIME: compare start holds every column once, streams each column once, settles per column and adopts', async () => {
  const f = await member();
  const before = judgements;
  const { requestId, choice, shown, started } = await begin(f.actor, f.session, '对比一下这两个选题');
  expect(started.state).toBe('claimed');
  if (started.state === 'processing') throw new Error('unexpected');
  expect(judgements - before).toBe(1);
  const held = await wallet(f.actor);
  expect(1000 - held).toBeLessThanOrEqual(shown.credits);
  // The same request again: the same group, nothing judged, priced or held again.
  const again = await startCompare(deps(f.actor), { ...choice, requestId, shown });
  expect(again).toMatchObject({ compareId: started.compareId });
  expect(judgements - before).toBe(1);
  expect(await wallet(f.actor)).toBe(held);

  // Column 0 streams; two requests for column 1 at once dispatch it once.
  const executor = executorFor(f.actor);
  const sentBefore = sent.length;
  const first = await collect(streamCompareColumn({ admin, actorId: f.actor, executor }, { compareId: started.compareId, column: 0 }));
  expect(first.filter(e => e.type === 'delta').map(e => (e as { text: string }).text).join('')).toBe(answer(pairs[0][0]));
  expect(first.at(-1)).toEqual({ type: 'done', verdict: 'usable' });
  const both = await Promise.allSettled([0, 1].map(() =>
    collect(streamCompareColumn({ admin, actorId: f.actor, executor: executorFor(f.actor) }, { compareId: started.compareId, column: 1 }))));
  expect(sent.length - sentBefore).toBe(2);
  expect(both.some(r => r.status === 'fulfilled' && r.value.at(-1)?.type === 'done')).toBe(true);
  for (const body of sent.slice(-2)) {
    expect(body.plugins).toEqual([{ id: 'web', enabled: false }]);
    expect(body).not.toHaveProperty('tools');
  }
  // A repeat after the answer never dispatches again.
  expect(await collect(streamCompareColumn({ admin, actorId: f.actor, executor }, { compareId: started.compareId, column: 0 })))
    .toEqual([{ type: 'already', verdict: 'usable' }]);
  expect(sent.length - sentBefore).toBe(2);

  const view = await read(f.actor, started.compareId);
  expect(view.state).toBe('finished');
  const charged = view.columns.map(c => c.billing.chargedCredits ?? 0);
  expect(charged.every(c => c >= 1)).toBe(true); // each column rounds up on its own
  expect(view.chargedCredits).toBe(charged.reduce((a, b) => a + b, 0));
  expect(await wallet(f.actor)).toBe(1000 - view.chargedCredits);

  const cards = await compareRpc<Array<{ compareId: string; question: string; adoption: unknown }>>(admin, 'fusion_compare_list',
    { p_actor_id: f.actor, p_session_id: f.session });
  expect(cards.map(c => [c.compareId, c.question])).toEqual([[started.compareId, '对比一下这两个选题']]);

  // Adoption: free, written once, replayable; the conversation shows it and the next turn can read it.
  const funds = await wallet(f.actor);
  const adoptId = randomUUID();
  const adopted = await adoptCompare({ admin, actorId: f.actor, env }, { compareId: started.compareId, column: 1, requestId: adoptId });
  expect(adopted.state).toBe('adopted');
  if (adopted.state !== 'adopted') throw new Error('unexpected');
  expect(await wallet(f.actor)).toBe(funds);
  const runtimeView = await admin.rpc('runtime_view', { p_actor_id: f.actor, p_session_id: f.session });
  expect(runtimeView.error).toBeNull();
  expect((runtimeView.data as { executions: Array<{ executionId: string; body: string }> }).executions
    .find(x => x.executionId === adopted.adoption.executionId)?.body).toBe(answer(pairs[1][0]));
  expect(await adoptCompare({ admin, actorId: f.actor, env }, { compareId: started.compareId, column: 1, requestId: adoptId }))
    .toMatchObject({ state: 'adopted', adoption: { executionId: adopted.adoption.executionId } });
  await expect(adoptCompare({ admin, actorId: f.actor, env }, { compareId: started.compareId, column: 0, requestId: randomUUID() }))
    .rejects.toThrow('FUSION_COMPARE_ADOPTED');
  const listed = await compareRpc<Array<{ adoption: { executionId: string } | null }>>(admin, 'fusion_compare_list',
    { p_actor_id: f.actor, p_session_id: f.session });
  expect(listed[0]!.adoption?.executionId).toBe(adopted.adoption.executionId);
  // The next compare reads the adopted pair as history.
  const next = await loadCompareChoice({ admin, user: admin, actorId: f.actor }, { sessionId: f.session, question: '继续', modelIds: models });
  expect(next.parts.history).toEqual([{ role: 'user', text: '对比一下这两个选题' }, { role: 'assistant', text: answer(pairs[1][0]) }]);
});

it.runIf(staging)('RUNTIME: compare adoption after the conversation moved on returns a quote and writes nothing', async () => {
  const f = await member();
  const executor = executorFor(f.actor);
  const run = async (question: string) => {
    const { started } = await begin(f.actor, f.session, question);
    if (started.state === 'processing') throw new Error('unexpected');
    for (const column of [0, 1]) await collect(streamCompareColumn({ admin, actorId: f.actor, executor }, { compareId: started.compareId, column }));
    return started.compareId;
  };
  const older = await run('第一个问题');
  const newer = await run('第二个问题');
  expect((await adoptCompare({ admin, actorId: f.actor, env }, { compareId: newer, column: 0, requestId: randomUUID() })).state).toBe('adopted');
  const revision = (await db.query('select revision from runtime_sessions where id=$1', [f.session])).rows[0].revision;
  const stale = await adoptCompare({ admin, actorId: f.actor, env }, { compareId: older, column: 0, requestId: randomUUID() });
  expect(stale).toEqual({ state: 'stale', quote: answer(pairs[0][0]) });
  expect((await db.query('select revision from runtime_sessions where id=$1', [f.session])).rows[0].revision).toBe(revision);
});

it.runIf(staging)('RUNTIME: compare without enough credits for the whole group holds nothing; a stop before dispatch is free', async () => {
  const poor = await member(1);
  const { started } = await begin(poor.actor, poor.session, '余额不足');
  expect(started.state).toBe('waiting_credits');
  expect(await wallet(poor.actor)).toBe(1);

  const f = await member();
  const { started: running } = await begin(f.actor, f.session, '马上停止');
  if (running.state === 'processing') throw new Error('unexpected');
  expect(await wallet(f.actor)).toBeLessThan(1000);
  await compareRpc(admin, 'fusion_compare_stop', { p_actor_id: f.actor, p_compare_id: running.compareId, p_run_id: null });
  expect(await wallet(f.actor)).toBe(1000);
  expect((await read(f.actor, running.compareId)).state).toBe('stopped');
  // The user's one compare slot is free again.
  expect((await begin(f.actor, f.session, '再来一次')).started.state).toBe('claimed');
});
