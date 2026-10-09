/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeAll, afterAll, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import { makePackage, makeWorkflow } from '../__tests__/fixtures/artifacts';
import { publishSkillPackage } from '../skills/publication';
import { opcService } from './service';
import { captureCompleted } from './capture';
import { readCaptureOutput } from '../../shared/conversationCapture';
import { runtimeExecutor } from '../runtime/execute';
import { runtimeAdmissionService } from '../runtime/admission';

const connectionString = process.env.V3_LOCAL_DB!;
if (!connectionString?.startsWith('postgres://postgres@127.0.0.1:') ||
  !connectionString.endsWith('/v3_disposable')) throw new Error('isolated runner required');
if (!process.env.V3_LOCAL_REST?.startsWith('http://127.0.0.1:')) throw new Error('isolated REST required');
const db = new pg.Client({ connectionString });
const admin = createClient(process.env.V3_LOCAL_REST!, process.env.V3_LOCAL_SERVICE_JWT!, { auth: { persistSession: false } });
beforeAll(() => db.connect());
afterAll(() => db.end());
async function rpc(name: string, args: Record<string, unknown>) {
  const result = await admin.rpc(name, args);
  if (result.error) throw new Error(result.error.message);
  return result.data;
}
const tuple = (value = '', status = 'unknown', nature = 'unknown') => ({ value, status, nature });
const patch = (value = 'A', stepId = 'step-0', fieldId = 'goal') =>
  ({ stepId, fieldId, value, status: 'provisional', nature: 'fact', basis: 'user_statement' });
const output = (patches = [patch()]) => JSON.stringify({ inputKind: 'answer', patches, notes: [] });
// Older capture tests reload 0159/0182 definitions; reapply the V3 patches afterwards (marker makes reruns no-ops).
const withdrawMigration = () => db.query(readFileSync(resolve(import.meta.dirname, '../../../../db/migrations/0199_opc_suggestion_withdraw.sql'), 'utf8'));

async function fixture(extraFields = 0, informationCounts?: number[], allRequired = false, proposalField = false) {
  const owner = randomUUID(), model = randomUUID(), moduleId = randomUUID();
  const email = randomUUID() + '@example.test', password = 'Local-' + randomUUID() + '!';
  const made = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (made.error) throw made.error;
  const actor = made.data.user.id;
  const pack = makePackage(), registration = 'capture-' + randomUUID(), flow = makeWorkflow(informationCounts?.length ?? 3);
  await db.query("insert into profiles(id,role,credits) values($1,'admin',10000),($2,'user',10000)", [owner, actor]);
  await db.query("insert into credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,idempotency_key,balance_before,balance_after) values($1,10000,'addition','grant','opening_grant','system',$2,0,10000)", [actor, randomUUID()]);
  await db.query('insert into skills(id,skill_key,created_by) values($1,$2,$3)', [pack.id, registration, owner]);
  await db.query("insert into ai_models(id,name,model_id,provider,is_active,max_tokens,input_limit) values($1,'Capture fixture','opc-fixture-default','fixture','true',1000,64000)", [model]);
  await db.query('insert into modules(id,title,skill_id,model_id,active) values($1,$2,$3,$4,true)', [moduleId, registration, pack.id, model]);
  flow.steps.forEach((s, i) => { s.information = Array.from({ length: informationCounts?.[i] ?? 2 }, (_, field) =>
    field === 0 ? { id: 'goal', title: 'Goal', required: true, profileKey: 'goal_' + i }
      : { id: field === 1 ? 'other' : 'extra' + field, title: 'Other', required: allRequired }); });
  for (let i = 0; i < extraFields; i++) flow.steps[0].information!.push({ id: 'extra' + i, title: 'Extra', required: false });
  if (proposalField) for (const index of [0, 2]) {
    Object.assign(flow.steps[index]!.information![1]!, {
      elicitation: 'agent_proposal', description: '具体的试行计划；保留频率和商业限制，不当作已完成事实。',
    });
  }
  await publishSkillPackage(admin, owner, pack);
  await db.query('insert into artifact_workflows(id,module_id,skill_id,revision_id,workflow,label,enabled) values($1,$2,$3,$4,$5,$6,true)', [registration, moduleId, pack.id, pack.revisionId, flow, registration]);
  const user = createClient(process.env.V3_LOCAL_REST!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
  const login = await user.auth.signInWithPassword({ email, password });
  if (login.error) throw login.error;
  const service = opcService(user, admin);
  const draft = await service.start({ requestId: randomUUID(), registration, mode: 'mentor' });
  await db.query(`update artifact_rounds r set steps=(select jsonb_object_agg(s.key,
    s.value || jsonb_build_object('information',(select jsonb_object_agg(f->>'id',
      jsonb_build_object('value','','status','unknown','nature','unknown'))
      from jsonb_array_elements(r.workflow->'steps') w,jsonb_array_elements(w->'information') f where w->>'id'=s.key)))
    from jsonb_each(r.steps) s) where r.id=(select round_id from opc_drafts where draft_id=$1)`, [draft.draftId]);
  const read = () => service.read(draft.draftId);
  const d = (await db.query('select opc_query($1,$2) v', [actor, draft.draftId])).rows[0].v;
  const apply = (id: string | null = null) => rpc('opc_capture_apply', { p_actor_id: actor, p_draft_id: draft.draftId, p_execution_id: id });
  const records = () => db.query("select * from artifact_requests where project_id=$1 and action='opc_capture' order by request_id", [d.projectId]);
  const steps = async () => (await db.query('select steps from artifact_rounds where id=$1', [d.roundId])).rows[0].steps;
  const save = async (value: string, field = 'goal') => {
    const current = await steps();
    return service.information({ draftId: draft.draftId, requestId: randomUUID(), stepId: 'step-0',
      expectedVersion: current['step-0'].version, values: { ...current['step-0'].information, [field]: tuple(value, value ? 'provisional' : 'unknown', value ? 'fact' : 'unknown') } });
  };
  const prepare = async (requestId: string, targetDraftId: string, client: typeof admin, databaseCapacity = false) => {
    // Artificial SQL capacity/performance fixtures use a short synthetic
    // instruction. Real method freeze/replay cases below use the unchanged OPC host.
    const material = databaseCapacity ? await rpc('opc_step_material', { p_actor_id: actor,
      p_draft_id: targetDraftId, p_request_id: requestId, p_step_id: 'step-0',
      p_purpose: 'mentor', p_input: 'Synthetic capture input' }) : null;
    return material ? await runtimeAdmissionService(user, client, {
      account: 'runtime-local', costPerCall: '0.02', creditsPerUsd: '1000', multiplier: '1',
      maxCalls: 1, maxOutputTokens: 1000, inputBytes: 64000, historyItems: 100,
      expectedMaterialRevision: material.revision, opcTurnToken: material.turnToken,
      additionalInstructions: 'Synthetic database capacity fixture', mentorStream: true,
      skillResources: ['SKILL.md'], searchEnabled: false,
    }).prepare({ sessionId: d.sessionId, requestId, input: 'Synthetic capture input', network: 'deny', sources: [],
      selection: { kind: 'skill', moduleId, revisionId: pack.revisionId, task: 'opc-question:goal' } })
      : await opcService(user, client).prepareStep({ draftId: targetDraftId,
        requestId, stepId: 'step-0', purpose: 'mentor', questionId: 'goal', input: 'Synthetic capture input' });
  };
  // Construct persisted executions through the real admission authority. A synthetic
  // DB-only completion keeps this suite independent of providers and transport.
  const seed = async (summary = output(), v2 = true, targetDraftId = draft.draftId, databaseCapacity = false) => {
    const requestId = randomUUID();
    const bypassCapture = new Proxy(admin, {
      get(target, key) {
        if (key !== 'rpc') return Reflect.get(target, key);
        return (name: string, args: Record<string, unknown>) => name === 'opc_capture_apply'
          ? { abortSignal: async () => ({ data: { processed: [], remaining: 0, hasMore: false }, error: null }) }
          : target.rpc(name, args);
      },
    });
    const prepared = await prepare(requestId, targetDraftId, bypassCapture, databaseCapacity);
    const id = prepared.executionId;
    await rpc('runtime_cancel', { p_actor_id: actor, p_execution_id: id });
    await db.query(`update runtime_executions set state='completed',unavailable_reason=null,result=$2,
      payload=payload || jsonb_build_object('attachedOrganizer',$3::jsonb) where id=$1`,
    [id, { body: 'Synthetic mentor', summary }, { input: JSON.stringify(v2 ? { captureFormat: 'v2' } : {}) }]);
    return id;
  };
  return { actor, model, moduleId, user, service, draft, d, read, apply, records, steps, save, seed, prepare };
}

it('RUNTIME: capture classification, permissions and unchanged content for terminal refusals', async () => {
  const f = await fixture();
  const before = await f.steps();
  const old = await f.seed(output(), false);
  expect(await f.apply(old)).toMatchObject({ result: 'skipped_format' });
  const malformed = await f.seed('not json');
  expect(await f.apply(malformed)).toMatchObject({ result: 'invalid_output' });
  const pending = await f.seed();
  await db.query("update runtime_executions set state='running' where id=$1", [pending]);
  expect(await f.apply(pending)).toEqual({ result: 'not_ready' });
  const denied = await f.seed();
  await db.query("update runtime_executions set payload=jsonb_set(payload,'{opcTurnToken}',to_jsonb($2::text)) where id=$1", [denied, randomUUID()]);
  expect(await f.apply(denied)).toMatchObject({ result: 'denied_binding' });
  const unavailable = await f.seed();
  await db.query("update runtime_executions set unavailable_reason='revoked' where id=$1", [unavailable]);
  expect(await f.apply(unavailable)).toEqual({ result: 'unavailable' });
  expect(await f.steps()).toEqual(before);
  expect((await f.records()).rows).toHaveLength(3);
  await expect(rpc('opc_capture_apply', { p_actor_id: randomUUID(), p_draft_id: f.draft.draftId, p_execution_id: old })).rejects.toThrow();
  const other = await fixture();
  await expect(other.apply(old)).rejects.toThrow('OPC_CAPTURE_DENIED');
  expect((await other.records()).rows).toHaveLength(0);
  expect((await db.query("select has_function_privilege('authenticated','opc_capture_apply(uuid,uuid,uuid)','execute') client,has_function_privilege('service_role','opc_capture_apply(uuid,uuid,uuid)','execute') server")).rows[0]).toEqual({ client: false, server: true });
});

it('RUNTIME: capture applies untouched fields across steps and conservatively protects manual values', async () => {
  const f = await fixture();
  const first = await f.seed(output([patch(), patch('later', 'step-2')]));
  expect(await f.apply(first)).toMatchObject({ result: 'applied' });
  const a = await f.steps();
  expect(a['step-0'].information.goal.value).toBe('A');
  expect(a['step-2'].information.goal.value).toBe('later');
  expect(await f.apply(first)).toEqual(await f.apply(first));
  const second = await f.seed(output([patch('B')]));
  expect(await f.apply(second)).toMatchObject({ result: 'applied' });
  await f.save('manual');
  const third = await f.seed(output([patch('C')]));
  expect(await f.apply(third)).toMatchObject({ result: 'suggested' });
  const current = await f.steps();
  expect(current['step-0'].information.goal.value).toBe('manual');
  expect(current['step-0'].fieldMeta.goal.suggestion.value).toBe('C');
  await db.query("update runtime_executions set unavailable_reason='revoked' where id=$1", [first]);
  expect(await f.apply(first)).toEqual({ result: 'unavailable' });
});

it.each([0, 5, 6])('RUNTIME: capture batch counts and concurrent clients (%i pending)', async count => {
  const f = await fixture();
  for (let i = 0; i < count; i++) await f.seed(output([patch(String(i))]));
  const results = await Promise.all([f.apply(), f.apply()]);
  expect(results.reduce((n, r) => n + r.processed.length, 0)).toBe(count);
  results.sort((a, b) => b.processed.length - a.processed.length);
  expect(results[0].processed.length).toBe(Math.min(count, 5));
  expect(results[0].remaining).toBe(Math.max(0, count - 5));
  expect(results[0].hasMore).toBe(count > 5);
  expect((await f.records()).rows).toHaveLength(count);
  expect(await f.apply()).toEqual({ processed: [], remaining: 0, hasMore: false });
});

it('RUNTIME: capture invalid first output advances and storage failure rolls back the whole batch', async () => {
  const f = await fixture();
  await f.seed(output([])); await f.apply();
  const ids = [await f.seed('{'), await f.seed(), await f.seed(output([patch('C')]))];
  await db.query(`create function capture_test_failure() returns trigger language plpgsql as $$ begin
    if NEW.action='opc_capture' and NEW.payload->>'executionId'='${ids[2]}' then raise exception 'synthetic storage failure';end if;return NEW;end $$;
    create trigger capture_test_failure before insert on artifact_requests for each row execute function capture_test_failure()`);
  const before = await f.steps();
  try { await expect(f.apply()).rejects.toThrow('synthetic storage failure'); }
  finally { await db.query('drop trigger capture_test_failure on artifact_requests; drop function capture_test_failure()'); }
  expect(await f.steps()).toEqual(before);
  expect((await f.records()).rows).toHaveLength(1);
  const done = await f.apply();
  expect(done.processed.map((x: { result: string }) => x.result)).toEqual(['invalid_output', 'applied', 'suggested']);
  expect(done.hasMore).toBe(false);
});

it('RUNTIME: capture resolve checks suggestion identity, ignores without version change and accepts as user', async () => {
  const f = await fixture();
  await f.save('user');
  const s1 = await f.seed(output([patch('S1')]));
  await f.apply(s1);
  const old = (await f.steps())['step-0'];
  const s2 = await f.seed(output([patch('S2')]));
  await f.apply(s2);
  const resolve = (id: string, hash: string, action: 'accept' | 'ignore', requestId = randomUUID()) => f.service.captureResolve({
    draftId: f.draft.draftId, requestId, stepId: 'step-0', fieldId: 'goal', executionId: id, hash, action, expectedVersion: old.version,
  });
  await expect(resolve(s1, old.fieldMeta.goal.suggestion.hash, 'ignore')).rejects.toThrow('OPC_SUGGESTION_CHANGED');
  const newest = (await f.steps())['step-0'];
  const request = randomUUID();
  expect(await resolve(s2, newest.fieldMeta.goal.suggestion.hash, 'ignore', request)).toEqual({ version: old.version, result: 'ignore' });
  expect(await resolve(s2, newest.fieldMeta.goal.suggestion.hash, 'ignore', request)).toEqual({ version: old.version, result: 'ignore' });
  expect((await f.steps())['step-0'].reviewVersion).toBe(old.reviewVersion);
  const s3 = await f.seed(output([patch('accepted')]));
  await f.apply(s3);
  await resolve(s3, (await f.steps())['step-0'].fieldMeta.goal.suggestion.hash, 'accept');
  expect((await f.steps())['step-0'].fieldMeta.goal.source).toBe('user');
});

it('RUNTIME: capture complete callback persists and new projection strips private metadata', async () => {
  const f = await fixture();
  const id = await f.seed();
  await captureCompleted(admin, f.actor, id);
  expect((await f.records()).rows).toHaveLength(1);
  await f.save('user');
  await f.apply(await f.seed(output([patch('suggestion')])));
  const projection = (await db.query('select runtime_work_projection($1,$2,$3) v', [f.actor, f.d.sessionId, f.d.roundId])).rows[0].v;
  expect(projection.steps['step-0'].fieldMeta.goal).toEqual({protected:true,source:'user',basis:'user_statement',hasPendingSuggestion:true});
  expect(projection.steps['step-0'].information.goal.value).toBe('user');
  const view = await f.read();
  expect(view.information['step-0'].meta.goal.suggestion.value).toBe('suggestion');
  await db.query("update runtime_executions set unavailable_reason='revoked' where id=$1",
    [view.information['step-0'].meta.goal.suggestion.executionId]);
  const hidden=(await db.query('select runtime_work_projection($1,$2,$3) v',[f.actor,f.d.sessionId,f.d.roundId])).rows[0].v;
  expect(hidden.steps['step-0'].fieldMeta.goal.hasPendingSuggestion).toBe(false);
});

it.each(['nonempty', 'cleared', 'confirmed', 'deferred', 'changed-fingerprint', 'missing-record', 'A-B-A', 'A-empty-A'])
('RUNTIME: capture source protection survives legacy history (%s)', async mode => {
  const f = await fixture();
  if (['changed-fingerprint', 'missing-record', 'A-B-A', 'A-empty-A'].includes(mode)) {
    await f.apply(await f.seed());
  }
  if (mode === 'nonempty' || mode === 'confirmed' || mode === 'deferred') {
    await db.query("update artifact_rounds set steps=jsonb_set(steps,'{step-0,information,goal}',$2) where id=$1",
      [f.d.roundId, tuple('legacy', mode === 'nonempty' ? 'provisional' : mode, 'fact')]);
  } else if (mode === 'cleared') {
    await f.save('once'); await f.save('');
    await db.query("update artifact_rounds set steps=steps #- '{step-0,fieldMeta}' where id=$1", [f.d.roundId]);
  } else if (mode === 'changed-fingerprint') {
    await db.query("update artifact_rounds set steps=jsonb_set(steps,'{step-0,information,goal,value}','\"changed\"') where id=$1", [f.d.roundId]);
  } else if (mode === 'missing-record') {
    await db.query("update artifact_rounds set steps=jsonb_set(steps,'{step-0,fieldMeta,goal,executionId}',to_jsonb($2::text)) where id=$1", [f.d.roundId, randomUUID()]);
  } else {
    // The old function leaves capture metadata untouched during a rollback.
    const metadata = (await f.steps())['step-0'].fieldMeta;
    await f.save(mode === 'A-B-A' ? 'B' : ''); await f.save('A');
    await db.query("update artifact_rounds set steps=jsonb_set(steps,'{step-0,fieldMeta}',$2) where id=$1", [f.d.roundId, metadata]);
  }
  const before = await f.steps();
  expect(await f.apply(await f.seed(output([patch('new')])))).toMatchObject({ result: 'suggested' });
  const after = await f.steps();
  expect(after['step-0'].information).toEqual(before['step-0'].information);
  expect(after['step-0'].version).toBe(before['step-0'].version);
});

it.each([false, true])('RUNTIME: capture permission restoration checks every frozen step (edited=%s)', async edited => {
  const f = await fixture();
  const id = await f.seed(output([patch('other value', 'step-0', 'other')]));
  await db.query("update ai_models set is_active='false' where id=$1", [f.model]);
  expect(await f.apply(id)).toEqual({ result: 'unavailable' });
  expect(await f.apply()).toEqual({ processed: [], remaining: 0, hasMore: false });
  expect((await f.records()).rows).toHaveLength(0);
  if (edited) await f.save('manual goal');
  await db.query("update ai_models set is_active='true' where id=$1", [f.model]);
  expect(await f.apply(id)).toMatchObject({ result: edited ? 'suggested' : 'applied' });
});

it.each(['revoke-first', 'capture-first'])('RUNTIME: capture and revocation serialize on two connections (%s)', async order => {
  const f = await fixture(), id = await f.seed();
  const c = new pg.Client({ connectionString }); await c.connect();
  try {
    await c.query("begin; set local lock_timeout='5s'; set local statement_timeout='10s'");
    if (order === 'revoke-first') {
      await c.query("update ai_models set is_active='false' where id=$1", [f.model]);
      const applying = f.apply(id);
      await c.query('commit');
      expect(await applying).toEqual({ result: 'unavailable' });
      expect((await f.records()).rows).toHaveLength(0);
    } else {
      expect((await c.query('select opc_capture_apply($1,$2,$3) v', [f.actor, f.draft.draftId, id])).rows[0].v.result).toBe('applied');
      const revoking = db.query("update ai_models set is_active='false' where id=$1", [f.model]);
      await c.query('commit'); await revoking;
      expect((await f.records()).rows).toHaveLength(1);
      expect(await f.apply(id)).toEqual({ result: 'unavailable' });
    }
  } finally { await c.query('rollback'); await c.end(); }
});

it('RUNTIME: capture whole-material CAS and execution ordering preserve newer suggestions', async () => {
  const f = await fixture();
  const old = await f.seed(output([patch('old', 'step-0', 'other')]));
  await f.save('changed another field');
  const recent = await f.seed(output([patch('recent', 'step-0', 'other')]));
  await f.apply(recent);
  expect(await f.apply(old)).toMatchObject({ result: 'suggested' });
  expect((await f.steps())['step-0'].information.other.value).toBe('recent');
  const s1 = await f.seed(output([patch('S1')])), s2 = await f.seed(output([patch('S2')]));
  await f.apply(s2); await f.apply(s1);
  expect((await f.steps())['step-0'].fieldMeta.goal.suggestion.value).toBe('S2');
});

it.each([6, 21])('RUNTIME: capture drains before new admission and never charges pending backlog (%i)', async count => {
  const f = await fixture();
  for (let i = 0; i < count; i++) await f.seed(output([]));
  const before = (await db.query('select count(*)::integer n from bill2_runs where actor_id=$1', [f.actor])).rows[0].n;
  const request = { draftId: f.draft.draftId, requestId: randomUUID(), stepId: 'step-0', purpose: 'mentor', questionId: 'goal', input: 'next' };
  if (count > 20) {
    await expect(f.service.prepareStep(request)).rejects.toThrow('OPC_CAPTURE_PENDING');
    expect((await db.query('select count(*)::integer n from bill2_runs where actor_id=$1', [f.actor])).rows[0].n).toBe(before);
    expect((await f.apply()).processed).toHaveLength(1);
  } else {
    const prepared = await f.service.prepareStep(request);
    expect(prepared.executionId).toBeTruthy();
    expect((await f.records()).rows).toHaveLength(6);
    await rpc('runtime_cancel', { p_actor_id: f.actor, p_execution_id: prepared.executionId });
  }
}, 60000);

it('RUNTIME: capture skips unavailable queue entries and rejects stale rounds without changing information', async () => {
  const f = await fixture();
  const revoked = await f.seed();
  await db.query("update runtime_executions set unavailable_reason='revoked' where id=$1", [revoked]);
  const good = await f.seed();
  expect((await f.apply()).processed).toEqual([{ executionId: good, result: 'applied' }]);
  const stale = await f.seed();
  await db.query("update runtime_executions set payload=jsonb_set(payload,'{scopeMaterial,content,work,roundId}',to_jsonb($2::text)) where id=$1", [stale, randomUUID()]);
  const before = await f.steps();
  expect(await f.apply(stale)).toMatchObject({ result: 'stale_round' });
  expect(await f.steps()).toEqual(before);
});

it('RUNTIME: capture rejects invalid items and confirmed steps only receive suggestions', async () => {
  const f = await fixture();
  const id = await f.seed(output([
    patch('', 'step-0'), patch('x'.repeat(401)), patch('x', 'unknown'), patch('x', 'step-0', 'unknown'),
    { ...patch('x'), status: 'confirmed' }, patch('safe', 'step-1'),
  ]));
  await db.query("update artifact_rounds set steps=jsonb_set(steps,'{step-1,valid}','true') where id=$1", [f.d.roundId]);
  const before = await f.steps();
  const result = await f.apply(id);
  expect(result.result).toBe('suggested');
  expect(result.discarded).toHaveLength(5);
  expect(result.discarded).toEqual([1, 2, 3, 4, 5].map(index => ({ index, reason: 'invalid_patch' })));
  expect(JSON.stringify((await f.records()).rows)).not.toContain('safe');
  const after = await f.steps();
  expect(after['step-1'].information).toEqual(before['step-1'].information);
  expect(after['step-1'].version).toBe(before['step-1'].version);
  expect(after['step-1'].valid).toBe(true);
  expect(after['step-1'].fieldMeta.goal.suggestion.value).toBe('safe');
});

it('RUNTIME: capture long session uses turn candidates and preserves billing and replay', async () => {
  const f = await fixture(), id = await f.seed(output([]));
  await db.query(`insert into runtime_executions(actor_id,session_id,request_id,payload,history_revision,state)
    select actor_id,session_id,gen_random_uuid(),payload-'attachedOrganizer',history_revision,'completed'
    from runtime_executions cross join generate_series(1,300) where id=$1`, [id]);
  const before = (await db.query('select credits,(select count(*) from bill2_runs where actor_id=$1) runs from profiles where id=$1', [f.actor])).rows[0];
  const started = performance.now();
  expect((await f.service.capturePending({ draftId: f.draft.draftId })).processed).toHaveLength(1);
  expect(performance.now() - started).toBeLessThan(3000);
  const after = (await db.query('select credits,(select count(*) from bill2_runs where actor_id=$1) runs from profiles where id=$1', [f.actor])).rows[0];
  expect(after).toEqual(before);
  const execution = (await db.query('select payload,request_id from runtime_executions where id=$1', [id])).rows[0];
  expect(await rpc('runtime_admission_replay', { p_actor_id: f.actor, p_request_id: execution.request_id,
    p_request: execution.payload.request })).toMatchObject({ executionId: id });
});

it('RUNTIME: capture v2 summary parsing accepts only strict objects', async () => {
  const f = await fixture();
  for (const raw of ['```json\n' + output() + '\n```', '[]', 'null', '{}',
    JSON.stringify({ inputKind: 'answer', patches: {}, notes: [] }),
    output(Array.from({ length: 13 }, () => patch()))]) {
    expect(readCaptureOutput(raw, f.d.information)).toBeNull();
    expect(await f.apply(await f.seed(raw))).toMatchObject({ result: 'invalid_output' });
  }
  expect(await f.apply(await f.seed(output([])))).toMatchObject({ result: 'suggested' });
  for (const value of ['  ', '\t', '😀'.repeat(400), '😀'.repeat(401)]) {
    const raw = output([patch(value), {...patch('bad'), status:'confirmed'}, patch('valid', 'step-1')]);
    const parsed = readCaptureOutput(raw, f.d.information)!;
    const result = await f.apply(await f.seed(raw));
    expect(result.discarded.map((entry: {index: number}) => entry.index)).toEqual(parsed.discarded);
    expect(parsed.patches.length + parsed.discarded.length).toBe(3);
  }
});

it('RUNTIME: capture rollback rejects a second rollback, preserves values and protects A-B-A after reenabling', async () => {
  const f = await fixture();
  await f.apply(await f.seed());
  const rollback = readFileSync(resolve('../../docs/launch/rollback/CONVERSATION_CAPTURE_B1.sql'), 'utf8');
  const forward = readFileSync(resolve('../db/migrations/0159_opc_capture.sql'), 'utf8');
  // Exercise the historical rollback against its exact 0159 definitions, then restore current migration.
  const latest = readFileSync(resolve('../db/migrations/0182_opc_mentor_checklist.sql'), 'utf8');
  for (const name of ['opc_information','runtime_work_projection','opc_capture_apply','opc_query','opc_capture_resolve']) {
    await db.query(forward.match(new RegExp('CREATE OR REPLACE FUNCTION ' + name + '[\\s\\S]*?END \\$\\$;'))![0]);
  }
  const definitions = async () => (await db.query(`select proname,pg_get_functiondef(oid) body from pg_proc
    where pronamespace='public'::regnamespace and proname in ('opc_information','opc_query','runtime_work_projection') order by proname`)).rows;
  try {
    await db.query(rollback);
    const first = await definitions();
    await expect(db.query(rollback)).rejects.toThrow('OPC_CAPTURE_ROLLBACK_SOURCE_MISMATCH');
    await db.query('rollback');
    expect(await definitions()).toEqual(first);
    await f.save('B'); await f.save('A');
  } finally { await db.query(forward); }
  expect(await f.apply(await f.seed(output([patch('new')])))).toMatchObject({ result: 'suggested' });
  expect((await f.steps())['step-0'].information.goal.value).toBe('A');
  await db.query(forward);
  expect((await f.steps())['step-0'].information.goal.value).toBe('A');
  await db.query(latest);
  await withdrawMigration();
});

it('RUNTIME: capture information byte capacity falls back to suggestions', async () => {
  const f = await fixture(22);
  const current = (await f.steps())['step-0'];
  const values = Object.fromEntries(Object.keys(current.information).map(key => [key,
    key === 'goal' ? tuple() : tuple('x'.repeat(400), 'provisional', 'fact')]));
  await f.service.information({ draftId: f.draft.draftId, requestId: randomUUID(), stepId: 'step-0', expectedVersion: current.version, values });
  expect(await f.apply(await f.seed(output([patch('😀'.repeat(400))]), true, f.draft.draftId, true)))
    .toMatchObject({ result: 'suggested' });
  const after = await f.steps();
  expect(after['step-0'].information.goal.value).toBe('');
  expect(after['step-0'].fieldMeta.goal.suggestion.value).toBe('😀'.repeat(400));
});

it.each(['ascii', 'utf8'])('RUNTIME: full fields and protected markers fit 32768 bytes for new freeze and old request recovery (%s)', async encoding => {
  // Same six-step/nine-field public shape pinned by agentTurnPromptCapacity.test.ts.
  const f = await fixture(0, [3, 1, 2, 1, 1, 1]);
  for (const [stepId, step] of Object.entries(await f.steps()) as Array<[string, { version: number; information: Record<string, unknown> }]>) {
    const values = Object.fromEntries(Object.keys(step.information).map(key => {
      const value = (encoding === 'ascii' ? 'x' : '汉').repeat(400);
      return [key, tuple(value, 'provisional', 'fact')];
    }));
    await f.service.information({ draftId: f.draft.draftId, requestId: randomUUID(), stepId, expectedVersion: step.version, values });
  }
  const root = resolve(import.meta.dirname, '../../../../..');
  const forward = readFileSync(resolve(root, 'packages/db/migrations/0182_opc_mentor_checklist.sql'), 'utf8');
  const rollback = readFileSync(resolve(root, 'docs/launch/rollback/CONVERSATION_CAPTURE_B1.sql'), 'utf8');
  const oldProjection = rollback.match(/CREATE OR REPLACE FUNCTION runtime_work_projection[\s\S]*?END \$\$;/)![0];
  let oldId: string;
  await db.query(oldProjection);
  try { oldId = await f.seed(output([]), false); } finally { await db.query(forward); }
  const old = (await db.query('select request_id,payload from runtime_executions where id=$1', [oldId!])).rows[0];
  const raw = await f.steps();
  for (const step of Object.values(raw) as Array<{ fieldMeta: Record<string, Record<string, unknown>> }>) {
    for (const meta of Object.values(step.fieldMeta)) meta.suggestion = { value: 'S'.repeat(400), executionId: oldId! };
  }
  await db.query('update artifact_rounds set steps=$2 where id=$1', [f.d.roundId, raw]);
  const id = await f.seed(output([]));
  const frozen = (await db.query(`select payload,octet_length((payload#>'{scopeMaterial,content}')::text) bytes,
    octet_length(payload::text) payload_bytes from runtime_executions where id=$1`, [id])).rows[0];
  expect(frozen.bytes).toBeLessThanOrEqual(32768);
  expect(frozen.payload_bytes).toBeLessThanOrEqual(262144);
  let fields = 0;
  for (const step of Object.values(frozen.payload.scopeMaterial.content.work.steps) as Array<{ fieldMeta: Record<string, unknown>; information: Record<string, { value: string }> }>) {
    expect(Object.keys(step.fieldMeta).sort()).toEqual(Object.keys(step.information).sort());
    for (const [field, meta] of Object.entries(step.fieldMeta)) {
      expect(meta).toMatchObject({protected:true,source:'user',hasPendingSuggestion:true});
      expect(step.information[field].value).toHaveLength(400); fields++;
    }
  }
  expect(fields).toBe(9);
  expect(JSON.stringify(frozen.payload.scopeMaterial.content)).not.toContain('suggestion');
  expect(JSON.stringify(frozen.payload.scopeMaterial.content)).not.toContain('"fp"');
  const adapter = { dispatch: async () => { throw new Error('no model dispatch'); }, lookup: async () => { throw new Error('no provider lookup'); } };
  expect(await runtimeExecutor({ callGate: async () => { throw new Error('replay must not call the gate'); }, database: admin, actor: async () => f.actor, adapter }).execute(oldId!))
    .toMatchObject({ state: 'completed', body: 'Synthetic mentor' });
  expect(await f.service.prepareStep({ draftId: f.draft.draftId, requestId: old.request_id,
    stepId: 'step-0', purpose: 'mentor', questionId: 'goal', input: 'Synthetic capture input' }))
    .toMatchObject({ executionId: oldId! });
  expect((await db.query('select payload from runtime_executions where id=$1', [oldId!])).rows[0].payload).toEqual(old.payload);
  console.info('B1 capacity', JSON.stringify({ encoding, fields, charactersPerField: 400, protectedMarkers: fields,
    contentBytes: frozen.bytes, payloadBytes: frozen.payload_bytes, notes: 0 }));
});

it.each(['purpose', 'revision', 'module', 'published'])('RUNTIME: capture frozen binding result (%s)', async mode => {
  const f = await fixture(), id = await f.seed();
  if (mode === 'purpose') {
    // Use a correctly saved non-mentor turn; only its completed result is synthetic.
    await db.query('alter table opc_turns disable trigger artifact_immutable');
    try { await db.query("update opc_turns set purpose='step' where session_id=$1", [f.d.sessionId]); }
    finally { await db.query('alter table opc_turns enable trigger artifact_immutable'); }
  } else if (mode === 'published') {
    await db.query("update artifact_rounds set state='published' where id=$1", [f.d.roundId]);
  } else {
    await db.query('update runtime_executions set payload=jsonb_set(payload,$2,to_jsonb($3::text)) where id=$1',
      [id, [mode === 'revision' ? 'revisionId' : 'moduleId'], randomUUID()]);
  }
  const before = await f.steps();
  expect(await f.apply(id)).toMatchObject({ result: mode === 'published' ? 'stale_round' : 'denied_binding' });
  expect(await f.steps()).toEqual(before);
});

it.each(['material', 'ancestor'])('RUNTIME: capture checks revoked frozen material and ancestors (%s)', async mode => {
  const f = await fixture(), ancestor = await f.seed(output([])), id = await f.seed();
  if (mode === 'material') {
    await db.query('update runtime_scope_material set revoked=true where session_id=$1', [f.d.sessionId]);
  } else {
    await db.query('insert into runtime_history_dependencies(execution_id,dependency_id) values($1,$2) on conflict do nothing', [id, ancestor]);
    await db.query("update runtime_executions set unavailable_reason='revoked' where id=$1", [ancestor]);
  }
  expect(await f.apply(id)).toEqual({ result: 'unavailable' });
  expect((await f.records()).rows).toHaveLength(0);
});

it('RUNTIME: capture request namespace conflicts are not treated as successful replay', async () => {
  const f = await fixture(), id = await f.seed();
  await db.query("insert into artifact_requests values($1,overlay(md5('opc_capture:'||$2::text) placing 'f' from 13 for 1)::uuid,$3,'unrelated','{}','{}')", [f.d.projectId, id, f.d.roundId]);
  await expect(f.apply(id)).rejects.toThrow('OPC_REQUEST_CONFLICT');
  await expect(f.apply()).rejects.toThrow('OPC_REQUEST_CONFLICT');
});

it('RUNTIME: capture ordinary revision inherits metadata but never inherits direct-write authority', async () => {
  const f = await fixture(), id = await f.seed();
  await f.apply(id);
  await db.query("update artifact_rounds set state='published' where id=$1", [f.d.roundId]);
  const revised = await f.service.revise(f.draft.draftId, randomUUID(), f.d.roundId);
  const next = await f.seed(output([patch('new round')]));
  expect(await f.apply(next)).toMatchObject({ result: 'suggested' });
  const steps = (await db.query('select steps from artifact_rounds where id=$1', [revised.roundId])).rows[0].steps;
  expect(steps['step-0'].fieldMeta.goal.executionId).toBe(id);
  expect(steps['step-0'].information.goal.value).toBe('A');
  expect(steps['step-0'].fieldMeta.goal.suggestion.value).toBe('new round');
  expect(await f.apply(await f.seed(output([]), false))).toMatchObject({ result: 'skipped_format' });
});

it('RUNTIME: account erasure clears captured metadata, notes and processing history', async () => {
  const f = await fixture(), id = await f.seed();
  await f.apply(id);
  await db.query("update artifact_rounds set steps=jsonb_set(steps,'{step-0,notes}',$2) where id=$1", [f.d.roundId, JSON.stringify([{ id: randomUUID(), text: 'private note', source: 'user' }])]);
  await db.query('select account_erasure_confirm($1,$2)', [f.actor, randomUUID()]);
  await db.query('select account_erasure_scrub_content($1)', [f.actor]);
  expect(await f.steps()).toBeNull();
  const record = (await f.records()).rows[0];
  expect(record.payload).toBeNull(); expect(record.response).toBeNull();
  await expect(f.apply(id)).rejects.toThrow();
});

it('RUNTIME: capture failure cannot block an original completed request replay', async () => {
  const f = await fixture(), id = await f.seed();
  const e = (await db.query('select request_id,payload from runtime_executions where id=$1', [id])).rows[0];
  const replayOnly = new Proxy(admin, {
    get(target, key) {
      if (key !== 'rpc') return Reflect.get(target, key);
      return (name: string, args: Record<string, unknown>) => {
        if (name === 'opc_capture_apply') throw new Error('capture must not run before replay');
        return target.rpc(name, args);
      };
    },
  });
  expect(await opcService(f.user, replayOnly).prepareStep({ draftId: f.draft.draftId,
    requestId: e.request_id, stepId: 'step-0', purpose: 'mentor', questionId: 'goal', input: 'Synthetic capture input' }))
    .toMatchObject({ executionId: id });
  expect((await f.records()).rows).toHaveLength(0);
});

it('RUNTIME: capture pending is available with stopNewCalls enabled and performs no gate or billing reads', async () => {
  const f = await fixture(); await f.seed(output([]));
  const prior = (await db.query("select value from system_settings where key='runtime_rate_limits'")).rows[0]?.value;
  await db.query("insert into system_settings(key,value) values('runtime_rate_limits',$1) on conflict(key) do update set value=excluded.value",
    [{ version: 1, admissionPerMinute: 10, admissionPer24Hours: 200, callsPerMinute: 30, callsPer24Hours: 600, stopNewCalls: true }]);
  const calls: string[] = [];
  const onlyCapture = new Proxy(admin, {
    get(target, key) {
      if (key === 'from') throw new Error('no settings, model or gate read is allowed');
      if (key !== 'rpc') return Reflect.get(target, key);
      return (name: string, args: Record<string, unknown>) => {
        calls.push(name); return target.rpc(name, args);
      };
    },
  });
  const before = (await db.query('select credits from profiles where id=$1', [f.actor])).rows[0].credits;
  try {
    expect((await opcService(f.user, onlyCapture).capturePending({ draftId: f.draft.draftId })).processed).toHaveLength(1);
    expect(calls).toEqual(['opc_capture_apply']);
    expect((await db.query('select credits from profiles where id=$1', [f.actor])).rows[0].credits).toBe(before);
  } finally {
    if (prior) await db.query("update system_settings set value=$1 where key='runtime_rate_limits'", [prior]);
    else await db.query("delete from system_settings where key='runtime_rate_limits'");
  }
});

it.each([false, true])('RUNTIME: capture account inheritance protects copied and edited branches (legacy=%s)', async legacy => {
  const f = await fixture(), original = await f.seed(output([patch(), patch('later', 'step-1')]));
  await f.apply(original);
  const source = randomUUID(), account = randomUUID();
  await db.query("update artifact_rounds set state='published' where id=$1", [f.d.roundId]);
  await db.query("insert into artifact_versions(id,project_id,round_id,version,report,report_hash,evidence_ids) values($1,$2,$3,1,'{}',artifact_hash('{}'),'[]')", [source, f.d.projectId, f.d.roundId]);
  await db.query("insert into artifact_projects(id,actor_id,module_id,skill_id,work_kind) select $1,actor_id,module_id,skill_id,'account' from artifact_projects where id=$2", [account, f.d.projectId]);
  await db.query("insert into opc_accounts(project_id,actor_id,platform,account_key,source_version_id,business_id) values($1,$2,'x','capture-account',$3,(select business_id from opc_draft_businesses where draft_id=$4))", [account, f.actor, source, f.draft.draftId]);
  const begun = await f.service.accountStrategyBegin(account, randomUUID());
  let target = await f.service.read(begun.draftId);
  expect(target.information['step-0'].meta.goal.protected).toBe(true);
  if (legacy) {
    // Reconstruct the pre-0134 seed ledger locally, then exercise the real
    // existing-draft repair branch, including one subsequently edited step.
    await db.query('alter table artifact_requests disable trigger artifact_immutable');
    try { await db.query("delete from artifact_requests where project_id=$1 and action='opc_account_inherit'", [target.projectId]); }
    finally { await db.query('alter table artifact_requests enable trigger artifact_immutable'); }
    for (const [stepId, state] of Object.entries(target.information) as Array<[string, { values: unknown }]>) {
      await db.query("insert into artifact_requests values($1,$2,$3,'opc_information',$4,$5)",
        [target.projectId, randomUUID(), target.roundId, { stepId, expectedVersion: 0, values: state.values }, { version: 1 }]);
    }
    await f.service.information({ draftId: begun.draftId, requestId: randomUUID(), stepId: 'step-0',
      expectedVersion: target.snapshot.steps['step-0'].version,
      values: { ...target.information['step-0'].values, goal: tuple('account edit', 'provisional', 'fact') } });
    await f.service.accountStrategyBegin(account, randomUUID());
    target = await f.service.read(begun.draftId);
    expect(target.information['step-0'].values.goal.value).toBe('account edit');
    expect(target.information['step-0'].meta.goal.source).toBe('user');
  }
  const id = await f.seed(output([patch('replacement'), patch('replacement', 'step-1')]), true, begun.draftId);
  expect(await rpc('opc_capture_apply', { p_actor_id: f.actor, p_draft_id: begun.draftId, p_execution_id: id })).toMatchObject({ result: 'suggested' });
  const after = await f.service.read(begun.draftId);
  expect(after.information['step-0'].values).toEqual(target.information['step-0'].values);
  expect(after.information['step-1'].values).toEqual(target.information['step-1'].values);
});

it('RUNTIME: capture waits for a concurrent edit of another field and uses the committed whole-step version', async () => {
  const f = await fixture(), id = await f.seed(output([patch('B from old input', 'step-0', 'other')]));
  const before = (await f.steps())['step-0'];
  const editor = new pg.Client({ connectionString }); await editor.connect();
  try {
    await editor.query("begin; set local statement_timeout='10s'");
    await editor.query('select opc_information($1,$2,$3,$4,$5,$6)', [f.actor, f.draft.draftId, 'step-0', randomUUID(),
      before.version, { ...before.information, goal: tuple('new A', 'provisional', 'fact') }]);
    const applying = f.apply(id);
    await editor.query('commit');
    expect(await applying).toMatchObject({ result: 'suggested' });
    const after = (await f.steps())['step-0'];
    expect(after.information.goal.value).toBe('new A');
    expect(after.information.other.value).toBe('');
    expect(after.fieldMeta.other.suggestion.value).toBe('B from old input');
  } finally { await editor.query('rollback'); await editor.end(); }
});

it('RUNTIME: capture suggestions remain visible across confirmation and disappear from reads after revocation', async () => {
  const f = await fixture(); await f.save('manual');
  const id = await f.seed(output([patch('suggested')])); await f.apply(id);
  const before = await f.read(), visible = before.information['step-0'].meta.goal.suggestion;
  const values = { ...before.information['step-0'].values, goal: tuple('manual', 'confirmed', 'fact') };
  await f.service.information({ draftId: f.draft.draftId, requestId: randomUUID(), stepId: 'step-0',
    expectedVersion: before.snapshot.steps['step-0'].version, values });
  expect((await f.read()).information['step-0'].meta.goal.suggestion).toEqual(visible);
  await db.query("update runtime_executions set unavailable_reason='revoked' where id=$1", [id]);
  expect((await f.read()).information['step-0'].meta.goal.suggestion).toBeUndefined();
  expect((await f.steps())['step-0'].fieldMeta.goal.suggestion).toEqual(visible);
});

it.each([false, true])('RUNTIME: suggestion-only metadata does not permanently protect untouched fields (ignored=%s)', async ignored => {
  const f = await fixture(), first = await f.seed(output([patch('S1', 'step-0', 'other')]));
  await f.save('user edit');
  expect(await f.apply(first)).toMatchObject({ result: 'suggested' });
  const st = (await f.steps())['step-0'];
  if (ignored) {
    await f.service.captureResolve({ draftId: f.draft.draftId, requestId: randomUUID(), stepId: 'step-0', fieldId: 'other',
      executionId: first, hash: st.fieldMeta.other.suggestion.hash, action: 'ignore', expectedVersion: st.version });
    expect((await f.steps())['step-0'].fieldMeta.other).toBeUndefined();
  }
  expect((await f.read()).information['step-0'].meta.other.protected).toBe(false);
  const next = await f.seed(output([patch('fresh', 'step-0', 'other')]));
  expect(await f.apply(next)).toMatchObject({ result: 'applied' });
  expect((await f.steps())['step-0'].information.other.value).toBe('fresh');
});

it('RUNTIME: capture reserved receipt IDs cannot be supplied through manual write APIs', async () => {
  const f = await fixture(), id = await f.seed();
  const reserved = (await db.query("select overlay(md5('opc_capture:'||$1::text) placing 'f' from 13 for 1)::uuid id", [id])).rows[0].id;
  const st = (await f.steps())['step-0'];
  await expect(f.service.information({ draftId: f.draft.draftId, requestId: reserved,
    stepId: 'step-0', expectedVersion: st.version, values: st.information })).rejects.toThrow();
  await expect(rpc('opc_information', { p_actor_id: f.actor, p_draft_id: f.draft.draftId, p_request_id: reserved,
    p_step_id: 'step-0', p_expected_version: st.version, p_values: st.information })).rejects.toThrow('OPC_REQUEST_CONFLICT');
  expect((await f.records()).rows).toHaveLength(0);
  expect(await f.apply(id)).toMatchObject({ result: 'applied' });
});

it('RUNTIME: capture writes an unreached step and its next full information save remains valid', async () => {
  const f = await fixture();
  await db.query("update artifact_rounds set steps=steps #- '{step-2,information}' where id=$1", [f.d.roundId]);
  const id = await f.seed(output([patch('later step', 'step-2')]));
  expect(await f.apply(id)).toMatchObject({ result: 'applied' });
  expect((await f.read()).information['step-2'].values.goal.value).toBe('later step');
  const st = (await f.steps())['step-2'];
  await f.service.information({ draftId: f.draft.draftId, requestId: randomUUID(), stepId: 'step-2',
    expectedVersion: st.version, values: { goal: st.information.goal, other: tuple() } });
  expect((await f.steps())['step-2'].information.other).toEqual(tuple());
});

async function pendingAdmission(f: Awaited<ReturnType<typeof fixture>>, databaseCapacity = false) {
  let args: Record<string, unknown> | undefined;
  const held = new Proxy(admin, { get(target, key) {
    if (key !== 'rpc') return Reflect.get(target, key);
    return (name: string, value: Record<string, unknown>) => {
      if (name === 'opc_capture_apply') return { abortSignal: async () => ({ data: { processed: [], remaining: 0, hasMore: false }, error: null }) };
      if (name === 'runtime_admit') { args = value; return Promise.resolve({ data: null, error: { message: 'HOLD_ADMISSION' } }); }
      return target.rpc(name, value);
    };
  } });
  await expect(f.prepare(randomUUID(), f.draft.draftId, held, databaseCapacity)).rejects.toThrow();
  expect(args).toBeDefined();
  return args!;
}
const admit = (client: pg.Client, a: Record<string, unknown>) => client.query('select runtime_admit($1,$2,$3,$4,$5) v',
  [a.p_actor_id, a.p_session_id, a.p_request_id, a.p_payload, a.p_billing]);

it.each(['capture-first', 'admit-first'].flatMap(order => [false, true].map(revoke => ({ order, revoke }))))
('RUNTIME: capture and runtime_admit serialize without deadlock ($order, revoke=$revoke)', async ({ order, revoke }) => {
  const f = await fixture();
  await db.query("update artifact_rounds set steps=steps #- '{step-2,information}' where id=$1", [f.d.roundId]);
  const id = await f.seed(output([patch('unreached', 'step-2')])), args = await pendingAdmission(f);
  const first = new pg.Client({ connectionString }), second = new pg.Client({ connectionString });
  await first.connect(); await second.connect();
  try {
    const pid = (await second.query('select pg_backend_pid() pid')).rows[0].pid;
    await first.query("begin; set local lock_timeout='8s'; set local statement_timeout='12s'");
    await second.query("set lock_timeout='8s'; set statement_timeout='12s'");
    if (order === 'capture-first') await first.query('select opc_capture_apply($1,$2,$3)', [f.actor, f.draft.draftId, id]);
    else await admit(first, args);
    if (revoke) await first.query("update ai_models set is_active='false' where id=$1", [f.model]);
    let settled = false;
    const pending = (order === 'capture-first' ? admit(second, args)
      : second.query('select opc_capture_apply($1,$2,$3) v', [f.actor, f.draft.draftId, id]))
      .then(value => ({ value, error: null }), error => ({ value: null, error }))
      .then(result => { settled = true; return result; });
    let blocked = false;
    for (let i = 0; i < 100; i++) {
      blocked = (await db.query("select wait_event_type IS NOT DISTINCT FROM 'Lock' waiting from pg_stat_activity where pid=$1", [pid])).rows[0]?.waiting;
      if (blocked || settled) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    // Shared authorization locks are compatible until the first transaction revokes.
    expect(blocked).toBe(revoke);
    if (!revoke) expect(settled).toBe(true);
    await first.query('commit');
    const result = await pending;
    if (revoke && order === 'capture-first') {
      expect(result.error).toMatchObject({ code: 'P0001', message: expect.stringMatching(/^BILL2_(CALL_POLICY|MODEL)_DENIED$/) });
    }
    else {
      expect(result.error).toBeNull();
      if (order === 'admit-first') expect(result.value!.rows[0].v.result).toBe(revoke ? 'unavailable' : 'applied');
    }
    expect((await f.records()).rows).toHaveLength(revoke && order === 'admit-first' ? 0 : 1);
  } finally { await first.query('rollback'); await first.end(); await second.end(); }
}, 30000);

it('RUNTIME: 2000 manual requests and 11 executions keep view and admission history at the 0158 baseline', async () => {
  const f = await fixture(22), ids: string[] = [];
  for (let i = 0; i < 11; i++) ids.push(await f.seed(output([]), false, f.draft.draftId, true));
  await db.query(`insert into runtime_session_history(session_id,revision,execution_id,item)
    select $1,n,id,jsonb_build_object('type','message','role','assistant','content','Synthetic history')
    from unnest($2::uuid[]) with ordinality t(id,n)`, [f.d.sessionId, ids]);
  await db.query('update runtime_sessions set revision=11 where id=$1', [f.d.sessionId]);
  await db.query(`insert into artifact_requests(project_id,request_id,round_id,action,payload,response)
    select $1,gen_random_uuid(),$2,'opc_information',jsonb_build_object('stepId','step-0','expectedVersion',n,
    'values',jsonb_build_object('goal',jsonb_build_object('status','unknown','value','','nature','unknown'))),'{}'
    from generate_series(1,2000) n`, [f.d.projectId, f.d.roundId]);
  const args = await pendingAdmission(f, true);
  const signatures = ['runtime_work_projection(uuid,uuid,uuid)', 'runtime_material_allowed_before_b1(uuid,jsonb)'];
  const current = await Promise.all(signatures.map(async sig => (await db.query('select pg_get_functiondef($1::regprocedure) def', [sig])).rows[0].def));
  const rollback = readFileSync(resolve(import.meta.dirname, '../../../../../docs/launch/rollback/CONVERSATION_CAPTURE_B1.sql'), 'utf8');
  const originals = ['runtime_work_projection', 'runtime_material_allowed_before_b1'].map(name =>
    rollback.match(new RegExp('CREATE OR REPLACE FUNCTION ' + name + '[\\s\\S]*?END \\$\\$;'))![0]);
  const sample = async () => {
    const view: number[] = [], admission: number[] = [];
    for (let i = 0; i < 4; i++) {
      let start = performance.now();
      const visible = (await db.query('select runtime_view($1,$2) v', [f.actor, f.d.sessionId])).rows[0].v;
      if (i) view.push(performance.now() - start);
      expect(visible.executions).toHaveLength(11);
      expect(visible.executions.every((e: { contentAvailable: boolean }) => e.contentAvailable)).toBe(true);
      await db.query('begin');
      try {
        start = performance.now(); const result = await admit(db, args);
        if (i) admission.push(performance.now() - start);
        const history = (await db.query('select cardinality(candidate_history) n from runtime_executions where id=$1', [result.rows[0].v.executionId])).rows[0].n;
        expect(history).toBe(11);
      } finally { await db.query('rollback'); }
    }
    const median = (values: number[]) => values.sort((a, b) => a - b)[1];
    return { view: median(view), admission: median(admission) };
  };
  let baseline: Awaited<ReturnType<typeof sample>>;
  try { for (const def of originals) await db.query(def); baseline = await sample(); }
  finally { for (const def of current) await db.query(def); }
  const measured = await sample();
  for (const key of ['view', 'admission'] as const) {
    expect(measured[key]).toBeLessThan(400);
    expect(measured[key]).toBeLessThan(baseline![key] * 2 + 30);
  }
  // Structural guard: permission checks must not invoke the field projection at all.
  try {
    await db.query("create or replace function runtime_work_projection(p_actor_id uuid,p_session_id uuid,p_round_id uuid) returns jsonb language plpgsql as $$ begin raise exception 'projection reached from authorization'; end $$");
    await sample();
  } finally { await db.query(current[0]); }
  console.info('B1 permission performance', JSON.stringify({ requests: 2000, executions: 11, baseline: baseline!, measured,
    thresholdMs: 400, relativeThreshold: '2 * 0158 baseline + 30ms', samples: 3, projectionCallsFromAuthorization: 0 }));
}, 90000);

it('RUNTIME: migration rejects an unexpected previous function definition before changing any function', async () => {
  const sig = 'opc_information(uuid,uuid,text,uuid,integer,jsonb)';
  const original = (await db.query('select pg_get_functiondef($1::regprocedure) def', [sig])).rows[0].def;
  const forward = readFileSync(resolve('../db/migrations/0159_opc_capture.sql'), 'utf8');
  const before = (await db.query("select md5(pg_get_functiondef('opc_capture_apply(uuid,uuid,uuid)'::regprocedure)) h")).rows[0].h;
  try {
    await db.query(original.replace('OPC_DENIED', 'OPC_SYNTHETIC_DRIFT'));
    await expect(db.query(forward)).rejects.toThrow('OPC_CAPTURE_SOURCE_MISMATCH');
    await db.query('rollback');
    expect((await db.query("select md5(pg_get_functiondef('opc_capture_apply(uuid,uuid,uuid)'::regprocedure)) h")).rows[0].h).toBe(before);
  } finally { await db.query('rollback'); await db.query(original); }
  const latest = readFileSync(resolve('../db/migrations/0182_opc_mentor_checklist.sql'), 'utf8');
  await db.query(latest);
  await withdrawMigration();
});

it('RUNTIME: rollback rejects drift in every replaced or removed definition without changing functions', async () => {
  const rollback = readFileSync(resolve('../../docs/launch/rollback/CONVERSATION_CAPTURE_B1.sql'), 'utf8');
  const signatures = [
    'opc_information(uuid,uuid,text,uuid,integer,jsonb)', 'opc_query(uuid,uuid)',
    'runtime_work_projection(uuid,uuid,uuid)', 'runtime_material_allowed_before_b1(uuid,jsonb)',
    'opc_capture_apply(uuid,uuid,uuid)',
    'opc_capture_resolve(uuid,uuid,uuid,text,text,uuid,text,text,integer)',
  ];
  const definitions = async () => (await db.query(`select sig, pg_get_functiondef(sig::regprocedure) def
    from unnest($1::text[]) sig order by sig`, [signatures])).rows as { sig: string; def: string }[];
  const original = await definitions();
  for (const entry of original) {
    try {
      const drifted = entry.def.replace('AS $function$', 'AS $function$\n-- synthetic definition drift');
      expect(drifted).not.toBe(entry.def);
      await db.query(drifted);
      const before = await definitions();
      await expect(db.query(rollback)).rejects.toThrow('OPC_CAPTURE_ROLLBACK_SOURCE_MISMATCH');
      await db.query('rollback');
      expect(await definitions()).toEqual(before);
    } finally { await db.query('rollback'); await db.query(entry.def); }
  }
  expect(await definitions()).toEqual(original);
});

it('RUNTIME: completion capture has a bounded wait and later retry remains idempotent', async () => {
  const f = await fixture(), id = await f.seed();
  const locker = new pg.Client({ connectionString }); await locker.connect();
  try {
    await locker.query('begin');
    await locker.query('select id from artifact_projects where id=$1 for update', [f.d.projectId]);
    const start = performance.now();
    await captureCompleted(admin, f.actor, id);
    expect(performance.now() - start).toBeLessThan(2500);
    expect((await f.records()).rows).toHaveLength(0);
    await locker.query('commit');
    // Cancellation may race with commit; either outcome must use the same receipt.
    await f.apply(id); await f.apply(id);
    expect((await f.records()).rows).toHaveLength(1);
  } finally { await locker.query('rollback'); await locker.end(); }
});

vi.mock('../runtime/newWorkGate', async importOriginal => ({
  ...await importOriginal<typeof import('../runtime/newWorkGate')>(),
  ...(await import('../__tests__/fixtures/runtimeGates')).testAdmissionGates,
}));


it('RUNTIME: Q1 pending organizer guards OPC material and new admission while allowing original replay', async () => {
  const f = await fixture();
  const executionId = await f.seed();
  const saved = (await db.query(`select e.*,r.payload billing from runtime_executions e
    join bill2_runs r on r.id=e.billing_run_id where e.id=$1`, [executionId])).rows[0];
  // DB-only synthetic waiting fixture, built from the real OPC admission above.
  // The seed already cancelled/refunded its v1 reservation; no provider runs.
  await db.query(`update bill2_runs set contract_version='bill2.v2',reserved=0,pre_deduct_id=null,
    cancel_requested=false,closed=false,runtime_cursor=1,runtime_epoch=1 where id=$1`, [saved.billing_run_id]);
  await db.query(`update runtime_executions set state='waiting_credits',result=null,
    primary_result=$2,unavailable_reason=null where id=$1`, [executionId, {body:'Synthetic mentor'}]);
  const snapshot = async () => (await db.query(`select
    (select to_jsonb(s) from runtime_sessions s where id=$1) session,
    (select coalesce(jsonb_agg(to_jsonb(m) order by revision),'[]') from runtime_scope_material m where session_id=$1) material,
    (select coalesce(jsonb_agg(to_jsonb(t) order by request_id),'[]') from opc_turns t where session_id=$1) turns,
    (select to_jsonb(r) from artifact_rounds r where id=$2) round`, [f.d.sessionId, f.d.roundId])).rows[0];
  const before = await snapshot();
  const newRequestId = randomUUID();
  for (const state of ['waiting_credits','waiting_resume','running','interrupted','cost_pending']) {
    await db.query('update runtime_executions set state=$2 where id=$1', [executionId,state]);
    const context = await rpc('runtime_session_context',{p_actor_id:f.actor,p_session_id:f.d.sessionId});
    expect(context.waitingOrganizer).toMatchObject({executionId,state,cursor:1,epoch:1});
    await expect(rpc('opc_step_material',{p_actor_id:f.actor,p_draft_id:f.draft.draftId,
      p_request_id:newRequestId,p_step_id:'step-0',p_purpose:'mentor',p_input:'New message'}))
      .rejects.toThrow('RUNTIME_ORGANIZER_PENDING');
    await expect(rpc('runtime_admit',{p_actor_id:f.actor,p_session_id:f.d.sessionId,p_request_id:newRequestId,
      p_payload:saved.payload,p_billing:saved.billing})).rejects.toThrow('RUNTIME_ORGANIZER_PENDING');
    expect(await snapshot()).toEqual(before);
    expect(await rpc('runtime_admission_replay',{p_actor_id:f.actor,p_request_id:saved.request_id,
      p_request:saved.payload.request})).toMatchObject({executionId});
    expect(await rpc('opc_step_material',{p_actor_id:f.actor,p_draft_id:f.draft.draftId,
      p_request_id:saved.request_id,p_step_id:'step-0',p_purpose:'mentor',p_input:saved.payload.request.input}))
      .toMatchObject({turnToken:saved.payload.opcTurnToken});
    expect(await snapshot()).toEqual(before);
  }
});

it('RUNTIME: B2 admits any declared field, selects gaps from frozen material and restores task on replay', async () => {
  const f = await fixture();
  await f.save('Existing goal');
  const request = {draftId:f.draft.draftId,requestId:randomUUID(),stepId:'step-0',purpose:'mentor',
    questionId:'goal',input:'New material'};
  const first = await f.service.prepareStep(request);
  const payload = (await db.query('select payload from runtime_executions where id=$1',[first.executionId])).rows[0].payload;
  expect(payload.request.selection.task).toBe('opc-question:goal');
  // Goal is a draft, so it remains the first unconfirmed identity when there are no required gaps.
  expect(payload.inputSelection).toBe('scope-projection-v2');
  expect(payload.hostTurnContext.checklist).toHaveLength(3);
  expect(payload.hostTurnContext.checklist[0].fields[0]).toMatchObject({status:'draft',protected:true});
  expect(payload.scopeMaterial.content.work.steps['step-0'].information.goal.value).toBe('Existing goal');
  await rpc('runtime_cancel',{p_actor_id:f.actor,p_execution_id:first.executionId});
  await f.save('Updated manually');
  expect(await f.service.prepareStep(request)).toMatchObject({executionId:first.executionId});
  const second = await f.service.prepareStep({...request,requestId:randomUUID(),questionId:'other'});
  expect(second.executionId).not.toBe(first.executionId);
  await rpc('runtime_cancel',{p_actor_id:f.actor,p_execution_id:second.executionId});
  await expect(f.service.prepareStep({...request,requestId:randomUUID(),questionId:'not-declared'}))
    .rejects.toThrow('OPC_QUESTION_NOT_REACHED');
});

it('RUNTIME: B2 answers inherit their source task after capture changes the focus', async () => {
  // Set the immutable workflow before publication; capture advances focus without changing the card identity.
  const f = await fixture(0, undefined, true);
  const source = await f.seed(output([patch('Goal now captured')]));
  await db.query('update runtime_executions set result=result||$2::jsonb where id=$1',[source,{body:JSON.stringify({
    format:'agent-turn.v1',message:'Choose a platform',card:{question:'Which platform?',options:['A','B'],recommended:null},
  })}]);
  await f.apply(source);
  const request = {draftId:f.draft.draftId,requestId:randomUUID(),stepId:'step-0',purpose:'mentor',
    questionId:'other',input:'B',answerSource:{executionId:source,optionIndex:1}};
  await expect(f.service.prepareStep({...request,requestId:randomUUID(),input:'Client display text'}))
    .rejects.toThrow('OPC_ANSWER_SOURCE_DENIED');
  const next = await f.service.prepareStep(request);
  const payload = (await db.query('select payload from runtime_executions where id=$1',[next.executionId])).rows[0].payload;
  expect(payload.request.selection.task).toBe('opc-question:goal');
  expect(payload.input).toBe('B');
  expect(payload.answeredCard).not.toHaveProperty('questionId'); // SQL keeps the original answer-source shape.
  await rpc('runtime_cancel',{p_actor_id:f.actor,p_execution_id:next.executionId});
  expect(await f.service.prepareStep(request)).toMatchObject({executionId:next.executionId});
});

it('RUNTIME: B2 opens each step only once and freezes organizer v2 on the exact material', async () => {
  const {OPENING_INPUT,openingRequestId} = await import('./questions');
  const f = await fixture(), organizer = randomUUID();
  await db.query("insert into ai_models(id,name,model_id,provider,is_active,max_tokens,input_limit) values($1,'Synthetic organizer','capture-organizer','fixture','true',2048,64000)",[organizer]);
  await db.query("insert into system_settings(key,value) values('v3_summary_model_id',to_jsonb($1::text)),('v3_summary_max_tokens','2048') on conflict(key) do update set value=excluded.value",[organizer]);
  const request = {draftId:f.draft.draftId,requestId:randomUUID(),stepId:'step-0',purpose:'mentor',questionId:'goal',input:OPENING_INPUT};
  const first = await f.service.prepareStep(request);
  const payload = (await db.query('select payload from runtime_executions where id=$1',[first.executionId])).rows[0].payload;
  expect(payload.request.requestId).toBe(openingRequestId(f.draft.draftId,f.d.roundId,'step-0','goal'));
  expect(payload.hostTurnContext.opening).toBe(true);
  const input=JSON.parse(payload.attachedOrganizer.input);
  expect(input.captureFormat).toBe('v2');expect(input.checklist).toHaveLength(3);
  for (const step of input.checklist) for (const field of step.fields)
    expect(field.value).toBe(payload.scopeMaterial.content.work.steps[step.id].information[field.id].value);
  await rpc('runtime_cancel',{p_actor_id:f.actor,p_execution_id:first.executionId});
  expect(await f.service.prepareStep({...request,requestId:randomUUID(),questionId:'other'}))
    .toMatchObject({executionId:first.executionId});
  expect((await db.query('select count(*)::int n from runtime_executions where session_id=$1',[f.d.sessionId])).rows[0].n).toBe(1);
});

it('RUNTIME: checklist save returns committed values and replay keeps the original version',async()=>{
 const f=await fixture(); const current=await f.steps();
 const request={draftId:f.draft.draftId,requestId:randomUUID(),stepId:'step-0',expectedVersion:current['step-0'].version,
  values:{...current['step-0'].information,goal:tuple('User supplied fact','provisional','fact')}};
 const saved=await f.service.information(request);
 expect(saved).toEqual({version:request.expectedVersion+1,values:request.values});
 await f.save('Later edit');
 expect(await f.service.information(request)).toEqual(saved);
 await expect(f.service.information({...request,values:{...request.values,goal:tuple('Conflict')}})).rejects.toThrow();
 // Old successful requests still yield their own values, never a newer whole-form read.
 const legacyId=randomUUID();
 await db.query(`insert into artifact_requests(project_id,request_id,round_id,action,payload,response)
  select project_id,$3,round_id,action,payload,response-'values' from artifact_requests
  where project_id=$1 and request_id=$2`,[f.d.projectId,request.requestId,legacyId]);
 expect(await f.service.information({...request,requestId:legacyId})).toEqual(saved);
});
it('RUNTIME: checklist notification shares normal admission billing and never writes extracted marker text',async()=>{
 const {checklistUpdatedInput}=await import('../../shared/opcQuestions');
 const f=await fixture(0,undefined,false,true); await f.save('Saved manually');
 const organizer=randomUUID();
 await db.query("insert into ai_models(id,name,model_id,provider,is_active,max_tokens,input_limit) values($1,'Synthetic organizer','checklist-organizer','fixture','true',2048,64000)",[organizer]);
 await db.query("insert into system_settings(key,value) values('v3_summary_model_id',to_jsonb($1::text)),('v3_summary_max_tokens','2048') on conflict(key) do update set value=excluded.value",[organizer]);
 const request={draftId:f.draft.draftId,requestId:randomUUID(),stepId:'step-0',purpose:'mentor',
  input:checklistUpdatedInput(['goal']),organizeAfter:true};
 const prepared=await f.service.prepareStep(request);
 expect(await f.service.prepareStep(request)).toEqual(prepared);
 const row=(await db.query('select * from runtime_executions where id=$1',[prepared.executionId])).rows[0];
 const financial=async()=>(await db.query(`select r.reserved,r.charged,r.pre_deduct_id,p.credits,
  (select count(*)::int from bill2_runs where actor_id=$1) runs from bill2_runs r
  join profiles p on p.id=r.actor_id where r.id=$2`,[f.actor,row.billing_run_id])).rows[0];
 const admitted=await financial();expect(admitted.runs).toBe(1);
 await f.service.prepareStep(request);expect(await financial()).toEqual(admitted);
 expect(row.payload.hostTurnContext).toMatchObject({updatedFieldIds:['goal']});
 expect(row.payload.hostTurnContext.checklist[0].fields[0]).toMatchObject({value:'Saved manually',source:'user',basis:'user_statement'});
 expect(JSON.parse(row.payload.attachedOrganizer.input)).toMatchObject({userInput:'',hostEvent:{kind:'checklist_updated'}});
 expect((await db.query('select count(*)::int n from runtime_executions where session_id=$1 and request_id=$2',
  [f.d.sessionId,request.requestId])).rows[0].n).toBe(1);
 await expect(f.service.prepareStep({...request,input:checklistUpdatedInput(['other'])})).rejects.toThrow('OPC_REQUEST_CONFLICT');
 await rpc('runtime_cancel',{p_actor_id:f.actor,p_execution_id:prepared.executionId});
 expect((await financial()).charged).toBe(0);
 const before=await f.steps();
 await db.query("update runtime_executions set state='completed',unavailable_reason=null,result=$2 where id=$1",
  [prepared.executionId,{body:'Received',summary:output([patch(request.input)])}]);
 expect(await f.apply(prepared.executionId)).toMatchObject({discarded:[{reason:'host_checklist_updated'}]});
 expect(await f.steps()).toEqual(before);
 expect(await f.apply(prepared.executionId)).toMatchObject({discarded:[{reason:'host_checklist_updated'}]});
 const next=await f.service.prepareStep({...request,requestId:randomUUID()});
 await rpc('runtime_cancel',{p_actor_id:f.actor,p_execution_id:next.executionId});
 await db.query("update runtime_executions set state='completed',unavailable_reason=null,result=$2 where id=$1",
  [next.executionId,{body:'A grounded recommendation',summary:output([
   {...patch('Concrete mentor recommendation','step-0','other'),basis:'agent_proposal',nature:'decision'},
   {...patch('Invented user fact'),basis:'agent_proposal'},
   {...patch(request.input,'step-0','other'),basis:'agent_proposal'},
  ])}]);
 const applied=await f.apply(next.executionId);
 expect(applied.discarded).toHaveLength(2);
 expect((await f.steps())['step-0'].information.other.value).toBe('Concrete mentor recommendation');
 expect((await f.steps())['step-0'].information.goal).toEqual(before['step-0'].information.goal);

});
it('RUNTIME: checklist read historical saturation has identical output with bounded work',async()=>{
 const f=await fixture(22);
 const states=await f.steps();
 const values=Object.fromEntries(Object.keys(states['step-0'].information).map(id=>[id,tuple('Known','confirmed','fact')]));
 await db.query(`insert into artifact_requests(project_id,request_id,round_id,action,payload,response)
  select $1,gen_random_uuid(),$2,'opc_information',jsonb_build_object('stepId','step-0','expectedVersion',n,'values',$3::jsonb),'{}'
  from generate_series(1,2000) n`,[f.d.projectId,f.d.roundId,values]);
 const signature='opc_historical_reach(uuid,uuid,text)';
 const current=(await db.query('select pg_get_functiondef($1::regprocedure) def',[signature])).rows[0].def;
 const source=readFileSync(resolve('../db/migrations/0111_opc_historical_reach.sql'),'utf8');
 const old=source.match(/CREATE OR REPLACE FUNCTION opc_historical_reach[\s\S]*?END \$\$;/)![0];
 const sample=async()=>{
  const times:number[]=[];let result;
  for(let i=0;i<8;i++){
   const start=performance.now();result=(await db.query('select opc_query($1,$2) v',[f.actor,f.draft.draftId])).rows[0].v;
   if(i)times.push(performance.now()-start);
  }
  times.sort((a,b)=>a-b);return {medianMs:times[3]!,maxMs:times.at(-1)!,result};
 };
 let before:Awaited<ReturnType<typeof sample>>;
 try {await db.query(old);before=await sample();}finally{await db.query(current);}
 const after=await sample();expect(after.result).toEqual(before!.result);
 console.info('CHECKLIST_READ_BENCHMARK',JSON.stringify({environment:'local disposable PostgreSQL',requests:2000,fields:24,
  samples:7,before:{medianMs:before!.medianMs,maxMs:before!.maxMs},after:{medianMs:after.medianMs,maxMs:after.maxMs}}));
},60000);


it('RUNTIME: confirmation gate read and frozen admission agree without automatic confirmation', async () => {
 const f = await fixture();
 const captured = await f.seed(output([patch('Current goal'), patch('Later goal', 'step-2')]));
 await f.apply(captured);
 const before = await f.read();
 expect(before.stepConfirmation['step-0']).toEqual({requiredComplete:true,stepConfirmed:false,
  stepReady:true,needsLookFieldIds:['goal']});
 expect(before.information['step-2'].values.goal.value).toBe('Later goal');
 expect(before.snapshot.steps['step-2'].valid).toBe(false);
 for (const input of ['继续','下一步','没问题','好的']) {
  const request = {draftId:f.draft.draftId,requestId:randomUUID(),stepId:'step-0',purpose:'mentor',input};
  const turn = await f.service.prepareStep(request);
  const payload = (await db.query('select payload from runtime_executions where id=$1',[turn.executionId])).rows[0].payload;
  expect(payload.hostTurnContext.confirmation).toEqual(before.stepConfirmation['step-0']);
  expect(payload.instructions).toContain('Do not start the next step');
  expect(payload.hostTurnContext.checklist[2].fields[0].value).toBe('Later goal');
  await rpc('runtime_cancel',{p_actor_id:f.actor,p_execution_id:turn.executionId});
  expect(await f.service.prepareStep(request)).toMatchObject({executionId:turn.executionId});
  expect((await f.read()).snapshot.steps).toEqual(before.snapshot.steps);
 }
 // Even malicious structured model output cannot use confirmed as a write status.
 const illegal = await f.seed(output([{...patch('Unauthorized confirmation'),status:'confirmed'}]));
 expect((await f.apply(illegal)).discarded).toContainEqual({index:1,reason:'invalid_patch'});
 expect((await f.read()).stepConfirmation['step-0'].stepConfirmed).toBe(false);
 await f.save('Manually reviewed goal');
 expect((await f.read()).stepConfirmation['step-0']).toMatchObject({stepReady:true,needsLookFieldIds:[]});
});

it('RUNTIME: user-stated proposal plans cross steps, round-trip descriptions and retain manual protection',async()=>{
 const f=await fixture(0,undefined,false,true);
 const before=await f.read();
 expect(before.information['step-2'].schema[1]).toMatchObject({elicitation:'agent_proposal',
  description:'具体的试行计划；保留频率和商业限制，不当作已完成事实。'});
 const plan={...patch('首月每周三、周五各一篇图文，只拍阅读角，不做促销','step-2','other'),nature:'decision'};
 const execution=await f.seed(output([plan]));
 expect(await f.apply(execution)).toMatchObject({result:'applied'});
 const after=await f.read();
 expect(after.information['step-2'].values.other).toMatchObject({value:plan.value,status:'provisional',nature:'decision'});
 expect(after.information['step-0'].values.goal.value).toBe('');
 expect((await f.steps())['step-2'].valid).not.toBe(true);
 const records=(await f.records()).rows.length;
 await f.apply(execution);expect((await f.records()).rows).toHaveLength(records);
 await f.save('手动保留的试行计划','other');
 const replacement={...plan,stepId:'step-0',value:'用户明确改为每周一篇，仍不促销'};
 const next=await f.seed(output([replacement]));
 expect(await f.apply(next)).toMatchObject({result:'suggested'});
 const protectedRead=await f.read();
 expect(protectedRead.information['step-0'].values.other.value).toBe('手动保留的试行计划');
 expect(protectedRead.information['step-0'].meta.other.suggestion).toMatchObject({
  value:replacement.value,basis:'user_statement',nature:'decision',status:'provisional',
 });
});

// CDC-WRITEBACK-V3: withdrawal only moves an older pending suggestion; values, versions and protection never change.
const withdrawOutput = (withdrawals: unknown, patches: unknown[] = []) =>
  JSON.stringify({ inputKind: 'answer', patches, notes: [], withdrawals });
async function userTurn(id: string, organizerInput: Record<string, unknown> = { userInput: '那条建议不对，不要了' },
  shown: string | null = 'Pending goal suggestion') {
  const checklist = [{ id: 'step-0', fields: [{ id: 'goal', ...(shown === null ? {} : { pendingSuggestion: { value: shown } }) }] }];
  await db.query(`update runtime_executions set payload=jsonb_set(payload,'{attachedOrganizer,input}',to_jsonb($2::text)) where id=$1`,
    [id, JSON.stringify({ captureFormat: 'v2', checklist, ...organizerInput })]);
  return id;
}
async function suggestedFixture() {
  const f = await fixture();
  const current = (await f.steps())['step-0'];
  await f.service.information({ draftId: f.draft.draftId, requestId: randomUUID(), stepId: 'step-0', expectedVersion: current.version,
    values: { ...current.information, goal: tuple('Confirmed goal', 'confirmed', 'fact') } });
  const source = await f.seed(output([patch('Pending goal suggestion')]));
  expect(await f.apply(source)).toMatchObject({ result: 'suggested' });
  return { f, source };
}

it('RUNTIME: V3 withdrawal moves only an older pending suggestion and leaves confirmed values byte-identical', async () => {
  const { f, source } = await suggestedFixture();
  const before = (await f.steps())['step-0'];
  const id = await userTurn(await f.seed(withdrawOutput([{ stepId: 'step-0', fieldId: 'goal' },
    { stepId: 'step-0', fieldId: 'other' }, { stepId: 'missing', fieldId: 'goal' }, 'x'])));
  const response = await f.apply(id);
  expect(response).toMatchObject({ result: 'suggested', withdrawn: { 'step-0': ['goal'] }, discarded: [
    { withdrawal: 2, reason: 'no_suggestion' }, { withdrawal: 3, reason: 'invalid_withdrawal' }, { withdrawal: 4, reason: 'invalid_withdrawal' }] });
  const after = (await f.steps())['step-0'];
  expect(after.information).toEqual(before.information);
  expect(after.version).toBe(before.version);
  expect(after.fieldMeta.goal.suggestion).toBeUndefined();
  expect(after.fieldMeta.goal.withdrawnSuggestion).toEqual({ ...before.fieldMeta.goal.suggestion, withdrawnBy: id });
  expect(await f.apply(id)).toEqual(response);
  const read = (await db.query('select opc_query($1,$2) v', [f.actor, f.draft.draftId])).rows[0].v;
  expect(read.information['step-0'].meta.goal).toMatchObject({ withdrawnSuggestion: { value: 'Pending goal suggestion', executionId: source } });
  expect(read.information['step-0'].meta.goal).not.toHaveProperty('suggestion');
  const resolve = (action: 'accept' | 'dismiss', hash: string) => f.service.captureResolve({ draftId: f.draft.draftId,
    requestId: randomUUID(), stepId: 'step-0', fieldId: 'goal', executionId: source, hash, action, expectedVersion: after.version });
  const hash = after.fieldMeta.goal.withdrawnSuggestion.hash;
  await expect(resolve('accept', hash)).rejects.toThrow('OPC_SUGGESTION_CHANGED');
  await expect(resolve('dismiss', 'wrong')).rejects.toThrow('OPC_SUGGESTION_CHANGED');
  expect(await resolve('dismiss', hash)).toEqual({ version: after.version, result: 'dismiss' });
  const dismissed = (await f.steps())['step-0'];
  expect(dismissed.information).toEqual(before.information);
  expect(dismissed.fieldMeta.goal).not.toHaveProperty('withdrawnSuggestion');
  expect(dismissed.fieldMeta.goal).toMatchObject({ source: 'user' });
});

it('RUNTIME: V3 withdrawal refuses host turns, newer suggestions and malformed lists', async () => {
  const { f } = await suggestedFixture();
  const goal = () => f.steps().then(steps => steps['step-0'].fieldMeta.goal);
  const pending = (await goal()).suggestion;
  const one = [{ stepId: 'step-0', fieldId: 'goal' }];
  for (const input of [{}, { userInput: '  ' }, { userInput: 'HOST_OPEN_CURRENT_QUESTION' },
    { userInput: '', hostEvent: { kind: 'checklist_updated', fieldIds: ['goal'] } }]) {
    const id = await userTurn(await f.seed(withdrawOutput(one)), input);
    expect(await f.apply(id)).toMatchObject({ discarded: [{ withdrawal: 1, reason: 'no_user_turn' }] });
    expect((await goal()).suggestion).toEqual(pending);
  }
  for (const bad of [{}, null, Array(13).fill(one[0])]) {
    expect(await f.apply(await userTurn(await f.seed(withdrawOutput(bad))))).toMatchObject({ result: 'invalid_output' });
  }
  const unseen = await userTurn(await f.seed(withdrawOutput(one)), undefined, null);
  expect(await f.apply(unseen)).toMatchObject({ discarded: [{ withdrawal: 1, reason: 'not_shown' }] });
  const sameText = await userTurn(await f.seed(withdrawOutput(one, [patch('Pending goal suggestion')])));
  expect(await f.apply(sameText)).toMatchObject({ discarded: [{ withdrawal: 1, reason: 'superseded' }] });
  const older = await userTurn(await f.seed(withdrawOutput(one)));
  await f.apply(await f.seed(output([patch('Pending goal suggestion')])));
  expect(await f.apply(older)).toMatchObject({ discarded: [{ withdrawal: 1, reason: 'superseded' }] });
  const replaced = await userTurn(await f.seed(withdrawOutput(one)));
  await f.apply(await f.seed(output([patch('Newest suggestion')])));
  expect(await f.apply(replaced)).toMatchObject({ discarded: [{ withdrawal: 1, reason: 'not_shown' }] });
  expect((await goal()).suggestion.value).toBe('Newest suggestion');
  expect((await goal()).withdrawnSuggestion).toBeUndefined();
});

it('RUNTIME: V3 a new suggestion replaces the withdrawn record, which reads hide after revocation', async () => {
  const { f, source } = await suggestedFixture();
  await f.apply(await userTurn(await f.seed(withdrawOutput([{ stepId: 'step-0', fieldId: 'goal' }]))));
  const query = async () => (await db.query('select opc_query($1,$2) v', [f.actor, f.draft.draftId])).rows[0].v.information['step-0'].meta.goal;
  await db.query("update runtime_executions set unavailable_reason='revoked' where id=$1", [source]);
  expect(await query()).not.toHaveProperty('withdrawnSuggestion');
  expect((await f.steps())['step-0'].fieldMeta.goal.withdrawnSuggestion.executionId).toBe(source);
  await f.apply(await f.seed(output([patch('Fresh suggestion')])));
  const meta = (await f.steps())['step-0'].fieldMeta.goal;
  expect(meta.suggestion.value).toBe('Fresh suggestion');
  expect(meta).not.toHaveProperty('withdrawnSuggestion');
});

it('RUNTIME: V3 migration reruns as a no-op and its rollback restores definitions and strips withdrawn records', async () => {
  const signatures = ['opc_capture_apply(uuid,uuid,uuid)', 'opc_query(uuid,uuid)',
    'opc_capture_resolve(uuid,uuid,uuid,text,text,uuid,text,text,integer)'];
  const definitions = async () => (await db.query(`select sig, pg_get_functiondef(sig::regprocedure) def
    from unnest($1::text[]) sig order by sig`, [signatures])).rows as { sig: string; def: string }[];
  const { f } = await suggestedFixture();
  await f.apply(await userTurn(await f.seed(withdrawOutput([{ stepId: 'step-0', fieldId: 'goal' }]))));
  const patched = await definitions();
  await withdrawMigration();
  expect(await definitions()).toEqual(patched);
  const rollback = readFileSync(resolve(import.meta.dirname, '../../../../../docs/launch/rollback/CDC_WRITEBACK_V3.sql'), 'utf8');
  const before = (await f.steps())['step-0'];
  try {
    await db.query(rollback);
    const reverted = await definitions();
    for (const entry of reverted) expect(entry.def).not.toContain('v3 suggestion withdraw');
    const after = (await f.steps())['step-0'];
    expect(after.information).toEqual(before.information);
    expect(after.fieldMeta.goal).toEqual(Object.fromEntries(Object.entries(before.fieldMeta.goal).filter(([key]) => key !== 'withdrawnSuggestion')));
    await expect(db.query(rollback)).rejects.toThrow('OPC_WITHDRAW_ROLLBACK_SOURCE_MISMATCH');
    await db.query('rollback');
    expect(await definitions()).toEqual(reverted);
  } finally { await withdrawMigration(); }
  expect(await definitions()).toEqual(patched);
});
