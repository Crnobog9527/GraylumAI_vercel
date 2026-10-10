/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeAll, afterAll, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import { makePackage, makeWorkflow } from '../__tests__/fixtures/artifacts';
import { publishSkillPackage } from '../skills/publication';
import { opcService } from './service';
import { workbenchService } from '../artifacts/workbench';
import { overlap } from '../__tests__/fixtures/planBConcurrency';
import { runtimeAdmissionService } from '../runtime/admission';

// Match the existing capture suite: this DB/confirmation test does not exercise the external rate limiter.
vi.mock('../runtime/newWorkGate', async importOriginal => ({
  ...await importOriginal<typeof import('../runtime/newWorkGate')>(),
  ...(await import('../__tests__/fixtures/runtimeGates')).testAdmissionGates,
}));

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


it('RUNTIME: R13.3 observed edit/capture overlap protects both edited and untouched fields', async () => {
  const f = await fixture(), execution = await f.seed(output([patch('stale goal'), patch('stale other', 'step-0', 'other')]));
  const before = (await f.steps())['step-0'];
  const result = await overlap(db, connectionString,
    'select id from artifact_projects where id=$1 for update', [f.d.projectId],
    a => a.query('select opc_information($1,$2,$3,$4,$5,$6)', [f.actor, f.draft.draftId, 'step-0', randomUUID(),
      before.version, {...before.information, goal: tuple('manual current', 'provisional', 'fact')}]),
    b => b.query('select opc_capture_apply($1,$2,$3) result', [f.actor, f.draft.draftId, execution]));
  expect(result.other).toMatchObject({ok: true});
  const after = (await f.steps())['step-0'];
  expect(after.information.goal.value).toBe('manual current');
  expect(after.information.other.value).toBe('');
  expect(after.fieldMeta.goal.suggestion.value).toBe('stale goal');
  expect(after.fieldMeta.other.suggestion.value).toBe('stale other');
  const stable = await f.steps(); await f.apply(execution);
  expect(await f.steps()).toEqual(stable);
});

it('RUNTIME: R13.10-11 confirmation rechecks a capture-changed version and confirmed content remains immutable', async () => {
  const f = await fixture(); await f.save('user selected value');
  const workbench = workbenchService(f.user, admin);
  const initial = (await f.steps())['step-0'];
  await f.service.information({draftId: f.draft.draftId, requestId: randomUUID(), stepId: 'step-0',
    expectedVersion: initial.version, values: {...initial.information, goal: tuple('user selected value', 'confirmed', 'fact')}});
  const initialReady = (await f.steps())['step-0'];
  await workbench.execute({action: 'save', projectId: f.d.projectId, roundId: f.d.roundId,
    requestId: randomUUID(), stepId: 'step-0', expectedVersion: initialReady.version, body: 'Original ready body', evidenceIds: []});
  const before = (await f.steps())['step-0'];
  const execution = await f.seed(output([patch('new other', 'step-0', 'other')]));
  await f.apply(execution);
  // Same step version captured by the old confirmation card must not confirm the newer state.
  await expect(workbench.execute({action: 'confirm', projectId: f.d.projectId, roundId: f.d.roundId,
    requestId: randomUUID(), stepId: 'step-0', expectedVersion: before.version,
    expectedReviewVersion: before.reviewVersion})).rejects.toThrow('ARTIFACT_REVIEW_REQUIRED');
  const current = (await f.steps())['step-0'];
  await f.service.information({draftId: f.draft.draftId, requestId: randomUUID(), stepId: 'step-0',
    expectedVersion: current.version, values: {...current.information, goal: tuple('user selected value', 'confirmed', 'fact')}});
  const ready = (await f.steps())['step-0'];
  await workbench.execute({action: 'save', projectId: f.d.projectId, roundId: f.d.roundId,
    requestId: randomUUID(), stepId: 'step-0', expectedVersion: ready.version, body: 'Confirmed user selected value', evidenceIds: []});
  const saved = (await f.steps())['step-0'];
  const requestId = randomUUID();
  const confirm = {action: 'confirm' as const, projectId: f.d.projectId, roundId: f.d.roundId,
    requestId, stepId: 'step-0', expectedVersion: saved.version, expectedReviewVersion: saved.reviewVersion};
  await workbench.execute(confirm); await workbench.execute(confirm);
  const confirmed = (await f.steps())['step-0']; expect(confirmed.valid).toBe(true);
  const late = await f.seed(output([patch('must remain a suggestion')])); await f.apply(late);
  const after = (await f.steps())['step-0'];
  expect(after.information).toEqual(confirmed.information);
  expect(after.body).toBe(confirmed.body); expect(after.valid).toBe(true);
  expect(after.fieldMeta.goal.suggestion.value).toBe('must remain a suggestion');
  expect((await db.query('select count(*)::int n from artifact_confirmations where round_id=$1 and step_id=$2',
    [f.d.roundId, 'step-0'])).rows[0].n).toBe(1);
});

it('RUNTIME: R13.4-5 delayed writeback cannot replace a newer turn and both executions receive receipts', async () => {
  const f = await fixture();
  const older = await f.seed(output([patch('older')]));
  const newer = await f.seed(output([patch('newer')]));
  await f.apply(newer); await f.apply(older);
  const step = (await f.steps())['step-0'];
  expect(step.information.goal.value).toBe('newer');
  expect(step.fieldMeta.goal.executionId).toBe(newer);
  expect(step.fieldMeta.goal.suggestion).toMatchObject({value: 'older', executionId: older});
  expect((await f.records()).rowCount).toBe(2);
});
