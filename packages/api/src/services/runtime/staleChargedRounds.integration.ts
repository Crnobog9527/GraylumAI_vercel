/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { runtimeExecutor } from './execute';
import { findStaleChargedRounds, STALE_ROUND_AGE_MS } from './staleChargedRounds';

// The daily reconciliation runs as service_role through PostgREST; this test uses exactly that
// identity (never the database owner) so table and function grants are part of what is verified.
const connectionString = process.env.V3_LOCAL_DB!;
if (!connectionString?.startsWith('postgres://postgres@127.0.0.1:') || !connectionString.endsWith('/v3_disposable'))
  throw new Error('isolated runner required');
const db = new pg.Client({ connectionString });
const service = createClient(process.env.V3_LOCAL_REST!, process.env.V3_LOCAL_SERVICE_JWT!, { auth: { persistSession: false } });
const anon = createClient(process.env.V3_LOCAL_REST!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
const server = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const input = JSON.parse(JSON.parse(raw).input), id = 'stale-round-' + randomUUID();
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ id, model: input.model, final: true, cost: '0.003', currency: 'USD', coverage: 'request_total',
    usage: { inputTokens: 3000, outputTokens: 4, sdkResponse: { id, object: 'chat.completion', created: 1, model: input.model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'Primary result' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3000, completion_tokens: 4, total_tokens: 3004 } } } }));
});
let endpoint = '';
beforeAll(async () => {
  await db.connect();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('local server required');
  endpoint = 'http://127.0.0.1:' + address.port;
});
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await db.end(); });
const rpc = async (name: string, args: Record<string, unknown>) => {
  const result = await service.rpc(name, args);
  if (result.error) throw new Error(result.error.message);
  return result.data;
};

/** A real PAYG round charged 3 credits for its primary call, then left open (no answer delivered). */
async function chargedOpenRound(ageMs: number) {
  const actor = randomUUID(), primary = randomUUID(), organizer = randomUUID();
  const model = 'stale-round-' + primary, summaryModel = 'stale-round-' + organizer;
  await db.query('insert into profiles(id,credits) values($1,100)', [actor]);
  await db.query(`insert into credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,
    idempotency_key,balance_before,balance_after) values($1,100,'addition','grant','opening_grant','system',$2,0,100)`,
  [actor, 'stale-round-opening:' + actor]);
  for (const [id, name] of [[primary, model], [organizer, summaryModel]])
    await db.query(`insert into ai_models(id,model_id,name,provider,is_active) values($1,$2,'Stale round','fixture',true)`, [id, name]);
  const pricingHash = 'a'.repeat(64), endpointTag = 'fixture/exact';
  const policies = [[primary, model], [organizer, summaryModel]].map(([modelId, name]) => ({
    modelId, model: name, provider: 'fixture', account: 'sandbox', protocol: 'fixture-cost-v1', upperUsd: '0.1', multiplier: '1',
    inputLimit: 32000, outputLimit: 1000, automaticRetry: false, hiddenTools: false, lookupSupported: false,
    providerLimits: { providerSlug: endpointTag, contextTokens: 100000, promptUsdPerMillion: '1', completionUsdPerMillion: '0', requestUsd: '0' },
    payg: { version: 'v1', policyId: 'stale-round', profileVersion: 'local-v1', evidenceVersion: 'local-v1', pricingHash, endpointTag,
      templateTokens: 4096, marginTokens: 4096, admissionPath: 'fixture', maxBytes: 32000, maxMessages: 32, maxTools: 2,
      maxSchemaBytes: 16384, purposes: ['ordinary', 'attached_organizer'], expiresAt: new Date(Date.now() + 3600000).toISOString(),
      nominalPricing: { version: 'nominal-v1', pricingHash, endpointTag,
        tiers: [{ minPromptTokens: 0, prompt: '1', completion: '0', request: '0' }], timeOfDay: [] } },
  }));
  // The organizer threshold (100) exceeds the 97 credits left, so the round stays open after one charge.
  await db.query(`insert into system_settings(key,value) values('billing_payg_start_thresholds',$1::jsonb)
    on conflict(key) do update set value=jsonb_set(system_settings.value,'{thresholds}',
    coalesce(system_settings.value->'thresholds','[]')||(excluded.value->'thresholds'))`,
  [{ version: 'local-v1', thresholds: [{ model, purpose: 'ordinary', credits: 1 },
    { model: summaryModel, purpose: 'attached_organizer', credits: 100 }] }]);
  const session = await rpc('runtime_start', { p_actor_id: actor, p_request_id: randomUUID(),
    p_payload: { scope: { kind: 'positioning_draft' } } });
  const context = { version: 'runtime.v1', sdkVersion: '0.18.0', role: 'ordinary', input: 'Answer and organize',
    instructions: 'Synthetic local response', model, maxOutputTokens: 1000, maxTurns: 1, historyItems: 0, tools: [], sources: [],
    network: 'deny', request: { sessionId: session.sessionId, requestId: randomUUID() },
    attachedOrganizer: { modelId: organizer, model: summaryModel, maxOutputTokens: 1000 } };
  const billing = { contractVersion: 'bill2.v2', mode: 'isolated', scope: session.scope, operation: 'question',
    modelId: primary, sourceHash: 'b'.repeat(64), input: context, callPolicy: policies,
    rules: { version: 'v1', quoteVersion: 'local-v1', creditsPerUsd: '1000', multiplier: '1', fx: {},
      billingUnit: { version: 'bill-unit-v2', creditsPerUsd: '1000', defaultMultiplier: '1', hash: 'f'.repeat(64), providers: {},
        models: { [primary]: { multiplier: '1', source: 'global' }, [organizer]: { multiplier: '1', source: 'global' } } } },
    limits: { costUsd: '0.2', credits: 0, maxPreDeduct: 0, maxCalls: 2, deadline: new Date(Date.now() + 3600000).toISOString() } };
  const admitted = await rpc('runtime_admit', { p_actor_id: actor, p_session_id: session.sessionId,
    p_request_id: context.request.requestId, p_payload: context, p_billing: billing });
  const host = runtimeExecutor({ database: service, actor: async () => actor, callGate: async () => ({ ok: true as const }), endpoint });
  expect(await host.execute(admitted.executionId)).toMatchObject({ state: 'waiting_credits' });
  // The round fails on our side and is left interrupted, as an unclassified exception leaves it.
  await db.query("update runtime_executions set state='interrupted',created_at=now()-($2::bigint*interval '1 millisecond') where id=$1",
    [admitted.executionId, ageMs]);
  return { actor, executionId: admitted.executionId as string, runId: admitted.runId as string };
}
const reported = async (limit = 100) => rpc('runtime_stale_charged_rounds',
  { p_cutoff: new Date(Date.now() - STALE_ROUND_AGE_MS).toISOString(), p_limit: limit }) as Promise<{
    total: number; rounds: Array<{ executionId: string; runId: string; chargedCredits: number }> }>;
const ids = (report: { rounds: Array<{ runId: string }> }) => report.rounds.map(round => round.runId);

it('RUNTIME: service_role reads stale charged rounds only through the report function', async () => {
  const stale = await chargedOpenRound(2 * STALE_ROUND_AGE_MS), recent = await chargedOpenRound(0);
  // The direct table read the first version used is denied to service_role.
  expect((await service.from('runtime_executions').select('id').limit(1)).error).toBeTruthy();
  expect((await anon.rpc('runtime_stale_charged_rounds', { p_cutoff: new Date().toISOString(), p_limit: 1 })).error).toBeTruthy();
  const report = await reported();
  expect(report.rounds).toContainEqual(expect.objectContaining({ executionId: stale.executionId, runId: stale.runId, chargedCredits: 3 }));
  expect(ids(report)).not.toContain(recent.runId);
  const live = await findStaleChargedRounds(service);
  expect(live.findings).toContainEqual(expect.objectContaining({ runId: stale.runId, refundMarker: 'stale-round:' + stale.runId }));
  expect(live.success).toBe(false);
  await expect(rpc('runtime_stale_charged_rounds', { p_cutoff: new Date(Date.now() + 60000).toISOString(), p_limit: 1 }))
    .rejects.toThrow('STALE_ROUND_CUTOFF_INVALID');
  await expect(rpc('runtime_stale_charged_rounds', { p_cutoff: new Date().toISOString(), p_limit: 501 }))
    .rejects.toThrow('STALE_ROUND_LIMIT_INVALID');
}, 60000);

it('RUNTIME: only marked refunds covering the charge, or an unknown call, remove a round from the report', async () => {
  const refunded = await chargedOpenRound(2 * STALE_ROUND_AGE_MS), unknown = await chargedOpenRound(2 * STALE_ROUND_AGE_MS);
  expect(ids(await reported())).toEqual(expect.arrayContaining([refunded.runId, unknown.runId]));
  // Exactly what admin.adjustUserCredits sends: `[Admin] <reason>`, the reason carrying the marker.
  const refund = (amount: number) => rpc('atomic_apply_credit_ledger_entry', { p_user_id: refunded.actor, p_amount: amount,
    p_type: 'addition', p_description: '[Admin] stale-round:' + refunded.runId + ' 系统原因未完成回合退款' });
  await refund(1);
  // A partial refund keeps the round reported with what is still owed.
  expect((await reported()).rounds).toContainEqual(expect.objectContaining({ runId: refunded.runId,
    chargedCredits: 3, refundedCredits: 1, outstandingCredits: 2 }));
  await refund(2);
  // A dispatched call without a settlement belongs to financial recovery, not to this report.
  await db.query('update bill2_calls set settled_at=null where run_id=$1', [unknown.runId]);
  const after = ids(await reported());
  expect(after).not.toContain(refunded.runId);
  expect(after).not.toContain(unknown.runId);
}, 60000);

it('RUNTIME: every filter applies before the limit and total counts all matches', async () => {
  const first = await chargedOpenRound(3 * STALE_ROUND_AGE_MS), second = await chargedOpenRound(3 * STALE_ROUND_AGE_MS);
  const all = await reported(500);
  expect(ids(all)).toEqual(expect.arrayContaining([first.runId, second.runId]));
  const page = await reported(1);
  expect(page.total).toBe(all.total);
  expect(page.rounds).toHaveLength(1);
  expect(page.rounds[0]).toEqual(all.rounds[0]);
}, 60000);
