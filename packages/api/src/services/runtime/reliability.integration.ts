/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import { expect, it, vi } from 'vitest';
import { runtimeExecutor } from './execute';
import { createRuntimeBudget } from './budget';
import { authoritativeBilling } from '../bill2/service';

async function fixture(invalid?: 'primary' | 'organizer' | 'terminal') {
  const connectionString = process.env.V3_LOCAL_DB;
  if (!connectionString?.startsWith('postgres://postgres@127.0.0.1:') || !connectionString.endsWith('/v3_disposable'))
    throw new Error('isolated runner required');
  const db = new pg.Client({ connectionString }); await db.connect();
  const admin = createClient(process.env.V3_LOCAL_REST!, process.env.V3_LOCAL_SERVICE_JWT!, { auth: { persistSession: false } });
  const actor = randomUUID(), primary = randomUUID(), organizer = randomUUID();
  const model = 'reliability-' + primary, summaryModel = 'reliability-' + organizer;
  await db.query('insert into profiles(id,credits) values($1,100)', [actor]);
  await db.query(`insert into credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,
    idempotency_key,balance_before,balance_after) values($1,100,'addition','grant','opening_grant','system',$2,0,100)`,
  [actor, 'reliability:' + actor]);
  const policies = [[primary, model], [organizer, summaryModel]].map(([modelId, name]) => ({
    modelId, model: name, provider: 'fixture', account: 'sandbox', protocol: 'fixture-cost-v1',
    upperUsd: '0.1', multiplier: '1', inputLimit: 32000, outputLimit: 1000,
    automaticRetry: false, hiddenTools: false, lookupSupported: false,
    providerLimits: { providerSlug: 'fixture/exact', contextTokens: 100000,
      promptUsdPerMillion: '1', completionUsdPerMillion: '0', requestUsd: '0' },
    payg: { version: 'v1', policyId: 'reliability', profileVersion: 'local-v1', evidenceVersion: 'local-v1',
      pricingHash: 'a'.repeat(64), endpointTag: 'fixture/exact', templateTokens: 4096, marginTokens: 4096,
      admissionPath: 'fixture', maxBytes: 32000, maxMessages: 32, maxTools: 2, maxSchemaBytes: 16384,
      purposes: ['ordinary', 'attached_organizer'], expiresAt: new Date(Date.now() + 3600000).toISOString(),
      nominalPricing: { version: 'nominal-v1', pricingHash: 'a'.repeat(64), endpointTag: 'fixture/exact',
        tiers: [{ minPromptTokens: 0, prompt: '1', completion: '0', request: '0' }], timeOfDay: [] } },
  }));
  for (const [id, name] of [[primary, model], [organizer, summaryModel]])
    await db.query("insert into ai_models(id,model_id,name,provider,is_active) values($1,$2,'Reliability fixture','fixture',true)", [id, name]);
  await db.query(`insert into system_settings(key,value) values('billing_payg_start_thresholds',$1::jsonb)
    on conflict(key) do update set value=jsonb_set(system_settings.value,'{thresholds}',
    coalesce(system_settings.value->'thresholds','[]')||(excluded.value->'thresholds'))`, [{ version: 'local-v1',
    thresholds: [{ model, purpose: 'ordinary', credits: 1 }, { model: summaryModel, purpose: 'attached_organizer', credits: 1 }] }]);
  const rpc = async (name: string, args: Record<string, unknown>) => {
    const result = await admin.rpc(name, args); if (result.error) throw new Error(result.error.message); return result.data;
  };
  const session = await rpc('runtime_start', { p_actor_id: actor, p_request_id: randomUUID(), p_payload: { scope: { kind: 'positioning_draft' } } });
  const requestId = randomUUID();
  const context = { ...(invalid === 'terminal' ? { providerRequestFormat: 'agent-turn-v5-stream', reasoning: { effort: 'none' } } : {}),
    version: 'runtime.v1', sdkVersion: '0.18.0', role: 'ordinary', input: 'Answer and organize',
    instructions: 'Synthetic reliability test', model, maxOutputTokens: 1000, maxTurns: 1,
    historyItems: 0, tools: [], sources: [], network: 'deny', request: { sessionId: session.sessionId, requestId },
    attachedOrganizer: { modelId: organizer, model: summaryModel, maxOutputTokens: 1000 } };
  const billing = { contractVersion: 'bill2.v2', mode: 'isolated', scope: session.scope, operation: 'question', modelId: primary,
    sourceHash: 'b'.repeat(64), input: context, callPolicy: policies,
    rules: { version: 'v1', quoteVersion: 'local-v1', creditsPerUsd: '1000', multiplier: '1', fx: {},
      billingUnit: { version: 'bill-unit-v2', creditsPerUsd: '1000', defaultMultiplier: '1', hash: 'f'.repeat(64), providers: {},
        models: { [primary]: { multiplier: '1', source: 'global' }, [organizer]: { multiplier: '1', source: 'global' } } } },
    limits: { costUsd: '0.2', credits: 0, maxPreDeduct: 0, maxCalls: invalid && invalid !== 'organizer' ? 1 : 2,
      deadline: new Date(Date.now() + 3600000).toISOString() } };
  const admitted = await rpc('runtime_admit', { p_actor_id: actor, p_session_id: session.sessionId,
    p_request_id: requestId, p_payload: context, p_billing: billing });
  const requests: string[] = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const input = JSON.parse(JSON.parse(raw).input); requests.push(input.model);
    const id = randomUUID(), content = invalid === 'terminal' ? '' : input.model === model ? 'Saved primary answer' : 'Saved organizer summary';
    const sdkModel = (invalid === 'primary' && input.model === model || invalid === 'organizer' && input.model === summaryModel)
      ? 'wrong-model' : input.model;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id, model: input.model, final: true, cost: '0.003', currency: 'USD', coverage: 'request_total',
      usage: { inputTokens: 3000, outputTokens: 4, sdkResponse: { id, object: 'chat.completion', created: 1, model: sdkModel,
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: invalid === 'terminal' ? 'content_filter' : 'stop' }],
        usage: { prompt_tokens: 3000, completion_tokens: 4, total_tokens: 3004 } } } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('local fixture');
  const options = { database: admin, actor: async () => actor, callGate: vi.fn(async () => ({ ok: true as const })),
    endpoint: 'http://127.0.0.1:' + address.port };
  const snapshot = async () => (await db.query(`select p.credits,
    (select sum(amount)::int from credit_transactions where user_id=p.id) ledger,
    (select count(*)::int from bill2_calls where run_id=$2) calls,
    (select count(*)::int from credit_transactions where bill2_run_id=$2 and reason_code='bill2_spend') spends,
    (select count(*)::int from credit_transactions where bill2_run_id=$2 and reason_code='bill2_compensation') refunds,
    b.reserved,b.charged,b.compensation_credits,b.state,b.closed,b.outcome,e.state execution_state,
    s.active_execution from profiles p join bill2_runs b on b.id=$2 join runtime_executions e on e.billing_run_id=b.id
    join runtime_sessions s on s.id=e.session_id where p.id=$1`, [actor, admitted.runId])).rows[0];
  const pause = async () => {
    await db.query("update bill2_runs set runtime_dispatch_deadline=clock_timestamp()-interval '1 second' where id=$1", [admitted.runId]);
    const waiting = await runtimeExecutor(options).execute(admitted.executionId);
    expect(waiting).toMatchObject({ state: 'waiting_resume', remainingCalls: 0 });
    return { executionId: admitted.executionId, cursor: (waiting as { cursor: number }).cursor, epoch: (waiting as { epoch: number }).epoch };
  };
  const interrupted = async () => {
    const database = { rpc: (name: string, args: Record<string, unknown>) => name === 'runtime_execution' && args.p_action === 'complete'
      ? Promise.resolve({ data: null, error: { code: '57014' } }) : admin.rpc(name, args) };
    expect(await runtimeExecutor({ ...options, database }).execute(admitted.executionId)).toMatchObject({ state: 'pending' });
    expect(await snapshot()).toMatchObject({ credits: 94, ledger: 94, calls: 2, spends: 2, reserved: 0 });
  };
  return { db, admin, actor, admitted, rpc, options, requests, snapshot, pause, interrupted,
    close: async () => { await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); await db.end(); } };
}

it.each(['normal', 'committed-lost-response', 'not-committed', 'readback-fails'])
('RUNTIME: reliability finalize normal/ambiguous transaction %s', async mode => {
  const f = await fixture();
  try {
    let finalized = 0, failed = false;
    const database = { rpc: async (name: string, args: Record<string, unknown>) => {
      if (name === 'bill2_finalize') {
        finalized++;
        if (!failed && mode !== 'normal') {
          failed = true;
          if (mode !== 'not-committed') expect((await f.admin.rpc(name, args)).error).toBeNull();
          return { data: null, error: { code: '57014' } };
        }
      }
      if (failed && mode === 'readback-fails' && name === 'bill2_read') return { data: null, error: { code: '57014' } };
      return f.admin.rpc(name, args);
    } };
    const result = await runtimeExecutor({ ...f.options, database }).execute(f.admitted.executionId);
    if (mode === 'readback-fails') {
      expect(result).toMatchObject({ state: 'pending' }); expect(finalized).toBe(1);
      expect(await f.snapshot()).toMatchObject({ calls: 1, spends: 1, credits: 97, ledger: 97, reserved: 0, closed: false });
    } else {
      expect(result).toMatchObject({ state: 'completed', body: 'Saved primary answer', summary: 'Saved organizer summary' });
      expect(await f.snapshot()).toMatchObject({ calls: 2, spends: 2, credits: 94, ledger: 94, reserved: 0, execution_state: 'completed' });
      expect(finalized).toBe(mode === 'normal' ? 2 : 3);
      const before = await f.snapshot();
      const billing = authoritativeBilling({ admin: f.admin, actor: f.options.actor, adapter: { dispatch: vi.fn(), lookup: vi.fn() } });
      await Promise.all([billing.finalizeRun(f.admitted.runId), billing.finalizeRun(f.admitted.runId)]);
      expect(await f.snapshot()).toEqual(before);
    }
  } finally { await f.close(); }
}, 30000);

it('RUNTIME: reliability exhausted saved primary and organizer replay to completion without new calls', async () => {
  const f = await fixture();
  try {
    await f.interrupted(); const token = await f.pause(); const before = await f.snapshot();
    await expect(runtimeExecutor(f.options).execute(token.executionId, undefined, { ...token, epoch: token.epoch - 1 }))
      .rejects.toThrow('RUNTIME_RESUME_CONFLICT');
    const resumed = await runtimeExecutor(f.options).execute(token.executionId, undefined, token);
    expect(resumed).toMatchObject({ state: 'completed', body: 'Saved primary answer', summary: 'Saved organizer summary' });
    expect(f.requests).toHaveLength(2);
    expect(await f.snapshot()).toMatchObject({ credits: 94, ledger: 94, calls: 2, spends: 2,
      refunds: 0, compensation_credits: 0, reserved: 0, execution_state: 'completed', active_execution: null });
    expect((await f.snapshot()).charged).toBe(before.charged);
    expect(await runtimeExecutor(f.options).execute(token.executionId)).toMatchObject({ state: 'completed' });
    await expect(runtimeExecutor(f.options).execute(token.executionId, undefined, token)).rejects.toThrow('RUNTIME_RESUME_CONFLICT');
    expect(f.requests).toHaveLength(2);
  } finally { await f.close(); }
}, 30000);

it('RUNTIME: reliability exhausted unsent organizer compensates the platform failure once', async () => {
  const f = await fixture();
  try {
    let elapsed = 0; const budget = createRuntimeBudget(() => elapsed);
    const database = { rpc: async (name: string, args: Record<string, unknown>) => {
      const result = await f.admin.rpc(name, args);
      if (name === 'bill2_claim' && args.p_sequence === 2) elapsed = budget.workDeadline;
      return result;
    } };
    const waiting = await runtimeExecutor({ ...f.options, database, budget }).execute(f.admitted.executionId);
    expect(waiting).toMatchObject({ state: 'waiting_resume', remainingCalls: 0 });
    const token = { executionId: f.admitted.executionId, cursor: (waiting as { cursor: number }).cursor,
      epoch: (waiting as { epoch: number }).epoch };
    const result = await runtimeExecutor(f.options).execute(token.executionId, undefined, token);
    expect(result).toMatchObject({ state: 'cancelled', unavailable: 'preflight' });
    expect(await f.snapshot()).toMatchObject({ credits: 100, ledger: 100, calls: 2, compensation_credits: 3,
      reserved: 0, state: 'refunded', outcome: 'confirmed_failure', execution_state: 'cancelled', active_execution: null });
    const before = await f.snapshot();
    await Promise.all([runtimeExecutor(f.options).execute(token.executionId), runtimeExecutor(f.options).execute(token.executionId)]);
    await f.rpc('bill2_finalize', { p_actor_id: f.actor, p_run_id: f.admitted.runId });
    expect(await f.snapshot()).toEqual(before); expect(f.requests).toHaveLength(1);
  } finally { await f.close(); }
}, 30000);

it('RUNTIME: reliability exhausted resume keeps the old read contract and one concurrent owner', async () => {
  const f = await fixture();
  try {
    await f.interrupted(); const token = await f.pause();
    const resume = () => f.rpc('runtime_execution', { p_actor_id: f.actor, p_execution_id: token.executionId,
      p_action: 'payg_resume', p_result: { cursor: token.cursor, epoch: token.epoch } });
    const results = await Promise.allSettled([resume(), resume()]);
    const won = results.filter(r => r.status === 'fulfilled');
    expect(won).toHaveLength(1);
    expect(won[0]).toMatchObject({ value: { executionId: token.executionId, runId: f.admitted.runId,
      live: false, state: 'running', remainingCalls: 0, epoch: token.epoch + 1 } });
    expect(results.filter(r => r.status === 'rejected')[0]).toMatchObject({ reason: new Error('RUNTIME_RESUME_CONFLICT') });
    await expect(f.rpc('runtime_execution', { p_actor_id: f.actor, p_execution_id: token.executionId,
      p_action: 'fail_platform', p_result: { epoch: token.epoch, value: { unavailable_reason: 'preflight' } } }))
      .rejects.toThrow('RUNTIME_RESUME_CONFLICT');
    expect(await runtimeExecutor(f.options).execute(token.executionId)).toMatchObject({ state: 'completed' });
    expect(await f.snapshot()).toMatchObject({ calls: 2, credits: 94, ledger: 94, refunds: 0, reserved: 0 });
    expect(f.requests).toHaveLength(2);
  } finally { await f.close(); }
}, 30000);

it('RUNTIME: reliability finalize reentry serializes against concurrent cancellation', async () => {
  const f = await fixture();
  try {
    await f.interrupted(); let writes = 0;
    const database = { rpc: async (name: string, args: Record<string, unknown>) => {
      if (name === 'bill2_finalize' && ++writes === 1) {
        expect((await f.admin.rpc(name, args)).error).toBeNull(); return { data: null, error: { code: '57014' } };
      }
      const result = await f.admin.rpc(name, args);
      if (name === 'bill2_read') await f.rpc('runtime_cancel', { p_actor_id: f.actor, p_execution_id: f.admitted.executionId });
      return result;
    } };
    const api = authoritativeBilling({ admin: database, actor: f.options.actor, adapter: { dispatch: vi.fn(), lookup: vi.fn() } });
    expect(await api.finalizeRun(f.admitted.runId)).toMatchObject({ closed: true, state: 'settled' });
    expect(writes).toBe(2);
    expect(await f.snapshot()).toMatchObject({ credits: 94, ledger: 94, calls: 2, spends: 2, compensation_credits: 0,
      reserved: 0, outcome: 'cancelled', execution_state: 'cancelled' });
    expect(f.requests).toHaveLength(2);
  } finally { await f.close(); }
}, 30000);

it.each(['primary', 'organizer', 'terminal'] as const)
('RUNTIME: reliability exhausted invalid %s receipt crosses the real Runner and compensates once', async invalid => {
  const f = await fixture(invalid);
  try {
    const used = invalid === 'organizer' ? 2 : 1; let finalizers = 0;
    // Persist the supplier response/cost, then stop before the SDK's response validation.
    // A fresh process must classify that invalid saved reply through the real Runner wrapper.
    const database = { rpc: (name: string, args: Record<string, unknown>) => name === 'bill2_finalize' && ++finalizers === used
      ? Promise.resolve({ data: null, error: { code: '42501' } }) : f.admin.rpc(name, args) };
    expect(await runtimeExecutor({ ...f.options, database }).execute(f.admitted.executionId)).toMatchObject({ state: 'pending' });
    expect(await f.snapshot()).toMatchObject({ calls: used, credits: 100 - 3 * used, reserved: 0, closed: false });
    const token = await f.pause();
    expect(await runtimeExecutor(f.options).execute(token.executionId, undefined, token))
      .toMatchObject({ state: 'cancelled', unavailable: 'preflight' });
    expect(await f.snapshot()).toMatchObject({ credits: 100, ledger: 100, calls: used, compensation_credits: 3 * used,
      outcome: 'confirmed_failure', state: 'refunded', reserved: 0 });
    const before = await f.snapshot(); await runtimeExecutor(f.options).execute(token.executionId);
    expect(await f.snapshot()).toEqual(before); expect(f.requests).toHaveLength(used);
  } finally { await f.close(); }
}, 30000);
