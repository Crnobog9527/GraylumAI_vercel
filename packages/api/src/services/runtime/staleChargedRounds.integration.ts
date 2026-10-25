/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { runtimeExecutor } from './execute';
import { autoCompensateStaleRounds, compensateStaleRound, findStaleChargedRounds, STALE_ROUND_AGE_MS } from './staleChargedRounds';
import { runAutomaticFinancialRecovery } from './automaticRecovery';
import { overlap } from '../__tests__/fixtures/planBConcurrency';

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
  // The round fails on our side and is left interrupted, as an unclassified exception leaves it:
  // no pause of its own (the fixture's credit wait is cleared), an earlier call already charged.
  await db.query("update runtime_executions set state='interrupted',created_at=now()-($2::bigint*interval '1 millisecond') where id=$1",
    [admitted.executionId, ageMs]);
  await db.query('update bill2_runs set paused_reason=null,runtime_dispatch_deadline=null where id=$1', [admitted.runId]);
  // Its calls happened back then too: the round has been quiet since.
  await db.query(`update bill2_calls set created_at=created_at-($2::bigint*interval '1 millisecond'),
    dispatched_at=dispatched_at-($2::bigint*interval '1 millisecond'),settled_at=settled_at-($2::bigint*interval '1 millisecond')
    where run_id=$1`, [admitted.runId, ageMs]);
  return { actor, host, sessionId: session.sessionId as string, executionId: admitted.executionId as string,
    runId: admitted.runId as string };
}
const reported = async (limit = 100) => rpc('runtime_stale_charged_rounds',
  { p_cutoff: new Date(Date.now() - STALE_ROUND_AGE_MS).toISOString(), p_limit: limit }) as Promise<{
    total: number; rounds: Array<{ executionId: string; runId: string; chargedCredits: number; evidence: Record<string, unknown> }> }>;
const ids = (report: { rounds: Array<{ runId: string }> }) => report.rounds.map(round => round.runId);

it('RUNTIME: service_role reads stale charged rounds only through the report function', async () => {
  const stale = await chargedOpenRound(2 * STALE_ROUND_AGE_MS), recent = await chargedOpenRound(0);
  // The direct table read the first version used is denied to service_role.
  expect((await service.from('runtime_executions').select('id').limit(1)).error).toBeTruthy();
  expect((await anon.rpc('runtime_stale_charged_rounds', { p_cutoff: new Date().toISOString(), p_limit: 1 })).error).toBeTruthy();
  const report = await reported();
  expect(report.rounds).toContainEqual(expect.objectContaining({ executionId: stale.executionId, runId: stale.runId,
    actorId: stale.actor, chargedCredits: 3 }));
  // Content-free review evidence: the fixture's primary call returned 4 output tokens and saved its reply.
  expect(report.rounds.find(round => round.runId === stale.runId)).toMatchObject({ evidence: {
    streamed: false, executionState: 'interrupted', unavailableReason: null, calls: 1, outputTokens: 4,
    savedReplyChars: 'Primary result'.length, lastFinishReason: 'stop' } });
  expect(ids(report)).not.toContain(recent.runId);
  const live = await findStaleChargedRounds(service);
  expect(live.findings).toContainEqual(expect.objectContaining({ kind: 'stale_charged_round', runId: stale.runId, chargedCredits: 3 }));
  expect(live.success).toBe(false);
  await expect(rpc('runtime_stale_charged_rounds', { p_cutoff: new Date(Date.now() + 60000).toISOString(), p_limit: 1 }))
    .rejects.toThrow('STALE_ROUND_CUTOFF_INVALID');
  await expect(rpc('runtime_stale_charged_rounds', { p_cutoff: new Date(Date.now() - 60_000).toISOString(), p_limit: 501 }))
    .rejects.toThrow('STALE_ROUND_LIMIT_INVALID');
}, 60000);

const ledger = async (round: { actor: string; runId: string; executionId: string; sessionId: string }) => (await db.query(`select
  p.credits,(select sum(amount)::int from credit_transactions where user_id=$1) ledger,
  (select count(*)::int from credit_transactions where user_id=$1 and reason_code='bill2_compensation') compensations,
  r.state run_state,r.closed,r.outcome,r.compensation_credits,e.state execution_state,e.unavailable_reason,s.active_execution
  from profiles p,bill2_runs r,runtime_executions e,runtime_sessions s where p.id=$1 and r.id=$2 and e.id=$3 and s.id=$4`,
[round.actor, round.runId, round.executionId, round.sessionId])).rows[0];

it('RUNTIME: operator compensation closes the round once; repeat, retry and fail_platform never refund again', async () => {
  const round = await chargedOpenRound(2 * STALE_ROUND_AGE_MS);
  expect(await ledger(round)).toMatchObject({ credits: 97, ledger: 97, compensations: 0, closed: false });
  expect(await compensateStaleRound(service, round.runId)).toMatchObject({ state: 'compensated', runId: round.runId,
    executionId: round.executionId, actorId: round.actor, executionState: 'cancelled', compensatedCredits: 3 });
  const after = await ledger(round);
  expect(after).toEqual({ credits: 100, ledger: 100, compensations: 1, run_state: 'refunded', closed: true,
    outcome: 'confirmed_failure', compensation_credits: 3, execution_state: 'cancelled',
    unavailable_reason: 'platform_review', active_execution: null });
  expect(ids(await reported())).not.toContain(round.runId);
  // A repeated click reports the original outcome without another refund.
  expect(await compensateStaleRound(service, round.runId)).toMatchObject({ state: 'already_compensated', compensatedCredits: 3 });
  // The user retries the round: it is finished and says it was not charged.
  expect(await round.host.execute(round.executionId)).toEqual({ state: 'cancelled', unavailable: 'platform_review' });
  // A late automatic platform failure for the same round is refused.
  const epoch = Number((await db.query('select runtime_epoch from bill2_runs where id=$1', [round.runId])).rows[0].runtime_epoch);
  await expect(db.query('select public.runtime_execution($1,$2,$3,$4)', [round.actor, round.executionId, 'fail_platform',
    { epoch, value: { unavailable_reason: 'provider_history' } }])).rejects.toThrow();
  await expect(db.query('select public.bill2_finalize($1,$2)', [round.actor, round.runId])).resolves.toBeTruthy();
  expect(await ledger(round)).toEqual(after);
}, 60000);

it('RUNTIME: two concurrent compensations refund once', async () => {
  const round = await chargedOpenRound(2 * STALE_ROUND_AGE_MS);
  const cutoff = new Date(Date.now() - STALE_ROUND_AGE_MS).toISOString();
  const call = (client: pg.Client) => client.query('select public.runtime_stale_round_compensate($1,$2) value', [round.runId, cutoff])
    .then(result => result.rows[0].value);
  // The barrier takes the first lock of the function's order (Session, execution, run).
  const race = await overlap(db, connectionString, 'select id from runtime_sessions where id=$1 for update', [round.sessionId], call, call);
  expect(race.value).toMatchObject({ state: 'compensated', compensatedCredits: 3 });
  expect(race.other).toMatchObject({ ok: true, value: { state: 'already_compensated', compensatedCredits: 3 } });
  expect(await ledger(round)).toMatchObject({ credits: 100, ledger: 100, compensations: 1, run_state: 'refunded' });
}, 60000);

it('RUNTIME: compensation refuses rounds that are not eligible and changes nothing', async () => {
  const recent = await chargedOpenRound(0), stopped = await chargedOpenRound(2 * STALE_ROUND_AGE_MS);
  const unknown = await chargedOpenRound(2 * STALE_ROUND_AGE_MS), unfunded = await chargedOpenRound(2 * STALE_ROUND_AGE_MS);
  await db.query("update bill2_runs set paused_reason='user_stop' where id=$1", [stopped.runId]);
  // A balance shortage left before waiting_credits was saved is user-side too.
  await db.query("update bill2_runs set paused_reason='insufficient_credits' where id=$1", [unfunded.runId]);
  // A dispatched call without a settlement belongs to financial recovery.
  await db.query('update bill2_calls set settled_at=null where run_id=$1', [unknown.runId]);
  const reportIds = ids(await reported());
  for (const round of [recent, stopped, unknown, unfunded]) {
    expect(reportIds).not.toContain(round.runId);
    const before = await ledger(round);
    await expect(compensateStaleRound(service, round.runId)).rejects.toThrow('STALE_ROUND_NOT_ELIGIBLE');
    expect(await ledger(round)).toEqual(before);
  }
  await expect(compensateStaleRound(service, randomUUID())).rejects.toThrow('STALE_ROUND_NOT_FOUND');
  expect((await anon.rpc('runtime_stale_round_compensate',
    { p_run_id: recent.runId, p_cutoff: new Date().toISOString() })).error).toBeTruthy();
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

it('RUNTIME: a cost-pending round whose last unknown call was settled is reported and compensated', async () => {
  const round = await chargedOpenRound(2 * STALE_ROUND_AGE_MS);
  // Receipt recovery settled the call, but the process exited before the round was finished.
  await db.query("update runtime_executions set state='cost_pending' where id=$1", [round.executionId]);
  // Its response receipt was not final (the cost came later from a lookup without the response):
  // its finish reason and output tokens are still shown to the operator.
  // Receipts are immutable evidence; only this synthetic shape is rewritten.
  await db.query('alter table bill2_receipts disable trigger bill2_evidence_immutable');
  try {
    await db.query(`update bill2_receipts set payload=jsonb_set(payload,'{final}','false'::jsonb)
      where call_id in (select id from bill2_calls where run_id=$1) and payload->>'source'='response'`, [round.runId]);
  } finally { await db.query('alter table bill2_receipts enable trigger bill2_evidence_immutable'); }
  expect((await reported()).rounds.find(item => item.runId === round.runId)?.evidence)
    .toMatchObject({ lastFinishReason: 'stop', outputTokens: 4 });
  expect(await compensateStaleRound(service, round.runId)).toMatchObject({ state: 'compensated', executionState: 'cancelled' });
  expect(await ledger(round)).toMatchObject({ credits: 100, compensations: 1, run_state: 'refunded' });
}, 60000);

it('RUNTIME: a retry or call activity just before the operator confirms keeps the round from compensation', async () => {
  const retried = await chargedOpenRound(2 * STALE_ROUND_AGE_MS), active = await chargedOpenRound(2 * STALE_ROUND_AGE_MS);
  expect(ids(await reported())).toEqual(expect.arrayContaining([retried.runId, active.runId]));
  // The user retried: the round runs again under a fresh dispatch lease, before its next call.
  await db.query("update runtime_executions set state='running' where id=$1", [retried.executionId]);
  await db.query("update bill2_runs set runtime_dispatch_deadline=now()+interval '5 minutes' where id=$1", [retried.runId]);
  // Another round just settled a call: it is not quiet any more.
  await db.query('update bill2_calls set settled_at=now() where run_id=$1', [active.runId]);
  const reportIds = ids(await reported());
  for (const round of [retried, active]) {
    expect(reportIds).not.toContain(round.runId);
    const before = await ledger(round);
    await expect(compensateStaleRound(service, round.runId)).rejects.toThrow('STALE_ROUND_NOT_ELIGIBLE');
    expect(await ledger(round)).toEqual(before);
  }
}, 60000);

it('RUNTIME: a round whose account was later banned can still be compensated', async () => {
  const round = await chargedOpenRound(2 * STALE_ROUND_AGE_MS);
  await db.query("update profiles set status='banned' where id=$1", [round.actor]);
  expect(ids(await reported())).toContain(round.runId);
  expect(await compensateStaleRound(service, round.runId)).toMatchObject({ state: 'compensated', compensatedCredits: 3 });
  expect(await ledger(round)).toMatchObject({ credits: 100, ledger: 100, compensations: 1, run_state: 'refunded' });
}, 60000);

const epochOf = async (runId: string) =>
  Number((await db.query('select runtime_epoch from bill2_runs where id=$1', [runId])).rows[0].runtime_epoch);
const markCapacity = async (round: { actor: string; executionId: string; runId: string },
  code = 'RUNTIME_COMPLETE_REQUEST_EXCEEDS_CAPACITY', epoch?: number) => rpc('runtime_interrupt_capacity',
  { p_actor_id: round.actor, p_execution_id: round.executionId, p_epoch: epoch ?? await epochOf(round.runId), p_code: code });

it('RUNTIME: a round interrupted for content beyond capacity is marked atomically, once, and never reported or compensated', async () => {
  const round = await chargedOpenRound(2 * STALE_ROUND_AGE_MS), other = await chargedOpenRound(2 * STALE_ROUND_AGE_MS);
  expect(ids(await reported())).toContain(round.runId);
  // Only the service host can write the marker, only for the execution's own account and only a capacity code.
  expect((await anon.rpc('runtime_interrupt_capacity', { p_actor_id: round.actor, p_execution_id: round.executionId,
    p_epoch: await epochOf(round.runId), p_code: 'RUNTIME_COMPLETE_REQUEST_EXCEEDS_CAPACITY' })).error).toBeTruthy();
  await expect(markCapacity({ ...round, actor: other.actor })).rejects.toThrow('RUNTIME_EXECUTION_DENIED');
  await expect(markCapacity(round, 'RUNTIME_DATABASE_UNAVAILABLE')).rejects.toThrow('RUNTIME_FAILURE_CODE_INVALID');
  // An older invocation still unwinding after a resume advanced the epoch cannot mark the resumed round.
  await expect(markCapacity(round, undefined, await epochOf(round.runId) - 1)).rejects.toThrow('RUNTIME_RESUME_CONFLICT');
  expect((await db.query('select failure_code from runtime_executions where id=$1', [round.executionId])).rows[0])
    .toEqual({ failure_code: null });
  // A running round: the marker and the interruption land together, or (refused) neither does.
  const live = await chargedOpenRound(2 * STALE_ROUND_AGE_MS);
  await db.query("update runtime_executions set state='running' where id=$1", [live.executionId]);
  const state = async () => (await db.query('select state,failure_code from runtime_executions where id=$1', [live.executionId])).rows[0];
  await expect(markCapacity(live, undefined, await epochOf(live.runId) + 1)).rejects.toThrow('RUNTIME_RESUME_CONFLICT');
  expect(await state()).toEqual({ state: 'running', failure_code: null });
  await markCapacity(live, 'RUNTIME_REQUIRED_CONTEXT_EXCEEDS_CAPACITY');
  expect(await state()).toEqual({ state: 'interrupted', failure_code: 'RUNTIME_REQUIRED_CONTEXT_EXCEEDS_CAPACITY' });
  expect(ids(await reported())).not.toContain(live.runId);
  // The marker and the interruption commit together through the existing owner interrupt.
  expect(await markCapacity(round)).toMatchObject({ state: 'interrupted' });
  // Write-once: the first code stays.
  await markCapacity(round, 'RUNTIME_REQUIRED_CONTEXT_EXCEEDS_CAPACITY');
  expect((await db.query('select failure_code from runtime_executions where id=$1', [round.executionId])).rows[0])
    .toEqual({ failure_code: 'RUNTIME_COMPLETE_REQUEST_EXCEEDS_CAPACITY' });
  expect(ids(await reported())).not.toContain(round.runId);
  const before = await ledger(round);
  await expect(compensateStaleRound(service, round.runId)).rejects.toThrow('STALE_ROUND_NOT_ELIGIBLE');
  await autoCompensateStaleRounds(service);
  expect(await ledger(round)).toEqual(before);
  expect(before).toMatchObject({ credits: 97, compensations: 0, closed: false });
}, 60000);

const markerSince = async (iso: string) => db.query(
  `insert into system_settings(key,value) values('runtime_capacity_marker_since',to_jsonb($1::text))
   on conflict(key) do update set value=excluded.value`, [iso]);

it('RUNTIME: the recovery job arms the marker clock itself and leaves older rounds to the operator', async () => {
  // The migration does not start the clock: a migration-first rollout would count old-version rounds as marked.
  await db.query("delete from system_settings where key='runtime_capacity_marker_since'");
  expect(await rpc('runtime_capacity_marker_since', {})).toBeNull();
  expect((await anon.rpc('runtime_capacity_marker_arm', {})).error).toBeTruthy();
  const old = await chargedOpenRound(2 * STALE_ROUND_AGE_MS);
  const before = await ledger(old);
  const first = await autoCompensateStaleRounds(service);
  expect(first.compensated).toBe(0);
  expect(first.manualReview).toBeGreaterThanOrEqual(1);
  const armed = Date.parse(await rpc('runtime_capacity_marker_since', {}) as string);
  // Armed in the future (margin for requests of the previous version), once: another run keeps the value.
  expect(armed).toBeGreaterThan(Date.now());
  await autoCompensateStaleRounds(service);
  expect(Date.parse(await rpc('runtime_capacity_marker_since', {}) as string)).toBe(armed);
  // Selected in SQL before the page limit: the old round is not in a page filtered by the marker time.
  const filtered = await rpc('runtime_stale_charged_rounds', { p_cutoff: new Date(Date.now() - STALE_ROUND_AGE_MS).toISOString(),
    p_limit: 500, p_created_since: new Date(armed).toISOString() }) as { total: number; rounds: Array<{ runId: string }> };
  expect(filtered.rounds.map(round => round.runId)).not.toContain(old.runId);
  expect(ids(await reported(500))).toContain(old.runId);
  expect(await ledger(old)).toEqual(before);
  // The operator path is unchanged and still refunds it.
  expect(await compensateStaleRound(service, old.runId)).toMatchObject({ state: 'compensated', compensatedCredits: 3 });
}, 60000);

it('RUNTIME: the recovery job closes a stale round by the same rule once and settles it correctly', async () => {
  await markerSince('2000-01-01T00:00:00Z'); // markers reliable for all fixtures here
  const stale = await chargedOpenRound(2 * STALE_ROUND_AGE_MS), recent = await chargedOpenRound(0);
  const capacity = await chargedOpenRound(2 * STALE_ROUND_AGE_MS);
  await markCapacity(capacity);
  const untouched = [await ledger(recent), await ledger(capacity)];
  // The real scheduled entry (financial recovery first, then the automatic close) through PostgREST as service_role.
  const first = await runAutomaticFinancialRecovery(service);
  expect(first.staleRounds).toMatchObject({ failed: 0 });
  expect(first.staleRounds!.compensated).toBeGreaterThanOrEqual(1);
  const after = await ledger(stale);
  expect(after).toEqual({ credits: 100, ledger: 100, compensations: 1, run_state: 'refunded', closed: true,
    outcome: 'confirmed_failure', compensation_credits: 3, execution_state: 'cancelled',
    unavailable_reason: 'platform_review', active_execution: null });
  expect([await ledger(recent), await ledger(capacity)]).toEqual(untouched);
  // Next minute: nothing left for it; an operator click afterwards and the user's retry refund nothing more.
  expect((await runAutomaticFinancialRecovery(service)).staleRounds).toMatchObject({ compensated: 0, failed: 0 });
  expect(await compensateStaleRound(service, stale.runId)).toMatchObject({ state: 'already_compensated', compensatedCredits: 3 });
  expect(await stale.host.execute(stale.executionId)).toEqual({ state: 'cancelled', unavailable: 'platform_review' });
  expect(await ledger(stale)).toEqual(after);
}, 60000);

it('RUNTIME: the recovery job and an operator refunding the same round at once refund it once', async () => {
  const round = await chargedOpenRound(2 * STALE_ROUND_AGE_MS);
  const [automatic, operator] = await Promise.all([autoCompensateStaleRounds(service), compensateStaleRound(service, round.runId)]);
  expect(automatic.failed).toBe(0);
  expect(['compensated', 'already_compensated']).toContain(operator.state);
  expect(await ledger(round)).toMatchObject({ credits: 100, ledger: 100, compensations: 1, run_state: 'refunded' });
}, 60000);

/**
 * 0398 (Owner 2026-10-25 "暂停回合选 A"): a round paused for the user whose charged step delivered no reply.
 * `reply` keeps the saved primary reply (an organizer waiting after its answer), which is never refunded.
 */
async function pausedRound(ageMs: number, state: 'waiting_resume' | 'waiting_credits', reply = false) {
  const round = await chargedOpenRound(ageMs);
  await db.query(`update runtime_executions set state=$2${reply ? '' : ',primary_result=null'} where id=$1`, [round.executionId, state]);
  await db.query('update bill2_runs set paused_reason=$2 where id=$1',
    [round.runId, state === 'waiting_credits' ? 'insufficient_credits' : 'http_budget']);
  await db.query('update runtime_sessions set active_execution=null where id=$1', [round.sessionId]);
  return round;
}

it.each(['waiting_resume', 'waiting_credits'] as const)(
  'RUNTIME: a paused round that delivered no reply is refunded after 24 hours and cannot be replayed for free (%s)', async state => {
    const round = await pausedRound(2 * STALE_ROUND_AGE_MS, state);
    expect((await ledger(round)).credits).toBe(97);
    const report = await reported();
    expect(report.rounds.find(item => item.runId === round.runId)).toMatchObject({ chargedCredits: 3,
      evidence: { executionState: state, savedReplyChars: 0 } });
    expect(await compensateStaleRound(service, round.runId)).toMatchObject({ state: 'compensated', compensatedCredits: 3 });
    expect(await ledger(round)).toMatchObject({ credits: 100, ledger: 100, compensations: 1, run_state: 'refunded', closed: true,
      execution_state: 'cancelled', active_execution: null });
    // Repeated: the same outcome, no second refund.
    const refunded = await ledger(round);
    expect(await compensateStaleRound(service, round.runId)).toMatchObject({ state: 'already_compensated', compensatedCredits: 3 });
    expect(await ledger(round)).toEqual(refunded);
    // A later "continue" finds the round closed: nothing is replayed free, nothing charged; the user starts a new round.
    const run = (await db.query('select runtime_cursor cursor,runtime_epoch epoch from bill2_runs where id=$1', [round.runId])).rows[0];
    await expect(round.host.execute(round.executionId, undefined, { executionId: round.executionId, cursor: run.cursor, epoch: run.epoch }))
      .rejects.toThrow();
    expect(await ledger(round)).toEqual(refunded);
  }, 60000);

it('RUNTIME: two concurrent compensations of a paused round refund once', async () => {
  const round = await pausedRound(2 * STALE_ROUND_AGE_MS, 'waiting_resume');
  const cutoff = new Date(Date.now() - STALE_ROUND_AGE_MS).toISOString();
  const call = (client: pg.Client) => client.query('select public.runtime_stale_round_compensate($1,$2) value', [round.runId, cutoff])
    .then(result => result.rows[0].value);
  const race = await overlap(db, connectionString, 'select id from runtime_sessions where id=$1 for update', [round.sessionId], call, call);
  expect(race.value).toMatchObject({ state: 'compensated', compensatedCredits: 3 });
  expect(race.other).toMatchObject({ ok: true, value: { state: 'already_compensated', compensatedCredits: 3 } });
  expect(await ledger(round)).toMatchObject({ credits: 100, ledger: 100, compensations: 1 });
}, 60000);

it('RUNTIME: a paused round with a delivered reply, a recent pause or a user stop is never refunded', async () => {
  const delivered = await pausedRound(2 * STALE_ROUND_AGE_MS, 'waiting_credits', true);
  const recent = await pausedRound(STALE_ROUND_AGE_MS / 2, 'waiting_resume');
  const stopped = await pausedRound(2 * STALE_ROUND_AGE_MS, 'waiting_resume');
  await db.query("update bill2_runs set paused_reason='user_stop' where id=$1", [stopped.runId]);
  const reportIds = ids(await reported());
  for (const round of [delivered, recent, stopped]) {
    expect(reportIds).not.toContain(round.runId);
    const before = await ledger(round);
    await expect(compensateStaleRound(service, round.runId)).rejects.toThrow('STALE_ROUND_NOT_ELIGIBLE');
    expect(await ledger(round)).toEqual(before);
  }
}, 60000);
