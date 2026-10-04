/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import { expect, it, vi } from 'vitest';
import { finishWaitingOrganizer } from './waitingOrganizer';
import { runtimeExecutor } from './execute';

it('RUNTIME: PAYG SDK organizer waits and original cursor resumes without duplicate primary charges or session items', async () => {
  const connectionString = process.env.V3_LOCAL_DB;
  if (!connectionString?.startsWith('postgres://postgres@127.0.0.1:')
    || !connectionString.endsWith('/v3_disposable')) throw new Error('isolated runner required');
  const db = new pg.Client({ connectionString });
  const admin = createClient(process.env.V3_LOCAL_REST!, process.env.V3_LOCAL_SERVICE_JWT!,
    { auth: { persistSession: false } });
  const rpc = async (name: string, args: Record<string, unknown>) => {
    const result = await admin.rpc(name, args);
    if (result.error) throw new Error(result.error.message);
    return result.data;
  };
  const actor = randomUUID(), primary = randomUUID(), organizer = randomUUID();
  const model = 'payg-sdk-' + primary, summaryModel = 'payg-sdk-' + organizer;
  const requests: Array<{ model: string }> = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const input = JSON.parse(JSON.parse(raw).input);
    requests.push(input);
    const id = 'payg-sdk-' + randomUUID();
    const content = input.model === model ? 'Preserved primary result' : 'Organized primary result';
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id, model: input.model, final: true, cost: '0.003', currency: 'USD',
      coverage: 'request_total', usage: { inputTokens: 3000, outputTokens: 4, sdkResponse: { id, object: 'chat.completion', created: 1,
        model: input.model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3000, completion_tokens: 4, total_tokens: 3004 } } } }));
  });
  await db.connect();
  try {
    await db.query('insert into profiles(id,credits) values($1,100)', [actor]);
    await db.query(`insert into credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,
      idempotency_key,balance_before,balance_after) values($1,100,'addition','grant','opening_grant','system',$2,0,100)`,
    [actor, 'payg-sdk-opening:' + actor]);
    for (const [id, name] of [[primary, model], [organizer, summaryModel]]) {
      await db.query(`insert into ai_models(id,model_id,name,provider,is_active)
        values($1,$2,'Local PAYG SDK','fixture',true)`, [id, name]);
    }
    const pricingHash = 'a'.repeat(64), endpointTag = 'fixture/exact';
    const policies = [[primary, model], [organizer, summaryModel]].map(([modelId, name]) => ({
      modelId, model: name, provider: 'fixture', account: 'sandbox', protocol: 'fixture-cost-v1',
      upperUsd: '0.1', multiplier: '1', inputLimit: 32000, outputLimit: 1000,
      automaticRetry: false, hiddenTools: false, lookupSupported: false,
      providerLimits: { providerSlug: endpointTag, contextTokens: 100000,
        promptUsdPerMillion: '1', completionUsdPerMillion: '0', requestUsd: '0' },
      payg: { version: 'v1', policyId: 'payg-sdk', profileVersion: 'local-v1', evidenceVersion: 'local-v1',
        pricingHash, endpointTag, templateTokens: 4096, marginTokens: 4096, admissionPath: 'fixture',
        maxBytes: 32000, maxMessages: 32, maxTools: 2, maxSchemaBytes: 16384,
        purposes: ['ordinary', 'attached_organizer'], expiresAt: new Date(Date.now() + 3600000).toISOString(),
        nominalPricing: { version: 'nominal-v1', pricingHash, endpointTag,
          tiers: [{ minPromptTokens: 0, prompt: '1', completion: '0', request: '0' }], timeOfDay: [] } },
    }));
    await db.query(`insert into system_settings(key,value) values('billing_payg_start_thresholds',$1::jsonb)
      on conflict(key) do update set value=jsonb_set(system_settings.value,'{thresholds}',
      coalesce(system_settings.value->'thresholds','[]')||(excluded.value->'thresholds'))`,
    [{ version: 'local-v1', thresholds: [
      { model, purpose: 'ordinary', credits: 1 },
      { model: summaryModel, purpose: 'attached_organizer', credits: 100 },
    ] }]);
    const session = await rpc('runtime_start', { p_actor_id: actor, p_request_id: randomUUID(),
      p_payload: { scope: { kind: 'positioning_draft' } } });
    const requestId = randomUUID();
    const context = { version: 'runtime.v1', sdkVersion: '0.18.0', role: 'ordinary', input: 'Answer and organize',
      instructions: 'Synthetic local response', model, maxOutputTokens: 1000, maxTurns: 1,
      historyItems: 0, tools: [], sources: [], network: 'deny', request: { sessionId: session.sessionId, requestId },
      attachedOrganizer: { modelId: organizer, model: summaryModel, maxOutputTokens: 1000 } };
    const billing = { contractVersion: 'bill2.v2', mode: 'isolated', scope: session.scope, operation: 'question',
      modelId: primary, sourceHash: 'b'.repeat(64), input: context, callPolicy: policies,
      rules: { version: 'v1', quoteVersion: 'local-v1', creditsPerUsd: '1000', multiplier: '1', fx: {},
        billingUnit: { version: 'bill-unit-v2', creditsPerUsd: '1000', defaultMultiplier: '1', hash: 'f'.repeat(64),
          providers: {}, models: { [primary]: { multiplier: '1', source: 'global' },
            [organizer]: { multiplier: '1', source: 'global' } } } },
      limits: { costUsd: '0.2', credits: 0, maxPreDeduct: 0, maxCalls: 2,
        deadline: new Date(Date.now() + 3600000).toISOString() } };
    const admitted = await rpc('runtime_admit', { p_actor_id: actor, p_session_id: session.sessionId,
      p_request_id: requestId, p_payload: context, p_billing: billing });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('local server required');
    const gate = vi.fn(async (verifiedActor: string, calls: number) => {
      expect(verifiedActor).toBe(actor); expect(calls).toBeGreaterThan(0); return { ok: true as const };
    });
    const host = runtimeExecutor({ database: admin, actor: async () => actor, callGate: gate,
      endpoint: 'http://127.0.0.1:' + address.port });
    const waiting = await host.execute(admitted.executionId);
    expect(waiting).toMatchObject({ state: 'waiting_credits', code: 'RUNTIME_WAITING_CREDITS',
      executionId: admitted.executionId, cursor: 1, epoch: 1, remainingCalls: 1, body: 'Preserved primary result' });
    expect(requests.map(r => r.model)).toEqual([model]);
    expect(await host.execute(admitted.executionId)).toEqual(waiting);
    const history = async () => (await db.query(
      'select item from runtime_session_history where session_id=$1 order by revision', [session.sessionId])).rows;
    const savedHistory = await history();
    expect(savedHistory.length).toBeGreaterThanOrEqual(2);
    expect(savedHistory.length).toBeLessThanOrEqual(3);
    expect((await db.query('select credits from profiles where id=$1', [actor])).rows[0].credits).toBe(97);
    // Q1: the next user message first attempts the original organizer. Low
    // credits retain both requests without another admission or primary call.
    const nextRequestId = randomUUID();
    const blockedContext={...context,request:{sessionId:session.sessionId,requestId:nextRequestId}};
    await expect(rpc('runtime_admit',{p_actor_id:actor,p_session_id:session.sessionId,
      p_request_id:nextRequestId,p_payload:blockedContext,p_billing:{...billing,input:blockedContext}}))
      .rejects.toThrow('RUNTIME_ORGANIZER_PENDING');
    // Exact original admission replay is still allowed before the pending guard.
    expect(await rpc('runtime_admit',{p_actor_id:actor,p_session_id:session.sessionId,
      p_request_id:requestId,p_payload:context,p_billing:billing})).toMatchObject({executionId:admitted.executionId});
    expect(await rpc('runtime_admission_replay',{p_actor_id:actor,p_request_id:requestId,p_request:context.request}))
      .toMatchObject({executionId:admitted.executionId});
    const sessionContext = () => rpc('runtime_session_context', {p_actor_id:actor,p_session_id:session.sessionId});
    const resumeOrganizer = (token: {executionId:string;cursor:number;epoch:number}) =>
      host.execute(token.executionId, undefined, token);
    expect(await finishWaitingOrganizer(await sessionContext(),nextRequestId,resumeOrganizer)).toMatchObject({
      admitted:false,blockedRequestId:nextRequestId,executionId:admitted.executionId,state:'waiting_credits',cursor:2,epoch:2,
    });
    expect(requests.map(r => r.model)).toEqual([model]);
    expect((await db.query('select count(*)::int n from runtime_executions where session_id=$1',
      [session.sessionId])).rows[0].n).toBe(1);
    // Synthetic local grant keeps the fixture ledger balanced; no payment provider is involved.
    await db.query(`insert into credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,
      idempotency_key,balance_before,balance_after) values($1,100,'addition','grant','opening_grant','system',$2,97,197)`,
    [actor, 'payg-sdk-resume:' + actor]);
    await db.query('update profiles set credits=197 where id=$1', [actor]);
    expect(await finishWaitingOrganizer(await sessionContext(),nextRequestId,resumeOrganizer)).toBeNull();
    const completed = await host.execute(admitted.executionId);
    expect(completed).toMatchObject({ state: 'completed', body: 'Preserved primary result',
      summary: 'Organized primary result' });
    const completedHistory = await history();
    expect(completedHistory).toHaveLength(4);
    expect(completedHistory.slice(0, 2)).toEqual(savedHistory.slice(0, 2));
    expect(await host.execute(admitted.executionId)).toEqual(completed);
    expect(requests.map(r => r.model)).toEqual([model, summaryModel]);
    expect(gate.mock.calls.map(call => call[1])).toEqual([2, 1, 1]);
    expect(await history()).toEqual(completedHistory);
    expect((await db.query(`select count(*)::int n,sum(charged_delta)::int charged
      from bill2_calls where run_id=$1`, [admitted.runId])).rows[0]).toEqual({ n: 2, charged: 6 });
    expect((await db.query(`select credits,(select sum(amount)::int from credit_transactions where user_id=$1) ledger
      from profiles where id=$1`, [actor])).rows[0]).toEqual({ credits: 194, ledger: 194 });
    // Only after the original organization completed may the same blocked
    // request ID admit the next user message. The SDK order proves no primary replay.
    const nextContext={...context,input:'Next user message',attachedOrganizer:undefined,
      request:{sessionId:session.sessionId,requestId:nextRequestId}};
    const next=await rpc('runtime_admit',{p_actor_id:actor,p_session_id:session.sessionId,
      p_request_id:nextRequestId,p_payload:nextContext,p_billing:{...billing,input:nextContext}});
    expect(next.executionId).not.toBe(admitted.executionId);
    expect(await host.execute(next.executionId)).toMatchObject({state:'completed',body:'Preserved primary result'});
    expect(requests.map(r=>r.model)).toEqual([model,summaryModel,model]);
  } finally {
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
    await db.end();
  }
}, 30000);
