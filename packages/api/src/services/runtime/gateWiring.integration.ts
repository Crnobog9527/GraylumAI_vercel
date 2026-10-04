/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeAll, afterAll, afterEach, it, expect, vi } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import { runtimeExecutor } from './execute';
import { openRouterAdapter } from '../bill2/openRouterAdapter';
import { allowAllModeration } from './moderation';
import type { RuntimeCallGate } from './newWorkGate';
const connectionString = process.env.V3_LOCAL_DB!;
if (!connectionString?.startsWith('postgres://postgres@127.0.0.1:') || !connectionString.endsWith('/v3_disposable')) {
  throw new Error('isolated runner required');
}
const db = new pg.Client({ connectionString });
const admin = createClient(process.env.V3_LOCAL_REST!, process.env.V3_LOCAL_SERVICE_JWT!, { auth: { persistSession: false } });
beforeAll(() => db.connect());
afterAll(() => db.end());
afterEach(() => vi.restoreAllMocks());
async function rpc(name: string, args: Record<string, unknown>) {
  const result = await admin.rpc(name, args); if (result.error) throw new Error(result.error.message); return result.data;
}
async function fixture() {
  const actorId = randomUUID(), modelId = randomUUID(), organizerId = randomUUID(), windowId = randomUUID();
  await db.query('insert into profiles(id,credits) values($1,100)', [actorId]);
  await db.query("insert into credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,idempotency_key," +
    "balance_before,balance_after) values($1,100,'addition','grant','opening_grant','system',$2,0,100)", [actorId, 'opening:' + actorId]);
  const policies = [[modelId, 'synthetic/gate-primary'], [organizerId, 'synthetic/gate-organizer']].map(([modelId, model]) => ({
    modelId, model, provider: 'openrouter', account: 'synthetic', protocol: 'openrouter-chat-v1', upperUsd: '0.02',
    inputLimit: 10000, outputLimit: 100, automaticRetry: false, hiddenTools: false, lookupSupported: true,
    providerLimits: { providerSlug: 'synthetic', contextTokens: 10000, promptUsdPerMillion: '2', completionUsdPerMillion: '0', requestUsd: '0' },
  }));
  for (const policy of policies) await db.query(
    "insert into ai_models(id,name,model_id,provider,is_active) values($1,'Synthetic gate',$2,'openrouter','true')", [policy.modelId, policy.model]);
  await db.query("insert into runtime_test_windows(id,enabled,actor_ids,call_policies,credits_per_usd,multiplier," +
    "max_cost_usd,max_calls,expires_at) values($1,true,$2,$3,1000,1,0.04,2,now()+interval '2 hours')",
  [windowId, [actorId], JSON.stringify(policies)]);
  const session = await rpc('runtime_start', { p_actor_id: actorId, p_request_id: randomUUID(), p_payload: { scope: { kind: 'positioning_draft' } } });
  async function admit() {
    const requestId = randomUUID();
    const context = { version: 'runtime.v1', sdkVersion: '0.18.0', role: 'ordinary', input: 'Synthetic input', instructions: 'Answer',
      model: policies[0].model, maxOutputTokens: 100, maxTurns: 1, historyItems: 0, network: 'deny', tools: [],
      providerRequestFormat: 'serial-tools-v2', inputSelection: 'scope-projection-v1', request: { sessionId: session.sessionId, requestId },
      attachedOrganizer: { modelId: organizerId, model: policies[1].model, maxOutputTokens: 100 } };
    const billing = { contractVersion: 'bill2.v1', mode: 'staging_test', testWindowId: windowId, scope: session.scope,
      operation: 'question', modelId, sourceHash: createHash('sha256').update(JSON.stringify(context)).digest('hex'), input: context,
      callPolicy: policies, rules: { version: 'runtime-staging-v1', quoteVersion: windowId, creditsPerUsd: '1000', multiplier: '1', fx: {} },
      limits: { costUsd: '0.04', credits: 40, maxPreDeduct: 40, maxCalls: 2, deadline: new Date(Date.now() + 3600000).toISOString() } };
    return rpc('runtime_admit', { p_actor_id: actorId, p_session_id: session.sessionId, p_request_id: requestId,
      p_payload: context, p_billing: billing });
  }
  const transport = vi.fn<typeof fetch>(async (_url, init) => {
    const model = JSON.parse(String(init?.body)).model;
    return new Response(JSON.stringify({ id: 'gen-gate-' + randomUUID(), object: 'chat.completion', created: 1, model,
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Synthetic reply' } }],
      usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7, cost: 0.003 } }));
  });
  const adapter = openRouterAdapter({ credential: async () => 'SYNTHETIC', transport });
  const host = (callGate: RuntimeCallGate) => runtimeExecutor({ database: admin, actor: async () => actorId, adapter, callGate });
  return { actorId, admit, transport, host };
}
it.each(['call_limited', 'paused', 'limit_unavailable'] as const)('RUNTIME: %s before first claim refunds fully and releases the session', async reason => {
  const f = await fixture(), execution = await f.admit();
  const gate = vi.fn<RuntimeCallGate>().mockResolvedValue({ ok: false, reason, retryAfter: 60 });
  expect(await f.host(gate).execute(execution.executionId)).toEqual({ state: 'cancelled', unavailable: reason });
  expect(gate).toHaveBeenCalledExactlyOnceWith(f.actorId, 2, 'bill2.v1'); expect(f.transport).not.toHaveBeenCalled();
  expect((await db.query('select count(*)::int n from bill2_calls where run_id=$1', [execution.runId])).rows[0].n).toBe(0);
  expect((await db.query('select credits from profiles where id=$1', [f.actorId])).rows[0].credits).toBe(100);
  const run = (await db.query('select charged,actual_restore from bill2_runs where id=$1', [execution.runId])).rows[0];
  expect(run).toEqual({ charged: 0, actual_restore: 40 });
  const next = await f.admit();
  await f.host(gate).cancel(next.executionId);
});
it('RUNTIME: a started primary+organizer finishes and replay never counts or checks output again', async () => {
  const f = await fixture(), execution = await f.admit();
  const gate = vi.fn<RuntimeCallGate>().mockResolvedValueOnce({ ok: true })
    .mockResolvedValue({ ok: false, reason: 'paused', retryAfter: 60 });
  const output = vi.spyOn(allowAllModeration, 'checkOutput');
  const host = f.host(gate), result = await host.execute(execution.executionId);
  expect(result).toMatchObject({ state: 'completed', body: 'Synthetic reply', summary: 'Synthetic reply' });
  expect(await host.execute(execution.executionId)).toEqual(result);
  expect(gate).toHaveBeenCalledExactlyOnceWith(f.actorId, 2, 'bill2.v1'); expect(output).toHaveBeenCalledTimes(1);
  expect(f.transport).toHaveBeenCalledTimes(2);
  expect((await db.query('select credits from profiles where id=$1', [f.actorId])).rows[0].credits).toBe(94);
});
it.each(['block', 'throw'])('RUNTIME: output moderation %s uses cancellation and keeps paid receipts', async mode => {
  const f = await fixture(), execution = await f.admit();
  const check = vi.spyOn(allowAllModeration, 'checkOutput');
  if (mode === 'block') check.mockResolvedValue({ action: 'block', category: 'synthetic' });
  else check.mockRejectedValue(new Error('Synthetic moderation failure'));
  expect(await f.host(async () => ({ ok: true })).execute(execution.executionId)).toEqual({ state: 'cancelled' });
  expect(f.transport).toHaveBeenCalledTimes(2);
  expect((await db.query('select credits from profiles where id=$1', [f.actorId])).rows[0].credits).toBe(94);
  expect((await db.query('select count(*)::int n from bill2_calls where run_id=$1', [execution.runId])).rows[0].n).toBe(2);
});
