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
import { admitFusionGroup, type FusionMember } from './admission';
import { fusionExecutor } from './executor';
import { recoverFusionFinancials } from './recovery';
import { DEFAULT_FUSION_SETTINGS, FUSION_SETTINGS_KEY } from './settings';

// Real admission -> PostgREST -> PostgreSQL (0234/0235) with a synthetic OpenRouter stream. No network.
const db = new pg.Client({ connectionString: process.env.V3_LOCAL_DB! });
const admin = createClient(process.env.V3_LOCAL_REST!, process.env.V3_LOCAL_SERVICE_JWT!, { auth: { persistSession: false } });
const staging = process.env.V3_LOCAL_STAGING_SCHEMA === 'true';
const windowId = randomUUID();
const pairs = [['anthropic/claude-sonnet-5.5', 'anthropic'], ['google/gemini-3.8-flash', 'google-ai-studio'], ['openai/gpt-6-luna', 'openai']] as const;
const models = pairs.map(() => randomUUID());
// Synthetic local key; the window binds its hash exactly as staging does. Never a real credential.
const syntheticKey = 'SYNTHETIC_LOCAL_ONLY_FUSION';
const account = 'openrouter-key:' + createHash('sha256').update(syntheticKey).digest('hex');
const env = { VERCEL: '1', VERCEL_PROJECT_PRODUCTION_URL: 'auth-staging.graylum.com', VERCEL_GIT_COMMIT_REF: 'staging',
  VERCEL_GIT_REPO_OWNER: 'Crnobog9527', VERCEL_GIT_REPO_SLUG: 'GraylumAI_vercel', VERCEL_PROJECT_ID: 'synthetic',
  V3_RUNTIME_STAGING_PROJECT_ID: 'synthetic', V3_RUNTIME_STAGING_DATABASE_HOST: 'synthetic.supabase.co',
  NEXT_PUBLIC_SUPABASE_URL: 'https://synthetic.supabase.co', V3_RUNTIME_STAGING_WINDOW_ID: windowId, V3_RUNTIME_STAGING_ENABLED: 'true' };
const sent: Array<Record<string, unknown>> = [];
const stream = (model: string, id: string) => [
  `data: ${JSON.stringify({ id, model, choices: [{ index: 0, delta: { role: 'assistant', content: '{"issues":[]}' }, finish_reason: null }] })}\n\n`,
  `data: ${JSON.stringify({ id, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 40, completion_tokens: 6, total_tokens: 46, cost: 0.0004 } })}\n\n`, 'data: [DONE]\n\n'].join('');
const adapter = openRouterAdapter({ credential: async () => 'SYNTHETIC_LOCAL_ONLY', transport: async (_url, init) => {
  const body = JSON.parse(String(init?.body));
  sent.push(body);
  const id = 'gen-fusion-' + randomUUID();
  return new Response(stream(body.model, id), { headers: { 'content-type': 'text/event-stream', 'x-generation-id': id } });
} });
const wallet = async (actor: string) => (await db.query('select credits from profiles where id=$1', [actor])).rows[0].credits as number;
const allow = async () => ({ ok: true as const });

async function member() {
  const actor = randomUUID();
  await db.query("insert into profiles(id,credits,membership_level) values($1,1000,'gold')", [actor]);
  await db.query(`insert into credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,idempotency_key,
    balance_before,balance_after) values($1,1000,'addition','grant','opening_grant','system',$2,0,1000)`, [actor, 'opening:' + actor]);
  await db.query('update runtime_test_windows set actor_ids=array_append(actor_ids,$2) where id=$1', [windowId, actor]);
  const session = await admin.rpc('runtime_start', { p_actor_id: actor, p_request_id: randomUUID(), p_payload: { scope: { kind: 'positioning_draft' } } });
  if (session.error) throw new Error(session.error.message);
  return { actor, session: session.data.sessionId as string };
}
const members = (): FusionMember[] => [
  { modelId: models[0]!, phase: 'fusion_review', request: { instructions: 'Review the report.', input: 'Synthetic report' } },
  { modelId: models[2]!, phase: 'fusion_summary', request: { instructions: 'Summarize the opinions.', input: 'Synthetic opinions' } },
];
const executorFor = (actor: string) => {
  const budget = createRuntimeBudget();
  const billing = authoritativeBilling({ admin: admin as unknown as BillingRpc, actor: async () => actor, adapter, budget });
  return fusionExecutor({ billing, admin, actorId: actor, callGate: allow, budget });
};

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
    const reasoning = { ...config.reasoning, catalog, purposes: { interactive: { mode: 'effort', effort: 'low', wire: 'reasoning_effort' },
      review: { mode: 'effort', effort: 'low', wire: 'reasoning_effort' }, writing: { mode: 'provider_default' } } };
    await db.query(`insert into ai_models(id,name,model_id,provider,is_active,input_limit,max_tokens,config,api_key,api_endpoint)
      values($1,$2,$2,'openrouter','true',250000,8192,$3,$4,'https://openrouter.ai/api/v1')`, [models[i], model, { ...config, reasoning }, syntheticKey]);
  }
  const profiles = pairs.map(([model, endpointTag]) => ({ model, endpointTag, protocol: 'openrouter-chat-v1', profileVersion: 'synthetic-only',
    evidenceVersion: 'synthetic-only', admissionPath: 'empirical', templateTokens: 4096, marginTokens: 4096, maxBytes: 196608,
    maxMessages: 128, maxTools: 2, maxSchemaBytes: 16384, purposes: ['ordinary', 'fusion_review', 'fusion_summary'],
    requestFormats: ['serial-tools-v6-reasoning', 'fusion-json-v1-stream'],
    reasoningVariants: [{ parameter: 'none' }, { effort: 'low' }].map(variant => ({ reasoning: variant, outputLimit: 8192, testedOutputLimit: 512,
      evidenceReference: 'synthetic-only', manifestHash: 'b'.repeat(64), outputStressSamples: 2, includesReasoning: true })),
    outputLimit: 8192, expiresAt, evidence: { reference: 'synthetic-only', manifestHash: 'a'.repeat(64), distinctSamples: 60,
      messageStressSamples: 12, maxVerifiedMessages: 128, completeCells: 15, variantsPerCell: 4, maxPromptToBytes: 0.5,
      maxPromptToUpper: 0.4, outputLimit: 8192, testedOutputLimit: 512, outputSemantics: 'max-tokens-includes-reasoning',
      includesReasoning: true, cacheCovered: true, costBoundPassed: true } }));
  const review = { ...DEFAULT_FUSION_SETTINGS.review, enabled: true, reviewerModelIds: models, summaryModelId: models[2], maxBudgetUsd: '5' };
  const values: Record<string, unknown> = { runtime_payg_staging: { version: 1, enabled: true, windowId, profiles },
    billing_credits_per_usd: '100', billing_token_price_multiplier: '3', fusion_compare_max_models: 4,
    [FUSION_SETTINGS_KEY]: { ...DEFAULT_FUSION_SETTINGS, review } };
  for (const [key, value] of Object.entries(values)) await db.query(
    'insert into system_settings(key,value) values($1,$2) on conflict(key) do update set value=excluded.value', [key, JSON.stringify(value)]);
  await db.query(`insert into membership_plans(id,name,level,allow_fusion_review,allow_fusion_compare,library_storage_bytes)
    values($1,'Local fixture','gold',true,true,500000000) on conflict(level) do update set allow_fusion_review=true`, [randomUUID()]);
  await db.query(`insert into runtime_test_windows(id,enabled,actor_ids,call_policies,credits_per_usd,multiplier,max_cost_usd,max_calls,expires_at)
    values($1,true,$2,$3,100,3,10,100,$4)`, [windowId, [randomUUID()], JSON.stringify(policies), expiresAt]);
  Object.assign(process.env, env);
});
afterAll(async () => { await db.end(); });

it.runIf(staging)('RUNTIME: Fusion group admission, streamed dispatch, saved body, verdict and per-run settlement', async () => {
  const f = await member();
  const requestId = randomUUID();
  const group = await admitFusionGroup({ admin, actorId: f.actor, requestId, sourceSessionId: f.session, members: members(), env });
  expect(group.replayed).toBe(false);
  expect(await admitFusionGroup({ admin, actorId: f.actor, requestId, sourceSessionId: f.session, members: members(), env }))
    .toEqual({ ...group, replayed: true });
  const executor = executorFor(f.actor);
  const claimed = await executor.claim(group.groupId, 'review:1', 1, group.runs);
  expect(claimed.state).toBe('claimed');
  const held = await wallet(f.actor);
  expect(held).toBeLessThan(1000);
  const chunks: string[] = [];
  for (const run of group.runs) {
    const call = claimed.calls.find(item => item.runId === run.runId)!;
    expect(await executor.run(run, call, () => 'usable', chunk => chunks.push(chunk))).toMatchObject({ state: 'judged', verdict: 'usable' });
    expect((await executor.readOutput(call.id))?.body).toBe('{"issues":[]}');
  }
  expect(chunks.length).toBeGreaterThan(0);
  for (const body of sent.slice(-2)) {
    expect(body.plugins).toEqual([{ id: 'web', enabled: false }]);
    expect(body).not.toHaveProperty('tools');
    expect(body).not.toHaveProperty('tool_choice');
  }
  const calls = (await db.query('select c.settled_at,c.fusion_verdict,c.charged_delta,r.closed from bill2_calls c join bill2_runs r on r.id=c.run_id where r.fusion_group_id=$1',
    [group.groupId])).rows;
  expect(calls).toHaveLength(2);
  for (const call of calls) expect({ settled: Boolean(call.settled_at), verdict: call.fusion_verdict, closed: call.closed,
    charged: Number(call.charged_delta) >= 1 }).toEqual({ settled: true, verdict: 'usable', closed: true, charged: true });
  expect(await wallet(f.actor)).toBe(1000 - calls.reduce((sum, c) => sum + Number(c.charged_delta), 0));
});

it.runIf(staging)('RUNTIME: Fusion stop releases undispatched holds; recovery cancels a call past its dispatch deadline', async () => {
  const f = await member();
  const executor = executorFor(f.actor);
  const stopped = await admitFusionGroup({ admin, actorId: f.actor, requestId: randomUUID(), sourceSessionId: f.session, members: members(), env });
  await executor.claim(stopped.groupId, 'review:1', 1, stopped.runs);
  expect(await wallet(f.actor)).toBeLessThan(1000);
  await executor.stop(stopped.runs.map(run => run.runId));
  expect(await wallet(f.actor)).toBe(1000);
  const late = await admitFusionGroup({ admin, actorId: f.actor, requestId: randomUUID(), sourceSessionId: f.session, members: members(), env });
  await executor.claim(late.groupId, 'review:1', 1, late.runs);
  expect(await wallet(f.actor)).toBeLessThan(1000);
  await db.query(`update bill2_calls set dispatch_deadline=now()-interval '1 second'
    where run_id in (select id from bill2_runs where fusion_group_id=$1)`, [late.groupId]);
  const summary = await recoverFusionFinancials(admin, { limit: 200 });
  expect(summary.cancelled).toBeGreaterThanOrEqual(2);
  expect(await wallet(f.actor)).toBe(1000);
  expect(sent.filter(body => body.model).length).toBeGreaterThan(0);
});

it.runIf(staging)('RUNTIME: Fusion admission refuses a disabled switch, a non-allowlisted model and a non-member', async () => {
  const f = await member();
  const base = { admin, actorId: f.actor, sourceSessionId: f.session, env };
  await expect(admitFusionGroup({ ...base, requestId: randomUUID(), members: [{ ...members()[0]!, modelId: randomUUID() }] }))
    .rejects.toThrow('FUSION_MODEL_DENIED');
  await db.query("update profiles set membership_level='free' where id=$1", [f.actor]);
  await expect(admitFusionGroup({ ...base, requestId: randomUUID(), members: members() })).rejects.toThrow();
  await db.query("update profiles set membership_level='gold' where id=$1", [f.actor]);
  const stored = (await db.query('select value from system_settings where key=$1', [FUSION_SETTINGS_KEY])).rows[0].value;
  await db.query('update system_settings set value=$2 where key=$1', [FUSION_SETTINGS_KEY, JSON.stringify(DEFAULT_FUSION_SETTINGS)]);
  try { await expect(admitFusionGroup({ ...base, requestId: randomUUID(), members: members() })).rejects.toThrow('FUSION_REVIEW_DISABLED'); }
  finally { await db.query('update system_settings set value=$2 where key=$1', [FUSION_SETTINGS_KEY, JSON.stringify(stored)]); }
});
