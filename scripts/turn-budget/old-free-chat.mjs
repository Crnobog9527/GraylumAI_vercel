/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// The OLD path's free-chat turn (no tools, one model call), as the database sees it: read the session, admit (runtime_admit with its
// prepare), take the runtime epoch, claim and dispatch the call, record the receipt, append the exchange to the session history, complete the
// execution. The application also
// reads settings, the model, the profile and the history through REST between these calls (about 25 round trips per request in the
// staging load runs, see docs/validation/core-path-v2/baseline-old-path.md); only the calls below are counted here.
import { randomUUID } from 'node:crypto';
import { createFixture } from '../../packages/db/tests/payg/fixture.mjs';

export default {
  name: 'old:free-chat',
  path: 'old',
  tables: ['runtime_sessions', 'runtime_executions', 'bill2_runs', 'bill2_calls', 'credit_transactions', 'runtime_session_history'],
  async setup({ client }) {
    const f = await createFixture(client, { credits: 1000, threshold: 1 });
    const started = (await client.query('SELECT runtime_start($1,$2,$3::jsonb) v', [f.actor, randomUUID(),
      JSON.stringify({ scope: f.payload.scope })])).rows[0].v;
    const context = { version: 'runtime.v1', sdkVersion: '0.18.0', role: 'ordinary', input: 'synthetic input', instructions: 'Answer',
      model: f.claimPayload.model, modelId: f.payload.modelId, maxOutputTokens: 1000, maxTurns: 1, historyItems: 0, tools: [], sources: [], network: 'deny' };
    return { f, sessionId: started.sessionId, context, billing: { ...f.payload, input: context }, requestId: randomUUID() };
  },
  async run({ call, state }) {
    const { f, sessionId, context, billing, requestId } = state;
    await call('runtime_session_context', [f.actor, sessionId]);
    const admitted = await call('runtime_admit', [f.actor, sessionId, requestId, JSON.stringify(context), JSON.stringify(billing)]);
    const begin = await call('runtime_execution', [f.actor, admitted.executionId, 'begin', null]);
    const claimed = await call('bill2_claim', [f.actor, admitted.runId, 1, JSON.stringify({ ...f.claimPayload, runtimeEpoch: begin.epoch })]);
    await call('bill2_dispatch', [f.actor, admitted.runId, claimed.id, claimed.dispatchToken]);
    await call('bill2_record', [f.actor, admitted.runId, claimed.id, JSON.stringify({ provider: f.claimPayload.provider, account: 'sandbox',
      model: f.claimPayload.model,
      protocol: f.claimPayload.protocol, providerId: `gen-load-${claimed.id}`, source: 'response', sourceHash: 'c'.repeat(64),
        observedAt: new Date().toISOString(),
      coverage: 'request_total', final: true, cost: '0.001', currency: 'USD', usage: { inputTokens: 1000, outputTokens: 0 } })]);
    await call('runtime_session_items', [f.actor, sessionId, admitted.executionId, 'append', JSON.stringify([{ role: 'user', content: 'synthetic input' },
      { role: 'assistant', content: 'synthetic answer' }]), null, 0]);
    await call('runtime_execution', [f.actor, admitted.executionId, 'complete', JSON.stringify({ epoch: begin.epoch, value: { kind: 'usable_result',
      body: 'synthetic answer', evidenceRef: `gen-load-${claimed.id}`, evidenceHash: 'd'.repeat(64) } })]);
  },
};
