/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// AGENT-CORE R8b PR-1: a stepped Skill without profileKey runs through the mentor flow but is never a positioning.
import { beforeAll, afterAll, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import { makePackage, makeWorkflow } from '../__tests__/fixtures/artifacts';
import { publishSkillPackage } from '../skills/publication';
import { opcService } from './service';
import { workbenchService } from '../artifacts/workbench';
import { stepSkillCatalog } from './stepSkill';

// Match the capture suites: this DB test does not exercise the external rate limiter.
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
const output = (value: string) => JSON.stringify({ inputKind: 'answer', notes: [],
  patches: [{ stepId: 'step-0', fieldId: 'hook', value, status: 'provisional', nature: 'fact', basis: 'user_statement' }] });

/** A published two-step Skill (e.g. a script): every step has fields; positioning adds profileKey fields. */
async function fixture(positioning: boolean) {
  const owner = randomUUID(), model = randomUUID(), moduleId = randomUUID();
  const email = randomUUID() + '@example.test', password = 'Local-' + randomUUID() + '!';
  const made = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (made.error) throw made.error;
  const actor = made.data.user.id;
  const pack = makePackage(), registration = 'step-skill-' + randomUUID(), flow = makeWorkflow(2);
  await db.query("insert into profiles(id,role,credits) values($1,'admin',10000),($2,'user',10000)", [owner, actor]);
  await db.query("insert into credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,idempotency_key,balance_before,balance_after) values($1,10000,'addition','grant','opening_grant','system',$2,0,10000)", [actor, randomUUID()]);
  await db.query('insert into skills(id,skill_key,created_by) values($1,$2,$3)', [pack.id, registration, owner]);
  await db.query("insert into ai_models(id,name,model_id,provider,is_active,max_tokens,input_limit) values($1,'Step fixture','opc-fixture-default','fixture','true',1000,64000)", [model]);
  await db.query('insert into modules(id,title,skill_id,model_id,active) values($1,$2,$3,$4,true)', [moduleId, registration, pack.id, model]);
  flow.steps.forEach((s, i) => { s.information = [
    { id: i === 0 ? 'hook' : 'body', title: i === 0 ? '开头' : '正文', required: true, ...(positioning ? { profileKey: 'k' + i } : {}) },
    { id: 'note', title: '备注', required: false },
  ]; });
  await publishSkillPackage(admin, owner, pack);
  await db.query('insert into artifact_workflows(id,module_id,skill_id,revision_id,workflow,label,enabled) values($1,$2,$3,$4,$5,$6,true)',
    [registration, moduleId, pack.id, pack.revisionId, flow, registration]);
  const user = createClient(process.env.V3_LOCAL_REST!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
  const login = await user.auth.signInWithPassword({ email, password });
  if (login.error) throw login.error;
  const service = opcService(user, admin);
  const draft = await service.start({ requestId: randomUUID(), registration, mode: 'mentor' });
  const d = (await db.query('select opc_query($1,$2) v', [actor, draft.draftId])).rows[0].v;
  const steps = async () => (await db.query('select steps from artifact_rounds where id=$1', [d.roundId])).rows[0].steps;
  const project = async () => (await db.query('select work_kind from artifact_projects where id=$1', [d.projectId])).rows[0];
  const businesses = async () => (await db.query('select count(*)::int n from opc_draft_businesses where draft_id=$1', [draft.draftId])).rows[0].n;
  return { actor, moduleId, pack, registration, user, service, draft, d, steps, project, businesses };
}

/** One synthetic completed mentor turn whose organizer proposes a value, persisted through the real admission. */
async function capturedTurn(f: Awaited<ReturnType<typeof fixture>>, value: string) {
  const requestId = randomUUID();
  const bypassCapture = new Proxy(admin, {
    get(target, key) {
      if (key !== 'rpc') return Reflect.get(target, key);
      return (name: string, args: Record<string, unknown>) => name === 'opc_capture_apply'
        ? { abortSignal: async () => ({ data: { processed: [], remaining: 0, hasMore: false }, error: null }) }
        : target.rpc(name, args);
    },
  });
  const prepared = await opcService(f.user, bypassCapture).prepareStep({ draftId: f.draft.draftId,
    requestId, stepId: 'step-0', purpose: 'mentor', questionId: 'hook', input: '我想做一条口播' });
  const id = prepared.executionId;
  await rpc('runtime_cancel', { p_actor_id: f.actor, p_execution_id: id });
  await db.query(`update runtime_executions set state='completed',unavailable_reason=null,result=$2,
    payload=payload || jsonb_build_object('attachedOrganizer',$3::jsonb) where id=$1`,
  [id, { body: 'Synthetic mentor', summary: output(value) }, { input: JSON.stringify({ captureFormat: 'v2' }) }]);
  return rpc('opc_capture_apply', { p_actor_id: f.actor, p_draft_id: f.draft.draftId, p_execution_id: id });
}

async function confirmAll(f: Awaited<ReturnType<typeof fixture>>, values: Record<string, Record<string, string>>) {
  const workbench = workbenchService(f.user, admin);
  for (const stepId of ['step-0', 'step-1']) {
    const current = (await f.steps())[stepId];
    const information = Object.fromEntries([stepId === 'step-0' ? 'hook' : 'body', 'note']
      .map(id => [id, values[stepId]?.[id] ? tuple(values[stepId][id], 'confirmed', 'fact') : tuple()]));
    await f.service.information({ draftId: f.draft.draftId, requestId: randomUUID(), stepId,
      expectedVersion: current.version, values: information });
    const ready = (await f.steps())[stepId];
    await workbench.execute({ action: 'save', projectId: f.d.projectId, roundId: f.d.roundId, requestId: randomUUID(),
      stepId, expectedVersion: ready.version, body: Object.values(values[stepId]).join('\n'), evidenceIds: [] });
    const saved = (await f.steps())[stepId];
    await workbench.execute({ action: 'confirm', projectId: f.d.projectId, roundId: f.d.roundId, requestId: randomUUID(),
      stepId, expectedVersion: saved.version, expectedReviewVersion: saved.reviewVersion });
  }
  const steps = await f.steps();
  const expectedSteps = Object.fromEntries(Object.entries(steps as Record<string, { version: number; reviewVersion: number }>)
    .map(([id, st]) => [id, { version: st.version, reviewVersion: st.reviewVersion }]));
  await workbench.execute({ action: 'publish', projectId: f.d.projectId, roundId: f.d.roundId, requestId: randomUUID(), expectedSteps });
  return { versionId: (await db.query('select id from artifact_versions where round_id=$1', [f.d.roundId])).rows[0]?.id as string };
}

it('RUNTIME: R8b a stepped Skill without profileKey starts, captures and confirms like positioning', async () => {
  const f = await fixture(false);
  expect(await f.project()).toEqual({ work_kind: 'step_skill' });
  expect(await f.businesses()).toBe(0);
  await capturedTurn(f, '三秒抓住注意力');
  expect((await f.steps())['step-0'].information.hook).toMatchObject({ value: '三秒抓住注意力', status: 'provisional' });
  const published = await confirmAll(f, { 'step-0': { hook: '三秒抓住注意力' }, 'step-1': { body: '讲清楚一个好处' } });
  expect(published.versionId).toBeTruthy();
  expect((await db.query('select state from artifact_rounds where id=$1', [f.d.roundId])).rows[0].state).toBe('published');
});

it('RUNTIME: R8b a stepped Skill result is never a positioning source', async () => {
  const f = await fixture(false);
  const { versionId } = await confirmAll(f, { 'step-0': { hook: '开头' }, 'step-1': { body: '正文' } });
  expect((await db.query('select opc_source_allowed($1,$2) v', [f.actor, versionId])).rows[0].v).toBe(false);
  expect((await db.query('select opc_has_confirmed_positioning($1) v', [f.actor])).rows[0].v).toBe(false);
  expect((await db.query('select count(*)::int n from opc_businesses where actor_id=$1', [f.actor])).rows[0].n).toBe(0);
  await expect(db.query('select opc_topic_consent($1,$2,$3)', [f.actor, f.draft.draftId, versionId]))
    .rejects.toThrow(/OPC_TOPIC_SOURCE_DENIED|OPC_DENIED/);
  // The flat Skill list leaves step flows out; this module is one.
  expect((await rpc('opc_step_flow_modules', {}) as string[])).toContain(f.moduleId);
  // The legacy saved-project list hides it like positioning projects.
  const projects = await rpc('artifact_query', { p_actor_id: f.actor, p_action: 'projects', p_project_id: null, p_round_id: null }) as Array<{ projectId: string }>;
  expect(projects.map(p => p.projectId)).not.toContain(f.d.projectId);
});

it('RUNTIME: R8b catalogs list their own kind; a stepped Skill refuses a business and positioning keeps its business', async () => {
  const positioning = await fixture(true);
  expect(await positioning.project()).toEqual({ work_kind: 'positioning' });
  expect(await positioning.businesses()).toBe(1);
  const businessId = (await db.query('select business_id from opc_draft_businesses where draft_id=$1', [positioning.draft.draftId])).rows[0].business_id;
  const stepped = await fixture(false);
  // The registry catalog refuses more than 100 enabled registrations; earlier suites in this run leave
  // theirs enabled (files run one at a time), so keep only these two for the catalog reads.
  await db.query('update artifact_workflows set enabled=false where enabled and id<>all($1)', [[positioning.registration, stepped.registration]]);
  // Each entry lists only its own kind.
  const stepIds = (await stepSkillCatalog(stepped.user, admin)).map(c => c.id);
  expect(stepIds).toContain(stepped.registration);
  expect(stepIds).not.toContain(positioning.registration);
  const positioningIds = (await stepped.service.catalog()).map(c => c.id);
  expect(positioningIds).toContain(positioning.registration);
  expect(positioningIds).not.toContain(stepped.registration);
  await expect(rpc('opc_start_b1', { p_actor_id: positioning.actor, p_request_id: randomUUID(), p_registration: stepped.registration,
    p_mode: 'mentor', p_business_id: businessId, p_business_name: null })).rejects.toThrow('OPC_BUSINESS_DENIED');
});
