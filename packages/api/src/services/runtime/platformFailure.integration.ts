/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import { expect, it } from 'vitest';
import { runtimeExecutor } from './execute';
import { overlap } from '../__tests__/fixtures/planBConcurrency';

// Owner 2026-10-12: a round that fails for a Graylum system reason ends and every credit it
// charged is restored. A real v2 run charges its primary call (3 credits), then waits for the
// attached organizer; the test resumes it as a live owner and reports a system failure.
const connectionString = process.env.V3_LOCAL_DB!;
async function waitingRound(organizerReply: 'answer' | 'drop' = 'answer') {
  if (!connectionString?.startsWith('postgres://postgres@127.0.0.1:') || !connectionString.endsWith('/v3_disposable'))
    throw new Error('isolated runner required');
  const db = new pg.Client({ connectionString });
  const admin = createClient(process.env.V3_LOCAL_REST!, process.env.V3_LOCAL_SERVICE_JWT!, { auth: { persistSession: false } });
  const rpc = async (name: string, args: Record<string, unknown>) => {
    const result = await admin.rpc(name, args);
    if (result.error) throw new Error(result.error.message);
    return result.data;
  };
  const actor = randomUUID(), primary = randomUUID(), organizer = randomUUID();
  const model = 'platform-failure-' + primary, summaryModel = 'platform-failure-' + organizer;
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const input = JSON.parse(JSON.parse(raw).input);
    // An organizer request that is sent but never answered leaves its cost unknown.
    if (input.model === summaryModel && organizerReply === 'drop') { req.socket.destroy(); return; }
    const id = 'platform-failure-' + randomUUID();
    const content = input.model === model ? 'Primary result' : 'Organized result';
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id, model: input.model, final: true, cost: '0.003', currency: 'USD',
      coverage: 'request_total', usage: { inputTokens: 3000, outputTokens: 4, sdkResponse: { id, object: 'chat.completion', created: 1,
        model: input.model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3000, completion_tokens: 4, total_tokens: 3004 } } } }));
  });
  await db.connect();
  await db.query('insert into profiles(id,credits) values($1,100)', [actor]);
  await db.query(`insert into credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,
    idempotency_key,balance_before,balance_after) values($1,100,'addition','grant','opening_grant','system',$2,0,100)`,
  [actor, 'platform-failure-opening:' + actor]);
  for (const [id, name] of [[primary, model], [organizer, summaryModel]])
    await db.query(`insert into ai_models(id,model_id,name,provider,is_active) values($1,$2,'Platform failure','fixture',true)`, [id, name]);
  const pricingHash = 'a'.repeat(64), endpointTag = 'fixture/exact';
  const policies = [[primary, model], [organizer, summaryModel]].map(([modelId, name]) => ({
    modelId, model: name, provider: 'fixture', account: 'sandbox', protocol: 'fixture-cost-v1',
    upperUsd: '0.1', multiplier: '1', inputLimit: 32000, outputLimit: 1000,
    automaticRetry: false, hiddenTools: false, lookupSupported: false,
    providerLimits: { providerSlug: endpointTag, contextTokens: 100000, promptUsdPerMillion: '1', completionUsdPerMillion: '0', requestUsd: '0' },
    payg: { version: 'v1', policyId: 'platform-failure', profileVersion: 'local-v1', evidenceVersion: 'local-v1',
      pricingHash, endpointTag, templateTokens: 4096, marginTokens: 4096, admissionPath: 'fixture',
      maxBytes: 32000, maxMessages: 32, maxTools: 2, maxSchemaBytes: 16384,
      purposes: ['ordinary', 'attached_organizer'], expiresAt: new Date(Date.now() + 3600000).toISOString(),
      nominalPricing: { version: 'nominal-v1', pricingHash, endpointTag,
        tiers: [{ minPromptTokens: 0, prompt: '1', completion: '0', request: '0' }], timeOfDay: [] } },
  }));
  // The organizer threshold (100) exceeds the balance left after the primary call (97).
  await db.query(`insert into system_settings(key,value) values('billing_payg_start_thresholds',$1::jsonb)
    on conflict(key) do update set value=jsonb_set(system_settings.value,'{thresholds}',
    coalesce(system_settings.value->'thresholds','[]')||(excluded.value->'thresholds'))`,
  [{ version: 'local-v1', thresholds: [{ model, purpose: 'ordinary', credits: 1 },
    { model: summaryModel, purpose: 'attached_organizer', credits: 100 }] }]);
  const session = await rpc('runtime_start', { p_actor_id: actor, p_request_id: randomUUID(),
    p_payload: { scope: { kind: 'positioning_draft' } } });
  const requestId = randomUUID();
  const context = { version: 'runtime.v1', sdkVersion: '0.18.0', role: 'ordinary', input: 'Answer and organize',
    instructions: 'Synthetic local response', model, maxOutputTokens: 1000, maxTurns: 1, historyItems: 0, tools: [], sources: [],
    network: 'deny', request: { sessionId: session.sessionId, requestId },
    attachedOrganizer: { modelId: organizer, model: summaryModel, maxOutputTokens: 1000 } };
  const billing = { contractVersion: 'bill2.v2', mode: 'isolated', scope: session.scope, operation: 'question',
    modelId: primary, sourceHash: 'b'.repeat(64), input: context, callPolicy: policies,
    rules: { version: 'v1', quoteVersion: 'local-v1', creditsPerUsd: '1000', multiplier: '1', fx: {},
      billingUnit: { version: 'bill-unit-v2', creditsPerUsd: '1000', defaultMultiplier: '1', hash: 'f'.repeat(64), providers: {},
        models: { [primary]: { multiplier: '1', source: 'global' }, [organizer]: { multiplier: '1', source: 'global' } } } },
    limits: { costUsd: '0.2', credits: 0, maxPreDeduct: 0, maxCalls: 2, deadline: new Date(Date.now() + 3600000).toISOString() } };
  const admitted = await rpc('runtime_admit', { p_actor_id: actor, p_session_id: session.sessionId,
    p_request_id: requestId, p_payload: context, p_billing: billing });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('local server required');
  const host = runtimeExecutor({ database: admin, actor: async () => actor, callGate: async () => ({ ok: true as const }),
    endpoint: 'http://127.0.0.1:' + address.port });
  expect(await host.execute(admitted.executionId)).toMatchObject({ state: 'waiting_credits', epoch: 1 });
  const financial = async () => (await db.query(`select p.credits,
    (select sum(amount)::int from credit_transactions where user_id=$1) ledger,
    (select count(*)::int from credit_transactions where user_id=$1 and reason_code='bill2_compensation') compensations,
    r.state run_state,r.closed,r.outcome,r.compensation_credits,e.state execution_state,e.unavailable_reason,
    s.active_execution
    from profiles p,bill2_runs r,runtime_executions e,runtime_sessions s
    where p.id=$1 and r.id=$2 and e.id=$3 and s.id=$4`, [actor, admitted.runId, admitted.executionId, session.sessionId])).rows[0];
  const epoch = async () => Number((await db.query('select runtime_epoch from bill2_runs where id=$1', [admitted.runId])).rows[0].runtime_epoch);
  /** The round is back with a live owner, as when a later call of the same round fails. */
  const resumeLive = async () => {
    await db.query("update runtime_executions set state='running' where id=$1", [admitted.executionId]);
    await db.query('update runtime_sessions set active_execution=$2 where id=$1', [session.sessionId, admitted.executionId]);
    await db.query('update bill2_runs set paused_reason=null where id=$1', [admitted.runId]);
  };
  const failPlatform = async (client: pg.Client, reason = 'provider_history') => (await client.query(
    'select public.runtime_execution($1,$2,$3,$4) value',
    [actor, admitted.executionId, 'fail_platform', { epoch: await epoch(), value: { unavailable_reason: reason } }])).rows[0].value;
  const close = async () => {
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
    await db.end();
  };
  return { db, actor, admitted, session, host, financial, resumeLive, failPlatform, close };
}

it('RUNTIME: platform failure after a charged call ends the round and restores its credits exactly once', async () => {
  const f = await waitingRound();
  try {
    expect(await f.financial()).toMatchObject({ credits: 97, ledger: 97, compensations: 0, run_state: 'prepared' });
    await f.resumeLive();
    expect(await f.failPlatform(f.db)).toMatchObject({ state: 'cancelled', unavailableReason: 'provider_history' });
    const after = await f.financial();
    expect(after).toMatchObject({ credits: 100, ledger: 100, compensations: 1, run_state: 'refunded', closed: true,
      outcome: 'confirmed_failure', compensation_credits: 3, execution_state: 'cancelled',
      unavailable_reason: 'provider_history', active_execution: null });
    // A repeated report is refused (the failed round's content is revoked) and changes nothing;
    // the executor still reads the original result.
    await expect(f.failPlatform(f.db)).rejects.toThrow('RUNTIME_CONTEXT_REVOKED');
    expect(await f.host.execute(f.admitted.executionId)).toEqual({ state: 'cancelled', unavailable: 'provider_history' });
    expect(await f.financial()).toEqual(after);
  } finally { await f.close(); }
}, 30000);

it('RUNTIME: concurrent platform-failure reports compensate once', async () => {
  const f = await waitingRound();
  try {
    await f.resumeLive();
    const race = await overlap(f.db, connectionString, 'select id from bill2_runs where id=$1 for update', [f.admitted.runId],
      a => f.failPlatform(a, 'preflight'), b => f.failPlatform(b, 'preflight'));
    expect(race.value).toMatchObject({ state: 'cancelled', unavailableReason: 'preflight' });
    expect(race.other.ok).toBe(false);
    expect(await f.financial()).toMatchObject({ credits: 100, ledger: 100, compensations: 1, run_state: 'refunded',
      compensation_credits: 3, execution_state: 'cancelled', unavailable_reason: 'preflight' });
  } finally { await f.close(); }
}, 30000);

it('RUNTIME: an unknown dispatched call keeps the original recovery path and charges', async () => {
  const f = await waitingRound('drop');
  try {
    // Credits for the organizer arrive; its request is sent but never answered.
    await f.db.query(`insert into credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,
      idempotency_key,balance_before,balance_after) values($1,100,'addition','grant','opening_grant','system',$2,97,197)`,
    [f.actor, 'platform-failure-topup:' + f.actor]);
    await f.db.query('update profiles set credits=197 where id=$1', [f.actor]);
    const token = { executionId: f.admitted.executionId, cursor: 1, epoch: 1 };
    await f.host.execute(f.admitted.executionId, undefined, token).catch(() => null);
    const unknown = (await f.db.query(`select count(*)::int n from bill2_calls where run_id=$1
      and dispatched_at is not null and settled_at is null`, [f.admitted.runId])).rows[0].n;
    expect(unknown).toBe(1);
    await f.resumeLive();
    const before = await f.financial();
    expect(await f.failPlatform(f.db)).toMatchObject({ state: 'running' });
    expect(await f.financial()).toEqual(before);
    expect(before).toMatchObject({ closed: false, compensations: 0 });
  } finally { await f.close(); }
}, 30000);

it('RUNTIME: platform failure refuses unknown reasons and a user-stopped round', async () => {
  const f = await waitingRound();
  try {
    await f.resumeLive();
    const before = await f.financial();
    await expect(f.failPlatform(f.db, 'output_truncated')).rejects.toThrow('RUNTIME_FAILURE_REASON_DENIED');
    await f.db.query("update bill2_runs set paused_reason='user_stop' where id=$1", [f.admitted.runId]);
    await expect(f.failPlatform(f.db)).rejects.toThrow('RUNTIME_STOP_REQUESTED');
    expect(await f.financial()).toEqual(before);
  } finally { await f.close(); }
}, 30000);
