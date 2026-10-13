/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import { expect, it } from 'vitest';
import { runtimeExecutor } from './execute';
import { POSITIONING_FALLBACK, POSITIONING_MARKER } from './positioningFallback';

// POSITIONING-GATE (Owner 2026-10-12): Decisions was unavailable, so the turn carries the fallback rule. When the primary
// model refuses with the structured marker, the round ends through fail_platform (0215 + 0233): the charged call is
// compensated once, nothing is shown or saved as an answer, and the execution records positioning_required.
const connectionString = process.env.V3_LOCAL_DB!;
async function fallbackRound(reply: string, gate: string | undefined = POSITIONING_FALLBACK) {
  if (!connectionString?.startsWith('postgres://postgres@127.0.0.1:') || !connectionString.endsWith('/v3_disposable'))
    throw new Error('isolated runner required');
  const db = new pg.Client({ connectionString });
  const admin = createClient(process.env.V3_LOCAL_REST!, process.env.V3_LOCAL_SERVICE_JWT!, { auth: { persistSession: false } });
  const rpc = async (name: string, args: Record<string, unknown>) => {
    const result = await admin.rpc(name, args);
    if (result.error) throw new Error(result.error.message);
    return result.data;
  };
  const actor = randomUUID(), primary = randomUUID(), model = 'positioning-refusal-' + primary;
  let dispatched = 0;
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const input = JSON.parse(JSON.parse(raw).input);
    dispatched++;
    const id = 'positioning-refusal-' + randomUUID();
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id, model: input.model, final: true, cost: '0.003', currency: 'USD',
      coverage: 'request_total', usage: { inputTokens: 3000, outputTokens: 4, sdkResponse: { id, object: 'chat.completion', created: 1,
        model: input.model, choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3000, completion_tokens: 4, total_tokens: 3004 } } } }));
  });
  await db.connect();
  await db.query('insert into profiles(id,credits) values($1,100)', [actor]);
  await db.query(`insert into credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,
    idempotency_key,balance_before,balance_after) values($1,100,'addition','grant','opening_grant','system',$2,0,100)`,
  [actor, 'positioning-refusal-opening:' + actor]);
  await db.query(`insert into ai_models(id,model_id,name,provider,is_active) values($1,$2,'Positioning refusal','fixture',true)`, [primary, model]);
  const pricingHash = 'a'.repeat(64), endpointTag = 'fixture/exact';
  const policy = { modelId: primary, model, provider: 'fixture', account: 'sandbox', protocol: 'fixture-cost-v1',
    upperUsd: '0.1', multiplier: '1', inputLimit: 32000, outputLimit: 1000, automaticRetry: false, hiddenTools: false, lookupSupported: false,
    providerLimits: { providerSlug: endpointTag, contextTokens: 100000, promptUsdPerMillion: '1', completionUsdPerMillion: '0', requestUsd: '0' },
    payg: { version: 'v1', policyId: 'positioning-refusal', profileVersion: 'local-v1', evidenceVersion: 'local-v1',
      pricingHash, endpointTag, templateTokens: 4096, marginTokens: 4096, admissionPath: 'fixture',
      maxBytes: 32000, maxMessages: 32, maxTools: 2, maxSchemaBytes: 16384,
      purposes: ['ordinary'], expiresAt: new Date(Date.now() + 3600000).toISOString(),
      nominalPricing: { version: 'nominal-v1', pricingHash, endpointTag,
        tiers: [{ minPromptTokens: 0, prompt: '1', completion: '0', request: '0' }], timeOfDay: [] } } };
  await db.query(`insert into system_settings(key,value) values('billing_payg_start_thresholds',$1::jsonb)
    on conflict(key) do update set value=jsonb_set(system_settings.value,'{thresholds}',
    coalesce(system_settings.value->'thresholds','[]')||(excluded.value->'thresholds'))`,
  [{ version: 'local-v1', thresholds: [{ model, purpose: 'ordinary', credits: 1 }] }]);
  const session = await rpc('runtime_start', { p_actor_id: actor, p_request_id: randomUUID(),
    p_payload: { scope: { kind: 'positioning_draft' } } });
  const requestId = randomUUID();
  const context = { version: 'runtime.v1', sdkVersion: '0.18.0', role: 'ordinary', input: '帮我想下周小红书发什么',
    instructions: 'Synthetic local response', model, maxOutputTokens: 1000, maxTurns: 1, historyItems: 0, tools: [], sources: [],
    network: 'deny', request: { sessionId: session.sessionId, requestId }, nativeOutput: 'native-output-v1',
    ...(gate ? { positioningGate: gate } : {}) };
  const billing = { contractVersion: 'bill2.v2', mode: 'isolated', scope: session.scope, operation: 'question',
    modelId: primary, sourceHash: 'b'.repeat(64), input: context, callPolicy: [policy],
    rules: { version: 'v1', quoteVersion: 'local-v1', creditsPerUsd: '1000', multiplier: '1', fx: {},
      billingUnit: { version: 'bill-unit-v2', creditsPerUsd: '1000', defaultMultiplier: '1', hash: 'f'.repeat(64), providers: {},
        models: { [primary]: { multiplier: '1', source: 'global' } } } },
    limits: { costUsd: '0.1', credits: 0, maxPreDeduct: 0, maxCalls: 1, deadline: new Date(Date.now() + 3600000).toISOString() } };
  const admitted = await rpc('runtime_admit', { p_actor_id: actor, p_session_id: session.sessionId,
    p_request_id: requestId, p_payload: context, p_billing: billing });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('local server required');
  const host = () => runtimeExecutor({ database: admin, actor: async () => actor, callGate: async () => ({ ok: true as const }),
    endpoint: 'http://127.0.0.1:' + address.port });
  const financial = async () => (await db.query(`select p.credits,
    (select sum(amount)::int from credit_transactions where user_id=$1) ledger,
    (select count(*)::int from credit_transactions where user_id=$1 and reason_code='bill2_compensation') compensations,
    r.state run_state,r.outcome,e.state execution_state,e.unavailable_reason,s.active_execution,
    (select count(*)::int from runtime_session_history h where h.session_id=s.id) items
    from profiles p,bill2_runs r,runtime_executions e,runtime_sessions s
    where p.id=$1 and r.id=$2 and e.id=$3 and s.id=$4`, [actor, admitted.runId, admitted.executionId, session.sessionId])).rows[0];
  const close = async () => {
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
    await db.end();
  };
  return { admitted, host, financial, close, dispatched: () => dispatched };
}

it('RUNTIME: a fallback positioning refusal ends the round and restores its charge exactly once', async () => {
  const f = await fallbackRound(POSITIONING_MARKER);
  try {
    const result = await f.host().execute(f.admitted.executionId);
    expect(result).toEqual({ state: 'cancelled', unavailable: 'positioning_required', code: 'POSITIONING_REQUIRED' });
    const after = await f.financial();
    expect(after).toMatchObject({ credits: 100, ledger: 100, compensations: 1, run_state: 'refunded', outcome: 'confirmed_failure',
      execution_state: 'cancelled', unavailable_reason: 'positioning_required', active_execution: null, items: 0 });
    // Reading it again (refresh) keeps the reason, never redispatches and never refunds twice.
    expect(await f.host().execute(f.admitted.executionId)).toEqual({ state: 'cancelled', unavailable: 'positioning_required' });
    expect(f.dispatched()).toBe(1);
    expect(await f.financial()).toEqual(after);
  } finally { await f.close(); }
}, 30000);

it('RUNTIME: concurrent executions of one refused round dispatch once and compensate once', async () => {
  const f = await fallbackRound(POSITIONING_MARKER);
  try {
    const results = await Promise.all([f.host().execute(f.admitted.executionId), f.host().execute(f.admitted.executionId)]);
    expect(results.some(r => r.state === 'cancelled')).toBe(true);
    expect(f.dispatched()).toBe(1);
    expect(await f.financial()).toMatchObject({ credits: 100, compensations: 1, run_state: 'refunded',
      execution_state: 'cancelled', unavailable_reason: 'positioning_required' });
  } finally { await f.close(); }
}, 30000);

it.each([
  ['an ordinary answer under the fallback rule', '小红书的推荐算法主要看互动率。', POSITIONING_FALLBACK],
  ['the marker without the fallback rule', POSITIONING_MARKER, undefined],
])('RUNTIME: %s completes and is charged normally', async (_name, reply, gate) => {
  const f = await fallbackRound(reply, gate);
  try {
    expect(await f.host().execute(f.admitted.executionId)).toMatchObject({ state: 'completed' });
    expect(await f.financial()).toMatchObject({ credits: 97, compensations: 0, execution_state: 'completed', unavailable_reason: null });
  } finally { await f.close(); }
}, 30000);
