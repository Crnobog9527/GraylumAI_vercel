/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {allowTestCalls} from '../__tests__/fixtures/runtimeGates';
import {beforeAll, afterAll, it, expect} from 'vitest';
import {randomUUID, createHash} from 'node:crypto';
import pg from 'pg';
import {createClient} from '@supabase/supabase-js';
import {runtimeExecutor} from './execute';
import {openRouterAdapter} from '../bill2/openRouterAdapter';
import {agentTurnBody} from '../../shared/agentTurn';

const connectionString = process.env.V3_LOCAL_DB!;
if (!connectionString?.startsWith('postgres://postgres@127.0.0.1:') ||
    !connectionString.endsWith('/v3_disposable')) throw new Error('isolated runner required');
if (!process.env.V3_LOCAL_REST?.startsWith('http://127.0.0.1:')) throw new Error('isolated REST required');
const db = new pg.Client({connectionString});
const admin = createClient(process.env.V3_LOCAL_REST, process.env.V3_LOCAL_SERVICE_JWT!, {
  auth: {persistSession: false},
});
beforeAll(async () => { await db.connect(); });
afterAll(async () => { await db.end(); });
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
async function rpc(name: string, args: Record<string, unknown>) {
  const result = await admin.rpc(name, args);
  if (result.error) throw new Error(result.error.message);
  return result.data;
}

async function fixture(organize: boolean) {
  const actorId = randomUUID(), mentorId = randomUUID(), organizerId = randomUUID();
  const windowId = randomUUID(), requestId = randomUUID();
  await db.query('insert into profiles(id,credits) values($1,1000)', [actorId]);
  await db.query("insert into credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,idempotency_key,balance_before,balance_after) values($1,1000,'addition','grant','opening_grant','system',$2,0,1000)", [actorId, randomUUID()]);
  const session = await rpc('runtime_start', {
    p_actor_id: actorId, p_request_id: randomUUID(), p_payload: {scope: {kind: 'positioning_draft'}},
  });
  const policies = [[mentorId, 'synthetic/mentor'], [organizerId, 'synthetic/organizer']].map(([modelId, model]) => ({
    modelId, model, provider: 'openrouter', account: 'synthetic-terminal', protocol: 'openrouter-chat-v1',
    upperUsd: '0.02', inputLimit: 10000, outputLimit: 100, automaticRetry: false,
    hiddenTools: false, lookupSupported: true,
    providerLimits: {providerSlug: 'synthetic', contextTokens: 10000, promptUsdPerMillion: '2',
      completionUsdPerMillion: '0', requestUsd: '0'},
  }));
  for (const policy of policies) {
    await db.query("insert into ai_models(id,name,model_id,provider,is_active) values($1,'Synthetic terminal integration',$2,'openrouter','true')", [policy.modelId, policy.model]);
  }
  await db.query("insert into runtime_test_windows(id,enabled,actor_ids,call_policies,credits_per_usd,multiplier,max_cost_usd,max_calls,expires_at) values($1,true,$2,$3,1000,1,1,10,now()+interval '2 hours')", [windowId, [actorId], JSON.stringify(policies)]);
  const context = {
    version: 'runtime.v1', sdkVersion: '0.18.0', role: 'ordinary', inputSelection: 'scope-projection-v1',
    providerRequestFormat: 'agent-turn-v5-stream', reasoning: {effort: 'none'},
    input: 'HOST_OPEN_CURRENT_QUESTION', instructions: 'Provide a concrete suggestion or ask one question.',
    model: policies[0]!.model, modelId: mentorId, maxOutputTokens: 100, maxTurns: 1,
    historyItems: 20, network: 'deny', tools: ['ask_question'],
    request: {sessionId: session.sessionId, requestId, organizeAfter: false},
    ...(organize ? {attachedOrganizer: {
      modelId: organizerId, model: policies[1]!.model, maxOutputTokens: 100,
      instructions: 'Extract supported fields only.', input: 'HOST_OPEN_CURRENT_QUESTION',
    }} : {}),
  };
  const billing = {
    contractVersion: 'bill2.v1', mode: 'staging_test', testWindowId: windowId,
    scope: session.scope, operation: 'question', modelId: mentorId, sourceHash: hash('synthetic-terminal'),
    input: context, callPolicy: organize ? policies : [policies[0]],
    rules: {version: 'runtime-staging-v1', quoteVersion: windowId, creditsPerUsd: '1000', multiplier: '1', fx: {}},
    limits: {costUsd: organize ? '0.04' : '0.02', credits: organize ? 40 : 20,
      maxPreDeduct: organize ? 40 : 20, maxCalls: organize ? 2 : 1,
      deadline: new Date(Date.now() + 3600000).toISOString()},
  };
  const execution = await rpc('runtime_admit', {
    p_actor_id: actorId, p_session_id: session.sessionId, p_request_id: requestId,
    p_payload: context, p_billing: billing,
  });
  return {actorId, session, execution, context, billing};
}

type Failure = 'mentor-refusal' | 'mentor-content-filter' | 'mentor-unknown-tool' |
  'organizer-empty' | 'organizer-refusal' | 'organizer-tool' |
  'organizer-missing-message' | 'organizer-array-message' |
  'organizer-array-content' | 'organizer-object-tools';
const failures: Failure[] = [
  'mentor-refusal', 'mentor-content-filter', 'mentor-unknown-tool',
  'organizer-empty', 'organizer-refusal', 'organizer-tool',
  'organizer-missing-message', 'organizer-array-message',
  'organizer-array-content', 'organizer-object-tools',
];
const cases = failures.flatMap(failure => [false, true].map(cancelLost => ({failure, cancelLost})));
const primaryText = '这是一条已付费并可核对的开场建议。';

it.runIf(process.env.V3_LOCAL_STAGING_SCHEMA === 'true').each(cases)(
  'RUNTIME: v5 durable terminal reply $failure cancels once and unlocks next admission (cancel lost=$cancelLost)',
  async ({failure, cancelLost}) => {
    const organize = failure.startsWith('organizer-');
    const f = await fixture(organize), requests: string[] = [];
    const expectedCalls = organize ? 2 : 1;
    const adapter = openRouterAdapter({
      allowAgentTools: true, credential: async () => 'SYNTHETIC_LOCAL_ONLY',
      transport: async (_url, init) => {
        const raw = String(init!.body), request = JSON.parse(raw);
        requests.push(raw);
        const id = 'gen-terminal-' + f.execution.executionId + '-' + requests.length;
        const failing = request.model === (organize ? 'synthetic/organizer' : 'synthetic/mentor');
        const refused = failing && failure.endsWith('refusal');
        const filtered = failing && failure.endsWith('content-filter');
        const illegalTool = failing && failure.endsWith('tool');
        const message = {
          role: 'assistant', content: failing ? (failure === 'organizer-empty' ? '' : null) : primaryText,
          ...(refused ? {refusal: 'SYNTHETIC_PROVIDER_REFUSAL'} : {}),
          ...(illegalTool ? {tool_calls: [{id: 'synthetic-illegal-tool', type: 'function', function: {
            name: organize ? 'ask_question' : 'nonexistent_tool',
            arguments: '{"question":"Synthetic?","options":["A","B"]}',
          }}]} : {}),
        };
        const finish = illegalTool ? 'tool_calls' : filtered ? 'content_filter' : 'stop';
        const usage = {prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, cost: 0.003};
        if (request.stream) {
          const frame = {id, object: 'chat.completion.chunk', model: request.model,
            choices: [{index: 0, delta: {...message, ...(illegalTool ? {
              tool_calls: message.tool_calls!.map(tool => ({index: 0, ...tool})),
            } : {})}, finish_reason: finish}], usage};
          return new Response('data: ' + JSON.stringify(frame) + '\n\ndata: [DONE]\n\n', {
            headers: {'content-type': 'text/event-stream'},
          });
        }
        // Complete non-streaming receipts can still contain a malformed message.
        // Keep the identity, sole choice, terminal finish and paid usage valid.
        const malformedResponses: Partial<Record<Failure, {message: unknown; finish: string}>> = {
          'organizer-missing-message': {message: undefined, finish: 'stop'},
          'organizer-array-message': {message: [], finish: 'content_filter'},
          'organizer-array-content': {message: {...message, content: []}, finish: 'length'},
          'organizer-object-tools': {message: {...message, tool_calls: {}}, finish: 'tool_calls'},
        };
        const malformed = failing ? malformedResponses[failure] : undefined;
        return new Response(JSON.stringify({id, object: 'chat.completion', created: 1, model: request.model,
          choices: [{index: 0, message: malformed ? malformed.message : message,
            finish_reason: malformed?.finish ?? finish}], usage}), {
          headers: {'content-type': 'application/json'},
        });
      },
    });
    let failCancel = cancelLost, cancellations = 0, lostInterrupts = 0;
    const database = {rpc: async (name: string, args: Record<string, unknown>) => {
      if (name === 'runtime_cancel') {
        cancellations++;
        if (failCancel) {
          failCancel = false;
          return {data: null, error: {message: 'Synthetic cancellation outage'}};
        }
      }
      if (cancelLost && name === 'runtime_execution' && args.p_action === 'interrupt') {
        lostInterrupts++;
        return {data: null, error: {message: 'Synthetic process loss before interrupt'}};
      }
      return admin.rpc(name, args);
    }};
    const host = () => runtimeExecutor({callGate:allowTestCalls,database, actor: async () => f.actorId, adapter});
    const snapshot = async () => (await db.query(
      'select state,payload,result,primary_result from runtime_executions where id=$1', [f.execution.executionId],
    )).rows[0];
    const first = await host().execute(f.execution.executionId);
    if (cancelLost) {
      expect(first).toEqual({state: 'pending'});
      expect(lostInterrupts).toBeGreaterThan(0);
      expect((await snapshot()).state).toBe('running');
      expect((await db.query('select active_execution from runtime_sessions where id=$1',
        [f.session.sessionId])).rows[0].active_execution).toBe(f.execution.executionId);
    } else expect(first).toEqual({state: 'cancelled'});
    expect(requests).toHaveLength(expectedCalls);
    const frozenRequests = [...requests];
    expect(await host().execute(f.execution.executionId)).toEqual({state: 'cancelled'});
    expect(await host().execute(f.execution.executionId)).toEqual({state: 'cancelled'});
    expect(requests).toEqual(frozenRequests);
    expect(cancellations).toBe(cancelLost ? 2 : 1);
    const saved = await snapshot();
    expect(saved).toMatchObject({state: 'cancelled', payload: f.context, result: null});
    if (organize) expect(saved.primary_result).toMatchObject({body: agentTurnBody(primaryText, null), truncated: false});
    else expect(saved.primary_result).toBeNull();
    const calls = (await db.query('select id,payload,provider_id from bill2_calls where run_id=$1 order by sequence',
      [f.execution.runId])).rows;
    expect(calls).toHaveLength(expectedCalls);
    expect(calls.map(call => call.payload.requestHash)).toEqual(frozenRequests.map(hash));
    expect(calls.map(call => call.provider_id)).toEqual(calls.map((_, index) =>
      'gen-terminal-' + f.execution.executionId + '-' + (index + 1)));
    expect((await db.query('select count(*)::int n from bill2_receipts where call_id=any($1::uuid[])',
      [calls.map(call => call.id)])).rows[0].n).toBe(expectedCalls);
    expect((await db.query('select state,closed,charged,actual_restore from bill2_runs where id=$1',
      [f.execution.runId])).rows[0]).toEqual({state: 'settled', closed: true,
      charged: expectedCalls * 3, actual_restore: expectedCalls * 17});
    expect((await db.query("select count(*)::int n from credit_transactions where bill2_run_id=$1 and reason_code='bill2_spend'",
      [f.execution.runId])).rows[0].n).toBe(1);
    expect((await db.query('select active_execution from runtime_sessions where id=$1',
      [f.session.sessionId])).rows[0].active_execution).toBeNull();
    // The original terminal turn must not leave the next message blocked.
    const requestId = randomUUID();
    const nextContext = {...f.context, input: 'A new independent message',
      request: {...f.context.request, requestId}};
    const next = await rpc('runtime_admit', {p_actor_id: f.actorId, p_session_id: f.session.sessionId,
      p_request_id: requestId, p_payload: nextContext, p_billing: {...f.billing, input: nextContext}});
    expect(next.executionId).not.toBe(f.execution.executionId);
    expect((await db.query('select active_execution from runtime_sessions where id=$1',
      [f.session.sessionId])).rows[0].active_execution).toBe(next.executionId);
    await rpc('runtime_cancel', {p_actor_id: f.actorId, p_execution_id: next.executionId});
    expect(requests).toEqual(frozenRequests);
  },
);
