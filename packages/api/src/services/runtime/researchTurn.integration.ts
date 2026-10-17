/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// RESEARCH-TOOLS RT-3b PR-3 against the real SQL (0255, 0263, 0267): a mentor turn whose frozen run carries a tool
// price calls web_search once, the subcall and both model calls share the run's sequence, the run rounds once,
// and a crash replay reuses the saved evidence and responses without another claim or supplier request.
// The supplier is a synthetic recorded result (no network); the model is the local fixture server.
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import { expect, it, vi } from 'vitest';
import { runtimeExecutor } from './execute';
import { freezeHistorySelection } from './hostTurn';
import { frozenResearchTurn, RESEARCH_PHASE, RESEARCH_RESULT_RESERVE_BYTES, RESEARCH_TURN_VERSION } from './researchTurn';
import { toolCallPolicy } from '../bill2/toolBilling';
import type { RuntimeProgress } from './progress';
import type { PaygWait } from './paygRuntime';

const supplier = vi.hoisted(() => ({ calls: 0 }));
vi.mock('../redisRateLimiter', () => ({ checkVendorRateLimit: async () => true }));
vi.mock('../research/vendors/parallel', async original => ({
  ...await original<typeof import('../research/vendors/parallel')>(),
  callParallel: async (_query: string, deps: { now?: () => Date }) => {
    supplier.calls++;
    return { vendor: 'parallel', route: 'parallel:search:fast', outcome: 'ok', reason: null, httpStatus: 200, supplierMayCharge: true,
      usage: { unit: 'sku_search', units: '1' }, truncated: false, fetchedAt: (deps.now?.() ?? new Date()).toISOString(),
      items: [{ url: 'https://example.com/coffee', fields: { title: 'Coffee guide', excerpt: 'Synthetic recorded excerpt' }, missing: [] }] };
  },
}));

const connectionString = process.env.V3_LOCAL_DB!;
const route = 'parallel:search:fast';
const research = frozenResearchTurn.parse({ version: RESEARCH_TURN_VERSION, configRevision: 1, phase: RESEARCH_PHASE, subcalls: 4,
  reserve: RESEARCH_RESULT_RESERVE_BYTES, vendors: ['parallel'], verifiedPlatforms: [], benchmarkPlatforms: [],
  routes: [{ platform: 'web', kind: 'web_search', vendor: 'parallel', route, backup: null, maxUnitsPerCall: '1' }],
  discoverSubcalls: 4, recentGrowth: { maxFirstPostAgeDays: 90, minViewsToFollowers: '1' } });
const toolPolicy = toolCallPolicy({ vendor: 'parallel', account: 'research-local', route, purposes: [RESEARCH_PHASE], maxUnitsPerCall: '1',
  price: { entryHash: 'e'.repeat(64), matchedBy: 'route', multiplier: '1', multiplierSource: 'global',
    entry: { provider: 'parallel', route, appliesToUnlistedRoutes: false, currency: 'USD', usageUnit: 'sku_search', unitsPerPrice: '1',
      price: '0.005', usdPerCurrency: null, fxSourceUrl: null, fxEffectiveAt: null, fxValidUntil: null, pricingBasis: 'synthetic',
      sourceUrl: 'https://example.com/pricing', evidenceHash: 'a'.repeat(64), verifiedAt: new Date(Date.now() - 86_400_000).toISOString(),
      validUntil: new Date(Date.now() + 7 * 86_400_000).toISOString(), chargeCondition: 'per search', includedInReceipt: false,
      priceMultiplier: null } } });

async function researchRound(toolThreshold = 1) {
  if (!connectionString?.startsWith('postgres://postgres@127.0.0.1:') || !connectionString.endsWith('/v3_disposable'))
    throw new Error('isolated runner required');
  const db = new pg.Client({ connectionString });
  const admin = createClient(process.env.V3_LOCAL_REST!, process.env.V3_LOCAL_SERVICE_JWT!, { auth: { persistSession: false } });
  const rpc = async (name: string, args: Record<string, unknown>) => {
    const result = await admin.rpc(name, args);
    if (result.error) throw new Error(result.error.message);
    return result.data;
  };
  const actor = randomUUID(), primary = randomUUID(), model = 'research-turn-' + primary;
  const requests: Array<{ messages: Array<{ role: string }> }> = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const input = JSON.parse(JSON.parse(raw).input);
    requests.push(input);
    const first = !input.messages.some((message: { role: string }) => message.role === 'tool');
    const id = 'research-turn-' + randomUUID();
    const message = first
      ? { role: 'assistant', content: null, tool_calls: [{ id: 'call-web-1', type: 'function',
        function: { name: 'web_search', arguments: JSON.stringify({ query: 'coffee shop positioning', mode: 'fast' }) } }] }
      : { role: 'assistant', content: '根据检索结果（Coffee guide），可以先从社区咖啡角度切入。' };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id, model: input.model, final: true, cost: '0.003', currency: 'USD', coverage: 'request_total',
      usage: { inputTokens: 3000, outputTokens: 20, sdkResponse: { id, object: 'chat.completion', created: 1, model: input.model,
        choices: [{ index: 0, message, finish_reason: first ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 3000, completion_tokens: 20, total_tokens: 3020 } } } }));
  });
  await db.connect();
  await db.query('insert into profiles(id,credits) values($1,1000)', [actor]);
  await db.query(`insert into credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,
    idempotency_key,balance_before,balance_after) values($1,1000,'addition','grant','opening_grant','system',$2,0,1000)`,
  [actor, 'research-turn-opening:' + actor]);
  await db.query(`insert into ai_models(id,model_id,name,provider,is_active) values($1,$2,'Research turn','fixture',true)`, [primary, model]);
  const pricingHash = 'a'.repeat(64), endpointTag = 'fixture/exact';
  const modelPolicy = { modelId: primary, model, provider: 'fixture', account: 'sandbox', protocol: 'fixture-cost-v1',
    upperUsd: '0.1', multiplier: '1', inputLimit: 64000, outputLimit: 1000, automaticRetry: false, hiddenTools: false, lookupSupported: false,
    providerLimits: { providerSlug: endpointTag, contextTokens: 100000, promptUsdPerMillion: '1', completionUsdPerMillion: '0', requestUsd: '0' },
    payg: { version: 'v1', policyId: 'research-turn', profileVersion: 'local-v1', evidenceVersion: 'local-v1',
      pricingHash, endpointTag, templateTokens: 4096, marginTokens: 4096, admissionPath: 'fixture',
      maxBytes: 64000, maxMessages: 32, maxTools: 9, maxSchemaBytes: 16384,
      purposes: ['skill'], expiresAt: new Date(Date.now() + 3600000).toISOString(),
      nominalPricing: { version: 'nominal-v1', pricingHash, endpointTag,
        tiers: [{ minPromptTokens: 0, prompt: '1', completion: '0', request: '0' }], timeOfDay: [] } } };
  await db.query(`insert into system_settings(key,value) values('billing_payg_start_thresholds',$1::jsonb)
    on conflict(key) do update set value=jsonb_set(system_settings.value,'{thresholds}',
    coalesce(system_settings.value->'thresholds','[]')||(excluded.value->'thresholds'))`,
  [{ version: 'local-v1', thresholds: [{ model, purpose: 'skill', credits: 1 }] }]);
  // One threshold entry per tool route and purpose (0180); an earlier run of this file may have added it.
  await db.query(`update system_settings set value=jsonb_set(value,'{thresholds}',(select coalesce(jsonb_agg(t),'[]')
    from jsonb_array_elements(value->'thresholds') t where t->>'model'<>$1)||$2::jsonb) where key='billing_payg_start_thresholds'`,
  [toolPolicy.model, JSON.stringify([{ model: toolPolicy.model, purpose: RESEARCH_PHASE, credits: toolThreshold }])]);
  const session = await rpc('runtime_start', { p_actor_id: actor, p_request_id: randomUUID(),
    p_payload: { scope: { kind: 'positioning_draft' } } });
  const requestId = randomUUID();
  const context = { version: 'runtime.v1', sdkVersion: '0.18.0', role: 'skill', input: '帮我看看同类账号怎么做',
    instructions: 'Synthetic positioning mentor', model, maxOutputTokens: 1000, maxTurns: 2, maxToolCalls: 2, historyItems: 0,
    tools: ['ask_question', 'web_search'], research, sources: [], network: 'deny', nativeOutput: 'native-output-v1',
    providerRequestFormat: 'agent-turn-v5-stream', reasoning: { parameter: 'none' }, inputSelection: 'scope-projection-v2',
    hostTurnContext: { stepId: 'step-1', opening: false, checklist: [] }, historySelection: freezeHistorySelection(),
    request: { sessionId: session.sessionId, requestId } };
  const billing = { contractVersion: 'bill2.v2', mode: 'isolated', scope: session.scope, operation: 'question',
    modelId: primary, sourceHash: 'b'.repeat(64), input: context, callPolicy: [modelPolicy, toolPolicy],
    rules: { version: 'v1', quoteVersion: 'local-v1', creditsPerUsd: '1000', multiplier: '1', fx: {},
      billingUnit: { version: 'bill-unit-v2', creditsPerUsd: '1000', defaultMultiplier: '1', hash: 'f'.repeat(64), providers: {},
        models: { [primary]: { multiplier: '1', source: 'global' } } } },
    limits: { costUsd: '0.220000000000', credits: 0, maxPreDeduct: 0, maxCalls: 2 + 4, deadline: new Date(Date.now() + 3600000).toISOString() } };
  const admitted = await rpc('runtime_admit', { p_actor_id: actor, p_session_id: session.sessionId,
    p_request_id: requestId, p_payload: context, p_billing: billing });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('local server required');
  const close = async () => {
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
    await db.end();
  };
  return { admin, admitted, db, actor, requests, close, endpoint: 'http://127.0.0.1:' + address.port };
}

it('RUNTIME: a research mentor turn claims the subcall between its model calls, rounds once and replays without resending', async () => {
  process.env.PARALLEL_API_KEY = 'synthetic-local-only';
  supplier.calls = 0;
  const f = await researchRound();
  try {
    let crash = true;
    const database = { rpc: (name: string, args: Record<string, unknown>) => {
      if (name === 'runtime_execution' && args.p_action === 'complete' && crash) {
        crash = false;
        return Promise.resolve({ data: null, error: { message: 'synthetic crash after the paid turn' } });
      }
      return f.admin.rpc(name, args);
    } };
    const events: RuntimeProgress[] = [];
    const host = () => runtimeExecutor({ database, actor: async () => f.actor, callGate: async () => ({ ok: true as const }),
      endpoint: f.endpoint });
    expect(await host().execute(f.admitted.executionId, event => events.push(event))).toMatchObject({ state: 'pending' });
    const calls = async () => (await f.db.query(`select sequence,call_kind,model,state,nominal_source,provider_id=id::text own_receipt,
      settled_at is not null settled from bill2_calls where run_id=$1 order by sequence`, [f.admitted.runId])).rows;
    const paid = await calls();
    expect(paid.map(c => [c.sequence, c.call_kind, c.own_receipt])).toEqual([[1, 'model', false], [2, 'tool', true], [3, 'model', false]]);
    expect(paid[1]).toMatchObject({ model: toolPolicy.model, nominal_source: 'tool_usage', settled: true });
    expect(supplier.calls).toBe(1);
    expect(f.requests).toHaveLength(2);
    const research = events.filter(event => event.type === 'research_call');
    expect(research.map(event => event.type === 'research_call' && event.state)).toEqual(['running', 'succeeded']);
    expect(research[1]).toMatchObject({ toolName: 'web_search', query: 'coffee shop positioning', dataKind: 'web_search' });
    // The evidence is bound to this answer and to the tool call's BILL2 row.
    const evidence = (await f.db.query(`select o.state,o.result->>'toolName' tool,c.sequence from research_operations o
      join research_plans p on p.id=o.plan_id join bill2_calls c on c.id=o.bill2_call_id where p.execution_id=$1`,
    [f.admitted.executionId])).rows;
    expect(evidence).toEqual([{ state: 'succeeded', tool: 'web_search', sequence: 2 }]);

    // Replay after the lost completion: saved responses and evidence, no claim, no supplier or model request.
    const replay = await host().execute(f.admitted.executionId);
    expect(replay).toMatchObject({ state: 'completed' });
    expect(await calls()).toEqual(paid.map(c => ({ ...c })));
    expect(supplier.calls).toBe(1);
    expect(f.requests).toHaveLength(2);
    const run = (await f.db.query(`select r.charged,p.credits from bill2_runs r,profiles p where r.id=$1 and p.id=$2`,
      [f.admitted.runId, f.actor])).rows[0];
    // (0.003 + 0.005 + 0.003) × 1000 × 1 = 11 credits, rounded once for the whole turn.
    expect(run).toEqual({ charged: 11, credits: 1000 - 11 });
  } finally { await f.close(); }
}, 60000);

it('RUNTIME: a subcall the balance cannot start pauses the turn at its slot; after a top-up it resumes there and charges once', async () => {
  process.env.PARALLEL_API_KEY = 'synthetic-local-only';
  supplier.calls = 0;
  // The tool route needs 999 credits to start; after the first model call (3 credits) only 997 are left.
  const f = await researchRound(999);
  try {
    const host = () => runtimeExecutor({ database: f.admin, actor: async () => f.actor, callGate: async () => ({ ok: true as const }),
      endpoint: f.endpoint });
    const calls = async () => (await f.db.query(`select sequence,call_kind,state,settled_at is not null settled
      from bill2_calls where run_id=$1 order by sequence`, [f.admitted.runId])).rows;
    const credits = async () => (await f.db.query('select credits from profiles where id=$1', [f.actor])).rows[0].credits;
    const events: RuntimeProgress[] = [];
    const waiting = await host().execute(f.admitted.executionId, event => events.push(event));
    // Paused between two steps (BILL-PAYG), not skipped: no supplier request, no tool row, no reply from the model without it.
    expect(waiting).toMatchObject({ state: 'waiting_credits', code: 'RUNTIME_WAITING_CREDITS', executionId: f.admitted.executionId });
    expect(supplier.calls).toBe(0);
    expect(f.requests).toHaveLength(1);
    expect(await calls()).toEqual([{ sequence: 1, call_kind: 'model', state: 'responded', settled: true }]);
    expect(await credits()).toBe(997);
    expect(events.filter(event => event.type === 'research_call').map(event => event.type === 'research_call' && event.state))
      .toEqual(['running']);
    const run = await f.db.query(`select r.paused_reason,r.runtime_checkpoint->>'sequence' seq,e.state from bill2_runs r
      join runtime_executions e on e.billing_run_id=r.id where r.id=$1`, [f.admitted.runId]);
    expect(run.rows[0]).toEqual({ paused_reason: 'insufficient_credits', seq: '2', state: 'waiting_credits' });
    // Still short: resuming keeps waiting instead of sending.
    expect(await host().execute(f.admitted.executionId)).toEqual(waiting);

    // Synthetic local grant keeps the fixture ledger balanced; no payment provider is involved.
    await f.db.query(`insert into credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,
      idempotency_key,balance_before,balance_after) values($1,100,'addition','grant','opening_grant','system',$2,997,1097)`,
    [f.actor, 'research-turn-topup:' + f.actor]);
    await f.db.query('update profiles set credits=1097 where id=$1', [f.actor]);
    const resumed = await host().execute(f.admitted.executionId, undefined,
      { executionId: f.admitted.executionId, cursor: (waiting as PaygWait).cursor, epoch: (waiting as PaygWait).epoch });
    expect(resumed).toMatchObject({ state: 'completed' });
    // The saved first reply is replayed; the subcall claims the paused slot with the same request, then the reply after it.
    expect((await calls()).map(c => [c.sequence, c.call_kind, c.settled])).toEqual([[1, 'model', true], [2, 'tool', true], [3, 'model', true]]);
    expect(supplier.calls).toBe(1);
    expect(f.requests).toHaveLength(2);
    const charged = (await f.db.query('select charged from bill2_runs where id=$1', [f.admitted.runId])).rows[0].charged;
    expect(charged).toBe(11);
    // Granted 1000 + 100 in total; the whole turn costs 11 once (3 of them were already taken before the pause).
    expect(await credits()).toBe(1000 + 100 - 11);
    const ledger = await f.db.query('select sum(amount)::int n from credit_transactions where user_id=$1', [f.actor]);
    expect(ledger.rows[0].n).toBe(1000 + 100 - 11);
  } finally { await f.close(); }
}, 60000);
