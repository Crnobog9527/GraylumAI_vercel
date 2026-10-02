/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeAll, afterAll, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import { makePackage, makeWorkflow } from '../__tests__/fixtures/artifacts';
import { publishSkillPackage } from '../skills/publication';
import { opcService } from './service';
import { captureCompleted } from './capture';

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

async function fixture(extraFields = 0) {
  const owner = randomUUID(), model = randomUUID(), moduleId = randomUUID();
  const email = randomUUID() + '@example.test', password = 'Local-' + randomUUID() + '!';
  const made = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (made.error) throw made.error;
  const actor = made.data.user.id;
  const pack = makePackage(), registration = 'capture-' + randomUUID(), flow = makeWorkflow(3);
  await db.query("insert into profiles(id,role,credits) values($1,'admin',10000),($2,'user',10000)", [owner, actor]);
  await db.query("insert into credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,idempotency_key,balance_before,balance_after) values($1,10000,'addition','grant','opening_grant','system',$2,0,10000)", [actor, randomUUID()]);
  await db.query('insert into skills(id,skill_key,created_by) values($1,$2,$3)', [pack.id, registration, owner]);
  await db.query("insert into ai_models(id,name,model_id,provider,is_active,max_tokens,input_limit) values($1,'Capture fixture','opc-fixture-default','fixture','true',1000,64000)", [model]);
  await db.query('insert into modules(id,title,skill_id,model_id,active) values($1,$2,$3,$4,true)', [moduleId, registration, pack.id, model]);
  flow.steps.forEach((s, i) => { s.information = [
    { id: 'goal', title: 'Goal', required: true, profileKey: 'goal_' + i },
    { id: 'other', title: 'Other', required: false },
  ]; });
  for (let i = 0; i < extraFields; i++) flow.steps[0].information!.push({ id: 'extra' + i, title: 'Extra', required: false });
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
  // Construct persisted executions through the real admission authority. A synthetic
  // DB-only completion keeps this suite independent of providers and transport.
  const seed = async (summary = output(), v2 = true, targetDraftId = draft.draftId) => {
    const requestId = randomUUID();
    const bypassCapture = new Proxy(admin, {
      get(target, key) {
        if (key !== 'rpc') return Reflect.get(target, key);
        return (name: string, args: Record<string, unknown>) => name === 'opc_capture_apply'
          ? { abortSignal: async () => ({ data: { processed: [], remaining: 0, hasMore: false }, error: null }) }
          : target.rpc(name, args);
      },
    });
    const prepared = await opcService(user, bypassCapture).prepareStep({ draftId: targetDraftId,
      requestId, stepId: 'step-0', purpose: 'mentor', questionId: 'goal', input: 'Synthetic capture input' });
    const id = prepared.executionId;
    await rpc('runtime_cancel', { p_actor_id: actor, p_execution_id: id });
    await db.query(`update runtime_executions set state='completed',unavailable_reason=null,result=$2,
      payload=payload || jsonb_build_object('attachedOrganizer',$3::jsonb) where id=$1`,
    [id, { body: 'Synthetic mentor', summary }, { input: JSON.stringify(v2 ? { captureFormat: 'v2' } : {}) }]);
    return id;
  };
  return { actor, model, moduleId, user, service, draft, d, read, apply, records, steps, save, seed };
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
  expect(projection.steps['step-0'].fieldMeta.goal).toEqual({ protected: true });
  expect(projection.steps['step-0'].information.goal.value).toBe('user');
  const view = await f.read();
  expect(view.information['step-0'].meta.goal.suggestion.value).toBe('suggestion');
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
});

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
    expect(await f.apply(await f.seed(raw))).toMatchObject({ result: 'invalid_output' });
  }
  expect(await f.apply(await f.seed(output([])))).toMatchObject({ result: 'suggested' });
});

it('RUNTIME: capture rollback repeats, preserves values and protects A-B-A after reenabling', async () => {
  const f = await fixture();
  await f.apply(await f.seed());
  const rollback = readFileSync(resolve('../../docs/launch/rollback/CONVERSATION_CAPTURE_B1.sql'), 'utf8');
  const forward = readFileSync(resolve('../db/migrations/0159_opc_capture.sql'), 'utf8');
  const definitions = async () => (await db.query(`select proname,pg_get_functiondef(oid) body from pg_proc
    where pronamespace='public'::regnamespace and proname in ('opc_information','opc_query','runtime_work_projection') order by proname`)).rows;
  try {
    await db.query(rollback);
    const first = await definitions();
    await db.query(rollback);
    expect(await definitions()).toEqual(first);
    await f.save('B'); await f.save('A');
  } finally { await db.query(forward); }
  expect(await f.apply(await f.seed(output([patch('new')])))).toMatchObject({ result: 'suggested' });
  expect((await f.steps())['step-0'].information.goal.value).toBe('A');
  await db.query(forward);
  expect((await f.steps())['step-0'].information.goal.value).toBe('A');
});

it('RUNTIME: capture information byte capacity falls back to suggestions and freezes full notes safely', async () => {
  const f = await fixture(22);
  const current = (await f.steps())['step-0'];
  // Leave the target field untouched. Fill the others near the byte ceiling.
  const values = Object.fromEntries(Object.keys(current.information).map(key => [key,
    key === 'goal' ? tuple() : tuple('x'.repeat(400), 'provisional', 'fact')]));
  await f.service.information({ draftId: f.draft.draftId, requestId: randomUUID(), stepId: 'step-0', expectedVersion: current.version, values });
  const raw = await f.steps();
  for (const step of Object.values(raw) as Array<Record<string, unknown>>) {
    step.notes = Array.from({ length: 8 }, () => ({ id: randomUUID(), text: '汉'.repeat(400), source: 'user', createdAt: new Date().toISOString() }));
  }
  await db.query('update artifact_rounds set steps=$2 where id=$1', [f.d.roundId, raw]);
  const id = await f.seed(output([patch('😀'.repeat(400))]));
  expect(await f.apply(id)).toMatchObject({ result: 'suggested' });
  const after = await f.steps();
  expect(after['step-0'].information.goal.value).toBe('');
  expect(after['step-0'].fieldMeta.goal.suggestion.value).toBe('😀'.repeat(400));
  const frozen = (await db.query('select payload from runtime_executions where id=$1', [id])).rows[0].payload;
  expect(Buffer.byteLength(JSON.stringify(frozen))).toBeLessThan(262144);
  expect(frozen.scopeMaterial.content.work.steps['step-0'].notes).toEqual(raw['step-0'].notes);
  expect(JSON.stringify(frozen.scopeMaterial.content.work.steps)).not.toContain('suggestion');
  expect(JSON.stringify(frozen.scopeMaterial.content.work.steps)).not.toContain('"fp"');
  expect(Buffer.byteLength(JSON.stringify(frozen.scopeMaterial.content.work))).toBeLessThan(64000);
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
  await db.query("insert into artifact_requests values($1,md5('opc_capture:'||$2::text)::uuid,$3,'unrelated','{}','{}')", [f.d.projectId, id, f.d.roundId]);
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
  await rpc('account_erasure_confirm', { p_profile_id: f.actor, p_request_id: randomUUID() });
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
