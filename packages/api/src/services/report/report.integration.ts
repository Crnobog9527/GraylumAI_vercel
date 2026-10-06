/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type pg from 'pg';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { makeWorkflow } from '../__tests__/fixtures/artifacts';
import { opcService } from '../opc/service';
import { workbenchService } from '../artifacts/workbench';
import { reportService } from './service';
import { runtimeExecutor } from '../runtime/execute';
import { openRouterAdapter } from '../bill2/openRouterAdapter';
import { openRouterBound } from '../bill2/openRouterPolicy';
import { configuredReasoning } from '../__tests__/fixtures/runtimeReasoning';
import { pricingConfig } from '../__tests__/fixtures/runtimePricing';
import type { FrozenPaygRun } from '../bill2/service';

type Fixture = { actor: string; user: SupabaseClient; admin: SupabaseClient; registration: string;
  mentorModel: string; flow: ReturnType<typeof makeWorkflow> };
export function registerReportTests(db: pg.Client, fixture: () => Promise<Fixture>) {
  it.each(['complete', 'length', 'waiting', 'expired', 'free', 'disabled', 'changed', 'equal', 'cancelled', 'off_after', 'missing', 'string_flag', 'foreign', 'waiting_expired',
    'sonnet_low', 'sonnet_missing_config', 'sonnet_missing_purpose'] as const)(
    'RUNTIME: REPORT-GEN real SQL and SDK %s', async scenario => {
      const f = await fixture(), opc = opcService(f.user, f.admin), artifacts = workbenchService(f.user, f.admin);
      const d = await opc.start({ requestId: randomUUID(), registration: f.registration, mode: 'manual' });
      const detail = await opc.read(d.draftId);
      for (const step of f.flow.steps) {
        await artifacts.execute({ action: 'save', projectId: detail.projectId, roundId: detail.roundId,
          requestId: randomUUID(), stepId: step.id, body: 'Synthetic confirmed fact', evidenceIds: [], expectedVersion: 0 });
        const before = (await artifacts.read(detail.projectId, detail.roundId)).steps[step.id]!;
        await opc.information({ draftId: d.draftId, stepId: step.id, requestId: randomUUID(), expectedVersion: before.version,
          values: { goal: { status: 'confirmed', nature: 'decision', value: 'Synthetic decision' } } });
        const updated = (await artifacts.read(detail.projectId, detail.roundId)).steps[step.id]!;
        await artifacts.execute({ action: 'confirm', projectId: detail.projectId, roundId: detail.roundId,
          requestId: randomUUID(), stepId: step.id, expectedVersion: updated.version, expectedReviewVersion: updated.reviewVersion });
      }
      await db.query("update profiles set membership_level=$2 where id=$1", [f.actor, scenario === 'free' ? 'free' : 'pro']);
      const real = scenario.startsWith('sonnet_'), windowId = randomUUID();
      const model = real ? 'anthropic/claude-sonnet-5.5' : 'ac1-mentor';
      const endpointTag = real ? 'synthetic/fp8' : 'fixture/report', pricingHash = 'e'.repeat(64);
      const policy: FrozenPaygRun['callPolicy'][number] = { modelId: f.mentorModel, model, provider: 'fixture', account: 'report-fixture',
        protocol: 'fixture-cost-v1', upperUsd: '0.3', multiplier: '6', inputLimit: 196608, outputLimit: 1000,
        automaticRetry: false, hiddenTools: false, lookupSupported: false,
        providerLimits: { providerSlug: endpointTag, contextTokens: 250000, promptUsdPerMillion: '1', completionUsdPerMillion: '1', requestUsd: '0' },
        payg: { version: 'v1', policyId: 'report-test', profileVersion: 'fixture', evidenceVersion: 'fixture', pricingHash, endpointTag,
          templateTokens: 4096, marginTokens: 4096, admissionPath: real ? 'empirical' : 'fixture', maxBytes: 196608, maxMessages: 32,
          maxTools: 0, maxSchemaBytes: 16384, purposes: ['report'], expiresAt: new Date(Date.now() + 7200000).toISOString(),
          nominalPricing: { version: 'nominal-v1', pricingHash, endpointTag,
            tiers: [{ minPromptTokens: 0, prompt: '1', completion: '1', request: '0' }], timeOfDay: [] } } };
      const billingUnit: NonNullable<FrozenPaygRun['rules']['billingUnit']> = { version: 'bill-unit-v2', creditsPerUsd: '100',
        hash: 'f'.repeat(64), defaultMultiplier: '6', providers: {}, models: { [f.mentorModel]: { multiplier: '6', source: 'global' } } };
      const settingKeys = ['runtime_report_generation', 'billing_payg_start_thresholds',
        ...(real ? ['billing_credits_per_usd', 'billing_token_price_multiplier'] : [])];
      const previous = (await db.query('select key,value from system_settings where key=any($1)', [settingKeys])).rows;
      let calls = 0;
      const server = createServer(async (req, res) => {
        let raw = ''; for await (const chunk of req) raw += chunk;
        calls++;
        const wire = JSON.parse(JSON.parse(raw).input);
        expect(wire.messages).toHaveLength(2);
        expect(wire.tools).toBeUndefined();
        expect(wire.max_tokens).toBe(1000);
        const id = 'report-fixture-' + randomUUID();
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ id, model, final: true, cost: '0.003', currency: 'USD', coverage: 'request_total',
          usage: { inputTokens: 3000, outputTokens: 10, sdkResponse: { id, object: 'chat.completion', created: 1, model,
            choices: [{ index: 0, message: { role: 'assistant', content: '## One\nReport body\n## Two\nMore body' },
              finish_reason: scenario === 'length' ? 'length' : 'stop' }],
            usage: { prompt_tokens: 3000, completion_tokens: 10, total_tokens: 3010 } } } }));
      });
      const requests: Array<Record<string, unknown>> = [];
      const adapter = openRouterAdapter({ credential: async () => 'SYNTHETIC_LOCAL_ONLY', transport: async (_url, init) => {
        const wire = JSON.parse(String(init?.body)); requests.push(wire);
        const frame = { id: 'gen-report-' + randomUUID(), object: 'chat.completion.chunk', model,
          choices: [{ index: 0, delta: { role: 'assistant', content: '## One\nReport body\n## Two\nMore body' },
            finish_reason: 'stop' }], usage: { prompt_tokens: 300, completion_tokens: 10, total_tokens: 310, cost: 0.00031 } };
        return new Response('data: ' + JSON.stringify(frame) + '\n\ndata: [DONE]\n\n',
          { headers: { 'content-type': 'text/event-stream' } });
      } });
      try {
        if (real) {
          policy.provider = 'openrouter'; policy.protocol = 'openrouter-chat-v1'; policy.lookupSupported = true;
          policy.outputLimit = 8192;
          policy.upperUsd = openRouterBound(policy.providerLimits!, policy.outputLimit).upperUsd;
          const config = configuredReasoning(model, { mode: 'effort', effort: 'low', wire: 'reasoning_effort' });
          config.reasoning.catalog!.reasoning!.mandatory = true;
          config.reasoning.catalog!.reasoning!.supportedEfforts = ['low'];
          config.reasoning.catalog!.reasoning!.defaultEffort = 'low';
          config.pricing = pricingConfig(model, endpointTag, '1', '1').pricing;
          if (scenario === 'sonnet_missing_purpose') config.reasoning.purposes = {};
          await db.query("update ai_models set model_id=$2,provider='openrouter',input_limit=250000,max_tokens=8192,config=$3 where id=$1",
            [f.mentorModel, model, scenario === 'sonnet_missing_config' ? { pricing: config.pricing } : config]);
          for (const [key, value] of [['billing_credits_per_usd', '100'], ['billing_token_price_multiplier', '6']])
            await db.query('insert into system_settings(key,value) values($1,$2) on conflict(key) do update set value=excluded.value',
              [key, JSON.stringify(value)]);
          const quote = { ...policy }; delete quote.payg;
          await db.query(`insert into runtime_test_windows(id,enabled,actor_ids,call_policies,credits_per_usd,multiplier,
            max_cost_usd,max_calls,expires_at) values($1,true,$2,$3,100,6,10,10,now()+interval '2 hours')`,
            [windowId, [f.actor], JSON.stringify([quote])]);
        }
        for (const [key, value] of Object.entries({ runtime_report_generation: scenario === 'string_flag' ? '{"enabled":true}' : { enabled: scenario !== 'disabled' },
          billing_payg_start_thresholds: { version: 'fixture', thresholds: [{ model, purpose: 'report', credits: scenario.startsWith('waiting') ? 1001 : scenario === 'equal' ? 1000 : 1 }] } })) {
          await db.query('insert into system_settings(key,value) values($1,$2) on conflict(key) do update set value=excluded.value',
            [key, JSON.stringify(value)]);
        }
        if (scenario === 'missing') await db.query("delete from system_settings where key='runtime_report_generation'");
        const service = reportService(f.user, f.admin, { ...(real ? { real: { id: windowId, creditsPerUsd: '100',
          multiplier: '6', expiresAt: new Date(Date.now() + 7200000).toISOString(), callPolicies: [policy] } } : {}), payg: { callPolicies: [policy], billingUnit }, account: 'report-fixture',
          costPerCall: '0.3', creditsPerUsd: '100', multiplier: '6', maxCalls: 1, maxOutputTokens: 1000, inputBytes: 196608, historyItems: 0 });
        const input = { sessionId: detail.sessionId, projectId: detail.projectId, roundId: detail.roundId, requestId: randomUUID() };
        if (['free', 'disabled', 'missing', 'string_flag'].includes(scenario)) {
          await expect(service.start(input)).rejects.toThrow(scenario === 'free' ? 'REPORT_MEMBERSHIP_REQUIRED' : 'REPORT_DISABLED');
          expect((await db.query('select count(*)::int n from runtime_executions where request_id=$1', [input.requestId])).rows[0].n).toBe(0);
          if (scenario !== 'free') await expect(db.query("select report_admission_check($1,$2,'{\"reportGeneration\":{}}','{}')",
            [f.actor, detail.sessionId])).rejects.toThrow('REPORT_DISABLED');
          return;
        }
        if (scenario === 'sonnet_missing_config' || scenario === 'sonnet_missing_purpose') {
          await expect(service.start(input)).rejects.toMatchObject({ cause: { message: 'RUNTIME_REASONING_NOT_CONFIGURED' } });
          expect((await db.query('select count(*)::int n from runtime_executions where request_id=$1', [input.requestId])).rows[0].n).toBe(0);
          expect(requests).toHaveLength(0); expect(calls).toBe(0);
          return;
        }
        const admitted = await service.start(input).catch(error => {
          let cause = error; while (cause.cause) cause = cause.cause; throw new Error(cause.message);
        });
        const frozen = (await db.query('select payload from runtime_executions where id=$1', [admitted.executionId])).rows[0].payload;
        if (real) {
          expect(frozen).toMatchObject({ role: 'skill', providerRequestFormat: 'agent-turn-v5-stream',
            reasoning: { effort: 'low' }, purposeBudget: { purpose: 'report' } });
          // Execution and replay must use the admitted snapshot, not mutable configuration.
          await db.query("update ai_models set config=config-'reasoning' where id=$1", [f.mentorModel]);
          expect(await service.start(input)).toMatchObject({ executionId: admitted.executionId });
        }
        expect(frozen).not.toHaveProperty('promptCache'); expect(frozen).not.toHaveProperty('scopeMaterial');
        expect(frozen.instructions.match(/Synthetic confirmed fact/g)).toHaveLength(3);
        expect(frozen.request.input).toBe('Generate the confirmed report.');
        if (scenario === 'cancelled') {
          // A stale tab with a new requestId cannot start a second paid report while the first is admitted.
          await expect(service.start({ ...input, requestId: randomUUID() })).rejects.toThrow('REPORT_ALREADY_EXISTS');
          const cancelled = await f.admin.rpc('runtime_cancel', { p_actor_id: f.actor, p_execution_id: admitted.executionId });
          expect(cancelled.error).toBeNull(); expect(cancelled.data.state).toBe('cancelled');
          expect(calls).toBe(0); expect((await service.status(admitted.executionId)).body).toBeNull();
          // The round's last report ended without text: a new request is admitted again.
          const again = await service.start({ ...input, requestId: randomUUID() });
          expect(again.executionId).not.toBe(admitted.executionId); expect(calls).toBe(0);
          return;
        }
        if (scenario === 'off_after') await db.query("update system_settings set value='{\"enabled\":false}' where key='runtime_report_generation'");
        if (scenario === 'expired') await db.query("update profiles set membership_level='free' where id=$1", [f.actor]);
        if (scenario === 'changed') {
          const step = (await artifacts.read(detail.projectId, detail.roundId)).steps[f.flow.steps[0]!.id]!;
          await artifacts.execute({ action: 'save', projectId: detail.projectId, roundId: detail.roundId, requestId: randomUUID(),
            stepId: f.flow.steps[0]!.id, body: 'Changed after admission', evidenceIds: [], expectedVersion: step.version });
        }
        if (['expired', 'changed', 'off_after'].includes(scenario)) {
          expect(await service.start(input)).toMatchObject({executionId: admitted.executionId, runId: admitted.runId});
          await expect(service.start({...input, roundId: randomUUID()})).rejects.toThrow('REPORT_REQUEST_CONFLICT');
        }
        if (scenario === 'foreign') {
          const other = await fixture();
          try {
            await db.query("update profiles set membership_level='pro' where id=$1", [other.actor]);
            const foreign = reportService(other.user, other.admin, { account:'report-fixture', costPerCall:'0.3',
              creditsPerUsd:'100', multiplier:'6', maxCalls:1, maxOutputTokens:1000, inputBytes:196608, historyItems:0 });
            await expect(foreign.start(input)).rejects.toThrow('REPORT_SOURCE_CONFLICT');
            await expect(foreign.status(admitted.executionId)).rejects.toMatchObject({code:'BAD_REQUEST',message:'REPORT_UNAVAILABLE'});
            await expect(foreign.latest({ sessionId: input.sessionId, projectId: input.projectId, roundId: input.roundId }))
              .rejects.toMatchObject({ message: 'REPORT_UNAVAILABLE' });
            expect(calls).toBe(0);
          } finally {
            await db.query('update modules set active=false where id=(select module_id from artifact_workflows where id=$1)', [other.registration]);
          }
          return;
        }
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        const run = () => runtimeExecutor({ database: f.admin, actor: async () => f.actor, endpoint, ...(real ? { adapter } : {}),
          callGate: async () => ({ ok: true }) });
        const historyBefore = (await db.query('select revision from runtime_sessions where id=$1', [detail.sessionId])).rows[0].revision;
        let result = await run().execute(admitted.executionId);
        if (scenario === 'expired' || scenario === 'changed') {
          expect(result).toMatchObject({ code: scenario === 'expired' ? 'REPORT_MEMBERSHIP_REQUIRED' : 'REPORT_SOURCE_CONFLICT' });
          expect(calls).toBe(0);
          expect((await db.query('select count(*)::int n from bill2_calls where run_id=$1', [admitted.runId])).rows[0].n).toBe(0);
          return;
        }
        if (scenario.startsWith('waiting')) {
          expect(result).toMatchObject({ state: 'waiting_credits', code: 'RUNTIME_WAITING_CREDITS' }); expect(calls).toBe(0);
          // Fulfillment is represented by a real local grant; do not alter the frozen threshold.
          await db.query(`insert into credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,idempotency_key,balance_before,balance_after)
            values($1,100,'addition','grant','opening_grant','system',$2,1000,1100)`, [f.actor, 'report-refill:' + f.actor]);
          await db.query('update profiles set credits=1100 where id=$1', [f.actor]);
          if (scenario === 'waiting_expired') await db.query("update profiles set membership_level='free' where id=$1", [f.actor]);
          const position = await service.status(admitted.executionId);
          result = await run().execute(admitted.executionId, undefined, { executionId: admitted.executionId, cursor: position.cursor, epoch: position.epoch });
        }
        if (scenario === 'waiting_expired') {
          expect(result).toMatchObject({code:'REPORT_MEMBERSHIP_REQUIRED'}); expect(calls).toBe(0);
          expect((await db.query('select count(*)::int n from bill2_calls where run_id=$1', [admitted.runId])).rows[0].n).toBe(0);
          return;
        }
        expect(result).toMatchObject({ state: 'completed', completeness: scenario === 'length' ? 'length_limit' : 'complete' });
        expect(real ? requests.length : calls).toBe(1);
        if (real) {
          expect(requests[0]).toMatchObject({ model, reasoning_effort: 'low', stream: true, max_tokens: 8192 });
          expect(requests[0]).not.toHaveProperty('reasoning'); expect(requests[0]).not.toHaveProperty('tools');
          expect(requests[0]!.messages).toHaveLength(2);
          expect((await db.query('select payload->>\'phase\' phase, metering_exit, metering_missing, budget_conflict from bill2_calls where run_id=$1', [admitted.runId])).rows)
            .toEqual([{ phase: 'report', metering_exit: false, metering_missing: false, budget_conflict: false }]);
        }
        if (scenario === 'length') {
          expect((await db.query('select charged_delta from bill2_calls where run_id=$1', [admitted.runId])).rows[0].charged_delta).toBe(2);
          expect((await db.query('select credits from profiles where id=$1', [f.actor])).rows[0].credits).toBe(998);
        }
        await run().execute(admitted.executionId); expect(real ? requests.length : calls).toBe(1);
        const counts = (await db.query(`select (select count(*)::int from runtime_session_history where execution_id=$1) history,
          (select count(*)::int from runtime_session_batches where execution_id=$1) batches,
          (select count(*)::int from bill2_calls where run_id=$2) calls`, [admitted.executionId, admitted.runId])).rows[0];
        expect(counts).toEqual({ history: 0, batches: 1, calls: 1 });
        expect((await db.query('select revision from runtime_sessions where id=$1', [detail.sessionId])).rows[0].revision).toBe(historyBefore);
        // One paid report per round: a stale tab's new requestId is refused, the same one replays.
        // (With the switch off, REPORT_DISABLED answers first; off_after covers that.)
        if (scenario !== 'off_after')
          await expect(service.start({ ...input, requestId: randomUUID() })).rejects.toThrow('REPORT_ALREADY_EXISTS');
        expect(await service.start(input)).toMatchObject({ executionId: admitted.executionId });
        expect(real ? requests.length : calls).toBe(1);
        await db.query("update profiles set membership_level='free' where id=$1", [f.actor]);
        const read = await service.status(admitted.executionId);
        expect(read.body).toContain('Report body'); expect(read.candidate).toBe(scenario !== 'length');
        // A saved report is found from the server with the switch off and the membership lapsed.
        await db.query("delete from system_settings where key='runtime_report_generation'");
        const locate = { sessionId: input.sessionId, projectId: input.projectId, roundId: input.roundId };
        expect(await service.latest(locate)).toEqual({ executionId: admitted.executionId });
        expect(await service.latest({ ...locate, roundId: randomUUID() })).toEqual({ executionId: null });
      } finally {
        await db.query('update modules set active=false where id=(select module_id from artifact_workflows where id=$1)', [f.registration]);
        if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        await db.query('delete from system_settings where key=any($1)', [settingKeys]);
        for (const row of previous) await db.query('insert into system_settings(key,value) values($1,$2)', [row.key, row.value]);
      }
    }, 30000);
}
