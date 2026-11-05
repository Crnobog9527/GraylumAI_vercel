import {vi} from 'vitest';
import {allowTestCalls} from '../__tests__/fixtures/runtimeGates';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeAll, afterAll, afterEach, it, expect, onTestFinished } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { createClient } from "@supabase/supabase-js";
import { makePackage, makeWorkflow } from "../__tests__/fixtures/artifacts";
import { publishSkillPackage } from "../skills/publication";
import { opcService } from "./service";
import { workbenchService } from "../artifacts/workbench";
import { schemaGuard, snapshotSchema } from "../__tests__/fixtures/schemaSnapshot";
import { OPENING_INPUT, confirmQuestionValues } from "../../shared/opcQuestions";
import { agentTurnBody } from "../../shared/agentTurn";
import type { Page } from "../../../../../apps/web/node_modules/@playwright/test";
import { ensurePositioningProfilePlans } from '../__tests__/fixtures/positioningProfilePlans';
const connectionString = process.env.V3_LOCAL_DB!;
if (
  !connectionString?.startsWith("postgres://postgres@127.0.0.1:") ||
  !connectionString.endsWith("/v3_disposable")
)
  throw new Error("isolated runner required");
const sql = new pg.Client({ connectionString });
const admin = createClient(
  process.env.V3_LOCAL_REST!,
  process.env.V3_LOCAL_SERVICE_JWT!,
  { auth: { persistSession: false } },
);
// Several cases replay old migrations on this shared database to prove an
// upgrade path. Restore the schema after every case and fail the case that
// leaves anything unrestorable (see schemaSnapshot.ts).
let restoreSchema = async () => {};
beforeAll(async () => { await sql.connect(); restoreSchema = await schemaGuard(sql); await ensurePositioningProfilePlans(sql); }, 120000);
afterEach(async () => { await restoreSchema(); await ensurePositioningProfilePlans(sql); }, 120000);
afterAll(() => sql.end());

/** The exact business turns in a fixture, not just "one row per request ID". */
type ExpectedMentorEffect = {
  stepId: string;
  questionId: string;
  opening: boolean;
  input: string;
  /** Optional per-turn scope; defaults to the call's draft/round. */
  scope?: Readonly<{ draftId: string; roundId: string }>;
};
type MentorEffectRow = {
  execution_id: string;
  request_id: string;
  billing_id: string | null;
  pre_deduct_id: string | null;
  draft_id: string | null;
  round_id: string | null;
  step_id: string | null;
  purpose: string | null;
  task: string | null;
  input: string | null;
  execution_state: string;
  billing_state: string | null;
};
async function expectExactMentorEffects(
  actorId: string,
  draftId: string,
  roundId: string,
  expected: readonly ExpectedMentorEffect[],
) {
  const readEffects = async () => (await sql.query<MentorEffectRow>(
    `select e.id::text execution_id, e.request_id::text request_id,
       b.id::text billing_id, b.pre_deduct_id::text pre_deduct_id,
       t.draft_id::text draft_id, t.round_id::text round_id, t.step_id, t.purpose,
       e.payload->'request'->'selection'->>'task' task,
       e.payload->'request'->>'input' input,
       e.state execution_state, b.state billing_state
     from runtime_executions e
     left join opc_turns t on t.session_id=e.session_id and t.request_id=e.request_id
     left join bill2_runs b on b.id=e.billing_run_id and b.actor_id=e.actor_id
     where e.actor_id=$1`,
    [actorId],
  )).rows;
  const expectedTurns = expected.map(turn => JSON.stringify({
    draftId: turn.scope?.draftId ?? draftId,
    roundId: turn.scope?.roundId ?? roundId,
    stepId: turn.stepId, purpose: "mentor",
    task: (turn.opening ? "opc-opening:" : "opc-question:") + turn.questionId,
    input: turn.input, executionState: "completed", billingState: "settled",
  })).sort();
  const project = (rows: MentorEffectRow[]) => rows.map(row => JSON.stringify({
    draftId: row.draft_id, roundId: row.round_id, stepId: row.step_id,
    purpose: row.purpose, task: row.task, input: row.input,
    executionState: row.execution_state, billingState: row.billing_state,
  })).sort();
  await expect.poll(async () => project(await readEffects()), { timeout: 30000 })
    .toEqual(expectedTurns);
  const rows = await readEffects();
  expect(project(rows)).toEqual(expectedTurns);
  // Also count all actor billing runs/reservations, so unlinked duplicate runs
  // cannot be hidden by the join or by using a fresh random request ID.
  expect((await sql.query("select count(*)::int n from bill2_runs where actor_id=$1", [actorId])).rows[0].n)
    .toBe(expected.length);
  expect((await sql.query("select count(*)::int n from credit_transactions where user_id=$1 and reason_code='bill2_reserve'", [actorId])).rows[0].n)
    .toBe(expected.length);
  expect(new Set(rows.map(row => row.request_id)).size).toBe(expected.length);
  expect(rows.every(row => Boolean(row.billing_id && row.pre_deduct_id))).toBe(true);
  expect(new Set(rows.map(row => row.billing_id)).size).toBe(expected.length);
  expect(new Set(rows.map(row => row.pre_deduct_id)).size).toBe(expected.length);
  // Identity sets are compared before/after navigation and authentication
  // recovery; a replacement execution must not pass as a restored one.
  return rows.map(row => JSON.stringify([
    row.execution_id, row.request_id, row.billing_id, row.pre_deduct_id,
  ])).sort();
}
async function mentorMessageCheck(
  page: Page,
  actorId: string,
  executionId: string,
): Promise<() => Promise<void>> {
  const rows = (await sql.query<{ body: string | null }>(
    "select coalesce(result->>'body', primary_result->>'body') body from runtime_executions where actor_id=$1 and id=$2",
    [actorId, executionId],
  )).rows;
  expect(rows).toHaveLength(1);
  const payload: unknown = JSON.parse(rows[0].body ?? "null");
  if (!payload || typeof payload !== "object" || !("message" in payload) ||
      typeof payload.message !== "string" || !payload.message.trim())
    throw new Error("expected this execution's completed public message");
  const normalise = (value: string) => value.replace(/\s+/g, " ").trim();
  const expected = normalise(payload.message);
  const paragraph = page.locator(
    `[data-execution-id="${executionId}"] [data-message-role="assistant"] p`,
  );
  return async () => {
    await expect.poll(() => paragraph.count(), { timeout: 60000 }).toBe(1);
    await paragraph.waitFor({ state: "visible", timeout: 60000 });
    await expect.poll(async () => normalise(
      (await paragraph.textContent({ timeout: 5000 })) ?? "",
    ), { timeout: 60000 }).toBe(expected);
  };
}

async function fixture(
  n = 6, secondField = false, extraFields = 0,
  configure?: (flow: ReturnType<typeof makeWorkflow>) => void,
  methodLabel = "隔离定位 " + n,
) {
  const password = "Local-" + randomUUID() + "!",
    email = randomUUID() + "@example.test";
  const made = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (made.error) throw made.error;
  const actor = made.data.user.id;
  await sql.query(
    // Most OPC cases exercise unrelated workflows; use the maximum plan so
    // the new per-tier profile limit does not constrain their setup helpers.
    "insert into profiles(id,email,role,credits,membership_level) values($1,$2,'user',1000,'gold')",
    [actor, email],
  );
  await sql.query(
    "insert into credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,idempotency_key,balance_before,balance_after) values($1,1000,'addition','grant','opening_grant','system',$2,0,1000)",
    [actor, randomUUID()],
  );
  const user = createClient(
    process.env.V3_LOCAL_REST!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false } },
  );
  const login = await user.auth.signInWithPassword({ email, password });
  if (login.error) throw login.error;
  const owner = randomUUID();
  await sql.query("insert into profiles(id,role) values($1,'admin')", [owner]);
  const pack = makePackage(),
    moduleId = randomUUID(),
    registration = "opc-" + randomUUID(),
    flow = makeWorkflow(n, n === 6),
    // The published module always carries an administrator model binding, the
    // same way the real product does, so the host can open a question itself.
    fixtureModel = randomUUID();
  flow.steps.forEach((step, index) => {
    step.information = [
      {
        id: "goal",
        title: "已知目标 " + index,
        required: true,
        profileKey: "goal_" + index,
      },
    ];
  });
  if (secondField) flow.steps[0].information!.push({id:"other",title:"Second independent field",required:false,profileKey:"other"});
  // Configurable extra fields let a focused case exercise more than the two
  // default questions of the first step without a second fixture.
  for (let i = 0; i < extraFields; i++)
    flow.steps[0].information!.push({
      id: "extra" + i,
      title: "Extra field " + i,
      required: false,
      profileKey: "extra_" + i,
    });
  configure?.(flow);
  await sql.query(
    "insert into skills(id,skill_key,created_by) values($1,$2,$3)",
    [pack.id, registration, owner],
  );
  await sql.query(
    "insert into ai_models(id,name,model_id,provider,is_active,max_tokens,input_limit) values($1,'Fixture default','opc-fixture-default','fixture','true',1000,32000)",
    [fixtureModel],
  );
  await sql.query(
    "insert into modules(id,title,skill_id,model_id,active) values($1,$2,$3,$4,true)",
    [moduleId, methodLabel, pack.id, fixtureModel],
  );
  await publishSkillPackage(admin, owner, pack);
  await sql.query(
    "insert into artifact_workflows(id,module_id,skill_id,revision_id,workflow,label,enabled) values($1,$2,$3,$4,$5,$6,true)",
    [registration, moduleId, pack.id, pack.revisionId, flow, methodLabel],
  );
  return {
    actor,
    owner,
    user,
    pack,
    moduleId,
    registration,
    flow,
    email,
    password,
    service: opcService(user, admin),
    artifacts: workbenchService(user, admin),
  };
}
// The approved merged workspace currently illustrates these six positioning
// stages. This is test data, not the production Skill definition: the latter
// is read from each draft's pinned workflow revision.
async function mergedPositioningFixture(configure?: (flow: ReturnType<typeof makeWorkflow>) => void) {
  const titles = ['需求确认','竞品研究','账号定位','内容策略','运营建议','商业规划'];
  const questions = [
    [['product','产品与服务'],['platforms','准备经营的平台'],['time','每周可用时间']],
    [['reference','参考研究结论']],
    [['audience','优先服务的用户'],['difference','价值与依据']],
    [['roles','内容表达与平台安排']],
    [['cadence','可持续的制作安排']],
    [['offer','内容如何支持业务']],
  ] as const;
  const result=await fixture(6,false,0,flow=>{
    flow.planResources=['SKILL.md'];
    flow.steps.forEach((step,index)=>{
      step.title=titles[index];
      step.information=questions[index].map(([id,title])=>({id,title,required:true,profileKey:id,elicitation:['reference','audience','roles','cadence','offer'].includes(id)?'agent_proposal' as const:'user_fact' as const}));
      flow.report.sections[index].title=titles[index];
    });
    configure?.(flow);
  },'梳理账号定位 · 六步');
  return result;
}
it('OPC: PROFILE_LIMIT allows one free profile and blocks the next', async () => {
  const f = await fixture();
  await sql.query("update profiles set membership_level='free' where id=$1", [f.actor]);
  const start = () => f.service.start({requestId:randomUUID(),registration:f.registration,mode:'manual'});
  await start();
  await expect(start()).rejects.toThrow('OPC_PROFILE_LIMIT');
  expect((await sql.query(
    'select count(*)::int n from opc_businesses where actor_id=$1 and erased_at is null', [f.actor],
  )).rows[0].n).toBe(1);
});

it('OPC: PROFILE_LIMIT keeps old membership-plan inserts compatible', async () => {
  await sql.query(
    `insert into membership_plans(id,name,level,allow_fusion_review,allow_fusion_compare,library_storage_bytes,
      allow_publish,own_data_window_days,allow_benchmark_monitor,allow_weekly_auto_review)
     values($1,'pro','pro',true,true,500000000,true,30,false,false) on conflict(level) do nothing`,
    [randomUUID()],
  );
  expect((await sql.query(
    "select positioning_profile_limit from membership_plans where level='pro'",
  )).rows[0].positioning_profile_limit).toBe(3);
});

it('OPC: PROFILE_LIMIT uses configured Pro 3 and Gold 6 caps', async () => {
  const f = await fixture();
  await sql.query("update profiles set membership_level='pro' where id=$1", [f.actor]);
  const limits = (await sql.query(
    "select level,positioning_profile_limit from membership_plans where level in ('pro','gold') order by level",
  )).rows;
  expect(limits).toEqual([
    {level:'gold',positioning_profile_limit:6},
    {level:'pro',positioning_profile_limit:3},
  ]);
  const start = () => f.service.start({requestId:randomUUID(),registration:f.registration,mode:'manual'});
  const existing = [await start(),await start(),await start()];
  await expect(start()).rejects.toThrow('OPC_PROFILE_LIMIT');
  await sql.query("update profiles set membership_level='gold' where id=$1", [f.actor]);
  existing.push(await start(),await start(),await start());
  expect((await sql.query(
    'select count(*)::int n from opc_businesses where actor_id=$1 and erased_at is null', [f.actor],
  )).rows[0].n).toBe(6);
  await expect(start()).rejects.toThrow('OPC_PROFILE_LIMIT');
});

it('OPC: PROFILE_LIMIT keeps existing drafts readable but denies new profiles after Pro expiry', async () => {
  const f = await fixture();
  await sql.query("update profiles set membership_level='pro' where id=$1", [f.actor]);
  const start = () => f.service.start({requestId:randomUUID(),registration:f.registration,mode:'manual'});
  const existing = [await start(),await start(),await start()];
  const plan = (await sql.query("select id from membership_plans where level='pro'")).rows[0];
  const subscriptionId = randomUUID();
  const externalId = 'sub_' + randomUUID();
  const contract = {
    version:1,item_type:'membership_plan',item_id:plan.id,item_updated_at:'2026-01-01T00:00:00Z',
    billing_cycle:'monthly',currency:'usd',unit:'major',price:'10',discount:'0',
    tax_behavior:'unspecified',credits:0,bonus_credits:0,
  };
  await sql.query(
    `insert into user_subscriptions(id,user_id,membership_plan_id,stripe_subscription_id,billing_cycle,status,
      cancel_at_period_end,current_period_start,current_period_end,payment_channel,merchant_namespace,payment_mode,contract_snapshot)
     values($1,$2,$3,$4,'monthly','active','true',now()-interval '1 month',now()-interval '1 hour',
      'stripe','paywall-test','test',$5::jsonb)`,
    [subscriptionId,f.actor,plan.id,externalId,JSON.stringify(contract)],
  );
  await sql.query(
    `insert into payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,subscription_id)
     values('stripe','paywall-test','test','subscription',$1,$2)`,
    [externalId,subscriptionId],
  );
  await expect(f.service.read(existing[0]!.draftId)).resolves.toMatchObject({draftId:existing[0]!.draftId});
  await expect(start()).rejects.toThrow('OPC_PROFILE_LIMIT');
  expect((await sql.query('select membership_level from profiles where id=$1',[f.actor])).rows[0].membership_level)
    .toBe('pro');
});

it('OPC: PROFILE_LIMIT serializes concurrent free profile starts', async () => {
  const f = await fixture();
  await sql.query("update profiles set membership_level='free' where id=$1", [f.actor]);
  const start = () => f.service.start({requestId:randomUUID(),registration:f.registration,mode:'manual'});
  const attempts = await Promise.allSettled([start(),start()]);
  const created = attempts.filter(result => result.status === 'fulfilled');
  const rejected = attempts.filter(result => result.status === 'rejected');
  expect(created).toHaveLength(1);
  expect(rejected).toHaveLength(1);
  expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({message:'OPC_PROFILE_LIMIT'});
  expect((await sql.query('select count(*)::int n from opc_businesses where actor_id=$1 and erased_at is null',[f.actor])).rows[0].n)
    .toBe(1);
  expect((await sql.query('select count(*)::int n from opc_drafts where actor_id=$1',[f.actor])).rows[0].n)
    .toBe(1);
});

it("OPC: an edited six-stage Skill gives new drafts new steps and questions while old drafts stay pinned", async () => {
  const f = await mergedPositioningFixture();
  const oldDraft = await f.service.start({requestId:randomUUID(),registration:f.registration,mode:"manual"});
  const oldBefore = await f.service.read(oldDraft.draftId);
  expect(oldBefore.snapshot.workflow.steps.map((step:{title:string})=>step.title)).toEqual(
    ['需求确认','竞品研究','账号定位','内容策略','运营建议','商业规划'],
  );
  expect(oldBefore.information['step-0'].schema.map((field:{id:string})=>field.id))
    .toEqual(['product','platforms','time']);

  const revisedPackage = makePackage(f.pack.id,true);
  const revisedRegistration = 'opc-six-revised-'+randomUUID();
  const revisedFlow = makeWorkflow(7,false);
  f.flow.steps.forEach((step,index)=>{
    revisedFlow.steps[index] = structuredClone(step);
    revisedFlow.report.sections[index].title = step.title;
  });
  revisedFlow.steps[0].title = '需求与目标';
  revisedFlow.steps[0].information = [
    {id:'audience_goal',title:'本期服务目标',required:true,profileKey:'audience_goal'},
    ...structuredClone(f.flow.steps[0].information),
  ];
  revisedFlow.report.sections[0].title = '需求与目标';
  revisedFlow.steps[6].title = '效果验证';
  revisedFlow.steps[6].information = [
    {id:'measure',title:'如何验证效果',required:true,profileKey:'measure'},
  ];
  revisedFlow.report.sections[6].title = '效果验证';
  await publishSkillPackage(admin,f.owner,revisedPackage);
  await sql.query(
    'insert into artifact_workflows(id,module_id,skill_id,revision_id,workflow,label,enabled) values($1,$2,$3,$4,$5,$6,true)',
    [revisedRegistration,f.moduleId,revisedPackage.id,revisedPackage.revisionId,revisedFlow,'修订后的定位'],
  );
  const newDraft = await f.service.start({requestId:randomUUID(),registration:revisedRegistration,mode:"manual"});
  const [oldAfter,newAfter] = await Promise.all([
    f.service.read(oldDraft.draftId),f.service.read(newDraft.draftId),
  ]);
  expect(oldAfter.snapshot.workflow.steps).toHaveLength(6);
  expect(oldAfter.snapshot.workflow.steps[0].title).toBe('需求确认');
  expect(oldAfter.information['step-0'].schema.map((field:{id:string})=>field.id))
    .toEqual(['product','platforms','time']);
  expect(newAfter.snapshot.workflow.steps).toHaveLength(7);
  expect(newAfter.snapshot.workflow.steps[0].title).toBe('需求与目标');
  expect(newAfter.snapshot.workflow.steps[6].title).toBe('效果验证');
  expect(newAfter.information['step-0'].schema.map((field:{id:string})=>field.id))
    .toEqual(['audience_goal','product','platforms','time']);
  expect(newAfter.information['step-6'].schema.map((field:{id:string})=>field.id))
    .toEqual(['measure']);
  const pinned = await sql.query(
    `select d.draft_id::text draft_id,r.revision_id::text revision_id from opc_drafts d
     join artifact_rounds r on r.id=d.round_id where d.draft_id in ($1,$2)`,
    [oldDraft.draftId,newDraft.draftId],
  );
  expect(pinned.rows.find((row:{draft_id:string})=>row.draft_id===oldDraft.draftId)?.revision_id)
    .toBe(f.pack.revisionId);
  expect(pinned.rows.find((row:{draft_id:string})=>row.draft_id===newDraft.draftId)?.revision_id)
    .toBe(revisedPackage.revisionId);
  const {chromium}=await import('../../../../../apps/web/node_modules/@playwright/test');
  const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
  try {
    const context=await browser.newContext({viewport:{width:1600,height:900},deviceScaleFactor:1});
    await context.route('**/*',route=>['127.0.0.1','localhost'].includes(new URL(route.request().url()).hostname)?route.continue():route.abort());
    const page=await context.newPage();
    page.setDefaultTimeout(30000);
    await page.goto(process.env.V3_LOCAL_APP+'/login?redirect='+encodeURIComponent('/app/positioning/'+newDraft.draftId));
    await page.getByPlaceholder('name@example.com').fill(f.email);
    await page.getByPlaceholder('输入你的密码').fill(f.password);
    await page.getByRole('button',{name:'登录',exact:true}).last().click();
    await page.waitForURL(url=>url.pathname==='/app/positioning/'+newDraft.draftId);
    const stages=page.getByRole('navigation',{name:'定位步骤'}).getByRole('button');
    await expect.poll(()=>stages.count()).toBe(7);
    expect(await stages.first().innerText()).toContain('需求与目标');
    expect(await stages.last().innerText()).toContain('效果验证');
    await page.getByRole('textbox',{name:'本期服务目标',exact:true}).waitFor();
    await page.screenshot({path:process.env.V3_WORKBENCH_OUTPUT+'/u2-revised-skill-seven-stage.png'});
    await page.goto(process.env.V3_LOCAL_APP+'/app/positioning/'+oldDraft.draftId);
    await expect.poll(()=>stages.count()).toBe(6);
    expect(await stages.first().innerText()).toContain('需求确认');
    await page.getByRole('textbox',{name:'产品与服务',exact:true}).waitFor();
  } finally { await browser.close(); }
},180000);
async function completed(n = 6, mode: "manual" | "mentor" = "manual") {
  const f = await fixture(n);
  const requestId = randomUUID();
  const d = await f.service.start({
    requestId,
    registration: f.registration,
    mode,
  });
  for (const step of f.flow.steps) {
    await f.artifacts.execute({
      action: "save",
      projectId: d.projectId,
      roundId: d.roundId,
      requestId: randomUUID(),
      stepId: step.id,
      body: "User confirmed " + step.title,
      evidenceIds: [],
      expectedVersion: 0,
    });
    const snap = await f.artifacts.read(d.projectId, d.roundId);
    const state = snap.steps[step.id];
    await f.service.information({
      draftId: d.draftId,
      stepId: step.id,
      requestId: randomUUID(),
      expectedVersion: state.version,
      values: {
        goal: {
          status: "confirmed",
          nature: "decision",
          value: "A concrete user decision",
        },
      },
    });
    const updated = (await f.artifacts.read(d.projectId, d.roundId)).steps[
      step.id
    ];
    await f.artifacts.execute({
      action: "confirm",
      projectId: d.projectId,
      roundId: d.roundId,
      requestId: randomUUID(),
      stepId: step.id,
      expectedVersion: updated.version,
      expectedReviewVersion: updated.reviewVersion,
    });
  }
  const snap = await f.artifacts.read(d.projectId, d.roundId);
  await f.artifacts.execute({
    action: "publish",
    projectId: d.projectId,
    roundId: d.roundId,
    requestId: randomUUID(),
    expectedSteps: Object.fromEntries(
      Object.entries(snap.steps).map(([k, v]) => [
        k,
        { version: v.version, reviewVersion: v.reviewVersion },
      ]),
    ),
  });
  const read = await f.service.read(d.draftId);
  return { ...f, d, sourceVersionId: read.report.id };
}
it("OPC: start replay and concurrency preserve one draft/session; actor and payload changes denied", async () => {
  const f = await fixture(),
    input = {
      requestId: randomUUID(),
      registration: f.registration,
      mode: "mentor",
    };
  const [a, b] = await Promise.all([
    f.service.start(input),
    f.service.start(input),
  ]);
  expect(a).toEqual(b);
  await expect(f.service.start({ ...input, mode: "manual" })).rejects.toThrow(
    "CONFLICT",
  );
  const other = await fixture();
  await expect(other.service.read(a.draftId)).rejects.toThrow("DENIED");
});
it("OPC: confirmed multi-account handoff is atomic, concurrent/replayed once and keeps original source/session/money", async () => {
  const f = await completed();
  const body = [
    {
      id: randomUUID(),
      platform: "x",
      account: "one",
      title: "Topic one",
      brief: "Original brief",
      day: "2026-09-15",
    },
    {
      id: randomUUID(),
      platform: "youtube",
      account: "two",
      title: "Topic two",
      brief: "Second brief",
      day: "2026-09-16",
    },
  ];
  const plan = await f.service.savePlan({
    draftId: f.d.draftId,
    requestId: randomUUID(),
    expectedVersion: 0,
    sourceVersionId: f.sourceVersionId,
    body,
  });
  const input = {
    draftId: f.d.draftId,
    requestId: randomUUID(),
    planId: plan.planId,
    accounts: body.map((i) => ({
      platform: i.platform,
      account: i.account,
      expectedRevision: null,
    })),
  };
  const [a, b] = await Promise.all([
    f.service.handoff(input),
    f.service.handoff(input),
  ]);
  expect(a).toEqual(b);
  expect(a).toHaveLength(2);
  expect(new Set(a.map((x: { sessionId: string }) => x.sessionId)).size).toBe(
    2,
  );
  expect(
    a.every((x: { sessionId: string }) => x.sessionId !== f.d.sessionId),
  ).toBe(true);
  expect((await f.service.list()).accounts).toHaveLength(2);
  expect((await f.service.read(f.d.draftId)).sessionId).toBe(f.d.sessionId);
  expect(
    (await sql.query("select credits from profiles where id=$1", [f.actor]))
      .rows[0].credits,
  ).toBe(1000);
  await expect(
    f.service.handoff({ ...input, accounts: [input.accounts[0]] }),
  ).rejects.toThrow("CONFLICT");
  await expect(
    f.service.handoff({ ...input, requestId: randomUUID() }),
  ).rejects.toThrow("ACCOUNT_CONFLICT");
  expect(
    (
      await sql.query(
        "select count(*)::int n from opc_items where plan_id=$1",
        [plan.planId],
      )
    ).rows[0].n,
  ).toBe(2);
});
it("OPC: stale plan, invalid target and transaction failure leave no partial accounts", async () => {
  const f = await completed();
  const body = [
    {
      id: randomUUID(),
      platform: "x",
      account: "one",
      title: "Topic",
      brief: "Brief",
      day: "2026-09-15",
    },
  ];
  const p = await f.service.savePlan({
    draftId: f.d.draftId,
    requestId: randomUUID(),
    expectedVersion: 0,
    sourceVersionId: f.sourceVersionId,
    body,
  });
  const input = {
    draftId: f.d.draftId,
    requestId: randomUUID(),
    planId: p.planId,
    accounts: [{ platform: "x", account: "one", expectedRevision: 1 }],
  };
  await expect(f.service.handoff(input)).rejects.toThrow("CONFLICT");
  await f.service.savePlan({
    draftId: f.d.draftId,
    requestId: randomUUID(),
    expectedVersion: 1,
    sourceVersionId: f.sourceVersionId,
    body,
  });
  await expect(
    f.service.handoff({
      ...input,
      accounts: [{ ...input.accounts[0], expectedRevision: null }],
    }),
  ).rejects.toThrow("VERSION_CONFLICT");
  expect((await f.service.list()).accounts).toHaveLength(0);
});

it("OPC: revising positioning retains original version/session and invalidates only configured dependents", async () => {
  const f = await completed(3);
  const old = await f.service.read(f.d.draftId);
  const request = randomUUID();
  const revision = await f.service.revise(f.d.draftId, request, f.d.roundId);
  expect(await f.service.revise(f.d.draftId, request, f.d.roundId)).toEqual(
    revision,
  );
  const current = await f.service.read(f.d.draftId);
  expect(current.sessionId).toBe(f.d.sessionId);
  expect(current.roundId).not.toBe(f.d.roundId);
  await f.artifacts.execute({
    action: "save",
    projectId: f.d.projectId,
    roundId: current.roundId,
    requestId: randomUUID(),
    stepId: "step-1",
    expectedVersion: current.snapshot.steps["step-1"].version,
    body: "Changed decision",
    evidenceIds: [],
  });
  const next = await f.service.read(f.d.draftId);
  expect(next.snapshot.steps["step-0"].valid).toBe(true);
  expect(next.snapshot.steps["step-1"].valid).toBe(false);
  expect(next.snapshot.steps["step-2"].valid).toBe(false);
  expect(await f.artifacts.report(f.d.projectId, f.d.roundId)).toEqual(
    old.report,
  );
});
it("OPC: required information states gate confirmation and survive revisions without replacing facts", async () => {
  const f = await fixture(3),
    d = await f.service.start({
      requestId: randomUUID(),
      registration: f.registration,
      mode: "mentor",
    });
  await f.artifacts.execute({
    action: "save",
    projectId: d.projectId,
    roundId: d.roundId,
    requestId: randomUUID(),
    stepId: "step-0",
    expectedVersion: 0,
    body: "A provisional answer",
    evidenceIds: [],
  });
  for (const status of [
    "unknown",
    "unclear",
    "provisional",
    "deferred",
    "confirmed",
  ] as const) {
    const before = await f.artifacts.read(d.projectId, d.roundId);
    await f.service.information({
      draftId: d.draftId,
      requestId: randomUUID(),
      stepId: "step-0",
      expectedVersion: before.steps["step-0"].version,
      values: {
        goal: {
          status,
          nature: "hypothesis",
          value:
            status === "deferred"
              ? "User accepts this limitation"
              : "User material",
        },
      },
    });
    const after = await f.artifacts.read(d.projectId, d.roundId),
      command = {
        action: "confirm" as const,
        projectId: d.projectId,
        roundId: d.roundId,
        requestId: randomUUID(),
        stepId: "step-0",
        expectedVersion: after.steps["step-0"].version,
        expectedReviewVersion: after.steps["step-0"].reviewVersion,
      };
    if (["deferred", "confirmed"].includes(status))
      await f.artifacts.execute(command);
    else await expect(f.artifacts.execute(command)).rejects.toThrow();
    expect(
      (await f.service.read(d.draftId)).information["step-0"].values.goal
        .status,
    ).toBe(status);
  }
  const other = await fixture();
  await expect(
    other.service.information({
      draftId: d.draftId,
      requestId: randomUUID(),
      stepId: "step-0",
      expectedVersion: 0,
      values: {},
    }),
  ).rejects.toThrow("DENIED");
});
it("OPC: deferred required information preserves draft progress but cannot publish a formal positioning", async () => {
  const f = await fixture(3);
  const d = await f.service.start({ requestId: randomUUID(), registration: f.registration, mode: "manual" });
  for (const step of f.flow.steps) {
    const before = await f.service.read(d.draftId);
    const values = Object.fromEntries(step.information!.map(field => [field.id, {
      status: "deferred", nature: "unknown", value: "用户明确说明目前缺少这项必需信息。",
    }]));
    await f.service.information({ draftId: d.draftId, stepId: step.id, requestId: randomUUID(), expectedVersion: before.snapshot.steps[step.id].version, values });
    const saved = await f.service.read(d.draftId);
    await f.artifacts.execute({ action: "save", projectId: d.projectId, roundId: d.roundId, requestId: randomUUID(), stepId: step.id, expectedVersion: saved.snapshot.steps[step.id].version, body: "暂缓原因已保留", evidenceIds: [] });
    const ready = await f.service.read(d.draftId);
    await f.artifacts.execute({ action: "confirm", projectId: d.projectId, roundId: d.roundId, requestId: randomUUID(), stepId: step.id, expectedVersion: ready.snapshot.steps[step.id].version, expectedReviewVersion: ready.snapshot.steps[step.id].reviewVersion });
  }
  const ready = await f.service.read(d.draftId);
  expect(Object.values(ready.snapshot.steps).every((step: any) => step.valid)).toBe(true);
  await expect(f.artifacts.execute({
    action: "publish", projectId: d.projectId, roundId: d.roundId, requestId: randomUUID(),
    expectedSteps: Object.fromEntries(Object.entries(ready.snapshot.steps).map(([id, step]: [string, any]) => [id, { version: step.version, reviewVersion: step.reviewVersion }])),
  })).rejects.toThrow("ARTIFACT_REVIEW_REQUIRED");
  expect((await f.service.read(d.draftId)).snapshot.state).toBe("draft");
});
for (const scenario of ["fresh", "retry", "same-field", "offline", "response-lost"]) {
  const conflict=scenario!=="fresh";
  it(`OPC: two browser tabs preserve edits (${scenario})`, async () => {
    const { chromium } = await import("../../../../../apps/web/node_modules/@playwright/test");
    const f = await fixture(3, true);
    const draft = await f.service.start({requestId:randomUUID(),registration:f.registration,mode:"manual"});
    const browser = await chromium.launch({executablePath:"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",headless:true});
    let release: (()=>void) | undefined;
    try {
      const context = await browser.newContext();
      await context.route("**/*",route => ["127.0.0.1","localhost"].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
      const a = await context.newPage();
      a.setDefaultTimeout(20000);
      const loginReady=a.waitForResponse(r=>r.url().includes("settings.getSystemSettings") && r.ok(),{timeout:90000});
      await a.goto(process.env.V3_LOCAL_APP+"/login?redirect=/positioning",{timeout:90000,waitUntil:"domcontentloaded"});
      await loginReady;
      await a.getByPlaceholder("name@example.com").fill(f.email);
      await a.getByPlaceholder("输入你的密码").fill(f.password);
      await a.getByRole("button",{name:"登录",exact:true}).last().click();
      await a.waitForURL(url=>url.pathname==="/app/positioning",{timeout:90000});
      const url=process.env.V3_LOCAL_APP+"/app/positioning/"+draft.draftId;
      await a.goto(url);
      if(scenario==="offline" || scenario==="response-lost") {
        await a.getByRole("textbox",{name:"已知目标 0",exact:true}).waitFor();
        const requests: string[]=[];
        let blocked=true, committed=false;
        await a.route("**/api/trpc/**",async route=>{
          if(route.request().method()==="POST" && route.request().url().includes("opc.information")) {
            requests.push(route.request().postData()!);
            if(blocked) {
              if(scenario==="response-lost" && !committed) { const response=await route.fetch(); expect(response.ok()).toBe(true);committed=true; }
              return route.abort("connectionreset");
            }
          }
          return route.continue();
        });
        await a.getByRole("textbox",{name:"已知目标 0",exact:true}).fill("Recover my original edit");
        await a.getByRole("status",{name:"自动保存失败",exact:true}).getByRole("button",{name:"重试",exact:true}).waitFor();
        const original=requests[0]; expect(original).toBeTruthy();
        expect((await sql.query("select count(*)::int n from artifact_requests where project_id=$1 and action='opc_information'",[draft.projectId])).rows[0].n).toBe(scenario==="response-lost"?1:0);
        await context.clearCookies();
        const readyAgain=a.waitForResponse(r=>r.url().includes("settings.getSystemSettings") && r.ok(),{timeout:90000});
        await a.goto(process.env.V3_LOCAL_APP+"/login?redirect="+encodeURIComponent(new URL(url).pathname));
        await readyAgain;
        await a.getByPlaceholder("name@example.com").fill(f.email);
        await a.getByPlaceholder("输入你的密码").fill(f.password);
        await a.getByRole("button",{name:"登录",exact:true}).last().click();
        await a.waitForURL(url,{timeout:90000});
        await a.getByRole("status",{name:"自动保存失败",exact:true}).getByRole("button",{name:"重试",exact:true}).waitFor();
        expect(await a.getByRole("textbox",{name:"已知目标 0",exact:true}).inputValue()).toBe("Recover my original edit");
        blocked=false;
        await a.getByRole("status",{name:"自动保存失败",exact:true}).getByRole("button",{name:"重试",exact:true}).click();
        await expect.poll(async()=> (await f.service.read(draft.draftId)).information["step-0"].values?.goal?.value,{timeout:20000}).toBe("Recover my original edit");
        await expect.poll(()=>a.getByRole("status",{name:"自动保存失败",exact:true}).getByRole("button",{name:"重试",exact:true}).count()).toBe(0);
        expect(new Set(requests).size).toBe(1);
        expect((await sql.query("select count(*)::int n from artifact_requests where project_id=$1 and action='opc_information'",[draft.projectId])).rows[0].n).toBe(1);
        expect((await f.service.read(draft.draftId)).sessionId).toBe(draft.sessionId);
        return;
      }
      // B reaches its next question only after A explicitly confirms the first.
      await a.getByRole("textbox",{name:"已知目标 0",exact:true}).fill("Initially confirmed goal");
      await a.getByRole("textbox",{name:"已知目标 0",exact:true}).locator("..").getByRole("button",{name:/^(确认本题并继续|确认当前信息，继续)$/,exact:true}).click();
      await a.getByRole("textbox",{name:"Second independent field",exact:true}).waitFor();
      // Manual entry now shows every field of the step at once, so the second
      // field no longer proves the confirmation landed; B must load after it.
      await expect.poll(async()=>(await f.service.read(draft.draftId)).information["step-0"].values?.goal?.status,{timeout:20000}).toBe("confirmed");
      const b=await context.newPage(); b.setDefaultTimeout(20000); await b.goto(url);
      await b.getByRole("textbox",{name:"Second independent field",exact:true}).waitFor();
      // The ordered navigator names each reached row with its hierarchical
      // question number and its own answer status.
      await a.getByRole("button",{name:/^1\.1 已知目标 0 · 已确认/}).click();
      if(scenario==="same-field") await b.getByRole("button",{name:/^1\.1 已知目标 0 · 已确认/}).click();
      await a.getByRole("textbox",{name:"已知目标 0",exact:true}).waitFor();
      const held=new Promise<void>(resolve=>{release=resolve;});
      let reached!:()=>void;
      const intercepted=new Promise<void>(resolve=>{reached=resolve;});
      // Hold either B's fresh-version read or its first write, not the backend.
      let once=true;
      await b.route("**/api/trpc/**",async route=>{
        const req=route.request();
        if(once && (conflict ? req.method()==="POST" && req.url().includes("opc.information") : req.method()==="GET" && req.url().includes("opc.read"))) {
          once=false; reached(); await held;
        }
        await route.continue();
      });
      await b.getByRole("textbox",{name:scenario==="same-field" ? "已知目标 0" : "Second independent field",exact:true}).fill("B original edit");
      await Promise.race([intercepted,new Promise((_,reject)=>setTimeout(()=>reject(new Error("autosave barrier not reached")),20000))]);
      await a.getByRole("textbox",{name:"已知目标 0",exact:true}).fill("A saved independently");
      await expect.poll(async()=>(await f.service.read(draft.draftId)).information["step-0"].values?.goal?.value,{timeout:20000}).toBe("A saved independently");
      release!();
      if(scenario==="same-field") {
        await b.getByText("其他窗口修改了相同字段。你的输入未提交，请比较后决定。",{exact:true}).waitFor();
        expect((await f.service.read(draft.draftId)).information["step-0"].values.goal.value).toBe("A saved independently");
        await b.reload();
        await b.getByText("其他窗口修改了相同字段。你的输入未提交，请比较后决定。",{exact:true}).waitFor();
        expect(await b.getByRole("textbox",{name:"已知目标 0",exact:true}).inputValue()).toBe("B original edit");
        await b.getByRole("button",{name:"保留我的这些修改并重新保存",exact:true}).click();
        await expect.poll(async()=>(await f.service.read(draft.draftId)).information["step-0"].values?.goal?.value,{timeout:20000}).toBe("B original edit");
        return;
      }
      await expect.poll(async()=>(await f.service.read(draft.draftId)).information["step-0"].values?.other?.value,{timeout:20000}).toBe("B original edit");
      expect((await f.service.read(draft.draftId)).information["step-0"].values.goal.value).toBe("A saved independently");
    } finally { release?.(); await browser.close(); }
  },180000);
}


async function finalized(n = 3, withTopics = false) {
  const f = await fixture(
    n,
    false,
    0,
    withTopics ? (flow) => { flow.planResources = ["SKILL.md"]; } : undefined,
  );
  const d = await f.service.start({
    requestId: randomUUID(),
    registration: f.registration,
    mode: "manual",
  });
  for (const step of f.flow.steps) {
    await f.artifacts.execute({
      action: "save", projectId: d.projectId, roundId: d.roundId,
      requestId: randomUUID(), stepId: step.id,
      body: "User confirmed " + step.title, evidenceIds: [], expectedVersion: 0,
    });
    const state = (await f.artifacts.read(d.projectId, d.roundId)).steps[step.id];
    await f.service.information({
      draftId: d.draftId, stepId: step.id, requestId: randomUUID(),
      expectedVersion: state.version,
      values: {
        goal: { status: "confirmed", nature: "decision", value: "A concrete user decision" },
      },
    });
    const updated = (await f.artifacts.read(d.projectId, d.roundId)).steps[step.id];
    await f.artifacts.execute({
      action: "confirm", projectId: d.projectId, roundId: d.roundId,
      requestId: randomUUID(), stepId: step.id,
      expectedVersion: updated.version, expectedReviewVersion: updated.reviewVersion,
    });
  }
  return { ...f, d };
}
/** A fixture-backed model bound to the module under test. */
/**
 * Every local browser request shares 127.0.0.1, and the website IP limiter
 * (#488) allows 60 per minute. A long journey (reloads plus #595 history
 * polling) exceeds that, which the positioning cases using this do not verify:
 * start a fresh window before a heavy phase. This empties this run's whole
 * disposable Redis (IP, message and call buckets alike) after checking its
 * ownership labels, so it is for preparing non-rate-limit cases only and must
 * never be used inside a RATE-LIMIT case. It must run before the limit is
 * reached: once an IP is limited, the website's limiter client also remembers
 * the block in its own process until the window ends. Nothing happens without
 * the local limiter.
 */
async function resetLocalIpWindow() {
  const tag = process.env.V3_RATE_LIMIT_TAG, owner = process.env.V3_RATE_LIMIT_OWNER;
  if (!tag || !owner) return;
  const { resetLocalRateLimit } = await import("../../../../db/tests/v3/local-rate-limit.mjs");
  resetLocalRateLimit(tag, owner);
}
/**
 * A server value alone does not prove the page finished its autosave: until it
 * clears its local buffer, a reload restores that edit against the old base and
 * reports a same-field conflict. Reload only after this.
 */
async function autosaveAcknowledged(page: Page, draftId: string, stepId = "step-0") {
  await expect.poll(() => page.evaluate(({ id, step }) => {
    if (sessionStorage.getItem("opc-information-autosave:" + id + ":" + step)) return false;
    const raw = sessionStorage.getItem("opc-edit:" + id);
    const state = raw ? JSON.parse(raw) : null;
    return !state?.infoEdits || !Object.hasOwn(state.infoEdits, step);
  }, { id: draftId, step: stepId }), { timeout: 30000 }).toBe(true);
}
/**
 * dc3ab89a keeps "暂时跳过本题" for manual entry only; a mentor draft has no
 * deferral control in the UI (deliberately; see #588). Cases that need a
 * deferred question in a mentor draft therefore make the server calls that
 * control makes (the values from confirmQuestionValues and, when they finish
 * the step, the step result save and confirm) and only verify the downstream
 * behaviour after that server-side deferral, not any deferral UI.
 */
async function deferQuestion(
  f: { service: ReturnType<typeof opcService>; artifacts: ReturnType<typeof workbenchService> },
  draftId: string, stepId: string, questionId: string,
) {
  const d = await f.service.read(draftId);
  const schema = d.information[stepId].schema as Array<{ id: string; title: string; required: boolean }>;
  const { values, finishStep } = confirmQuestionValues(schema, d.information[stepId].values ?? {}, questionId, true, { allowUnreached: true });
  await f.service.information({ draftId, stepId, requestId: randomUUID(), expectedVersion: d.snapshot.steps[stepId].version, values });
  if (!finishStep) return;
  const body = schema.filter(field => values[field.id].value).map(field =>
    field.title + "\n" + (values[field.id].status === "deferred" ? "（暂缓确认）" : "") + values[field.id].value).join("\n\n");
  const saved = await f.service.read(draftId);
  await f.artifacts.execute({ action: "save", projectId: saved.projectId, roundId: saved.roundId, requestId: randomUUID(), stepId,
    body, evidenceIds: saved.snapshot.steps[stepId].evidenceIds, expectedVersion: saved.snapshot.steps[stepId].version });
  const state = (await f.artifacts.read(saved.projectId, saved.roundId)).steps[stepId];
  await f.artifacts.execute({ action: "confirm", projectId: saved.projectId, roundId: saved.roundId, requestId: randomUUID(), stepId,
    expectedVersion: state.version, expectedReviewVersion: state.reviewVersion });
}
/**
 * Test data hygiene, not product behaviour. Every case registers its own
 * fixture module and enabled workflow, and product reads cap them:
 * runtime.choices sees only userVisibleModules(limit:64), unordered, so a work
 * item's own Skill can be missing and its turn runs as ordinary chat; the
 * catalog query raises 'registry capacity' above 100 enabled workflows. A case
 * that depends on its own Skill or method keeps only its modules enabled. The
 * ids it disables are recorded and restored when this case finishes, pass or fail.
 */
async function onlyOwnCatalog(moduleIds: string[]) {
  const modules = (await sql.query("update modules set active=false where active and id<>all($1::uuid[]) returning id", [moduleIds])).rows.map(row => row.id);
  const workflows = (await sql.query("update artifact_workflows set enabled=false where enabled and module_id<>all($1::uuid[]) returning id", [moduleIds])).rows.map(row => row.id);
  onTestFinished(async () => {
    await sql.query("update modules set active=true where id=any($1::uuid[])", [modules]);
    await sql.query("update artifact_workflows set enabled=true where id=any($1::text[])", [workflows]);
  });
}
async function planFixtureModel(moduleId: string) {
  const model = randomUUID();
  await sql.query(
    "insert into ai_models(id,name,model_id,provider,is_active,max_tokens,input_limit) values($1,'Runtime local','opc-browser','fixture','true',1000,32000)",
    [model],
  );
  await organizerFixtureModel();
  await sql.query("update modules set model_id=$1 where id=$2", [model, moduleId]);
  return model;
}
/** Owns the global extraction organizer setting instead of inheriting another case's. Returns its model name. */
async function organizerFixtureModel() {
  const summaryModel = randomUUID(), name = "opc-organizer-" + summaryModel;
  await sql.query(
    "insert into ai_models(id,name,model_id,provider,is_active,max_tokens,input_limit) values($1,'OPC organizer',$2,'fixture','true',1000,32000)",
    [summaryModel, name],
  );
  await sql.query(
    "insert into system_settings(key,value) values('v3_summary_model_id',to_jsonb($1::text)),('v3_summary_max_tokens','1000'::jsonb) on conflict(key) do update set value=excluded.value",
    [summaryModel],
  );
  return name;
}
/**
 * Exact plan-purpose money and identity for one actor: nothing here is derived
 * from a request the test itself made up.
 */
async function planIdentity(actor: string, draftId: string) {
  const count = async (q: string, params: unknown[]) =>
    Number((await sql.query(q, params)).rows[0].n);
  return {
    executions: await count(
      "select count(*)::int n from runtime_executions where actor_id=$1", [actor]),
    planExecutions: await count(
      "select count(*)::int n from runtime_executions e join opc_turns t on t.session_id=e.session_id and t.request_id=e.request_id where e.actor_id=$1 and t.purpose='plan'",
      [actor],
    ),
    planRuns: await count(
      "select count(*)::int n from bill2_runs b join runtime_executions e on e.billing_run_id=b.id join opc_turns t on t.session_id=e.session_id and t.request_id=e.request_id where b.actor_id=$1 and t.purpose='plan'",
      [actor],
    ),
    reserves: await count(
      "select count(*)::int n from credit_transactions where user_id=$1 and reason_code='bill2_reserve'",
      [actor],
    ),
    plans: await count("select count(*)::int n from opc_plans where draft_id=$1", [draftId]),
    accounts: await count(
      "select count(*)::int n from opc_accounts where actor_id=$1", [actor]),
    workItems: await count(
      "select count(*)::int n from artifact_projects where actor_id=$1 and work_kind='account'",
      [actor],
    ),
  };
}
/** Execution/billing/pre-deduct identity rows, compared before and after recovery. */
async function planIdentityRows(actor: string) {
  return (await sql.query(
    `select e.id::text execution_id, e.request_id::text request_id,
       b.id::text billing_id, b.pre_deduct_id::text pre_deduct_id
     from runtime_executions e
     left join bill2_runs b on b.id=e.billing_run_id
     where e.actor_id=$1`,
    [actor],
  )).rows.map((row) =>
    JSON.stringify([row.execution_id, row.request_id, row.billing_id, row.pre_deduct_id]),
  ).sort();
}
/** The envelope the positioning page freezes after a successful publish. */
function planEnvelopeFor(
  f: { d: { draftId: string; roundId: string } },
  options: { requestId?: string; sourceRoundId?: string; accounts?: string[] } = {},
) {
  return {
    // The consent marker: these cases seed the envelope that only an explicit
    // "继续生成第一周选题" may write, so they keep proving that a lost reply
    // replays its own identity instead of paying twice.
    v: 3,
    sourceRoundId: options.sourceRoundId ?? f.d.roundId,
    consentedAt: new Date("2026-09-20T07:00:00.000Z").toISOString(),
    request: {
      draftId: f.d.draftId,
      requestId: options.requestId ?? randomUUID(),
      purpose: "plan",
      stepId: "step-1",
      input: JSON.stringify({
        confirmedPositioning: { "已知目标 0": "A concrete user decision" },
        platforms: [],
        accounts: options.accounts ?? [],
        startDate: "2026-09-21",
        days: 7,
      }),
    },
  };
}
/**
 * a8dba69c: /plan only recovers a request an older client already admitted;
 * opening it never admits one. Seeds that server state as the old client left
 * it: admitted and, unless `execute` is false, completed.
 */
async function planBrowser(
  f: { email: string; password: string; d: { draftId: string } },
  options: {
    envelope?: Record<string, unknown> | null;
    clearBuffer?: boolean;
    buffer?: Record<string, unknown> | null;
  } = {},
) {
  const { chromium } =
    await import("../../../../../apps/web/node_modules/@playwright/test");
  const browser = await chromium.launch({
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
  });
  const context = await browser.newContext();
  await context.route("**/*", (route) => {
    const u = new URL(route.request().url());
    return ["127.0.0.1", "localhost"].includes(u.hostname) ||
      ["data:", "blob:"].includes(u.protocol)
      ? route.continue()
      : route.abort();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(90000);
  const path = "/app/positioning/" + f.d.draftId;
  await page.goto(
    process.env.V3_LOCAL_APP + "/login?redirect=" + encodeURIComponent(path),
  );
  await page.getByPlaceholder("name@example.com").fill(f.email);
  await page.getByPlaceholder("输入你的密码").fill(f.password);
  await page.getByRole("button", { name: "登录", exact: true }).last().click();
  await page.waitForURL((url) => url.pathname.endsWith('/app/positioning/' + f.d.draftId));
  const key = "opc-plan-generation:" + f.d.draftId;
  await page.evaluate(
    ({ key, envelope, clearBuffer, buffer, draftId }) => {
      sessionStorage.removeItem(key);
      if (envelope) sessionStorage.setItem(key, JSON.stringify(envelope));
      if (clearBuffer) sessionStorage.removeItem("opc-edit:" + draftId);
      if (buffer)
        sessionStorage.setItem("opc-edit:" + draftId, JSON.stringify(buffer));
    },
    {
      key,
      envelope: options.envelope ?? null,
      clearBuffer: options.clearBuffer ?? false,
      buffer: options.buffer ?? null,
      draftId: f.d.draftId,
    },
  );
  if (options.envelope || options.buffer) await page.goto(process.env.V3_LOCAL_APP + path);
  return { browser, context, page, key };
}
const CANDIDATE_HEADING = "AI 计划候选 · 尚未替换你的编辑";
it("OPC: Stage C1 the final positioning confirmation asks first and spends nothing until an explicit continue generates one candidate", async () => {
  const { chromium } =
    await import("../../../../../apps/web/node_modules/@playwright/test");
  // This draft's method declares topic resources, so the explicit consent may
  // bind the topic workspace.
  const f = await finalized(3, true);
  await planFixtureModel(f.moduleId);
  const browser = await chromium.launch({
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
  });
  const context = await browser.newContext();
  await context.route("**/*", (route) => {
    const u = new URL(route.request().url());
    return ["127.0.0.1", "localhost"].includes(u.hostname) ||
      ["data:", "blob:"].includes(u.protocol)
      ? route.continue()
      : route.abort();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(90000);
  const draftPath = "/app/positioning/" + f.d.draftId;
  const envelopeKey = "opc-plan-generation:" + f.d.draftId;
  try {
    await page.goto(
      process.env.V3_LOCAL_APP + "/login?redirect=" + encodeURIComponent(draftPath),
    );
    await page.getByPlaceholder("name@example.com").fill(f.email);
    await page.getByPlaceholder("输入你的密码").fill(f.password);
    await page.getByRole("button", { name: "登录", exact: true }).last().click();
    await page.waitForURL((url) => url.pathname.endsWith(draftPath));
    const finalButton = page.getByRole("button", {
      name: "确认正式定位",
      exact: true,
    });
    await expect.poll(() => finalButton.isEnabled(), { timeout: 30000 }).toBe(true);
    // Nothing is authorized before the user confirms: no envelope, and no plan
    // work of any kind. (The positioning page may open its mentor question on
    // its own; that is not plan work and is excluded by the plan-purpose joins.)
    expect(await page.evaluate((k) => sessionStorage.getItem(k), envelopeKey)).toBeNull();
    const before = await planIdentity(f.actor, f.d.draftId);
    expect(before.planExecutions).toBe(0);
    expect(before.planRuns).toBe(0);
    await finalButton.click();
    // Confirming the positioning publishes the version and asks. It must not
    // create a generation request by itself.
    const dialog = page.getByRole("dialog", { name: "是否继续生成第一周选题" });
    await dialog.waitFor();
    await page.keyboard.press('Escape');
    await expect.poll(() => dialog.count()).toBe(0);
    expect((await topicIdentity(f.actor)).topicExecutions).toBe(0);
    await page.getByRole('button', { name: '继续生成第一周选题', exact: true }).click();
    await dialog.getByRole('button', { name: '关闭选题询问', exact: true }).click();
    await expect.poll(() => dialog.count()).toBe(0);
    expect((await topicIdentity(f.actor)).binds).toBe(0);
    await page.getByRole('button', { name: '继续生成第一周选题', exact: true }).click();
    await dialog.getByRole("button", { name: "稍后", exact: true }).click();
    await expect.poll(() => dialog.count(), { timeout: 15000 }).toBe(0);
    expect(await page.evaluate((k) => sessionStorage.getItem(k), envelopeKey)).toBeNull();
    // A refresh, a re-login or the re-entry control are not consent either.
    await page.reload();
    await page
      .getByRole("button", { name: "继续生成第一周选题", exact: true })
      .waitFor();
    expect(await page.evaluate((k) => sessionStorage.getItem(k), envelopeKey)).toBeNull();
    const asked = await planIdentity(f.actor, f.d.draftId);
    expect(asked.planExecutions).toBe(0);
    expect(asked.planRuns).toBe(0);
    expect(asked.reserves).toBe(0);
    // The explicit continue enters the bound topic workspace. It binds the
    // confirmed version, the pinned method revision and a dedicated Session,
    // and starts the one explicitly accepted first turn.
    await page
      .getByRole("button", { name: "继续生成第一周选题", exact: true })
      .click();
    await dialog
      .getByRole("button", { name: "继续生成第一周选题", exact: true })
      .click();
    await page.waitForURL((url) => url.pathname.endsWith(draftPath + "/topics"));
    await page
      .getByRole("heading", { name: "第一批选题", level: 1, exact: true })
      .waitFor();
    // One canonical reading of the binding row. Mentor Session, topic Session,
    // bind request, frozen source version and creation time are different
    // fields; the earlier failure compared a bind request id with a round id.
    const bindingState = async () =>
      (
        await sql.query(
          "select w.session_id::text topic_session, w.request_id::text bind_request, w.source_version_id::text source_version, w.created_at::text created_at, s.scope topic_scope from opc_topic_workspaces w join runtime_sessions s on s.id=w.session_id and s.actor_id=w.actor_id where w.draft_id=$1 and w.actor_id=$2",
          [f.d.draftId, f.actor],
        )
      ).rows as Array<Record<string, unknown>>;
    const boundRows = await bindingState();
    expect(boundRows).toHaveLength(1);
    const bound = boundRows[0]!;
    // Bound to the confirmed version of this round, in its own Session.
    expect(
      (
        await sql.query(
          "select round_id::text r from artifact_versions where id=$1",
          [bound.source_version],
        )
      ).rows[0].r,
    ).toBe(f.d.roundId);
    expect(bound.topic_scope).toEqual({
      kind: "positioning_topic",
      draftId: f.d.draftId,
    });
    expect(await page.evaluate((k) => sessionStorage.getItem(k), envelopeKey)).toBeNull();
    const after = await planIdentity(f.actor, f.d.draftId);
    // Opening runs under topic purpose, separate from legacy plan generation.
    expect(after.planExecutions - before.planExecutions).toBe(0);
    expect(after.planRuns - before.planRuns).toBe(0);
    await expect.poll(async () => (await topicIdentity(f.actor)).topicExecutions, { timeout: 30000 }).toBe(1);
    // Re-entering with the same confirmed source recovers the very same
    // binding: same Session, same bind identity, no second workspace.
    await page.goto(process.env.V3_LOCAL_APP + draftPath);
    await page
      .getByRole("button", { name: "继续生成第一周选题", exact: true })
      .click();
    await dialog
      .getByRole("button", { name: "继续生成第一周选题", exact: true })
      .click();
    await page.waitForURL((url) => url.pathname.endsWith(draftPath + "/topics"));
    await page
      .getByRole("heading", { name: "第一批选题", level: 1, exact: true })
      .waitFor();
    const againRows = await bindingState();
    expect(againRows).toHaveLength(1);
    // The identical row: same topic Session, same bind request identity, same
    // frozen source version and the same creation time.
    expect(againRows[0]).toEqual(bound);
    expect(after.plans).toBe(0);
    expect(after.accounts).toBe(0);
    expect(after.workItems).toBe(0);
  } finally {
    await browser.close();
  }
}, 300000);
it("OPC: Stage C4 an already published draft spends nothing by waiting or refreshing", async () => {
  const f = await publishedDraft();
  await planFixtureModel(f.moduleId);
  const before = { plan: await planIdentity(f.actor, f.d.draftId), topic: await topicIdentity(f.actor) };
  expect(before.plan.planExecutions).toBe(0);
  expect(before.topic).toMatchObject({ binds: 0, topicExecutions: 0 });
  // Without a local request the plan link continues to the topic workspace.
  const { browser, page, key } = await planBrowser(f);
  try {
    expect(await page.evaluate((k) => sessionStorage.getItem(k), key)).toBeNull();
    const start = page.getByRole("button", { name: "开始选题工作对话", exact: true });
    await start.waitFor();
    await page.reload();
    await start.waitFor();
    // Give an automatic generation every chance to (wrongly) fire.
    await new Promise((resolve) => setTimeout(resolve, 3000));
    // The retired /plan address is a permanent redirect (next.config) to the positioning conversation.
    await page.goto(process.env.V3_LOCAL_APP + "/app/positioning/" + f.d.draftId + "/plan");
    await page.waitForURL((url) => url.pathname === "/app/positioning/" + f.d.draftId);
    await new Promise((resolve) => setTimeout(resolve, 3000));
    expect(await planIdentity(f.actor, f.d.draftId)).toEqual(before.plan);
    expect(await topicIdentity(f.actor)).toEqual(before.topic);
    expect(await page.getByRole("heading", { name: CANDIDATE_HEADING, exact: true }).count()).toBe(0);
    // Only the explicit start may create one request, and it is topic work.
    await start.click();
    await expect.poll(async () => (await topicIdentity(f.actor)).topicExecutions, { timeout: 30000 }).toBe(1);
    expect((await topicIdentity(f.actor)).binds).toBe(1);
    expect(await planIdentity(f.actor, f.d.draftId)).toMatchObject({ planExecutions: 0, planRuns: 0 });
  } finally {
    await browser.close();
  }
}, 300000);
it("OPC: an upstream reconfirmation can be resubmitted and never hides already answered questions", async () => {
  const {chromium} = await import("../../../../../apps/web/node_modules/@playwright/test");
  const f = await fixture(3, true), model = randomUUID();
  await sql.query("insert into ai_models(id,name,model_id,provider,is_active,max_tokens,input_limit) values($1,'Reconfirm local','opc-reconfirm','fixture','true',1000,32000)",[model]);
  await sql.query("update modules set model_id=$1 where id=$2",[model,f.moduleId]);
  // v5 openings carry an organizer extraction (#497): own that global setting.
  await organizerFixtureModel();
  const draft = await f.service.start({requestId: randomUUID(), registration: f.registration, mode: "mentor"});
  const browser = await chromium.launch({executablePath:"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",headless:true});
  const startedAt = Date.now();
  const marks: Record<string, number> = {};
  const external: string[] = [];
  try {
    const context = await browser.newContext();
    await context.route("**/*", route => {
      const host = new URL(route.request().url()).hostname;
      if (["127.0.0.1","localhost"].includes(host)) return route.continue();
      external.push(host);
      return route.abort();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    page.setDefaultNavigationTimeout(90000);
    const errors: string[] = [];
    page.on("pageerror", e => errors.push(e.message));
    const path = "/app/positioning/" + draft.draftId;
    const ready = page.waitForResponse(r => r.url().includes("settings.getSystemSettings") && r.ok(), {timeout: 90000});
    await page.goto(process.env.V3_LOCAL_APP + "/login?redirect=" + encodeURIComponent(path));
    await ready;
    await page.getByPlaceholder("name@example.com").fill(f.email);
    await page.getByPlaceholder("输入你的密码").fill(f.password);
    await page.getByRole("button", {name:"登录", exact:true}).last().click();
    await page.waitForURL(process.env.V3_LOCAL_APP + path);

    const read = async () => await f.service.read(draft.draftId);
    const stepState = async (stepId: string) => (await read()).snapshot.steps[stepId] as {valid: boolean};
    // Each configured step owns its own field title.
    const goalOf = (n: number) => page.getByRole("textbox", {name:"已知目标 " + n, exact:true});
    const confirmButton = () => page.getByRole("button", {name:/^(确认本题并继续|确认当前信息，继续)$/, exact:true});
    const navigator = page.getByRole("navigation", {name:"本步骤已到达的问题"});
    // Since dc3ab89a a step tab reads "<n> <title>", or "✓ <title>" once valid.
    const stepPill = (n: number) =>
      page.getByRole("navigation", {name:"定位步骤"}).getByRole("button", {name:new RegExp("^(✓|" + n + ") " + f.flow.steps[n - 1].title + "$")});
    const rowTexts = async () =>
      (await navigator.getByRole("button").allTextContents()).map(t => t.replace(/\s+/g," ").trim());

    // Step 0: confirm the first question, defer the optional one, so step 0 is valid.
    await goalOf(0).fill("初始定位");
    await confirmButton().click();
    await expect.poll(async () => (await read()).information["step-0"].values?.goal?.status, {timeout:30000}).toBe("confirmed");
    await expect.poll(async () => (await rowTexts()).length, {timeout:30000}).toBe(2);
    // No deferral UI in a mentor draft: defer on the server, then check the page.
    // Like the removed control, defer only after this question's own opening finished.
    await page.getByRole("log", {name:"完整 AI 教练消息"}).getByText("AI 自媒体陪跑教练 · 主动引导 · 1.2", {exact:true}).waitFor({timeout:60000});
    await deferQuestion(f, draft.draftId, "step-0", "other");
    await resetLocalIpWindow();

    await page.reload();
    await expect.poll(async () => (await read()).information["step-0"].values?.other?.status, {timeout:30000}).toBe("deferred");
    await expect.poll(async () => (await stepState("step-0")).valid, {timeout:30000}).toBe(true);

    // Step 1 must be confirmed BEFORE the upstream change, so it can be invalidated.
    await resetLocalIpWindow();
    await stepPill(2).click();
    await goalOf(1).waitFor();
    await goalOf(1).fill("第二步定位");
    await confirmButton().click();
    await expect.poll(async () => (await stepState("step-1")).valid, {timeout:60000}).toBe(true);
    marks.step1Confirmed = Date.now() - startedAt;

    // Q-F2: going back and editing the first answer must not shrink the review list.
    await resetLocalIpWindow();
    await stepPill(1).click();
    await expect.poll(async () => (await rowTexts()).length, {timeout:30000}).toBe(2);
    const pinned = await rowTexts();
    await navigator.getByRole("button", {name:/^1\.1 /}).click();
    await goalOf(0).fill("修改后的定位");
    await expect.poll(async () => (await read()).information["step-0"].values?.goal?.status, {timeout:30000}).toBe("provisional");
    await expect.poll(async () => (await rowTexts()).length, {timeout:30000}).toBe(2);
    await expect.poll(async () => (await rowTexts())[0] ?? "", {timeout:30000}).toContain("待核对");
    const afterEdit = await rowTexts();
    expect(afterEdit.map(t => t.split(" ")[0])).toEqual(pinned.map(t => t.split(" ")[0]));
    expect(afterEdit[0]).toContain("待核对");
    expect(afterEdit[1]).toContain("待定（已暂缓）");
    marks.rowsKeptAfterEdit = Date.now() - startedAt;
    // A refresh keeps the same durable rows.
    await autosaveAcknowledged(page, draft.draftId);
    await resetLocalIpWindow();

    await page.reload();
    await expect.poll(async () => (await rowTexts()).length, {timeout:90000}).toBe(2);

    // Q-F1: resubmit the upstream step without changing anything else; that
    // invalidates the confirmed downstream step.
    await navigator.getByRole("button", {name:/^1\.1 /}).click();
    await confirmButton().click();
    await expect.poll(async () => (await stepState("step-0")).valid, {timeout:90000}).toBe(true);
    await expect.poll(async () => (await stepState("step-1")).valid, {timeout:60000}).toBe(false);
    marks.downstreamInvalidated = Date.now() - startedAt;

    // The downstream answers are still resolved, but the step needs an explicit
    // reconfirmation; the button must be actionable and the resubmit must stick.
    await resetLocalIpWindow();
    await stepPill(2).click();
    await expect.poll(async () => confirmButton().isEnabled(), {timeout:30000}).toBe(true);
    await confirmButton().click();
    await expect.poll(async () => (await stepState("step-1")).valid, {timeout:90000}).toBe(true);
    marks.downstreamReconfirmed = Date.now() - startedAt;
    expect((await read()).information["step-1"].values?.goal?.value).toBe("第二步定位");
    // A valid step with an unchanged answer offers no duplicate submit.
    await resetLocalIpWindow();
    await stepPill(2).click();
    await goalOf(1).waitFor();
    await expect.poll(async () => confirmButton().isEnabled(), {timeout:30000}).toBe(false);

    // Q-F3: finish the workflow and check the completion copy does not promise a
    // dialog that does not exist yet.
    await resetLocalIpWindow();
    await stepPill(3).click();
    await goalOf(2).waitFor();
    await goalOf(2).fill("第三步定位");
    await confirmButton().click();
    await expect.poll(async () => (await stepState("step-2")).valid, {timeout:90000}).toBe(true);
    const completion = page.getByText("本步骤进度已完成", {exact:true}).first();
    await completion.waitFor();
    const completionText = await page.locator("body").textContent();
    expect(completionText).not.toContain("再次明确同意");
    expect(completionText).not.toContain("才会询问是否生成");
    await expect.poll(() => page.getByRole("button", {name:"确认正式定位", exact:true}).count(), {timeout:30000}).toBe(1);

    expect(errors).toEqual([]);
    expect(external).toEqual([]);
    console.log("OPC_QF_MILESTONES " + JSON.stringify({...marks, totalMs: Date.now() - startedAt}));
  } finally {
    await browser.close();
  }
}, 300000);

it("OPC: the historical reach projection is idempotent, permission-scoped and contamination-safe", async () => {
  const { readFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  // Five fields keeps q4/q5 unreached, so a foreign stronger frontier would be
  // visible if it leaked and a rejected write could really extend reach.
  const f = await fixture(3, false, 4), model = randomUUID();
  await sql.query("insert into ai_models(id,name,model_id,provider,is_active,max_tokens,input_limit) values($1,'Reach local','opc-reach','fixture','true',1000,32000)",[model]);
  await sql.query("update modules set model_id=$1 where id=$2",[model,f.moduleId]);
  const draft = await f.service.start({requestId: randomUUID(), registration: f.registration, mode: "mentor"});
  const stepVersion = async (stepId: string) =>
    (await f.service.read(draft.draftId)).snapshot.steps[stepId].version;
  const reachOf = async (stepId: string) =>
    ((await f.service.read(draft.draftId)).information[stepId] as { reached?: string[] }).reached ?? [];

  // Reproduce the previous read contract for real: restore 0110 (no `reached`),
  // then create records under it before applying 0111.
  const migration = (name: string) => readFileSync(
    resolve(import.meta.dirname, "../../../../db/migrations/" + name),
    "utf8",
  );
  // The whole transition runs under one failure-safe cleanup: any failure —
  // including the first swap — restores the current read definition, and the
  // original error is preserved (the restore never masks it).
  try {
  await sql.query(migration("0110_opc_turn_round_ownership.sql"));
  const priorRead = await f.service.read(draft.draftId);
  expect(Object.hasOwn(priorRead.information["step-0"], "reached")).toBe(false);

  await f.service.information({
    draftId: draft.draftId, stepId: "step-0", requestId: randomUUID(),
    expectedVersion: await stepVersion("step-0"),
    values: {
      goal: { status: "confirmed", nature: "fact", value: "客户定位" },
      extra0: { status: "deferred", nature: "unknown", value: "暂缓的原因" },
      extra1: { status: "unknown", nature: "unknown", value: "" },
      extra2: { status: "unknown", nature: "unknown", value: "" },
      extra3: { status: "unknown", nature: "unknown", value: "" },
    },
  });
  const before = await f.service.read(draft.draftId);
  const beforeKeys = Object.keys(before).sort();
  const beforeSteps = JSON.stringify(before.snapshot.steps);
  const beforeValues = JSON.stringify(before.information["step-0"].values);
  expect(Object.hasOwn(before.information["step-0"], "reached")).toBe(false);

  // Upgrade: the prior records must survive and the new reach must appear.
  await sql.query(migration("0111_opc_historical_reach.sql"));
  const after = await f.service.read(draft.draftId);
  expect(Object.keys(after).sort()).toEqual(beforeKeys);
  expect(JSON.stringify(after.snapshot.steps)).toBe(beforeSteps);
  expect(JSON.stringify(after.information["step-0"].values)).toBe(beforeValues);
  expect(await reachOf("step-0")).toEqual(["goal","extra0","extra1"]);

  // Restore the prior contract and re-apply 0111 without losing records.
  await sql.query(migration("0110_opc_turn_round_ownership.sql"));
  const restored = await f.service.read(draft.draftId);
  expect(Object.hasOwn(restored.information["step-0"], "reached")).toBe(false);
  expect(JSON.stringify(restored.snapshot.steps)).toBe(beforeSteps);
  expect(JSON.stringify(restored.information["step-0"].values)).toBe(beforeValues);
  await sql.query(migration("0111_opc_historical_reach.sql"));
  expect(await reachOf("step-0")).toEqual(["goal","extra0","extra1"]);
  expect(JSON.stringify((await f.service.read(draft.draftId)).snapshot.steps)).toBe(beforeSteps);
  } finally {
    try {
      await sql.query(migration("0111_opc_historical_reach.sql"));
    } catch (restoreError) {
      console.error("reach read-contract restore failed", String(restoreError));
      throw restoreError;
    }
  }

  // Revoked scope is denied with the exact code through the normal read entry,
  // and the flag is restored even if the assertion fails.
  expect(await reachOf("step-0")).toEqual(["goal","extra0","extra1"]);
  try {
    await sql.query("update bill2_drafts set revoked=true where id=$1", [draft.draftId]);
    await expect(f.service.read(draft.draftId)).rejects.toThrow("OPC_DENIED");
  } finally {
    await sql.query("update bill2_drafts set revoked=false where id=$1", [draft.draftId]);
  }
  expect(await reachOf("step-0")).toEqual(["goal","extra0","extra1"]);

  // Grants: the helper is internal-only and the read entry stays service-role only.
  const privilege = async (role: string, fn: string) => Number((await sql.query(
    "select has_function_privilege($1,$2,'EXECUTE')::int p", [role, fn],
  )).rows[0].p);
  expect(await privilege("service_role","opc_query(uuid,uuid)")).toBe(1);
  expect(await privilege("anon","opc_query(uuid,uuid)")).toBe(0);
  expect(await privilege("authenticated","opc_query(uuid,uuid)")).toBe(0);
  for (const role of ["anon","authenticated","service_role"])
    expect(await privilege(role,"opc_historical_reach(uuid,uuid,text)")).toBe(0);

  // Denied entry point: another authenticated actor cannot read this draft, and
  // its own longer, stronger frontier must not leak into this draft.
  const other = await fixture(3, false, 4);
  const otherDraft = await other.service.start({requestId: randomUUID(), registration: other.registration, mode: "mentor"});
  const otherVersion = (await other.service.read(otherDraft.draftId)).snapshot.steps["step-0"].version;
  await other.service.information({
    draftId: otherDraft.draftId, stepId: "step-0", requestId: randomUUID(), expectedVersion: otherVersion,
    values: {
      goal: { status: "confirmed", nature: "fact", value: "别的账号第一步" },
      extra0: { status: "confirmed", nature: "fact", value: "别的账号第二步" },
      extra1: { status: "confirmed", nature: "fact", value: "别的账号第三步" },
      extra2: { status: "confirmed", nature: "fact", value: "别的账号第四步" },
      extra3: { status: "unknown", nature: "unknown", value: "" },
    },
  });
  await expect(other.service.read(draft.draftId)).rejects.toThrow();
  expect(((await other.service.read(otherDraft.draftId)).information["step-0"] as { reached?: string[] }).reached)
    .toEqual(["goal","extra0","extra1","extra2","extra3"]);
  expect(await reachOf("step-0")).toEqual(["goal","extra0","extra1"]);

  // Absent history falls back honestly instead of claiming a frontier.
  const fresh = await f.service.start({requestId: randomUUID(), registration: f.registration, mode: "mentor"});
  expect(((await f.service.read(fresh.draftId)).information["step-0"] as { reached?: string[] }).reached ?? [])
    .toEqual([]);

  // Contamination control: another step with the same field id and a longer
  // prefix must not extend this step's reach.
  await f.service.information({
    draftId: draft.draftId, stepId: "step-1", requestId: randomUUID(),
    expectedVersion: await stepVersion("step-1"),
    values: { goal: { status: "confirmed", nature: "fact", value: "第二步已确认" } },
  });
  expect(await reachOf("step-0")).toEqual(["goal","extra0","extra1"]);
  expect(await reachOf("step-1")).toEqual(["goal"]);

  // A definitely rejected write cannot add reach.
  await expect(f.service.information({
    draftId: draft.draftId, stepId: "step-0", requestId: randomUUID(), expectedVersion: 999,
    values: {
      goal: { status: "confirmed", nature: "fact", value: "不应写入" },
      extra0: { status: "confirmed", nature: "fact", value: "不应写入" },
      extra1: { status: "confirmed", nature: "fact", value: "不应写入" },
      extra2: { status: "confirmed", nature: "fact", value: "不应写入" },
      extra3: { status: "confirmed", nature: "fact", value: "不应写入" },
    },
  })).rejects.toThrow();
  expect(await reachOf("step-0")).toEqual(["goal","extra0","extra1"]);
  expect(Number((await sql.query(
    "select count(*)::int n from artifact_requests where project_id=$1 and round_id=$2 and action='opc_information' and payload->>'stepId'='step-0'",
    [draft.projectId, draft.roundId],
  )).rows[0].n)).toBe(1);
  console.log("OPC_REACH_COMPAT " + JSON.stringify({
    rowsForStep: 1,
    reach: ["goal","extra0","extra1"],
    otherStepReach: ["goal"],
  }));
}, 300000);

it("OPC: published revision stays immutable while its revised round owns reach and openings", async () => {
  const { chromium } = await import("../../../../../apps/web/node_modules/@playwright/test");
  const ids = ["goal", "extra0", "extra1", "extra2", "extra3"];
  const f = await fixture(3, false, 0, flow => {
    for (const step of flow.steps.slice(0, 2)) {
      step.information = ids.map(id => ({
        id, title: "B " + id, required: id === "goal",
        profileKey: step.id.replace(/-/g, "_") + "_" + id,
      }));
    }
  });
  const draft = await f.service.start({
    requestId: randomUUID(), registration: f.registration, mode: "mentor",
  });
  const { draftId, projectId, sessionId, roundId: r1 } = draft as {
    draftId: string; projectId: string; sessionId: string; roundId: string;
  };
  for (const id of [draftId, projectId, sessionId, r1]) {
    if (typeof id !== "string" || !id) throw new Error("missing B fixture identity");
  }
  const read = () => f.service.read(draftId);
  const app = process.env.V3_LOCAL_APP;
  if (!app) throw new Error("V3_LOCAL_APP required");
  const browser = await chromium.launch({
    headless: true,
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  const pageErrors: string[] = [], externalRequests: string[] = [];
  let phase = "setup";
  let page: Page | undefined;
  type Values = Record<string, {
    status: "confirmed" | "provisional" | "unknown";
    nature: "fact" | "unknown"; value: string;
  }>;
  const opening = (roundId: string): ExpectedMentorEffect => ({
    scope: { draftId, roundId }, stepId: "step-0", questionId: "goal",
    opening: true, input: OPENING_INPUT,
  });
  const writeValues = async (stepId: string, values: Values) => {
    const before = await f.artifacts.read(projectId, (await read()).roundId);
    const saved = await f.service.information({
      draftId, stepId, requestId: randomUUID(),
      expectedVersion: before.steps[stepId].version, values,
    });
    const after = await read();
    expect(after.information[stepId].values).toEqual(values);
    expect(after.snapshot.steps[stepId].version).toBe(saved.version);
    expect(saved.version).toBe(before.steps[stepId].version + 1);
    return after;
  };
  const prefix = (count: number): Values => Object.fromEntries(ids.map((id, index) => [id,
    index < count
      ? { status: "confirmed" as const, nature: "fact" as const, value: "B evidence " + id }
      : { status: "unknown" as const, nature: "unknown" as const, value: "" },
  ]));
  try {
    const context = await browser.newContext();
    await context.route("**/*", route => {
      const target = new URL(route.request().url());
      if (!["127.0.0.1", "localhost", "[::1]"].includes(target.hostname)) {
        externalRequests.push(target.origin);
        return route.abort("blockedbyclient");
      }
      return route.continue();
    });
    const newPage = async () => {
      const next = await context.newPage();
      next.setDefaultTimeout(30000);
      next.on("pageerror", error => pageErrors.push(error.message));
      return next;
    };
    page = await newPage();
    phase = "login";
    const settings = page.waitForResponse(
      response => response.url().includes("settings.getSystemSettings") && response.ok(),
      { timeout: 60000 },
    );
    await page.goto(app + "/login");
    await settings;
    await page.getByPlaceholder("name@example.com").fill(f.email);
    await page.getByPlaceholder("输入你的密码").fill(f.password);
    expect(await page.getByPlaceholder("name@example.com").inputValue()).toBe(f.email);
    expect(await page.getByPlaceholder("输入你的密码").inputValue()).toBe(f.password);
    await page.getByRole("button", { name: "登录", exact: true }).last().click();
    await page.waitForURL(url => !url.pathname.startsWith("/login"), { timeout: 60000 });

    phase = "R1 opening";
    await page.goto(app + "/app/positioning/" + draftId);
    const oldIdentities = await expectExactMentorEffects(f.actor, draftId, r1, [opening(r1)]);
    expect(oldIdentities).toHaveLength(1);
    const [oldExecution] = JSON.parse(oldIdentities[0]) as [string, string, string, string];
    const oldMessage = await mentorMessageCheck(page, f.actor, oldExecution);
    await oldMessage();
    await page.close();
    page = undefined;

    // No live page during preparation: only the two deliberate openings cost.
    phase = "R1 save confirm publish";
    for (const step of f.flow.steps) {
      const before = await f.artifacts.read(projectId, r1);
      await f.artifacts.execute({
        action: "save", projectId, roundId: r1, requestId: randomUUID(),
        stepId: step.id, body: "B published body " + step.id, evidenceIds: [],
        expectedVersion: before.steps[step.id].version,
      });
      const values: Values = Object.fromEntries((step.information ?? []).map(field => [field.id, {
        status: "confirmed" as const, nature: "fact" as const,
        value: "B R1 " + step.id + " " + field.id,
      }]));
      await writeValues(step.id, values);
      const state = (await f.artifacts.read(projectId, r1)).steps[step.id];
      await f.artifacts.execute({
        action: "confirm", projectId, roundId: r1, requestId: randomUUID(), stepId: step.id,
        expectedVersion: state.version, expectedReviewVersion: state.reviewVersion,
      });
    }
    const confirmed = await f.artifacts.read(projectId, r1);
    await f.artifacts.execute({
      action: "publish", projectId, roundId: r1, requestId: randomUUID(),
      expectedSteps: Object.fromEntries(Object.entries(confirmed.steps).map(([id, state]) => [id, {
        version: state.version, reviewVersion: state.reviewVersion,
      }])),
    });
    const reportBefore = structuredClone(await f.artifacts.report(projectId, r1));
    expect(reportBefore.available).toBe(true);
    const versionId = reportBefore.id;
    if (typeof versionId !== "string" || !versionId) throw new Error("R1 version required");
    const versionJSON = async () => {
      const rows = (await sql.query<{ body: Record<string, unknown> }>(
        "select to_jsonb(v) body from artifact_versions v where v.id=$1 and v.round_id=$2",
        [versionId, r1],
      )).rows;
      expect(rows).toHaveLength(1);
      return rows[0].body;
    };
    const roundSteps = async (roundId: string) => {
      const rows = (await sql.query<{ steps: Record<string, { confirmationId?: string; valid?: boolean }> }>(
        "select steps from artifact_rounds where id=$1 and project_id=$2", [roundId, projectId],
      )).rows;
      expect(rows).toHaveLength(1);
      return rows[0].steps;
    };
    const versionBefore = structuredClone(await versionJSON());
    const stepsBefore = structuredClone(await roundSteps(r1));
    expect((await read()).information["step-0"].reached).toEqual(ids);
    expect((await read()).information["step-1"].reached).toEqual(ids);

    phase = "published page and explicit revise";
    page = await newPage();
    await page.goto(app + "/app/positioning/" + draftId);
    const reviseButton = page.getByRole("button", { name: "修订定位，保留原版本", exact: true });
    await reviseButton.waitFor({ state: "visible" });
    expect((await read()).snapshot.state).toBe("published");
    // A published strategy exposes its read-only result until an explicit
    // revision is requested. The old question action is absent in that view.
    expect(await page.getByRole("button", { name: /^(确认本题并继续|确认当前信息，继续)$/, exact: true }).count()).toBe(0);
    await reviseButton.click();
    await expect.poll(async () => (await read()).roundId, { timeout: 60000 }).not.toBe(r1);
    const revised = await read();
    const r2: unknown = revised.roundId;
    if (typeof r2 !== "string" || !r2) throw new Error("R2 identity required");
    expect(revised.snapshot.state).toBe("draft");
    expect({ draftId: revised.draftId, projectId: revised.projectId, sessionId: revised.sessionId })
      .toEqual({ draftId, projectId, sessionId });
    const revisedSteps = await roundSteps(r2);
    for (const step of f.flow.steps) {
      expect(revisedSteps[step.id].valid).toBe(true);
      expect(revisedSteps[step.id].confirmationId).toBeTruthy();
      expect(revisedSteps[step.id].confirmationId).not.toBe(stepsBefore[step.id].confirmationId);
    }
    expect(await expectExactMentorEffects(f.actor, draftId, r1, [opening(r1)])).toEqual(oldIdentities);
    await page.close();
    page = undefined;

    phase = "round and step isolation";
    const short = await writeValues("step-0", prefix(1));
    expect(short.information["step-0"].reached).toEqual(["goal", "extra0"]);
    const long = await writeValues("step-1", prefix(5));
    expect(long.information["step-1"].reached).toEqual(ids);
    expect(long.information["step-0"].reached).toEqual(["goal", "extra0"]);
    const pending = prefix(0);
    pending.goal = { status: "provisional", nature: "fact", value: "B R2 revised goal" };
    const current = await writeValues("step-0", pending);
    expect(current.information["step-0"].reached).toEqual(["goal", "extra0"]);

    phase = "R2 opening and edit";
    page = await newPage();
    await page.goto(app + "/app/positioning/" + draftId);
    const allExpected = [opening(r1), opening(r2)];
    const identities = await expectExactMentorEffects(f.actor, draftId, r1, allExpected);
    const newIdentities = identities.filter(identity => !oldIdentities.includes(identity));
    expect(newIdentities).toHaveLength(1);
    const [newExecution] = JSON.parse(newIdentities[0]) as [string, string, string, string];
    expect(newExecution).not.toBe(oldExecution);
    const currentMessage = await mentorMessageCheck(page, f.actor, newExecution);
    await currentMessage();
    const form = page.locator("section[aria-label='本步填写信息']");
    const heading = form.getByRole("heading", { level: 3 });
    const box = form.getByRole("textbox", { name: "B goal", exact: true });
    const nav = page.getByRole("navigation", { name: "本步骤已到达的问题" });
    const expectCurrent = async (value: string) => {
      await expect.poll(() => heading.count()).toBe(1);
      await expect.poll(() => heading.textContent()).toMatch(/^1\.1 B goal/);
      await expect.poll(() => box.inputValue()).toBe(value);
      await expect.poll(() => nav.getByRole("button").count()).toBe(2);
      expect(await nav.getByRole("button", { name: /B extra1/ }).count()).toBe(0);
      expect((await read()).information["step-0"].reached).toEqual(["goal", "extra0"]);
    };
    await expectCurrent(pending.goal.value);
    const beforeEdit = await f.artifacts.read(projectId, r2);
    const edited = "B R2 edited by browser";
    await box.fill(edited);
    await expect.poll(async () => (await read()).information["step-0"].values.goal.value,
      { timeout: 30000 }).toBe(edited);
    await expect.poll(async () => (await read()).snapshot.steps["step-0"].version,
      { timeout: 30000 }).toBe(beforeEdit.steps["step-0"].version + 1);
    expect((await read()).information["step-0"].values.goal.status).toBe("provisional");
    await expectCurrent(edited);
    phase = "R2 reload and R1 immutability";
    await page.reload();
    await expectCurrent(edited);
    await currentMessage();
    expect(await expectExactMentorEffects(f.actor, draftId, r1, allExpected)).toEqual(identities);
    expect(await versionJSON()).toEqual(versionBefore);
    expect(await roundSteps(r1)).toEqual(stepsBefore);
    expect(await f.artifacts.report(projectId, r1)).toEqual(reportBefore);
    expect(pageErrors).toEqual([]);
    expect(externalRequests).toEqual([]);
    console.log("OPC_REVISION_ISOLATION " + JSON.stringify({
      draftId, projectId, sessionId, r1, r2, versionId,
      openings: 2, runs: 2, reserves: 2, reached: ["goal", "extra0"],
    }));
  } catch (error) {
    console.error("B_FAILURE", { phase, message: String(error), pathname: page ? new URL(page.url()).pathname : null });
    throw error;
  } finally {
    await browser.close();
  }
}, 300000);

it("OPC: an explicit continue keeps a retained request identity instead of overwriting an unknown outcome", async () => {
  const { chromium } =
    await import("../../../../../apps/web/node_modules/@playwright/test");
  // The draft is already published, so the completed state owns the explicit
  // re-entry control this case presses.
  const f = await completed(3);
  await planFixtureModel(f.moduleId);
  const browser = await chromium.launch({
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
  });
  const context = await browser.newContext();
  await context.route("**/*", (route) => {
    const u = new URL(route.request().url());
    return ["127.0.0.1", "localhost"].includes(u.hostname) ||
      ["data:", "blob:"].includes(u.protocol)
      ? route.continue()
      : route.abort();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(90000);
  const draftPath = "/app/positioning/" + f.d.draftId;
  const key = "opc-plan-generation:" + f.d.draftId;
  try {
    await page.goto(
      process.env.V3_LOCAL_APP + "/login?redirect=" + encodeURIComponent(draftPath),
    );
    await page.getByPlaceholder("name@example.com").fill(f.email);
    await page.getByPlaceholder("输入你的密码").fill(f.password);
    await page.getByRole("button", { name: "登录", exact: true }).last().click();
    await page.waitForURL((url) => url.pathname.endsWith(draftPath));
    // A consented envelope that still owns an unresolved request: pressing the
    // re-entry control again must keep THAT request, never replace it.
    const original = planEnvelopeFor(f, {
      requestId: "1f0a1c2d-3e4f-4a5b-8c6d-7e8f90a1b2c3",
    });
    await page.evaluate(
      ({ key, envelope }) => sessionStorage.setItem(key, JSON.stringify(envelope)),
      { key, envelope: original },
    );
    const before = await planIdentity(f.actor, f.d.draftId);
    const topicsBefore = await topicIdentity(f.actor);
    await page
      .getByRole("button", { name: "继续生成第一周选题", exact: true })
      .click();
    await page
      .getByRole("dialog", { name: "是否继续生成第一周选题" })
      .getByRole("button", { name: "继续生成第一周选题", exact: true })
      .click();
    // a8dba69c: the continue goes on to the topic workspace and leaves the
    // retained request untouched; it neither admits it
    // nor creates a second identity or a topic binding.
    await page.waitForURL((url) => url.pathname.endsWith(draftPath + "/topics"));
    const stored = JSON.parse(
      (await page.evaluate((k) => sessionStorage.getItem(k), key)) as string,
    ) as { request: { requestId: string } };
    expect(stored.request.requestId).toBe(original.request.requestId);
    expect(await planIdentity(f.actor, f.d.draftId)).toEqual(before);
    expect(await topicIdentity(f.actor)).toEqual(topicsBefore);
  } finally {
    await browser.close();
  }
}, 300000);
it.each(["save", "confirm"] as const)(
  "OPC: workbench %s conflict recovery preserves unknown-outcome replay",
  async targetPhase => {
    const { chromium } = await import("../../../../../apps/web/node_modules/@playwright/test");
    const f = await fixture(3);
    const draft = await f.service.start({
      requestId: randomUUID(), registration: f.registration, mode: "mentor",
    });
    const { draftId, projectId, roundId, sessionId } = draft;
    const stepId = f.flow.steps[0].id;
    const original = "F1 original audience: first-time film makers";
    const updated = "F1 reviewed audience: experienced documentary directors";
    const readDraft = () => f.service.read(draftId);
    await f.service.information({
      draftId, stepId, requestId: randomUUID(),
      expectedVersion: (await readDraft()).snapshot.steps[stepId].version,
      values: { goal: { value: original, status: "provisional", nature: "decision" } },
    });
    const app = process.env.V3_LOCAL_APP;
    if (!app || !["127.0.0.1", "localhost", "[::1]"].includes(new URL(app).hostname))
      throw new Error("F1 requires the existing loopback disposable runner");
    const origin = new URL(app).origin;
    const key = "opc-confirm-step:" + draftId + ":" + stepId;
    type Pending = {
      phase: "information" | "save" | "confirm";
      information: { requestId: string };
      save: { requestId: string; expectedVersion: number | null; body: string };
      confirm: { requestId: string; expectedVersion: number | null; expectedReviewVersion: number | null };
    };
    const browser = await chromium.launch({
      headless: true,
      executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    });
    let phase = "setup", fault: "conflict" | "loss" | "done" = "conflict";
    let rejectedId = "", lostRaw = "", lostPost = "", replayCount = 0;
    let committedVersion = -1, routeFailure: string | null = null;
    const pageErrors: string[] = [], externalRequests: string[] = [];
    let page: Page | undefined;
    const receiptCount = async (id: string) => (await sql.query<{ n: number }>(
      "select count(*)::int n from artifact_requests where project_id=$1 and round_id=$2 and request_id=$3",
      [projectId, roundId, id],
    )).rows[0].n;
    const opening: ExpectedMentorEffect = {
      stepId, questionId: "goal", opening: true, input: OPENING_INPUT,
    };
    try {
      const context = await browser.newContext();
      await context.route("**/*", route => {
        const url = new URL(route.request().url());
        if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
          externalRequests.push(url.origin);
          return route.abort("blockedbyclient");
        }
        return route.continue();
      });
      const p = await context.newPage();
      page = p;
      p.setDefaultTimeout(30000);
      p.on("pageerror", error => pageErrors.push(error.message));
      const rawPending = () => p.evaluate(k => sessionStorage.getItem(k), key);
      const form = () => p.locator("section[aria-label='本步填写信息']");
      const answer = () => form().getByRole("textbox", { name: "已知目标 0", exact: true });
      // A mentor draft confirms from the current-question action under the chat,
      // not from the form panel (dc3ab89a).
      const action = () => p.locator("section[aria-label='当前问题操作']");
      const confirm = () => action().getByRole("button", { name: /^(确认本题并继续|确认当前信息，继续)$/, exact: true });
      const retry = () => action().getByRole("button", { name: "继续核对本题确认", exact: true });
      const settings = p.waitForResponse(r => r.url().includes("settings.getSystemSettings") && r.ok(), { timeout: 60000 });
      await p.goto(app + "/login");
      await settings;
      await p.getByPlaceholder("name@example.com").fill(f.email);
      await p.getByPlaceholder("输入你的密码").fill(f.password);
      await p.getByRole("button", { name: "登录", exact: true }).last().click();
      await p.waitForURL(u => u.origin === origin && !u.pathname.startsWith("/login"), { timeout: 60000 });
      await p.goto(app + "/app/positioning/" + draftId);
      await expect.poll(() => answer().inputValue(), { timeout: 60000 }).toBe(original);
      const initialEffects = await expectExactMentorEffects(f.actor, draftId, roundId, [opening]);
      const [openingExecution] = JSON.parse(initialEffects[0]) as string[];
      await (await mentorMessageCheck(p, f.actor, openingExecution))();
      await expect.poll(() => confirm().isEnabled(), { timeout: 30000 }).toBe(true);

      // Delay the real workbench mutation after the page froze its version.
      // No fabricated error, success, batch-response decoder or DB shortcut.
      await p.route("**/api/trpc/**", async route => {
        const req = route.request(), url = new URL(req.url());
        const procedures = decodeURIComponent(url.pathname.slice("/api/trpc/".length)).split(",");
        if (req.method() !== "POST" || url.origin !== origin || !procedures.includes("workbench.execute")) {
          await route.fallback();
          return;
        }
        try {
          const raw = await rawPending();
          if (!raw) { await route.fallback(); return; }
          const pending = JSON.parse(raw) as Pending;
          if (pending.phase !== targetPhase) { await route.fallback(); return; }
          const post = req.postData();
          if (!post) throw new Error("expected a real workbench mutation body");
          const target = pending[targetPhase];
          if (fault === "conflict") {
            rejectedId = target.requestId;
            const before = await readDraft();
            expect(target.expectedVersion).toBe(before.snapshot.steps[stepId].version);
            await f.service.information({
              draftId, stepId, requestId: randomUUID(),
              expectedVersion: before.snapshot.steps[stepId].version,
              values: { goal: { value: updated, status: "provisional", nature: "decision" } },
            });
            const concurrent = await readDraft();
            expect(concurrent.snapshot.steps[stepId].version).toBe(before.snapshot.steps[stepId].version + 1);
            const response = await route.fetch();
            const body = JSON.stringify(await response.json());
            expect(body).toContain('"code":"CONFLICT"');
            expect(body).toContain('"path":"workbench.execute"');
            // A concurrent provisional answer makes the server's OPC
            // required-information gate reject the confirm before any version
            // comparison, so confirm returns the generic workbench CONFLICT
            // message while save returns the version-conflict one.
            expect(body).toContain(
              targetPhase === "save" ? "保存版本已变化" : "操作未完成，请重新加载项目状态",
            );
            expect(body).not.toContain("ARTIFACT_VERSION_CONFLICT");
            expect(body).not.toContain("ARTIFACT_REVIEW_REQUIRED");
            expect(await receiptCount(rejectedId)).toBe(0);
            fault = "loss";
            await route.fulfill({ response }); // Deliver the actual server rejection.
            return;
          }
          if (fault === "loss") {
            expect(target.requestId).not.toBe(rejectedId);
            lostRaw = raw;
            lostPost = post;
            const response = await route.fetch();
            expect(response.ok()).toBe(true);
            expect(JSON.stringify(await response.json())).toContain('"accepted":true');
            expect(await receiptCount(target.requestId)).toBe(1);
            const committed = await readDraft();
            committedVersion = committed.snapshot.steps[stepId].version;
            expect(committed.information[stepId].values.goal.value).toBe(updated);
            expect(committed.snapshot.steps[stepId].body).toContain(updated);
            expect(committed.snapshot.steps[stepId].valid).toBe(targetPhase === "confirm");
            fault = "done";
            await route.abort("failed"); // Server committed; browser receives nothing.
            return;
          }
          expect(raw).toBe(lostRaw);
          expect(post).toBe(lostPost); // Same request ID AND frozen versions/payload.
          replayCount++;
          await route.continue();
        } catch (error) {
          routeFailure = error instanceof Error ? error.message : String(error);
          await route.abort("failed").catch(() => {});
        }
      });

      phase = "real mapped conflict releases the rejected envelope";
      await confirm().click();
      await expect.poll(() => rejectedId, { timeout: 30000 }).not.toBe("");
      await expect.poll(rawPending, { timeout: 30000 }).toBeNull();
      expect(routeFailure).toBeNull();
      await expect.poll(() => answer().inputValue(), { timeout: 30000 }).toBe(updated);
      await expect.poll(() => answer().isEnabled(), { timeout: 30000 }).toBe(true);
      await expect.poll(() => confirm().isEnabled(), { timeout: 30000 }).toBe(true);
      const afterConflict = await readDraft();
      expect(afterConflict.snapshot.steps[stepId].valid).toBe(false);
      expect(afterConflict.information[stepId].values.goal).toEqual({ value: updated, status: "provisional", nature: "decision" });
      expect(await receiptCount(rejectedId)).toBe(0);
      expect(await expectExactMentorEffects(f.actor, draftId, roundId, [opening])).toEqual(initialEffects);

      phase = "explicitly confirm the changed answer, then lose the committed reply";
      await confirm().click();
      await expect.poll(() => fault, { timeout: 30000 }).toBe("done");
      await expect.poll(() => retry().isEnabled(), { timeout: 30000 }).toBe(true);
      expect(routeFailure).toBeNull();
      expect(lostRaw).not.toBe("");
      expect(await rawPending()).toBe(lostRaw);
      const lost = JSON.parse(lostRaw) as Pending;
      expect(lost.phase).toBe(targetPhase);
      expect(lost[targetPhase].expectedVersion).not.toBeNull();
      expect(await answer().isDisabled()).toBe(true);
      expect(await receiptCount(lost[targetPhase].requestId)).toBe(1);
      expect(await expectExactMentorEffects(f.actor, draftId, roundId, [opening])).toEqual(initialEffects);

      phase = "refresh retains unknown outcome, then the same request recovers";
      await p.reload();
      await expect.poll(() => retry().isEnabled(), { timeout: 60000 }).toBe(true);
      expect(await rawPending()).toBe(lostRaw);
      expect(replayCount).toBe(0);
      expect(await answer().inputValue()).toBe(updated);
      expect(await answer().isDisabled()).toBe(true);
      expect(await expectExactMentorEffects(f.actor, draftId, roundId, [opening])).toEqual(initialEffects);
      await retry().click();
      await expect.poll(rawPending, { timeout: 30000 }).toBeNull();
      expect(routeFailure).toBeNull();
      expect(replayCount).toBe(1);
      const final = await readDraft();
      expect({ draftId: final.draftId, projectId: final.projectId, roundId: final.roundId, sessionId: final.sessionId })
        .toEqual({ draftId, projectId, roundId, sessionId });
      expect(final.snapshot.steps[stepId].valid).toBe(true);
      expect(final.snapshot.steps[stepId].body).toContain(updated);
      expect(final.snapshot.steps[stepId].body).not.toContain(original);
      expect(final.information[stepId].values.goal).toEqual({ value: updated, status: "confirmed", nature: "decision" });
      if (targetPhase === "confirm") expect(final.snapshot.steps[stepId].version).toBe(committedVersion);
      for (const id of [lost.information.requestId, lost.save.requestId, lost.confirm.requestId])
        expect(await receiptCount(id)).toBe(1);
      expect(await receiptCount(rejectedId)).toBe(0);
      const finalEffects = await expectExactMentorEffects(f.actor, draftId, roundId, [
        opening, { stepId: f.flow.steps[1].id, questionId: "goal", opening: true, input: OPENING_INPUT },
      ]);
      for (const identity of initialEffects) expect(finalEffects).toContain(identity);
      await expect.poll(() => form().getByRole("heading", { level: 3 }).textContent(), { timeout: 60000 })
        .toContain("2.1");
      expect(pageErrors).toEqual([]);
      expect(externalRequests).toEqual([]);
      console.log("F1_WORKBENCH_RECOVERY", JSON.stringify({
        targetPhase, draftId, roundId, rejectedId,
        recovered: [lost.information.requestId, lost.save.requestId, lost.confirm.requestId],
        replayCount, initialEffects, finalEffects,
      }));
    } catch (error) {
      console.error("F1_RECOVERY_FAILURE", JSON.stringify({
        targetPhase, phase, fault, routeFailure, pageErrors, externalRequests,
        pending: page ? await page.evaluate(k => sessionStorage.getItem(k), key).catch(() => null) : null,
      }));
      throw error;
    } finally {
      await browser.close();
    }
  },
  300000,
);

/**
 * A draft whose pinned method revision declares topic resources, with every
 * step confirmed and the positioning version published, so the topic workspace
 * has an immutable source version to bind to.
 */
async function publishedDraft(n = 3, withTopics = true, revisionFixture = false, reverseDisplay = false) {
  const f = await fixture(
    n,
    false,
    0,
    (flow) => { if(withTopics)flow.planResources = ["SKILL.md"]; if(revisionFixture)delete flow.steps.at(-1)!.information![0].profileKey; if(reverseDisplay)flow.steps.reverse(); },
  );
  const d = await f.service.start({
    requestId: randomUUID(),
    registration: f.registration,
    mode: "manual",
  });
  if(revisionFixture)await f.artifacts.execute({action:'userEvidence',projectId:d.projectId,roundId:d.roundId,
    requestId:randomUUID(),body:'原正式版本的可撤销事实依据',observedAt:null,supersedes:null});
  const sourceEvidence=revisionFixture?(await f.artifacts.read(d.projectId,d.roundId)).evidence[0].id as string:null;
  for (const step of reverseDisplay ? [...f.flow.steps].reverse() : f.flow.steps) {
    await f.artifacts.execute({
      action: "save", projectId: d.projectId, roundId: d.roundId,
      requestId: randomUUID(), stepId: step.id,
      body: "User confirmed " + step.title, evidenceIds: sourceEvidence?[sourceEvidence]:[], expectedVersion: 0,
    });
    const state = (await f.artifacts.read(d.projectId, d.roundId)).steps[step.id];
    await f.service.information({
      draftId: d.draftId, stepId: step.id, requestId: randomUUID(),
      expectedVersion: state.version,
      values: {
        goal: { status: "confirmed", nature: "decision", value: revisionFixture ? "原正式答案 "+step.id : "A concrete user decision" },
      },
    });
    const updated = (await f.artifacts.read(d.projectId, d.roundId)).steps[step.id];
    await f.artifacts.execute({
      action: "confirm", projectId: d.projectId, roundId: d.roundId,
      requestId: randomUUID(), stepId: step.id,
      expectedVersion: updated.version, expectedReviewVersion: updated.reviewVersion,
    });
  }
  const published = await f.artifacts.read(d.projectId, d.roundId);
  await f.artifacts.execute({
    action: "publish", projectId: d.projectId, roundId: d.roundId,
    requestId: randomUUID(),
    expectedSteps: Object.fromEntries(
      Object.entries(published.steps).map(([k, v]) => [k, { version: v.version, reviewVersion: v.reviewVersion }]),
    ),
  });
  const sourceVersionId = (await f.service.read(d.draftId)).report.id as string;
  return { ...f, d, sourceVersionId, sourceEvidence };
}

/** Every turn, run, reservation and binding the topic workspace created. */
async function topicIdentity(actor: string) {
  const count = async (q: string) =>
    Number((await sql.query(q, [actor])).rows[0].n);
  return {
    binds: await count(
      "select count(*)::int n from opc_topic_workspaces w join opc_drafts d on d.draft_id=w.draft_id where d.actor_id=$1",
    ),
    turns: await count(
      "select count(*)::int n from opc_turns t join opc_drafts d on d.draft_id=t.draft_id where d.actor_id=$1 and t.purpose='topic'",
    ),
    topicExecutions: await count(
      "select count(*)::int n from runtime_executions e join opc_turns t on t.session_id=e.session_id and t.request_id=e.request_id where e.actor_id=$1 and t.purpose='topic'",
    ),
    topicRuns: await count(
      "select count(*)::int n from bill2_runs b join runtime_executions e on e.billing_run_id=b.id join opc_turns t on t.session_id=e.session_id and t.request_id=e.request_id where b.actor_id=$1 and t.purpose='topic'",
    ),
    reserves: await count(
      "select count(*)::int n from credit_transactions where user_id=$1 and reason_code='bill2_reserve'",
    ),
  };
}

it("OPC: topic consent concurrency and source mismatch preserve the accepted intent", async () => {
  const f = await publishedDraft();
  const consent = { draftId: f.d.draftId, sourceVersionId: f.sourceVersionId };
  const accepted = await Promise.all([f.service.topicConsent(consent), f.service.topicConsent(consent)]);
  expect(accepted[0]).toEqual(accepted[1]);
  expect(accepted[0].opening.requestId).toBeTruthy();
  const other = await publishedDraft();
  await expect(other.service.topicConsent(consent)).rejects.toThrow(/OPC_DENIED/);
  await expect(f.service.topicConsent({ ...consent, sourceVersionId: other.sourceVersionId })).rejects.toThrow(/OPC_TOPIC_SOURCE_CHANGED/);
  expect(await f.service.topicRead(f.d.draftId)).toEqual(accepted[0]);
  expect(await topicIdentity(f.actor)).toEqual({ binds: 1, turns: 0, topicExecutions: 0, topicRuns: 0, reserves: 0 });
  // Schema may be reapplied to populated records without losing consent.
  const { readFile } = await import('node:fs/promises');
  const migration = await readFile(new URL('../../../../db/migrations/0114_opc_topic_consent.sql', import.meta.url), 'utf8');
  await sql.query(migration);
  expect(await f.service.topicRead(f.d.draftId)).toEqual(accepted[0]);
}, 120000);

it("OPC: old publish and adoption replays cannot roll back the current business source", async () => {
  const f = await publishedDraft();
  const oldPublish = (await sql.query(
    "select request_id::text,round_id::text,payload from artifact_requests where project_id=$1 and action='publish' order by request_id limit 1",
    [f.d.projectId],
  )).rows[0];
  const newer = await publishedDraft();
  const currentSource = newer.sourceVersionId;
  expect(currentSource).not.toBe(f.sourceVersionId);
  await sql.query("update opc_businesses b set current_source_version_id=$1,revision=revision+1 from opc_draft_businesses db where db.draft_id=$2 and b.id=db.business_id", [currentSource, f.d.draftId]);
  const state = async () => (await sql.query(
    "select b.current_source_version_id::text source,b.revision::int revision from opc_businesses b join opc_draft_businesses db on db.business_id=b.id where db.draft_id=$1",
    [f.d.draftId],
  )).rows[0];
  const beforeReplay = await state();
  expect(beforeReplay.source).toBe(currentSource);
  await f.artifacts.execute({
    action: 'publish', projectId: f.d.projectId, roundId: oldPublish.round_id,
    requestId: oldPublish.request_id, expectedSteps: oldPublish.payload.expectedSteps,
  });
  const historicalItemId = randomUUID();
  const historicalAdoption = {
    draftId: f.d.draftId, requestId: randomUUID(), expectedVersion: 0, sourceVersionId: f.sourceVersionId,
    body: [{ id: historicalItemId, platform: 'x', account: 'historical-account', title: '历史来源新采用', brief: '采用旧定位候选但不改变业务当前定位', day: '2026-09-21' }],
    accounts: [{ platform: 'x', account: 'historical-account', expectedRevision: null }],
  };
  await f.service.adoptTopics(historicalAdoption);
  expect(await state()).toEqual(beforeReplay);
  const itemCount = Number((await sql.query("select count(*)::int n from opc_items i join opc_plans p on p.id=i.plan_id where p.draft_id=$1 and i.item_key=$2", [f.d.draftId, historicalItemId])).rows[0].n);
  await expect(f.service.adoptTopics({ ...historicalAdoption, requestId: randomUUID(), expectedVersion: 1 })).rejects.toThrow('OPC_TOPIC_ALREADY_ADOPTED');
  expect(Number((await sql.query("select count(*)::int n from opc_items i join opc_plans p on p.id=i.plan_id where p.draft_id=$1 and i.item_key=$2", [f.d.draftId, historicalItemId])).rows[0].n)).toBe(itemCount);
}, 120000);

it("OPC: B1 browser auto-saves discussion, adopts one topic across a lost reply and re-login, and edits it in the library", async () => {
  // The topic workspace adopts one card at a time since its redesign; the
  // video package half of the old journey is covered by "final script asks
  // before derivatives…", "upgraded legacy partial result…" and "work item uses
  // shared Runtime … source revocation denies recovery reads".
  const f = await publishedDraft();
  await planFixtureModel(f.moduleId);
  const seed = await f.service.savePlan({ draftId: f.d.draftId, requestId: randomUUID(), expectedVersion: 0, sourceVersionId: f.sourceVersionId,
    body: [{ id: randomUUID(), platform: 'x', account: 'existing-account', title: '原工作', brief: '原有账号项目', day: '2026-09-20' }] });
  await f.service.handoff({ draftId: f.d.draftId, requestId: randomUUID(), planId: seed.planId, accounts: [{ platform: 'x', account: 'existing-account', expectedRevision: null }] });
  const { browser, context, page } = await planBrowser(f);
  const path = '/app/positioning/' + f.d.draftId + '/topics';
  let lostAdoption = 0;
  try {
    const homeLibrary = page.waitForResponse(response => response.url().includes('opc.library'));
    await page.goto(process.env.V3_LOCAL_APP+'/app'); await homeLibrary;
    expect(await page.getByRole('heading', { name: '先完成正式定位', exact: true }).count()).toBe(0);
    await page.goto(process.env.V3_LOCAL_APP + path);
    await page.getByRole('button', { name: '开始选题工作对话', exact: true }).click();
    await page.getByRole('heading', { name: '1. 首周选题', exact: true }).waitFor({ timeout: 60000 });
    // The candidate draft is saved after the reply renders.
    await expect.poll(async () => (await f.service.topicDraftRead(f.d.draftId)).version, { timeout: 30000 }).toBe(1);

    // Discussion revises the candidate and auto-saves a new draft version.
    await page.getByLabel('消息', { exact: true }).fill('请修改第一条选题');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect.poll(async () => (await f.service.topicDraftRead(f.d.draftId)).version, { timeout: 60000 }).toBe(2);
    const revised = page.getByRole('heading', { name: '1. 修改后的选题', exact: true }).last().locator('..');
    await revised.waitFor({ timeout: 60000 });
    const second = page.getByRole('heading', { name: '2. 第二个账号选题', exact: true }).last().locator('..');
    await expect.poll(() => second.getByRole('button', { name: '采用这个选题', exact: true }).isEnabled(), { timeout: 30000 }).toBe(true);

    // Adopting only the revised topic loses its reply; the frozen request survives a re-login.
    await page.route('**/api/trpc/opc.adoptTopics*', async route => {
      const response = await route.fetch(); expect(response.ok()).toBe(true); await route.abort(); lostAdoption += 1;
    });
    await revised.getByRole('button', { name: '采用这个选题', exact: true }).click();
    await page.getByRole('status',{name:'待确认的操作',exact:true}).getByRole('button',{name:'重试',exact:true}).waitFor({ timeout: 60000 });
    await expect.poll(() => lostAdoption, { timeout: 30000 }).toBeGreaterThan(0);
    const bound = await f.service.topicRead(f.d.draftId);
    const frozenKey = 'opc-topic-operation:' + bound.sessionId;
    const frozen = JSON.parse((await page.evaluate(key => localStorage.getItem(key), frozenKey))!);
    expect(frozen.kind).toBe('adoptTopics');
    expect(frozen.request.body).toHaveLength(1);
    expect(frozen.request.body[0].title).toBe('修改后的选题');
    expect(frozen.request.expectedVersion).toBe(1);
    await page.unroute('**/api/trpc/opc.adoptTopics*');

    await context.clearCookies();
    await page.goto(process.env.V3_LOCAL_APP + '/login?redirect=' + encodeURIComponent(path));
    await page.getByPlaceholder('name@example.com').fill(f.email);
    await page.getByPlaceholder('输入你的密码').fill(f.password);
    await page.getByRole('button', { name: '登录', exact: true }).last().click();
    await page.waitForURL(url => url.pathname === path);
    await page.getByRole('status',{name:'待确认的操作',exact:true}).getByRole('button',{name:'重试',exact:true}).click();
    await expect.poll(() => page.evaluate(key => localStorage.getItem(key), frozenKey), { timeout: 30000 }).toBeNull();
    const plans = (await f.service.read(f.d.draftId)).plans;
    expect(plans).toHaveLength(2);
    expect(plans[0].body).toHaveLength(1);
    // The adopted card now continues its work; the other card stays adoptable.
    await page.getByRole('heading', { name: '1. 修改后的选题', exact: true }).last().locator('..')
      .getByRole('link', { name: '继续这条内容工作', exact: true }).waitFor({ timeout: 30000 });
    await expect.poll(() => page.getByRole('heading', { name: '2. 第二个账号选题', exact: true }).last().locator('..')
      .getByRole('button', { name: '采用这个选题', exact: true }).isEnabled(), { timeout: 30000 }).toBe(true);

    // The library edits the adopted topic's direction and returns to its work.
    await page.goto(process.env.V3_LOCAL_APP + '/app/library');
    const adoptedRow = page.getByRole('article').filter({ hasText: '修改后的选题' });
    await adoptedRow.getByRole('button').first().click();
    const detail = page.getByRole('dialog', { name: '选题详情' });
    await detail.getByRole('button', { name: '编辑稿件', exact: true }).click();
    await detail.getByRole('button', { name: /选题方向.*查看与修改/ }).click();
    await page.getByLabel('方向名称', { exact: true }).fill('资料库修订标题');
    await page.getByLabel('选题简报', { exact: true }).fill('内容：真实案例；对象：起步创作者；价值：明确行动；结构：问题、过程、结果；假设：案例提升收藏。');
    await page.getByRole('button', { name: '保存选题方向', exact: true }).click();
    await page.getByText('选题方向已保存', { exact: true }).waitFor({ timeout: 30000 });
    const edited = (await f.service.library({ search: '资料库修订标题', from: null, to: null })).businesses
      .flatMap((business: { accounts: Array<{ items: any[] }> }) => business.accounts.flatMap(account => account.items));
    expect(edited.map((item: { title: string }) => item.title)).toEqual(['资料库修订标题']);
    await page.getByRole('button', { name: '← 返回详情', exact: true }).click();
    await detail.getByRole('link', { name: '继续讨论', exact: true }).click();
    await page.waitForURL(url => url.pathname === '/app/runtime');
    expect(new URL(page.url()).searchParams.get('session')).toBe(edited[0].sessionId);
  } finally { await browser.close(); }
}, 300000);

it("OPC: B1 business scope, legacy handoff replay and library edits stay owned and versioned", async () => {
  const f = await publishedDraft();
  const businessId = (await sql.query(
    "select business_id::text from opc_draft_businesses where draft_id=$1",
    [f.d.draftId],
  )).rows[0].business_id as string;
  const publishedLibrary = await f.service.library({ search: "", from: null, to: null });
  expect(publishedLibrary.businesses.find((entry: {businessId: string}) => entry.businessId === businessId).sourceAvailable).toBe(true);
  const shared = await f.service.start({
    requestId: randomUUID(), registration: f.registration, mode: "manual", businessId,
  });
  expect(shared.businessId).toBe(businessId);
  const isolated = await f.service.start({
    requestId: randomUUID(), registration: f.registration, mode: "manual", businessName: "隔离业务",
  });
  expect(isolated.businessId).not.toBe(businessId);

  const body = [{
    id: randomUUID(), platform: "x", account: "owned-account", title: "可恢复的选题",
    brief: "完整简报保留内容、对象、价值、结构和待验证假设。", day: "2026-09-23",
    // 0124 accepts a brief version only for an article or image-text item.
    contentType: "article",
  }];
  const plan = await f.service.savePlan({
    draftId: f.d.draftId, requestId: randomUUID(), expectedVersion: 0,
    sourceVersionId: f.sourceVersionId, body,
  });
  const handoffRequest = {
    draftId: f.d.draftId, requestId: randomUUID(), planId: plan.planId,
    accounts: [{ platform: "x", account: "owned-account", expectedRevision: null }],
  };
  const first = await f.service.handoff(handoffRequest);
  expect(await f.service.handoff(handoffRequest)).toEqual(first);

  const library = await f.service.library({ search: "可恢复的选题", from: null, to: null });
  const ownedBusiness = library.businesses.find((entry: {businessId: string}) => entry.businessId === businessId);
  const item = ownedBusiness.accounts.flatMap((account: {items: Array<{workItemId: string;revision: number}>}) => account.items)[0];
  expect(item.workItemId).toBe(first[0].workItemId);
  const editRequest = {
    requestId: randomUUID(), target: "item", targetId: item.workItemId, expectedRevision: item.revision,
    patch: { title: "资料库已修订", brief: "修订后的完整简报仍可追溯。", day: "2026-09-24" },
  };
  const edit = await f.service.libraryEdit(editRequest);
  expect(await f.service.libraryEdit(editRequest)).toEqual(edit);
  await expect(f.service.libraryEdit({ ...editRequest, requestId: randomUUID() })).rejects.toThrow("OPC_VERSION_CONFLICT");

  await sql.query("update opc_accounts set business_id=$1 where project_id=$2", [isolated.businessId, first[0].projectId]);
  await expect(f.service.handoff({
    ...handoffRequest, requestId: randomUUID(),
    accounts: [{ platform: "x", account: "owned-account", expectedRevision: 1 }],
  })).rejects.toThrow("OPC_BUSINESS_CONFLICT");

  const other = await publishedDraft();
  const otherLibrary = await other.service.library({ search: "资料库已修订", from: null, to: null });
  expect(otherLibrary.businesses.flatMap((entry: {accounts: Array<{items: unknown[]}>}) =>
    entry.accounts.flatMap(account => account.items))).toHaveLength(0);
  await expect(other.service.libraryEdit({
    requestId: randomUUID(), target: "item", targetId: item.workItemId, expectedRevision: edit.revision,
    patch: { title: "越权修改", brief: "不能写入其他用户的完整简报。", day: "2026-09-25" },
  })).rejects.toThrow("OPC_DENIED");

  await sql.query("insert into opc_content_versions(actor_id,work_item_id,kind,version,status,body,request_id) values($1,$2,'brief',1,'final','撤回后不得读取的成果正文',$3)", [f.actor, item.workItemId, randomUUID()]);
  await sql.query("update bill2_drafts set revoked=true where id=$1", [f.d.draftId]);
  const revoked = await f.service.library({ search: "", from: null, to: null });
  const hidden = revoked.businesses.flatMap((entry: {accounts: Array<{items: unknown[]}>}) => entry.accounts.flatMap(account => account.items))
    .find((entry: {workItemId: string}) => entry.workItemId === item.workItemId);
  expect(hidden).toMatchObject({ sourceAvailable: false, brief: null });
  expect(hidden.content[0]).toMatchObject({ body: null, contentAvailable: false });
  const hiddenSearch = await f.service.library({ search: "修订后的完整简报", from: null, to: null });
  expect(hiddenSearch.businesses.flatMap((entry: {accounts: Array<{items: unknown[]}>}) => entry.accounts.flatMap(account => account.items))).toHaveLength(0);
  await expect(f.service.libraryEdit({ ...editRequest, requestId: randomUUID(), expectedRevision: edit.revision })).rejects.toThrow("OPC_DENIED");
}, 120000);

it("OPC: U2 manual article versions are owned, immutable and replayed once", async () => {
  const f=await publishedDraft();
  const plan=await f.service.savePlan({draftId:f.d.draftId,requestId:randomUUID(),expectedVersion:0,sourceVersionId:f.sourceVersionId,
    body:[{id:randomUUID(),platform:'x',account:'u2-account-a',title:'第一条',brief:'第一条简报',day:'2026-09-24',contentType:'article'},
      {id:randomUUID(),platform:'x',account:'u2-account-b',title:'第二条',brief:'第二条简报',day:'2026-09-25',contentType:'article'}]});
  const handoff=await f.service.handoff({draftId:f.d.draftId,requestId:randomUUID(),planId:plan.planId,
    accounts:[{platform:'x',account:'u2-account-a',expectedRevision:null},{platform:'x',account:'u2-account-b',expectedRevision:null}]});
  const second=handoff[1];
  const request={workItemId:second.workItemId,requestId:randomUUID(),expectedVersion:0,sourceContentId:null,
    kind:'brief' as const,status:'draft' as const,title:'第二条文章',body:'真实内容第一版'};
  const [first,replay]=await Promise.all([f.service.contentManualSave(request),f.service.contentManualSave(request)]);
  expect(replay).toEqual(first);
  expect(first.version).toBe(1);
  await expect(f.service.contentManualSave({...request,body:'偷换内容'})).rejects.toThrow('OPC_REQUEST_CONFLICT');
  await expect(f.service.contentManualSave({...request,requestId:randomUUID(),body:'过期编辑'})).rejects.toThrow('OPC_VERSION_CONFLICT');
  const next=await f.service.contentManualSave({...request,requestId:randomUUID(),expectedVersion:1,sourceContentId:first.id,status:'final',body:'真实内容第二版'});
  expect(next.version).toBe(2);
  const library=await f.service.library({search:'',from:null,to:null});
  const accounts=library.businesses.flatMap((business:{accounts:Array<{account:string;items:any[]}>})=>business.accounts);
  expect(accounts.find((account:{account:string})=>account.account==='u2-account-b')?.strategyDraftId).toBe(f.d.draftId);
  expect(accounts.find((account:{account:string})=>account.account==='u2-account-a')?.items[0].content).toEqual([]);
  const saved=accounts.find((account:{account:string})=>account.account==='u2-account-b')?.items[0].content;
  expect(saved.map((version:{version:number})=>version.version)).toEqual([1,2]);
  expect(saved[1]).toMatchObject({title:'第二条文章',body:'真实内容第二版',status:'final',sourceContentId:first.id});
  const outsider=await publishedDraft();
  await expect(outsider.service.contentManualSave({...request,requestId:randomUUID(),expectedVersion:2,sourceContentId:next.id,body:'越权写入'})).rejects.toThrow('OPC_CONTENT_DENIED');
  expect((await outsider.service.library({search:'第二条',from:null,to:null})).businesses.flatMap((business:{accounts:Array<{items:any[]}>})=>business.accounts.flatMap(account=>account.items))).toEqual([]);
  const item=accounts.find((account:{account:string})=>account.account==='u2-account-b')?.items[0];
  const metadata={requestId:randomUUID(),target:'item' as const,targetId:item.workItemId,expectedRevision:item.revision,
    patch:{title:'资料库元数据标题',brief:item.brief,day:item.day,contentType:'article'}};
  const [metadataA,metadataB]=await Promise.all([f.service.libraryEdit(metadata),f.service.libraryEdit(metadata)]);
  expect(metadataA).toEqual(metadataB);
  expect(metadataA.revision).toBe(item.revision+1);
  const videoItem=accounts.find((account:{account:string})=>account.account==='u2-account-a')?.items[0];
  await f.service.libraryEdit({requestId:randomUUID(),target:'item',targetId:videoItem.workItemId,expectedRevision:videoItem.revision,
    patch:{title:videoItem.title,brief:videoItem.brief,day:videoItem.day,contentType:'video'}});
  await expect(f.service.contentManualSave({...request,workItemId:videoItem.workItemId,requestId:randomUUID(),
    kind:'script',expectedVersion:0,sourceContentId:null})).rejects.toThrow('OPC_CONTENT_SOURCE');
  await sql.query('update bill2_drafts set revoked=true where id=$1',[f.d.draftId]);
  const withdrawn=await f.service.library({search:'',from:null,to:null});
  const withdrawnVersions=withdrawn.businesses.flatMap((business:{accounts:Array<{items:any[]}>})=>business.accounts.flatMap(account=>account.items))
    .find((entry:{workItemId:string})=>entry.workItemId===second.workItemId).content;
  expect(withdrawnVersions).toHaveLength(2);
  expect(withdrawnVersions.every((version:{title:string|null;body:string|null;contentAvailable:boolean})=>
    version.title===null&&version.body===null&&!version.contentAvailable)).toBe(true);
  await expect(f.service.contentManualSave(request)).rejects.toThrow('OPC_CONTENT_DENIED');
},120000);

it("OPC: U2 browser adopts only second topic, edits a server version and returns from library", async()=>{
  const f=await publishedDraft();
  const {browser,context,page}=await planBrowser(f);
  const path='/app/positioning/'+f.d.draftId+'/topics';
  try{
    await page.setViewportSize({width:1600,height:900});
    await page.goto(process.env.V3_LOCAL_APP+'/app/positioning/'+f.d.draftId);
    await page.getByRole('link',{name:'进入选题工作对话 →',exact:true}).click();
    await page.waitForURL(url=>url.pathname===path);
    await page.getByRole('button',{name:'开始选题工作对话',exact:true}).click();
    const second=page.getByRole('heading',{name:'2. 第二个账号选题',exact:true}).locator('..');
    await second.waitFor({timeout:60000});
    await second.getByRole('button',{name:'采用这个选题',exact:true}).click();
    await expect.poll(async()=>{
      const snapshot=await f.service.library({search:'',from:null,to:null});
      return snapshot.businesses.flatMap((business:{accounts:Array<{items:any[]}>})=>business.accounts.flatMap(account=>account.items)).map((item:{title:string})=>item.title);
    },{timeout:30000}).toEqual(['第二个账号选题']);
    const adopted=await f.service.library({search:'',from:null,to:null});
    const items=adopted.businesses.flatMap((business:{accounts:Array<{items:any[]}>})=>business.accounts.flatMap(account=>account.items));
    expect(items.map((item:{title:string})=>item.title)).toEqual(['第二个账号选题']);
    await page.screenshot({path:process.env.V3_WORKBENCH_OUTPUT+'/u2-topic-adopted-desktop.png'});
    const continueLink=second.getByRole('link',{name:'继续这条内容工作',exact:true});
    await continueLink.click();
    await page.waitForURL(url=>url.pathname==='/app/runtime');
    await page.getByLabel('文章正文').fill('先讲真实场景，再说明判断，最后安排一次练习。');
    await page.getByRole('status').filter({hasText:'已在服务端保存 v1'}).waitFor();
    const workUrl=page.url();
    await page.getByRole('link',{name:'资料库',exact:true}).click();
    await page.waitForURL(url=>url.pathname==='/app/library');
    await page.getByRole('main').getByRole('button',{name:/第二个账号选题/}).first().click();
    await page.getByText('先讲真实场景，再说明判断，最后安排一次练习。').waitFor();
    await page.screenshot({path:process.env.V3_WORKBENCH_OUTPUT+'/u2-library-desktop.png'});
    await page.getByRole('button',{name:'关闭窗口',exact:true}).click();
    await page.getByRole('link',{name:'返回当前工作',exact:true}).last().click();
    await page.waitForURL(url=>url.pathname==='/app/runtime');
    await page.getByLabel('文章正文').fill('修改后的正文：补充前后对照案例。');
    await page.getByRole('status').filter({hasText:'已在服务端保存 v2'}).waitFor();
    // U4: keyboard users must stay in the visible modal, return to its
    // trigger, and leave cancelled edits and read-only history unchanged.
    for(const viewport of [{width:1600,height:900},{width:390,height:844}]){
      await page.setViewportSize(viewport);
      if(viewport.width===390)await page.getByRole('button',{name:'展开右边栏',exact:true}).click();
      const trigger=page.getByRole('button',{name:'展开编辑',exact:true});
      await trigger.focus();await page.keyboard.press('Enter');
      const editor=page.getByRole('dialog',{name:'编辑标题与正文',exact:true});await editor.waitFor();
      await page.screenshot({path:process.env.V3_WORKBENCH_OUTPUT+`/u4-editor-${viewport.width}.png`});
      await expect.poll(()=>editor.evaluate(node=>node.contains(document.activeElement))).toBe(true);
      for(let i=0;i<8;i++){await page.keyboard.press('Tab');expect(await editor.evaluate(node=>node.contains(document.activeElement))).toBe(true);}
      await editor.getByLabel('展开编辑正文',{exact:true}).fill('U4 取消的编辑不能保存');
      await page.keyboard.press('Escape');await editor.waitFor({state:'hidden'});
      await expect.poll(()=>trigger.evaluate(node=>node===document.activeElement)).toBe(true);
      expect(await page.getByLabel('文章正文').inputValue()).toBe('修改后的正文：补充前后对照案例。');
      const historyTrigger=page.getByRole('button',{name:'历史版本',exact:true});
      await historyTrigger.focus();await page.keyboard.press('Enter');
      const history=page.getByRole('dialog',{name:'历史版本',exact:true});await history.waitFor();
      await page.screenshot({path:process.env.V3_WORKBENCH_OUTPUT+`/u4-history-${viewport.width}.png`});
      await expect.poll(()=>history.evaluate(node=>node.contains(document.activeElement))).toBe(true);
      for(let i=0;i<8;i++){await page.keyboard.press('Tab');expect(await history.evaluate(node=>node.contains(document.activeElement))).toBe(true);}
      await page.keyboard.press('Escape');await history.waitFor({state:'hidden'});
      await expect.poll(()=>historyTrigger.evaluate(node=>node===document.activeElement)).toBe(true);
      expect(await page.getByLabel('文章正文').inputValue()).toBe('修改后的正文：补充前后对照案例。');
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    }
    await page.setViewportSize({width:1600,height:900});
    await page.getByLabel('消息',{exact:true}).fill('这条问题先不要发送');
    await page.getByLabel('文章正文').fill('未保存的下一次修改');
    await page.reload();
    await expect.poll(()=>page.getByLabel('消息',{exact:true}).textContent()).toBe('这条问题先不要发送');
    await expect.poll(()=>page.getByLabel('文章正文').inputValue()).toBe('未保存的下一次修改');
    await page.getByRole('button',{name:'历史版本',exact:true}).click();
    await page.getByText('修改后的正文：补充前后对照案例。').waitFor();
    await page.setViewportSize({width:1600,height:900});
    await page.screenshot({path:process.env.V3_WORKBENCH_OUTPUT+'/u2-article-desktop.png'});
    await page.setViewportSize({width:390,height:844});
    await page.screenshot({path:process.env.V3_WORKBENCH_OUTPUT+'/u2-article-narrow.png'});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await context.clearCookies();
    await page.goto(process.env.V3_LOCAL_APP+'/login?redirect='+encodeURIComponent(new URL(workUrl).pathname+new URL(workUrl).search));
    await page.getByPlaceholder('name@example.com').fill(f.email);
    await page.getByPlaceholder('输入你的密码').fill(f.password);
    await page.getByRole('button',{name:'登录',exact:true}).last().click();
    await page.waitForURL(url=>url.pathname==='/app/runtime');
    await expect.poll(()=>page.getByLabel('文章正文').inputValue()).toBe('未保存的下一次修改');
    await expect.poll(()=>page.getByLabel('消息',{exact:true}).textContent()).toBe('这条问题先不要发送');
  }catch(error){console.info('U4_CORE_FAILURE',error instanceof Error?error.stack:'unknown');throw error;}finally{console.info('U4_CORE_CLOSE_START');await browser.close();console.info('U4_CORE_CLOSED');}
},300000);

it("OPC: U2 browser preserves later edits across unknown saves, conflict and another login", async()=>{
  const f=await publishedDraft();
  const plan=await f.service.savePlan({draftId:f.d.draftId,requestId:randomUUID(),expectedVersion:0,sourceVersionId:f.sourceVersionId,
    body:[{id:randomUUID(),platform:'x',account:'protected-account',title:'仅本账号内容',brief:'真实简报',day:'2026-09-25',contentType:'article'}]});
  const [work]=await f.service.handoff({draftId:f.d.draftId,requestId:randomUUID(),planId:plan.planId,
    accounts:[{platform:'x',account:'protected-account',expectedRevision:null}]});
  const outsider=await publishedDraft();
  const {browser,context,page}=await planBrowser(f);
  try{
    await page.goto(process.env.V3_LOCAL_APP+'/app/runtime?session='+work.sessionId);
    const body=page.getByLabel('文章正文');
    await body.fill('第一版正文');
    let release!:()=>void,received=false;
    const gate=new Promise<void>(resolve=>{release=resolve;});
    await page.route('**/api/trpc/opc.saveContentManual*',async route=>{
      const response=await route.fetch();received=true;await gate;await route.fulfill({response});
    });
    await expect.poll(()=>received,{timeout:30000}).toBe(true);
    await body.fill('第一版提交后继续写的新内容');
    release();
    await page.getByRole('status').filter({hasText:'已在服务端保存 v1'}).waitFor();
    await page.getByText('账号已保存 v1 · 草稿').waitFor();
    expect(await body.inputValue()).toBe('第一版提交后继续写的新内容');
    await page.unroute('**/api/trpc/opc.saveContentManual*');

    await page.route('**/api/trpc/opc.saveContentManual*',async route=>{
      const response=await route.fetch();expect(response.ok()).toBe(true);await route.abort();
    });
    await page.getByRole('alert').filter({hasText:'保存结果待核实'}).waitFor();
    const before=(await f.service.library({search:'仅本账号内容',from:null,to:null})).businesses
      .flatMap((business:{accounts:Array<{items:any[]}>})=>business.accounts.flatMap(account=>account.items))[0];
    expect(before.content.map((version:{version:number})=>version.version)).toEqual([1,2]);
    await body.fill('未知结果后继续写，不能被旧结果覆盖');
    await page.unroute('**/api/trpc/opc.saveContentManual*');
    await page.getByRole('button',{name:'恢复草稿同步',exact:true}).click();
    await page.getByRole('status').filter({hasText:'已在服务端保存 v2'}).waitFor();
    await page.getByText('账号已保存 v2 · 草稿').waitFor();
    expect(await body.inputValue()).toBe('未知结果后继续写，不能被旧结果覆盖');
    const versions=before.content as Array<{id:string;version:number}>;
    const other=await f.service.contentManualSave({workItemId:work.workItemId,requestId:randomUUID(),expectedVersion:2,
      sourceContentId:versions[1].id,kind:'brief',status:'draft',title:'仅本账号内容',body:'另一标签已保存'});
    await page.getByRole('alert').filter({hasText:'已有更新版本'}).waitFor();
    expect(await body.inputValue()).toBe('未知结果后继续写，不能被旧结果覆盖');
    await page.getByRole('button',{name:/已比较历史，基于服务端 v3/}).click();
    await page.getByRole('status').filter({hasText:'已在服务端保存 v4'}).waitFor();
    expect(other.version).toBe(3);

    await context.clearCookies();
    await page.goto(process.env.V3_LOCAL_APP+'/login?redirect='+encodeURIComponent('/app/runtime?session='+work.sessionId));
    await page.getByPlaceholder('name@example.com').fill(outsider.email);
    await page.getByPlaceholder('输入你的密码').fill(outsider.password);
    await page.getByRole('button',{name:'登录',exact:true}).last().click();
    await page.waitForURL(url=>url.pathname==='/app/runtime');
    // 0beff6aa: denial is reported through the shared workspace notice.
    await page.getByRole('alert').filter({hasText:'当前工作：'}).waitFor();
    expect(await page.getByText('未知结果后继续写，不能被旧结果覆盖').count()).toBe(0);
    expect(await page.getByLabel('文章正文').count()).toBe(0);
  }finally{await browser.close();}
},300000);

it("OPC: new business start restores the complete frozen request before another business can begin", async () => {
  const f=await publishedDraft();
  await onlyOwnCatalog([f.moduleId]);
  const originalBusiness=(await sql.query('select business_id::text id from opc_draft_businesses where draft_id=$1',[f.d.draftId])).rows[0].id;
  const otherActor=await publishedDraft();
  const {browser,page}=await planBrowser(f);
  try{
    await page.goto(process.env.V3_LOCAL_APP+'/app/positioning');
    await page.getByRole('button',{name:'梳理账号定位',exact:true}).first().click();
    let lost=0;
    await page.route('**/api/trpc/opc.start*',async route=>{const response=await route.fetch();expect(response.ok()).toBe(true);lost+=1;await route.abort();});
    await page.getByRole('dialog',{name:'梳理账号定位'}).getByRole('button',{name:'从头分析新定位'}).click();
    expect(await page.getByLabel('业务名称',{exact:true}).count()).toBe(0);
    await page.getByRole('button',{name:'恢复上次开始请求',exact:true}).waitFor({timeout:60000});
    await expect.poll(()=>lost,{timeout:60000}).toBe(1);
    const startKey='opc-start-operation:'+f.actor;
    const frozen=JSON.parse((await page.evaluate(key=>sessionStorage.getItem(key),startKey))!);
    expect(frozen).toMatchObject({actorId:f.actor,mode:'mentor'});
    expect(frozen.businessId).toBeNull();
    expect(frozen.businessName).toBeUndefined();
    await page.getByRole('button',{name:'梳理账号定位',exact:true}).first().click();
    expect(await page.getByRole('dialog',{name:'梳理账号定位'}).getByRole('button',{name:'从头分析新定位'}).isDisabled()).toBe(true);
    expect(lost).toBe(1);
    await page.context().clearCookies();
    await page.goto(process.env.V3_LOCAL_APP+'/login?redirect=/positioning');
    await page.getByPlaceholder('name@example.com').fill(otherActor.email);
    await page.getByPlaceholder('输入你的密码').fill(otherActor.password);
    await page.getByRole('button',{name:'登录',exact:true}).last().click();
    await page.waitForURL(url=>url.pathname==='/app/positioning');
    await page.getByRole('heading',{name:'今天，想推进什么？',exact:true}).waitFor();
    expect(await page.getByRole('button',{name:'恢复上次开始请求',exact:true}).count()).toBe(0);
    expect(await page.evaluate(key=>sessionStorage.getItem(key),startKey)).toBeTruthy();
    await page.context().clearCookies();
    await page.goto(process.env.V3_LOCAL_APP+'/login?redirect=/positioning');
    await page.getByPlaceholder('name@example.com').fill(f.email);
    await page.getByPlaceholder('输入你的密码').fill(f.password);
    await page.getByRole('button',{name:'登录',exact:true}).last().click();
    await page.waitForURL(url=>url.pathname==='/app/positioning');
    await page.getByRole('heading',{name:'今天，想推进什么？',exact:true}).waitFor();
    await page.getByRole('button',{name:'恢复上次开始请求',exact:true}).waitFor();
    await page.unroute('**/api/trpc/opc.start*');
    await page.getByRole('button',{name:'恢复上次开始请求',exact:true}).click();
    await page.waitForURL(url=>/^\/app\/positioning\/[0-9a-f-]+$/.test(url.pathname),{timeout:60000});
    const restoredDraft=page.url().split('/').at(-1)!;
    const restoredBusiness=(await sql.query('select business_id::text id from opc_draft_businesses where draft_id=$1',[restoredDraft])).rows[0].id;
    expect(restoredBusiness).not.toBe(originalBusiness);
    expect((await sql.query('select name from opc_businesses where id=$1',[restoredBusiness])).rows[0].name).toBe('未命名业务');
    expect(await page.evaluate(key=>sessionStorage.getItem(key),startKey)).toBeNull();
  }finally{await browser.close();}
},180000);

it("OPC: library edit binds fields and revision to one snapshot across a concurrent refresh", async()=>{
  const f=await publishedDraft();
  const plan=await f.service.savePlan({draftId:f.d.draftId,requestId:randomUUID(),expectedVersion:0,sourceVersionId:f.sourceVersionId,
    body:[{id:randomUUID(),platform:'x',account:'edit-account',title:'原始标题',brief:'原始简报',day:'2026-09-25'}]});
  const [work]=await f.service.handoff({draftId:f.d.draftId,requestId:randomUUID(),planId:plan.planId,accounts:[{platform:'x',account:'edit-account',expectedRevision:null}]});
  const {browser,page}=await planBrowser(f);
  try{
    await page.goto(process.env.V3_LOCAL_APP+'/app/library');
    await page.getByRole('navigation',{name:'资料库平台与账号'}).getByRole('button',{name:/edit-account/}).click();
    const card=page.getByRole('article').filter({hasText:'原始标题'});
    await card.getByRole('button',{name:/原始标题/}).first().click();
    // The redesigned library edits the topic direction from the manuscript view.
    const detail=page.getByRole('dialog',{name:'选题详情'});
    await detail.getByRole('button',{name:'编辑稿件'}).click();
    await detail.getByRole('button',{name:/选题方向.*查看与修改/}).click();
    await page.getByLabel('方向名称',{exact:true}).fill('本标签准备保存的标题');
    const before=(await f.service.library({search:'原始标题',from:null,to:null})).businesses.flatMap((business:{accounts:Array<{items:Array<{workItemId:string;revision:number}>}>})=>business.accounts.flatMap(account=>account.items)).find((item:{workItemId:string})=>item.workItemId===work.workItemId)!;
    await f.service.libraryEdit({requestId:randomUUID(),target:'item',targetId:work.workItemId,expectedRevision:before.revision,patch:{title:'另一标签已保存的标题',brief:'另一标签已保存的简报',day:'2026-09-26'}});
    const refreshed=page.waitForResponse(response=>response.url().includes('opc.library')&&response.ok());
    await page.getByLabel('当前阶段 edit-account').selectOption('starting');
    await refreshed;
    await page.getByRole('button',{name:'保存选题方向',exact:true}).click();
    await expect.poll(async()=>(await page.getByRole('alert').allTextContents()).join(' '),{timeout:30000}).toContain('OPC_VERSION_CONFLICT');
    const library=await f.service.library({search:'另一标签已保存的标题',from:null,to:null});
    const saved=library.businesses.flatMap((business:{accounts:Array<{items:Array<{workItemId:string;title:string;brief:string;day:string}>}>})=>business.accounts.flatMap(account=>account.items)).find((item:{workItemId:string})=>item.workItemId===work.workItemId);
    expect(saved).toMatchObject({title:'另一标签已保存的标题',brief:'另一标签已保存的简报',day:'2026-09-26'});
  }finally{await browser.close();}
},180000);

it("OPC: account strategy dialog returns to a complete revision and explicit official history",async()=>{
 const f=await publishedDraft(6,true,true);
 const plan=await f.service.savePlan({draftId:f.d.draftId,requestId:randomUUID(),expectedVersion:0,sourceVersionId:f.sourceVersionId,
  body:['revision-a','revision-b'].map(account=>({id:randomUUID(),platform:'x',account,title:'原来源选题 '+account,brief:'保持旧来源',day:'2026-09-26'}))});
 await f.service.handoff({draftId:f.d.draftId,requestId:randomUUID(),planId:plan.planId,
  accounts:['revision-a','revision-b'].map(account=>({platform:'x',account,expectedRevision:null}))});
 const accounts=(await f.service.library({search:'',from:null,to:null})).businesses[0].accounts;
 const a=accounts.find((a:{account:string})=>a.account==='revision-a')!;
 const source=await f.service.read(f.d.draftId);
 const {browser,page}=await planBrowser(f);
 try{
  await page.goto(process.env.V3_LOCAL_APP+'/app/library');
  await page.getByRole('navigation',{name:'资料库平台与账号'}).getByRole('button',{name:/revision-a/}).click();
  await page.getByRole('button',{name:/x · revision-a.*查看详情/}).click();
  await page.getByRole('dialog',{name:'定位详情'}).getByRole('button',{name:'回到策略讨论',exact:true}).click();
  await page.waitForURL(url=>/^\/app\/positioning\/[^/]+$/.test(url.pathname));
  const draftId=page.url().split('/app/positioning/')[1];
  const draft=await f.service.read(draftId);
  await page.getByRole('navigation',{name:'定位步骤'}).waitFor();
  await page.getByText('已保留原正式定位的全部步骤。请选择需要修改的部分；未变化且已确认的内容无需重新填写。修改保存为草稿，核对后可更新正式版本。',{exact:true}).waitFor();
  const phases=page.getByRole('navigation',{name:'定位步骤'}).getByRole('button');
  console.info('ACCOUNT_REVISION_INPUT',JSON.stringify({sourceVersionId:f.sourceVersionId,sourceDraftId:f.d.draftId,draftId,
   source:source.information,draft:draft.information,phaseDisabled:await phases.evaluateAll(nodes=>nodes.map(n=>(n as HTMLButtonElement).disabled))}));
  await page.screenshot({path:process.env.V3_WORKBENCH_OUTPUT+'/account-revision-return.png'});
  expect(draftId).not.toBe(f.d.draftId);
  expect(draft.sessionId).not.toBe(source.sessionId);
  for(const step of f.flow.steps)expect(draft.information[step.id].values).toEqual(source.information[step.id].values);
  expect(await phases.evaluateAll(nodes=>nodes.map(n=>(n as HTMLButtonElement).disabled))).toEqual(Array(6).fill(false));
  expect(await f.service.accountStrategyHistory(a.projectId)).toHaveLength(1);
  const last=f.flow.steps.at(-1)!;
  for(let i=0;i<6;i++){
   await phases.nth(i).click();
   expect(await page.getByRole('textbox',{name:'已知目标 '+i,exact:true}).inputValue()).toBe('原正式答案 step-'+i);
  }
  const answer=page.getByRole('textbox',{name:'已知目标 5',exact:true});
  await answer.fill('账号 A 新修改，无 profileKey 也必须保留');
  await page.getByText('已自动保存',{exact:true}).waitFor();
  await page.reload();
  await page.getByRole('navigation',{name:'定位步骤'}).getByRole('button').nth(5).click();
  expect(await answer.inputValue()).toBe('账号 A 新修改，无 profileKey 也必须保留');
  expect(await f.service.accountStrategyHistory(a.projectId)).toHaveLength(1);
  await page.goto(process.env.V3_LOCAL_APP+'/app/library');
  await page.getByRole('navigation',{name:'资料库平台与账号'}).getByRole('button',{name:/revision-a/}).click();
  await page.getByRole('button',{name:/x · revision-a.*查看详情/}).click();
  const dialog=page.getByRole('dialog',{name:'定位详情'});
  await dialog.getByRole('button',{name:'历史版本',exact:true}).click();
  await dialog.getByText('正式版本历史',{exact:true}).waitFor();
  await dialog.getByText('原正式答案 step-5',{exact:true}).waitFor();
  await dialog.getByRole('button',{name:'继续当前修改草稿',exact:true}).click();
  await page.waitForURL('**/positioning/'+draftId);
  expect((await f.service.read(draftId)).sessionId).toBe(draft.sessionId);
  await page.getByRole('navigation',{name:'定位步骤'}).getByRole('button').nth(5).click();
  expect(await answer.inputValue()).toBe('账号 A 新修改，无 profileKey 也必须保留');
  await page.getByRole('button',{name:'确认当前信息，继续',exact:true}).click();
  await expect.poll(async()=>(await f.service.read(draftId)).snapshot.steps[last.id].valid,{timeout:15000}).toBe(true);
  const finalize=page.getByRole('button',{name:'确认正式定位',exact:true});
  await expect.poll(()=>finalize.isEnabled(),{timeout:15000}).toBe(true);
  // A lost publish response must be recovered by reading the actual version,
  // never by publishing another account or clearing the draft.
  let lost=false;
  await page.route('**/api/trpc/workbench.execute*',async route=>{
   if(!lost&&route.request().postData()?.includes('publish')){lost=true;await route.fetch();await route.abort();return;}
   await route.continue();
  });
  await finalize.click();
  await expect.poll(async()=>(await f.service.accountStrategyHistory(a.projectId)).length,{timeout:15000}).toBe(2);
  await page.reload();
  expect(await finalize.isEnabled()).toBe(false);
  expect(lost).toBe(true);
  const history=await f.service.accountStrategyHistory(a.projectId);
  expect(history[1].id).toBe(f.sourceVersionId);
  expect(history[0].information[last.id].values.goal.value).toBe('账号 A 新修改，无 profileKey 也必须保留');
  for(const step of f.flow.steps.slice(0,-1))expect(history[0].information[step.id].values).toEqual(source.information[step.id].values);
  expect((await f.service.read(f.d.draftId)).information).toEqual(source.information);
  await page.goto(process.env.V3_LOCAL_APP+'/app/library');
  await page.getByRole('navigation',{name:'资料库平台与账号'}).getByRole('button',{name:/revision-a/}).click();
  await page.getByRole('button',{name:/x · revision-a.*查看详情/}).click();
  await dialog.getByRole('button',{name:'历史版本',exact:true}).click();
  await dialog.getByText('账号 A 新修改，无 profileKey 也必须保留',{exact:true}).waitFor();
  await page.screenshot({path:process.env.V3_WORKBENCH_OUTPUT+'/account-revision-official-history.png'});
  const b=accounts.find((a:{account:string})=>a.account==='revision-b')!;
  await page.goto(process.env.V3_LOCAL_APP+'/app/library');
  await page.getByRole('navigation',{name:'资料库平台与账号'}).getByRole('button',{name:/revision-b/}).click();
  await page.getByRole('button',{name:/x · revision-b.*查看详情/}).click();
  await page.getByRole('dialog',{name:'定位详情'}).getByRole('button',{name:'回到策略讨论',exact:true}).click();
  await page.waitForURL(url=>/^\/app\/positioning\/[^/]+$/.test(url.pathname));
  const bDraft=await f.service.read(page.url().split('/app/positioning/')[1]);
  expect(bDraft.sessionId).not.toBe(draft.sessionId);
  for(const step of f.flow.steps)expect(bDraft.information[step.id].values).toEqual(source.information[step.id].values);
  expect(await f.service.accountStrategyHistory(b.projectId)).toHaveLength(1);
  const itemSources=(await sql.query('select distinct source_version_id from opc_items where account_project_id=ANY($1)',[[a.projectId,b.projectId]])).rows;
  expect(itemSources).toEqual([{source_version_id:f.sourceVersionId}]);
  const sameProject=await f.service.revise(draftId,randomUUID(),draft.roundId);
  const reopened=await f.service.accountStrategyBegin(a.projectId,randomUUID());
  expect(reopened).toEqual({draftId,roundId:sameProject.roundId});
  expect((await f.service.read(draftId)).sessionId).toBe(draft.sessionId);
  expect((await sql.query("select count(*)::int n from artifact_requests where project_id=$1 and round_id=$2 and action='opc_account_inherit'",[draft.projectId,sameProject.roundId])).rows[0].n).toBe(0);

  // Revoking the original source still denies the now-published account
  // version after its binding has advanced to that account's own version.
  await f.artifacts.execute({action:'restrictEvidence',projectId:f.d.projectId,roundId:f.d.roundId,requestId:randomUUID(),evidenceId:f.sourceEvidence!,deleted:true,expiresAt:null});
  await expect(f.service.accountStrategyHistory(a.projectId)).rejects.toThrow('OPC_DENIED');
  await expect(f.artifacts.read(draft.projectId,draft.roundId)).rejects.toThrow('ARTIFACT_DENIED');

 }catch(error){console.info('ACCOUNT_REVISION_FAILURE',error instanceof Error?error.stack:String(error),await page.getByRole('alert').allTextContents());await page.screenshot({path:process.env.V3_WORKBENCH_OUTPUT+'/account-revision-failure.png'});throw error;}finally{await browser.close();}
},180000);

it("OPC: account revision confirms only edited information before official finalization",async()=>{
 const f=await publishedDraft(6,true,true);
 const plan=await f.service.savePlan({draftId:f.d.draftId,requestId:randomUUID(),expectedVersion:0,sourceVersionId:f.sourceVersionId,
  body:[{id:randomUUID(),platform:'x',account:'review-revision',title:'确认路径',brief:'只修改两处，其余保留',day:'2026-09-26'}]});
 await f.service.handoff({draftId:f.d.draftId,requestId:randomUUID(),planId:plan.planId,accounts:[{platform:'x',account:'review-revision',expectedRevision:null}]});
 const account=(await f.service.library({search:'',from:null,to:null})).businesses[0].accounts[0];
 const {browser,page}=await planBrowser(f);
 try{
  await page.goto(process.env.V3_LOCAL_APP+'/app/library');
  await page.getByRole('navigation',{name:'资料库平台与账号'}).getByRole('button',{name:/review-revision/}).click();
  await page.getByRole('button',{name:/x · review-revision.*查看详情/}).click();
  await page.getByRole('dialog',{name:'定位详情'}).getByRole('button',{name:'回到策略讨论',exact:true}).click();
  await page.waitForURL(url=>/^\/app\/positioning\/[^/]+$/.test(url.pathname));
  const draftId=page.url().split('/app/positioning/')[1];
  const phases=page.getByRole('navigation',{name:'定位步骤'}).getByRole('button');
  const initial=await f.service.read(draftId);
  await f.service.information({draftId,stepId:'step-0',requestId:randomUUID(),expectedVersion:initial.snapshot.steps['step-0'].version,values:{goal:{...initial.information['step-0'].values.goal,status:'deferred'}}});
  await page.reload();
  expect(await page.getByRole('button',{name:'确认正式定位',exact:true}).isEnabled()).toBe(false);
  await page.getByRole('button',{name:/核对修改：/}).click();
  await page.getByRole('textbox',{name:'已知目标 0',exact:true}).fill('第一步的新业务目标');
  await page.getByText('已自动保存',{exact:true}).waitFor();
  await phases.nth(3).click();
  await page.getByRole('textbox',{name:'已知目标 3',exact:true}).fill('第四步的新内容安排');
  await page.getByText('已自动保存',{exact:true}).waitFor();
  const finalize=page.getByRole('button',{name:'确认正式定位',exact:true});
  expect(await finalize.isEnabled()).toBe(false);
  // Confirm the later edit first; unedited dependencies require no user action.
  await page.getByRole('button',{name:'确认当前信息，继续',exact:true}).click();
  await expect.poll(async()=>(await f.service.read(draftId)).information['step-3'].values.goal.status,{timeout:15000}).toBe('confirmed');
  await expect.poll(()=>page.getByRole('button',{name:'确认当前信息，继续',exact:true}).isEnabled(),{timeout:15000}).toBe(false);
  expect(await finalize.isEnabled()).toBe(false); // step 0 is still unconfirmed.
  await page.reload();
  await phases.nth(0).click();
  expect(await page.getByRole('textbox',{name:'已知目标 0',exact:true}).inputValue()).toBe('第一步的新业务目标');
  let lostConfirm=true;
  const confirmRequests:unknown[]=[];
  await page.route('**/api/trpc/workbench.execute*',async route=>{
   const body=route.request().postDataJSON(),entry=body[0]??body,input=entry.json??entry;
   if(input.action!=='confirm')return route.continue();
   confirmRequests.push(input);
   if(!lostConfirm)return route.continue();
   lostConfirm=false;const response=await route.fetch();expect(response.ok()).toBe(true);await route.abort();
  });
  await page.getByRole('button',{name:'确认当前信息，继续',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'操作未完成'}).waitFor();
  expect(await page.evaluate(id=>JSON.parse(sessionStorage.getItem('opc-confirm-step:'+id+':step-0')!).phase,draftId)).toBe('confirm');
  await page.reload();
  await page.getByRole('button',{name:/确认当前信息，继续|继续核对本题确认/,exact:true}).click();
  await expect.poll(()=>finalize.isEnabled(),{timeout:15000}).toBe(true);
  expect(confirmRequests).toHaveLength(2);expect(confirmRequests[1]).toEqual(confirmRequests[0]);
  const confirmed=await f.service.read(draftId);
  expect((await sql.query('select count(*)::int n from artifact_confirmations where round_id=$1 and step_id=$2 and version=$3',[confirmed.roundId,'step-0',confirmed.snapshot.steps['step-0'].version])).rows[0].n).toBe(1);
  await page.waitForLoadState('networkidle');
  expect(await finalize.isEnabled()).toBe(true);
  await finalize.scrollIntoViewIfNeeded();
  await page.screenshot({path:process.env.V3_WORKBENCH_OUTPUT+'/account-review-ready.png',animations:'disabled'});
  await finalize.click();
  await expect.poll(async()=>(await f.service.accountStrategyHistory(account.projectId)).length,{timeout:15000}).toBe(2);
  const versions=await f.service.accountStrategyHistory(account.projectId);
  expect(versions[0].information['step-0'].values.goal.value).toBe('第一步的新业务目标');
  expect(versions[0].information['step-3'].values.goal.value).toBe('第四步的新内容安排');
  expect(versions[1].information['step-0'].values.goal.value).toBe('原正式答案 step-0');
 }finally{await browser.close();}
},180000);

it("OPC: V2-5d mentor checks agree with the old chain on a real account strategy draft, allowed and after its evidence is withdrawn",async()=>{
 const f=await publishedDraft(6,true,true);
 const plan=await f.service.savePlan({draftId:f.d.draftId,requestId:randomUUID(),expectedVersion:0,sourceVersionId:f.sourceVersionId,
  body:[{id:randomUUID(),platform:'x',account:'scope-check',title:'来源',brief:'账号策略',day:'2026-09-26'}]});
 await f.service.handoff({draftId:f.d.draftId,requestId:randomUUID(),planId:plan.planId,accounts:[{platform:'x',account:'scope-check',expectedRevision:null}]});
 const account=(await f.service.library({search:'',from:null,to:null})).businesses[0].accounts[0];
 const strategy=await f.service.accountStrategyBegin(account.projectId,randomUUID());
 const actor=(await sql.query('select actor_id,session_id,project_id from opc_drafts where draft_id=$1',[strategy.draftId])).rows[0];
 const verdict=async()=>{
  const q=async(text:string,args:unknown[])=>(await sql.query(text,args)).rows[0].v;
  const old=await q("select coalesce(bill2_scope_allowed($1,jsonb_build_object('kind','positioning_draft','draftId',$2::uuid)),false) v",[actor.actor_id,strategy.draftId]);
  const narrow=await q('select turn_mentor_draft_allowed($1,$2) v',[actor.actor_id,strategy.draftId]);
  const check=await q('select mentor_source_check($1,$2) v',[actor.actor_id,actor.session_id]);
  return {old,fresh:narrow&&check.allowed,view:await q('select session_view_allowed($1,$2) v',[actor.actor_id,actor.session_id])};
 };
 expect(await verdict()).toEqual({old:true,fresh:true,view:true});
 // Opening without the check is refused for this draft; with it, the context opens.
 const mentor={moduleId:(await sql.query('select module_id from artifact_projects where id=$1',[actor.project_id])).rows[0].module_id,stepId:f.flow.steps[0]!.id};
 await expect(sql.query('select turn_mentor_context($1,$2,$3)',[actor.actor_id,actor.session_id,JSON.stringify(mentor)])).rejects.toThrow('TURN_SOURCE_CHECK_REQUIRED');
 expect((await sql.query('select turn_mentor_context($1,$2,$3) v',[actor.actor_id,actor.session_id,JSON.stringify({...mentor,sourceChecked:true})])).rows[0].v.draftId).toBe(strategy.draftId);
 await f.artifacts.execute({action:'restrictEvidence',projectId:f.d.projectId,roundId:f.d.roundId,requestId:randomUUID(),evidenceId:f.sourceEvidence!,deleted:true,expiresAt:null});
 expect(await verdict()).toEqual({old:false,fresh:false,view:false});
});

it("OPC: V2-5d a source draft revoked after the check stops the open, the close write and the refresh read",async()=>{
 const f=await publishedDraft(6,true,true);
 const plan=await f.service.savePlan({draftId:f.d.draftId,requestId:randomUUID(),expectedVersion:0,sourceVersionId:f.sourceVersionId,
  body:[{id:randomUUID(),platform:'x',account:'scope-race',title:'来源',brief:'账号策略',day:'2026-09-26'}]});
 await f.service.handoff({draftId:f.d.draftId,requestId:randomUUID(),planId:plan.planId,accounts:[{platform:'x',account:'scope-race',expectedRevision:null}]});
 const account=(await f.service.library({search:'',from:null,to:null})).businesses[0].accounts[0];
 const strategy=await f.service.accountStrategyBegin(account.projectId,randomUUID());
 const row=(await sql.query('select actor_id,session_id from opc_drafts where draft_id=$1',[strategy.draftId])).rows[0];
 const checked=(await sql.query('select mentor_source_check($1,$2) v',[row.actor_id,row.session_id])).rows[0].v;
 expect(checked.allowed).toBe(true);
 expect(checked.sourceDrafts).toContain(f.d.draftId);
 await sql.query('select bill2_revoke_draft($1,$2)',[row.actor_id,f.d.draftId]);
 // Revoked between the check and turn_open: the turn does not open, so nothing reaches a model.
 const module_id=(await sql.query('select p.module_id from artifact_projects p join opc_drafts d on d.project_id=p.id where d.draft_id=$1',[strategy.draftId])).rows[0].module_id;
 await expect(sql.query('select turn_mentor_context($1,$2,$3)',[row.actor_id,row.session_id,JSON.stringify({moduleId:module_id,stepId:f.flow.steps[0]!.id,
  sourceChecked:true,sourceDrafts:checked.sourceDrafts})])).rejects.toThrow('TURN_MENTOR_DENIED');
 expect((await sql.query('select turn_mentor_source_live($1) v',[strategy.draftId])).rows[0].v).toBe(false);
 await expect(sql.query('select turn_session_view($1,$2,0)',[row.actor_id,row.session_id])).rejects.toThrow('TURN_SESSION_DENIED');
});

it("OPC: V2-5c a free chat reads benchmarks a turn made, through the workspace source",async()=>{
 const f=await publishedDraft(6,true,true);
 const row=(await sql.query('select actor_id,session_id from opc_drafts where draft_id=$1',[f.d.draftId])).rows[0];
 const fetchId=randomUUID();
 await sql.query(`insert into research_account_fetches(id,actor_id,session_id,turn_actor_id,turn_id,platform,account,account_key,state)
  values($1,$2,$3,$2,1,'tiktok','turn_made',$4,'failed')`,[fetchId,row.actor_id,row.session_id,randomUUID().replace(/-/g,'').padEnd(64,'0')]);
 await sql.query(`insert into research_benchmarks(fetch_id,actor_id,session_id,turn_actor_id,turn_id,platform,account,followers,posts_analyzed,last_published_at,category,qualified,refs,operation_ids,missing,fetched_at)
  values($1,$2,$3,$2,1,'tiktok','turn_made',50000,20,now(),'imitable',true,'{}','{}','{}',now())`,[fetchId,row.actor_id,row.session_id]);
 const chatDraft=(await sql.query('select bill2_create_draft($1) v',[row.actor_id])).rows[0].v;
 const chat=randomUUID();
 await sql.query("insert into runtime_sessions(id,actor_id,scope,start_request_id,start_payload) values($1,$2,$3,$4,'{}')",
  [chat,row.actor_id,JSON.stringify({kind:'positioning_draft',draftId:chatDraft}),randomUUID()]);
 const index=(await sql.query("select runtime_workspace_source($1,$2,'') v",[row.actor_id,chat])).rows[0].v;
 const entry=index.entries.find((e:{kind:string})=>e.kind==='benchmarks');
 expect(entry?.producedBy).toEqual([{turnId:1}]);
 const accounts=(await sql.query('select research_chat_benchmark_accounts($1,$2,null) v',[row.actor_id,chat])).rows[0].v;
 expect(JSON.stringify(accounts)).toContain('turn_made');
});

it("OPC: account inheritance validates dependency order and revocable local evidence",async()=>{
 const f=await publishedDraft(3,true,true,true);
 const plan=await f.service.savePlan({draftId:f.d.draftId,requestId:randomUUID(),expectedVersion:0,sourceVersionId:f.sourceVersionId,
  body:[{id:randomUUID(),platform:'x',account:'reverse-order',title:'合法的依赖顺序',brief:'显示顺序不等于确认顺序',day:'2026-09-26'}]});
 await f.service.handoff({draftId:f.d.draftId,requestId:randomUUID(),planId:plan.planId,accounts:[{platform:'x',account:'reverse-order',expectedRevision:null}]});
 const account=(await f.service.library({search:'',from:null,to:null})).businesses[0].accounts[0];
 const begun=await f.service.accountStrategyBegin(account.projectId,randomUUID());
 const d=await f.service.read(begun.draftId);
 expect(d.snapshot.workflow.steps.map((step:{id:string})=>step.id)).toEqual(['step-2','step-1','step-0']);
 expect(Object.values(d.snapshot.steps).every((step:any)=>step.valid)).toBe(true);
 const evidence=d.snapshot.steps['step-0'].evidenceIds[0];
 expect((await sql.query('select count(*)::int n from artifact_evidence_restrictions where evidence_id=$1',[evidence])).rows[0].n).toBe(1);
 await f.artifacts.execute({action:'restrictEvidence',projectId:d.projectId,roundId:d.roundId,requestId:randomUUID(),evidenceId:evidence,deleted:true,expiresAt:null});
 expect((await sql.query('select artifact_evidence_allowed($1,$2::jsonb) allowed',[d.projectId,JSON.stringify([evidence])])).rows[0].allowed).toBe(false);
 await expect(f.service.read(d.draftId)).rejects.toThrow('OPC_DENIED');
 await expect(f.service.accountStrategySchema(account.projectId)).rejects.toThrow('OPC_SOURCE_DENIED');
 await expect(f.artifacts.read(d.projectId,d.roundId)).rejects.toThrow('ARTIFACT_DENIED');
 await expect(f.artifacts.execute({action:'publish',projectId:d.projectId,roundId:d.roundId,requestId:randomUUID(),expectedSteps:Object.fromEntries(Object.entries(d.snapshot.steps).map(([k,v]:[string,any])=>[k,{version:v.version,reviewVersion:v.reviewVersion}]))})).rejects.toThrow();
 expect(await f.service.accountStrategyHistory(account.projectId)).toHaveLength(1);
},120000);

it("OPC: an older account draft with a different method keeps both sides without guessed repair",async()=>{
 const f=await publishedDraft();
 const plan=await f.service.savePlan({draftId:f.d.draftId,requestId:randomUUID(),expectedVersion:0,sourceVersionId:f.sourceVersionId,
  body:[{id:randomUUID(),platform:'x',account:'method-conflict',title:'方法边界',brief:'不猜测映射',day:'2026-09-26'}]});
 await f.service.handoff({draftId:f.d.draftId,requestId:randomUUID(),planId:plan.planId,accounts:[{platform:'x',account:'method-conflict',expectedRevision:null}]});
 const account=(await f.service.library({search:'',from:null,to:null})).businesses[0].accounts[0];
 const next=makePackage(f.pack.id,true),flow=structuredClone(f.flow),registration='conflict-'+randomUUID();
 flow.steps[0].information![0].title='新方法的不同问法';
 await publishSkillPackage(admin,f.owner,next);
 await sql.query('update artifact_workflows set enabled=false where id=$1',[f.registration]);
 await sql.query('insert into artifact_workflows(id,module_id,skill_id,revision_id,workflow,label,enabled) values($1,$2,$3,$4,$5,$6,true)',[registration,f.moduleId,next.id,next.revisionId,flow,'新方法']);
 const {readFile}=await import('node:fs/promises');
 const oldSql=await readFile(new URL('../../../../db/migrations/0125_opc_account_strategy.sql',import.meta.url),'utf8');
 const newSql=await readFile(new URL('../../../../db/migrations/0134_opc_account_strategy_inheritance.sql',import.meta.url),'utf8');
 const begin=oldSql.slice(oldSql.indexOf('CREATE OR REPLACE FUNCTION opc_account_strategy_begin('),oldSql.indexOf('END $$;',oldSql.indexOf('CREATE OR REPLACE FUNCTION opc_account_strategy_begin('))+7);
 let legacy:{draftId:string;roundId:string};await sql.query(begin);
 try{legacy=await f.service.accountStrategyBegin(account.projectId,randomUUID());}finally{await sql.query(newSql);}
 const d=await f.service.read(legacy!.draftId);
 await f.service.information({draftId:d.draftId,stepId:'step-0',requestId:randomUUID(),expectedVersion:d.snapshot.steps['step-0'].version,
  values:{goal:{...d.information['step-0'].values.goal,value:'新方法下用户的新输入'}}});
 const before=(await sql.query('select to_jsonb(r) value from artifact_rounds r where id=$1',[legacy!.roundId])).rows[0];
 const {browser,page}=await planBrowser(f);
 try{
  await page.goto(process.env.V3_LOCAL_APP+'/app/library');
  await page.getByRole('navigation',{name:'资料库平台与账号'}).getByRole('button',{name:/method-conflict/}).click();
  await page.getByRole('button',{name:/x · method-conflict.*查看详情/}).click();
  await page.getByRole('dialog',{name:'定位详情'}).getByRole('button',{name:'回到策略讨论',exact:true}).click();
  await page.waitForURL('**/positioning/'+legacy!.draftId);
  await page.getByRole('alert').filter({hasText:'未自动合并或覆盖任何答案'}).waitFor();
  await page.getByText('查看原正式版本完整内容',{exact:true}).click();
  expect((await page.getByRole('alert').allTextContents()).join(' ')).toContain('A concrete user decision');
  expect(await page.getByRole('textbox',{name:'新方法的不同问法',exact:true}).inputValue()).toBe('新方法下用户的新输入');
  expect((await sql.query('select to_jsonb(r) value from artifact_rounds r where id=$1',[legacy!.roundId])).rows[0]).toEqual(before);
 }finally{await browser.close();}
},180000);

it("OPC: account strategy edits stay draft-scoped and publish only for the chosen account", async()=>{
  const f=await publishedDraft();
  const other=await publishedDraft();
  const plan=await f.service.savePlan({draftId:f.d.draftId,requestId:randomUUID(),expectedVersion:0,sourceVersionId:f.sourceVersionId,
    body:[{id:randomUUID(),platform:'x',account:'strategy-a',title:'旧来源选题',brief:'已有稿件必须保留旧来源',day:'2026-09-26'},
      {id:randomUUID(),platform:'x',account:'strategy-b',title:'另一账号选题',brief:'另一账号不变',day:'2026-09-27'}]});
  await f.service.handoff({draftId:f.d.draftId,requestId:randomUUID(),planId:plan.planId,accounts:[{platform:'x',account:'strategy-a',expectedRevision:null},{platform:'x',account:'strategy-b',expectedRevision:null}]});
  const original=(await f.service.library({search:'',from:null,to:null})).businesses[0].accounts;
  const a=original.find((account:{account:string})=>account.account==='strategy-a')!;
  const b=original.find((account:{account:string})=>account.account==='strategy-b')!;
  const initialA=a;
  const request={accountProjectId:a.projectId,requestId:randomUUID(),expectedSourceVersionId:f.sourceVersionId,expectedPendingDraftId:null,expectedRegistrationId:f.registration,
    edits:{[f.flow.steps[0].id]:{goal:'仅账号 A 的待确认新方向'}}};
  await expect(other.service.accountStrategySave({...request,requestId:randomUUID()})).rejects.toThrow('OPC_DENIED');
  const saved=await f.service.accountStrategySave(request);
  expect(await f.service.accountStrategySave(request)).toEqual(saved);
  await expect(f.service.accountStrategySave({...request,expectedStepVersions:{[f.flow.steps[0].id]:1}})).rejects.toThrow('OPC_REQUEST_CONFLICT');
  await expect(f.service.accountStrategySave({...request,expectedRegistrationId:'another-skill-revision'})).rejects.toThrow('OPC_REQUEST_CONFLICT');
  await expect(f.service.accountStrategySave({...request,edits:{[f.flow.steps[0].id]:{goal:'重放不能换内容'}}})).rejects.toThrow('OPC_REQUEST_CONFLICT');
  await expect(f.service.accountStrategySave({...request,requestId:randomUUID()})).rejects.toThrow('OPC_VERSION_CONFLICT');
  const pending=(await f.service.library({search:'',from:null,to:null})).businesses[0].accounts;
  expect(pending.find((account:{projectId:string})=>account.projectId===a.projectId)).toMatchObject({sourceVersionId:f.sourceVersionId,pendingStrategyDraftId:saved.draftId,sourceVersion:1});
  expect(pending.find((account:{projectId:string})=>account.projectId===b.projectId)).toMatchObject({sourceVersionId:f.sourceVersionId,pendingStrategyDraftId:null,sourceVersion:1});
  expect((await f.service.accountStrategyHistory(a.projectId)).map((v:{id:string})=>v.id)).toEqual([f.sourceVersionId]);
  const draft=await f.service.read(saved.draftId);
  expect(draft.information[f.flow.steps[0].id].values.goal).toMatchObject({value:'仅账号 A 的待确认新方向',status:'provisional'});
  const stepId=f.flow.steps[0].id;
  const concurrentBase={accountProjectId:a.projectId,expectedSourceVersionId:f.sourceVersionId,
    expectedPendingDraftId:saved.draftId,expectedRegistrationId:f.registration,
    expectedStepVersions:{[stepId]:draft.snapshot.steps[stepId].version}};
  const firstConcurrent={...concurrentBase,requestId:randomUUID(),edits:{[stepId]:{goal:'先保存的标签页'}}};
  const secondConcurrent={...concurrentBase,requestId:randomUUID(),edits:{[stepId]:{goal:'迟到的标签页'}}};
  const firstSaved=await f.service.accountStrategySave(firstConcurrent);
  expect(await f.service.accountStrategySave(firstConcurrent)).toEqual(firstSaved);
  await expect(f.service.accountStrategySave({...firstConcurrent,expectedStepVersions:{[stepId]:draft.snapshot.steps[stepId].version+1}}))
    .rejects.toThrow('OPC_REQUEST_CONFLICT');
  await expect(f.service.accountStrategySave(secondConcurrent)).rejects.toThrow('OPC_VERSION_CONFLICT');
  await expect(f.service.accountStrategySave({...secondConcurrent,requestId:randomUUID(),expectedStepVersions:null}))
    .rejects.toThrow('OPC_VERSION_CONFLICT');
  expect((await f.service.read(saved.draftId)).information[stepId].values.goal.value).toBe('先保存的标签页');
  // The open library dialog must refresh its account binding after a save.
  // A second edit in the same dialog must target the pending draft, not the
  // previously published account snapshot.
  const {browser:strategyBrowser,page:strategyPage}=await planBrowser(f);
  try{
    await strategyPage.goto(process.env.V3_LOCAL_APP+'/app/library');
    await strategyPage.getByRole('navigation',{name:'资料库平台与账号'}).getByRole('button',{name:/strategy-a/}).click();
    await strategyPage.getByRole('button',{name:/x · strategy-a.*查看详情/}).click();
    const dialog=strategyPage.getByRole('dialog',{name:'定位详情'});
    const secondTab=await strategyPage.context().newPage();
    secondTab.setDefaultTimeout(90000);
    await secondTab.goto(process.env.V3_LOCAL_APP+'/app/library');
    await secondTab.getByRole('navigation',{name:'资料库平台与账号'}).getByRole('button',{name:/strategy-a/}).click();
    await secondTab.getByRole('button',{name:/x · strategy-a.*查看详情/}).click();
    const secondDialog=secondTab.getByRole('dialog',{name:'定位详情'});
    await dialog.getByRole('button',{name:'修改定位'}).click();
    await secondDialog.getByRole('button',{name:'修改定位'}).click();
    await dialog.getByRole('textbox').first().fill('标签页 A 已保存');
    await secondDialog.getByRole('textbox').first().fill('标签页 B 未保存');
    await dialog.getByRole('button',{name:'确认保存'}).click();
    await dialog.getByText('标签页 A 已保存',{exact:true}).first().waitFor();
    await secondDialog.getByRole('button',{name:'确认保存'}).click();
    await secondDialog.getByRole('alert').filter({hasText:'OPC_VERSION_CONFLICT'}).waitFor();
    expect(await secondDialog.getByRole('textbox').first().inputValue()).toBe('标签页 B 未保存');
    expect((await f.service.read(saved.draftId)).information[stepId].values.goal.value).toBe('标签页 A 已保存');
    await secondTab.close();
    for(const text of ['第一次在弹窗修改','第二次在同一弹窗修改']){
      console.info('ACCOUNT_SAVE_PHASE','edit',text);
      await dialog.getByRole('button',{name:'修改定位'}).click();
      await dialog.getByRole('textbox').first().fill(text);
      await dialog.getByRole('button',{name:'确认保存'}).click();
      await dialog.getByRole('status').filter({hasText:'已保存到此账号的待确认定位草稿'}).waitFor();
      console.info('ACCOUNT_SAVE_PHASE','saved',text);
      await dialog.getByText(text,{exact:true}).first().waitFor();
      await dialog.getByRole('button',{name:'修改定位'}).waitFor();
      await dialog.getByRole('button',{name:'修改定位'}).click();
      expect(await dialog.getByRole('textbox').first().inputValue()).toBe(text);
      await dialog.getByRole('button',{name:'取消'}).click();
    }
    expect((await f.service.read(saved.draftId)).information[f.flow.steps[0].id].values.goal.value)
      .toBe('第二次在同一弹窗修改');
  }catch(error){console.info('ACCOUNT_SAVE_FAILURE',error instanceof Error?error.message:String(error));throw error;}finally{console.info('ACCOUNT_SAVE_PHASE','closing');await strategyBrowser.close();console.info('ACCOUNT_SAVE_PHASE','closed');}
  for(const step of f.flow.steps){
    const state=(await f.service.read(saved.draftId)).snapshot.steps[step.id];
    await f.artifacts.execute({action:'save',projectId:draft.projectId,roundId:saved.roundId,requestId:randomUUID(),stepId:step.id,
      body:'用户核对的账号定位 '+step.title,evidenceIds:[],expectedVersion:state.version});
    const next=(await f.service.read(saved.draftId)).snapshot.steps[step.id];
    await f.service.information({draftId:saved.draftId,stepId:step.id,requestId:randomUUID(),expectedVersion:next.version,
      values:{goal:{status:'confirmed',nature:'decision',value:step.id===f.flow.steps[0].id?'仅账号 A 的已确认新方向':'保留原方向'}}});
    const confirmed=(await f.service.read(saved.draftId)).snapshot.steps[step.id];
    await f.artifacts.execute({action:'confirm',projectId:draft.projectId,roundId:saved.roundId,requestId:randomUUID(),stepId:step.id,
      expectedVersion:confirmed.version,expectedReviewVersion:confirmed.reviewVersion});
  }
  const ready=(await f.service.read(saved.draftId)).snapshot;
  await f.artifacts.execute({action:'publish',projectId:draft.projectId,roundId:saved.roundId,requestId:randomUUID(),
    expectedSteps:Object.fromEntries(Object.entries(ready.steps).map(([id,state])=>[id,{version:(state as {version:number}).version,reviewVersion:(state as {reviewVersion:number}).reviewVersion}]))});
  const after=(await f.service.library({search:'',from:null,to:null})).businesses[0].accounts;
  const nowA=after.find((account:{projectId:string})=>account.projectId===a.projectId)!;
  const nowB=after.find((account:{projectId:string})=>account.projectId===b.projectId)!;
  expect(nowA.sourceVersionId).not.toBe(f.sourceVersionId);
  expect(nowA).toMatchObject({sourceVersion:2,pendingStrategyDraftId:null});
  expect(nowB.sourceVersionId).toBe(f.sourceVersionId);
  expect((await f.service.accountStrategyHistory(a.projectId)).map((v:{id:string})=>v.id)).toEqual([nowA.sourceVersionId,f.sourceVersionId]);
  expect((await sql.query('select source_version_id from opc_items where account_project_id=$1',[a.projectId])).rows[0].source_version_id).toBe(f.sourceVersionId);
  expect(initialA.sourceVersionId).toBe(f.sourceVersionId);
  await expect(other.service.accountStrategyHistory(a.projectId)).rejects.toThrow('OPC_DENIED');
  const secondPackage=makePackage(f.pack.id,true);
  const secondFlow=structuredClone(f.flow);
  secondFlow.steps[0].title='新版账号问题';
  secondFlow.steps[0].information=[...secondFlow.steps[0].information,
    {id:'new_need',title:'新增问题',required:true,profileKey:'new_need'}];
  secondFlow.report.sections[0].title='新版账号问题';
  const secondRegistration='opc-account-next-'+randomUUID();
  await publishSkillPackage(admin,f.owner,secondPackage);
  await sql.query('update artifact_workflows set enabled=false where id=$1',[f.registration]);
  await sql.query('insert into artifact_workflows(id,module_id,skill_id,revision_id,workflow,label,enabled) values($1,$2,$3,$4,$5,$6,true)',
    [secondRegistration,f.moduleId,secondPackage.id,secondPackage.revisionId,secondFlow,'账号定位新版']);
  const secondStartRequest=randomUUID();
  const secondDraft=await f.service.accountStrategyBegin(a.projectId,secondStartRequest);
  expect(secondDraft.draftId).not.toBe(saved.draftId);
  expect((await f.service.accountStrategyBegin(a.projectId,request.requestId)).draftId).toBe(saved.draftId);
  const sharedBefore=(await sql.query('select current_source_version_id from opc_businesses where id=(select business_id from opc_accounts where project_id=$1)',[a.projectId])).rows[0].current_source_version_id;
  await expect(f.service.revise(saved.draftId,randomUUID(),saved.roundId)).rejects.toThrow('OPC_VERSION_CONFLICT');
  await expect(sql.query('select artifact_transition($1,$2,$3,$4,$5,$6,$7,$8)',
    [f.actor,f.moduleId,f.pack.id,'publish',draft.projectId,saved.roundId,randomUUID(),{}])).rejects.toThrow('OPC_VERSION_CONFLICT');
  expect((await sql.query('select current_source_version_id from opc_businesses where id=(select business_id from opc_accounts where project_id=$1)',[a.projectId])).rows[0].current_source_version_id).toBe(sharedBefore);
  const {browser:historicalBrowser,page:historicalPage}=await planBrowser(f);
  try{
    await historicalPage.goto(process.env.V3_LOCAL_APP+'/app/positioning/'+saved.draftId);
    await historicalPage.getByRole('button',{name:'修订定位，保留原版本',exact:true}).click();
    await expect.poll(async()=>(await historicalPage.getByRole('alert').allTextContents()).join(' '),{timeout:15000}).toContain('版本已变化');
  }finally{await historicalBrowser.close();}
  const secondRead=await f.service.read(secondDraft.draftId);
  expect(secondRead.snapshot.workflow.steps[0].title).toBe(f.flow.steps[0].title);
  expect(secondRead.information[secondFlow.steps[0].id].schema.map((field:{title:string})=>field.title)).not.toContain('新增问题');
  expect((await f.service.accountStrategyHistory(a.projectId)).map((v:{id:string})=>v.id))
    .toEqual([nowA.sourceVersionId,f.sourceVersionId]);
  const secondRoundId=secondDraft.roundId;
  for(const step of f.flow.steps){
    const state=(await f.service.read(secondDraft.draftId)).snapshot.steps[step.id];
    await f.artifacts.execute({action:'save',projectId:secondRead.projectId,roundId:secondRoundId,requestId:randomUUID(),stepId:step.id,
      body:'用户核对的新版账号定位 '+step.title,evidenceIds:[],expectedVersion:state.version});
    const next=(await f.service.read(secondDraft.draftId)).snapshot.steps[step.id];
    const values=Object.fromEntries(step.information!.map(field=>[field.id,{status:'confirmed',nature:'decision',value:'用户确认 '+field.title}]));
    await f.service.information({draftId:secondDraft.draftId,stepId:step.id,requestId:randomUUID(),expectedVersion:next.version,values});
    const confirmed=(await f.service.read(secondDraft.draftId)).snapshot.steps[step.id];
    await f.artifacts.execute({action:'confirm',projectId:secondRead.projectId,roundId:secondRoundId,requestId:randomUUID(),stepId:step.id,
      expectedVersion:confirmed.version,expectedReviewVersion:confirmed.reviewVersion});
  }
  const secondReady=(await f.service.read(secondDraft.draftId)).snapshot;
  await f.artifacts.execute({action:'publish',projectId:secondRead.projectId,roundId:secondRoundId,requestId:randomUUID(),
    expectedSteps:Object.fromEntries(Object.entries(secondReady.steps).map(([id,state])=>[id,{version:(state as {version:number}).version,reviewVersion:(state as {reviewVersion:number}).reviewVersion}]))});
  const thirdHistory=await f.service.accountStrategyHistory(a.projectId);
  expect(thirdHistory).toHaveLength(3);
  expect(thirdHistory[1].id).toBe(nowA.sourceVersionId);
  expect(thirdHistory[2].id).toBe(f.sourceVersionId);
  const pendingAgain=await f.service.accountStrategyBegin(a.projectId,randomUUID());
  const pendingRead=await f.service.read(pendingAgain.draftId);
  const beforeStale=(await sql.query('select steps from artifact_rounds where id=$1',[pendingAgain.roundId])).rows[0];
  const revision=(await sql.query('select revision from opc_accounts where project_id=$1',[a.projectId])).rows[0].revision;
  const otherRevision=(await sql.query('select revision from opc_accounts where project_id=$1',[b.projectId])).rows[0].revision;
  console.info('ACCOUNT_SOURCE_DRIFT','before');
  await f.service.handoff({draftId:f.d.draftId,requestId:randomUUID(),planId:plan.planId,accounts:[{platform:'x',account:'strategy-a',expectedRevision:Number(revision)},{platform:'x',account:'strategy-b',expectedRevision:Number(otherRevision)}]});
  console.info('ACCOUNT_SOURCE_DRIFT','after');
  const target=pendingRead.snapshot.steps[f.flow.steps[0].id];
  await expect(f.artifacts.execute({action:'confirm',projectId:pendingRead.projectId,roundId:pendingRead.roundId,requestId:randomUUID(),stepId:f.flow.steps[0].id,expectedVersion:target.version,expectedReviewVersion:target.reviewVersion})).rejects.toThrow();
  await expect(f.artifacts.execute({action:'publish',projectId:pendingRead.projectId,roundId:pendingRead.roundId,requestId:randomUUID(),expectedSteps:Object.fromEntries(Object.entries(pendingRead.snapshot.steps).map(([k,v]:[string,any])=>[k,{version:v.version,reviewVersion:v.reviewVersion}]))})).rejects.toThrow();
  expect((await sql.query('select steps from artifact_rounds where id=$1',[pendingAgain.roundId])).rows[0]).toEqual(beforeStale);
},180000);

it("OPC: account strategy revision after Skill upload preserves its exact published method",async()=>{
  const f=await publishedDraft();
  const plan=await f.service.savePlan({draftId:f.d.draftId,requestId:randomUUID(),expectedVersion:0,sourceVersionId:f.sourceVersionId,
    body:[{id:randomUUID(),platform:'x',account:'strategy-upgrade',title:'旧来源选题',brief:'来源须保留',day:'2026-09-26'}]});
  await f.service.handoff({draftId:f.d.draftId,requestId:randomUUID(),planId:plan.planId,
    accounts:[{platform:'x',account:'strategy-upgrade',expectedRevision:null}]});
  const account=(await f.service.library({search:'',from:null,to:null})).businesses[0].accounts[0];
  const revisedPackage=makePackage(f.pack.id,true);
  const revisedFlow=structuredClone(f.flow);
  revisedFlow.steps[0].title='更新后的需求确认';
  revisedFlow.steps[0].information=[
    ...revisedFlow.steps[0].information,
    {id:'new_need',title:'新增待确认问题',required:true,profileKey:'new_need'},
  ];
  revisedFlow.report.sections[0].title='更新后的需求确认';
  const revisedRegistration='opc-account-revised-'+randomUUID();
  await publishSkillPackage(admin,f.owner,revisedPackage);
  await sql.query('update artifact_workflows set enabled=false where id=$1',[f.registration]);
  await sql.query('insert into artifact_workflows(id,module_id,skill_id,revision_id,workflow,label,enabled) values($1,$2,$3,$4,$5,$6,true)',
    [revisedRegistration,f.moduleId,revisedPackage.id,revisedPackage.revisionId,revisedFlow,'新版定位']);
  const started=await f.service.accountStrategyBegin(account.projectId,randomUUID());
  const draft=await f.service.read(started.draftId);
  expect(draft.snapshot.workflow.steps[0].title).toBe(f.flow.steps[0].title);
  expect(draft.information[revisedFlow.steps[0].id].schema.map((field:{title:string})=>field.title))
    .not.toContain('新增待确认问题');
  expect(draft.information[revisedFlow.steps[0].id].values.new_need?.value??'').toBe('');
  expect((await f.service.library({search:'',from:null,to:null})).businesses[0].accounts[0].sourceVersionId)
    .toBe(f.sourceVersionId);
},180000);

it("OPC: library edits retain source Skill fields after a renamed method is published",async()=>{
  const f=await publishedDraft();
  const plan=await f.service.savePlan({draftId:f.d.draftId,requestId:randomUUID(),expectedVersion:0,sourceVersionId:f.sourceVersionId,
    body:[{id:randomUUID(),platform:'x',account:'renamed-schema',title:'旧稿来源',brief:'保留来源',day:'2026-09-26'}]});
  await f.service.handoff({draftId:f.d.draftId,requestId:randomUUID(),planId:plan.planId,
    accounts:[{platform:'x',account:'renamed-schema',expectedRevision:null}]});
  const account=(await f.service.library({search:'',from:null,to:null})).businesses[0].accounts[0];
  const nextPackage=makePackage(f.pack.id,true);
  const nextFlow=structuredClone(f.flow);
  nextFlow.steps[0].id='renamed-step';
  nextFlow.steps[0].title='新版问题顺序';
  nextFlow.steps[0].information![0].id='renamed-goal';
  nextFlow.steps[0].information![0].title='新版目标问题';
  nextFlow.steps[1].dependsOn=['renamed-step'];
  nextFlow.report.sections[0].stepId='renamed-step';
  nextFlow.report.sections[0].title='新版问题顺序';
  const nextRegistration='opc-renamed-'+randomUUID();
  await publishSkillPackage(admin,f.owner,nextPackage);
  await sql.query('update artifact_workflows set enabled=false where id=$1',[f.registration]);
  await sql.query('insert into artifact_workflows(id,module_id,skill_id,revision_id,workflow,label,enabled) values($1,$2,$3,$4,$5,$6,true)',
    [nextRegistration,f.moduleId,nextPackage.id,nextPackage.revisionId,nextFlow,'新版问题']);
  const directSchema=await sql.query('select opc_account_strategy_schema($1,$2) as schema',[f.actor,account.projectId]);
  expect(directSchema.rows[0].schema.registrationId).toBe(f.registration);
  const schema=await f.service.accountStrategySchema(account.projectId);
  expect(schema.registrationId).toBe(f.registration);
  expect(schema.workflow.steps[0].information[0].id).toBe('goal');
  const other=await publishedDraft();
  await expect(other.service.accountStrategySchema(account.projectId)).rejects.toThrow('OPC_DENIED');
  await expect(f.service.accountStrategySave({accountProjectId:account.projectId,requestId:randomUUID(),
    expectedSourceVersionId:f.sourceVersionId,expectedPendingDraftId:null,expectedRegistrationId:nextRegistration,
    edits:{'renamed-step':{'renamed-goal':'旧 Skill 的过期保存'}}})).rejects.toThrow('OPC_VERSION_CONFLICT');
  const {browser,page}=await planBrowser(f);
  try{
    await page.goto(process.env.V3_LOCAL_APP+'/app/library');
    await page.getByRole('navigation',{name:'资料库平台与账号'}).getByRole('button',{name:/renamed-schema/}).click();
    await page.getByRole('button',{name:/x · renamed-schema.*查看详情/}).click();
    const dialog=page.getByRole('dialog',{name:'定位详情'});
    await dialog.getByRole('button',{name:'修改定位'}).click();
    await dialog.getByText(f.flow.steps[0].title,{exact:true}).waitFor();
    await dialog.getByText('已知目标 0',{exact:true}).first().waitFor();
    expect(await dialog.getByText('新版目标问题').count()).toBe(0);
    await dialog.getByRole('textbox').first().fill('取消后不能写入');
    await dialog.getByRole('button',{name:'取消'}).click();
    expect((await sql.query('select count(*)::int as n from opc_account_strategy_drafts where account_project_id=$1',[account.projectId])).rows[0].n).toBe(0);
    await dialog.getByRole('button',{name:'修改定位'}).click();
    await dialog.getByRole('textbox').first().fill('新版问题下的待确认答案');
    await dialog.getByRole('button',{name:'确认保存'}).click();
    await dialog.getByRole('status').filter({hasText:'已保存到此账号的待确认定位草稿'}).waitFor();
  }finally{await browser.close();}
  const updated=(await f.service.library({search:'',from:null,to:null})).businesses[0].accounts[0];
  expect(updated.sourceVersionId).toBe(f.sourceVersionId);
  expect(updated.pendingStrategyDraftId).toBeTruthy();
  const draft=await f.service.read(updated.pendingStrategyDraftId);
  expect(draft.snapshot.workflow.steps[0].id).toBe(f.flow.steps[0].id);
  expect(draft.information[f.flow.steps[0].id].values.goal).toMatchObject({value:'新版问题下的待确认答案',status:'provisional'});
},180000);

it("OPC: manual positioning keeps both the composer and current answer editable",async()=>{
  const f=await mergedPositioningFixture();
  await planFixtureModel(f.moduleId);
  const d=await f.service.start({requestId:randomUUID(),registration:f.registration,mode:'manual'});
  const {chromium}=await import('../../../../../apps/web/node_modules/@playwright/test');
  const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:900}});
  await context.route('**/*',route=>['127.0.0.1','localhost'].includes(new URL(route.request().url()).hostname)?route.continue():route.abort());
  const page=await context.newPage();page.setDefaultTimeout(60000);
  try{
    await page.goto(process.env.V3_LOCAL_APP+'/login?redirect='+encodeURIComponent('/app/positioning/'+d.draftId));
    await page.getByPlaceholder('name@example.com').fill(f.email);
    await page.getByPlaceholder('输入你的密码').fill(f.password);
    await page.getByRole('button',{name:'登录',exact:true}).last().click();
    await page.waitForURL(url=>url.pathname==='/app/positioning/'+d.draftId);
    const mentor=page.getByRole('textbox',{name:'给 AI 教练的回复',exact:true});
    const answer=page.getByRole('textbox',{name:'产品与服务',exact:true});
    await answer.waitFor();
    const phases=page.getByRole('navigation',{name:'定位步骤'}).getByRole('button');
    expect(await phases.count()).toBe(6);
    for(const [index,title] of ['需求确认','竞品研究','账号定位','内容策略','运营建议','商业规划'].entries())
      expect((await phases.nth(index).innerText()).replace(/\s+/g,' ')).toContain(`${index+1} ${title}`);
    await page.screenshot({path:process.env.V3_WORKBENCH_OUTPUT+'/u2-six-stage-positioning-desktop.png'});
    await mentor.fill('请帮我理解这一步怎样回答。');
    await answer.fill('我教摄影新手建立每周拍摄练习。');
    expect(await mentor.inputValue()).toBe('请帮我理解这一步怎样回答。');
    await page.getByText('已自动保存',{exact:true}).waitFor();
    await page.reload();
    expect(await mentor.inputValue()).toBe('请帮我理解这一步怎样回答。');
    expect(await answer.inputValue()).toBe('我教摄影新手建立每周拍摄练习。');
    await page.getByRole('button',{name:'发送',exact:true}).click();
    await page.getByRole('log',{name:'完整 AI 教练消息'}).getByText('请帮我理解这一步怎样回答。',{exact:true}).waitFor({timeout:15000});
  }finally{await browser.close();}
},180000);

it("OPC: prior confirmed information remains scoped after edits and reader upgrade",async()=>{
 const f=await fixture(3,false,2);
 const d=await f.service.start({requestId:randomUUID(),registration:f.registration,mode:'manual'});
 const read=()=>f.service.read(d.draftId);
 const values={goal:{status:'confirmed',nature:'fact',value:'Previously confirmed'},extra0:{status:'deferred',nature:'unknown',value:'Explicitly deferred'},extra1:{status:'provisional',nature:'decision',value:'Never confirmed'}};
 const write=async(next:typeof values)=>f.service.information({draftId:d.draftId,stepId:'step-0',requestId:randomUUID(),expectedVersion:(await read()).snapshot.steps['step-0'].version,values:next});
 await write(values);
 // No completed-step confirmation is needed to preserve an individually confirmed field.
 expect((await read()).snapshot.steps['step-0'].valid).toBe(false);
 await write({...values,goal:{...values.goal,status:'provisional',value:'Edited confirmed answer'},extra0:{...values.extra0,status:'provisional',value:'Edited deferred answer'}});
 const edited=await read();
 expect(edited.information['step-0'].previouslyConfirmed).toEqual(['goal']);
 expect(edited.information['step-1'].previouslyConfirmed).toEqual([]);
 const records=async()=>(await sql.query('select to_jsonb(a) row from artifact_requests a where project_id=$1 order by request_id',[d.projectId])).rows;
 const frozen=await records();
 const {readFile}=await import('node:fs/promises');
 const migration=await readFile(new URL('../../../../db/migrations/0133_opc_confirmed_information_history.sql',import.meta.url),'utf8');
 // Later migrations (0159) extend the same reader, so 0133 is checked for what it
 // adds and the current reader is then restored before the full comparison.
 const restoreCurrent=await snapshotSchema(sql);
 await sql.query(await readFile(new URL('../../../../db/migrations/0120_opc_entry_projection.sql',import.meta.url),'utf8'));
 try{
  expect((await read()).information['step-0'].previouslyConfirmed).toBeUndefined();
 }finally{await sql.query(migration);}
 await sql.query(migration);
 expect((await read()).information['step-0'].previouslyConfirmed).toEqual(edited.information['step-0'].previouslyConfirmed);
 await restoreCurrent();
 expect((await read()).information['step-0']).toEqual(edited.information['step-0']);
 expect(await records()).toEqual(frozen);
 const other=await fixture(3);
 await expect(other.service.read(d.draftId)).rejects.toThrow('OPC_DENIED');
 const privileges=(await sql.query("select has_function_privilege('authenticated','opc_query(uuid,uuid)','execute') client,has_function_privilege('service_role','opc_query(uuid,uuid)','execute') server")).rows[0];
 expect(privileges).toEqual({client:false,server:true});
 await sql.query('update bill2_drafts set revoked=true where id=$1',[d.draftId]);
 await expect(read()).rejects.toThrow('OPC_DENIED');
 // A revision inherits only its exact published predecessor's confirmed values.
 await sql.query('update bill2_drafts set revoked=false where id=$1',[d.draftId]);
 const published=await completed(3,'mentor');
 expect((await published.service.read(published.d.draftId)).information['step-0'].previouslyConfirmed).toEqual(['goal']);
 await published.service.revise(published.d.draftId,randomUUID(),published.d.roundId);
 const revised=await published.service.read(published.d.draftId);
 expect(revised.information['step-0'].previouslyConfirmed).toEqual(['goal']);
 await published.service.information({draftId:published.d.draftId,stepId:'step-0',requestId:randomUUID(),expectedVersion:revised.snapshot.steps['step-0'].version,
  values:{goal:{...revised.information['step-0'].values.goal,status:'provisional',value:'A corrected inherited decision'}}});
 const {browser,page}=await planBrowser(published);
 try{
  await page.goto(process.env.V3_LOCAL_APP+'/app/positioning/'+published.d.draftId);
  await page.reload();
  const inherited=page.getByRole('textbox',{name:'已确认：已知目标 0',exact:true});
  await inherited.waitFor();
  expect(await inherited.inputValue()).toBe('A corrected inherited decision');
  await page.getByRole('button',{name:'确认这项修改',exact:true}).first().click();
  await expect.poll(async()=>(await published.service.read(published.d.draftId)).information['step-0'].values.goal.status).toBe('confirmed');
 }finally{await browser.close();}
},60000);

it("OPC: approved six-stage guided positioning keeps one editable conversation and current question",async()=>{
  const f=await mergedPositioningFixture();
  await planFixtureModel(f.moduleId);
  const {chromium}=await import('../../../../../apps/web/node_modules/@playwright/test');
  const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
  const context=await browser.newContext({viewport:{width:1600,height:900},deviceScaleFactor:1});
  await context.route('**/*',route=>['127.0.0.1','localhost'].includes(new URL(route.request().url()).hostname)?route.continue():route.abort());
  const page=await context.newPage();page.setDefaultTimeout(60000);
  try{
    await page.goto(process.env.V3_LOCAL_APP+'/login?redirect=/positioning');
    await page.getByPlaceholder('name@example.com').fill(f.email);
    await page.getByPlaceholder('输入你的密码').fill(f.password);
    await page.getByRole('button',{name:'登录',exact:true}).last().click();
    await page.waitForURL(url=>url.pathname==='/app/positioning');
    const fixtureDraft=await f.service.start({requestId:randomUUID(),registration:f.registration,mode:'mentor',businessName:'摄影入门课程'});
    await page.goto(process.env.V3_LOCAL_APP+'/app/positioning/'+fixtureDraft.draftId);
    const draftId=page.url().split('/app/positioning/')[1]?.split('?')[0]??'';
    expect(draftId).toBeTruthy();
    const phases=page.getByRole('navigation',{name:'定位步骤'}).getByRole('button');
    await expect.poll(()=>phases.count(),{timeout:30000}).toBe(6);
    for(const [index,title] of ['需求确认','竞品研究','账号定位','内容策略','运营建议','商业规划'].entries())
      expect((await phases.nth(index).innerText()).replace(/\s+/g,' ')).toContain(`${index+1} ${title}`);
    const answer=page.getByRole('textbox',{name:'产品与服务',exact:true});
    const mentor=page.getByRole('textbox',{name:'给 AI 教练的回复',exact:true});
    // The opening, autosave, send and history polling reach the local IP limit
    // (60/min) within the first minute; see resetLocalIpWindow.
    await resetLocalIpWindow();
    await answer.fill('摄影入门课程，用真实场景带新手练习取景。');
    await page.getByText('已自动保存',{exact:true}).waitFor();
    await mentor.fill('我想先聊真实的学员困境。');
    await page.getByRole('button',{name:'发送',exact:true}).click();
    await page.getByRole('log',{name:'完整 AI 教练消息'}).getByText('我想先聊真实的学员困境。',{exact:true}).waitFor();
    // The optimistic bubble is immediate; wait for the separate execution and
    // organizer phase before this happy-path refresh/confirmation traversal.
    await expect.poll(()=>page.evaluate(id=>sessionStorage.getItem('opc-step:'+id+':step-0'),draftId),{timeout:30000}).toBeNull();
    await page.evaluate(()=>document.fonts.ready);
    console.error('SIX_STAGE_METRICS',JSON.stringify(await page.evaluate(()=>{
      const entries:[string,string][]=[['rail','[aria-label="工作区导航"]'],['center','main'],['right','[aria-label="当前成果"]'],['composer','[aria-label="给 AI 教练的回复"]']];
      return Object.fromEntries(entries.map(([name,selector])=>{const element=document.querySelector(selector);if(!element)return[name,null];const rect=element.getBoundingClientRect(),style=getComputedStyle(element);return[name,{x:rect.x,y:rect.y,width:rect.width,height:rect.height,fontSize:style.fontSize,color:style.color,background:style.backgroundColor}]}));
    })));
    await page.screenshot({path:process.env.V3_WORKBENCH_OUTPUT+'/u2-approved-six-stage-guided-1600x900.png'});
    await page.setViewportSize({width:390,height:844});
    await page.screenshot({path:process.env.V3_WORKBENCH_OUTPUT+'/u2-approved-six-stage-guided-390x844.png'});
    await page.getByRole('button',{name:'展开右边栏'}).click();
    await answer.waitFor({state:'visible'});
    await page.screenshot({path:process.env.V3_WORKBENCH_OUTPUT+'/u2-approved-six-stage-answer-390x844.png'});
    await page.getByRole('button',{name:'收起成果面板'}).click();
    await page.setViewportSize({width:1600,height:900});
    await resetLocalIpWindow();
    await page.reload();
    expect(await answer.inputValue()).toBe('摄影入门课程，用真实场景带新手练习取景。');
    const answers:[string,string][]=[
      ['准备经营的平台','先做公众号和小红书，公众号解释判断，小红书展示练习。'],
      ['每周可用时间','每周稳定投入 3 小时。'],
      ['参考研究结论','借鉴同场景前后对照的讲解方式，不以器材评测为主。'],
      ['优先服务的用户','会操作相机，但不知道如何整理画面的摄影新手。'],
      ['价值与依据','曾带学员在同一街景中移动机位，用前后两张照片解释背景干扰。'],
      ['内容表达与平台安排','公众号解释判断；小红书提供练习清单。'],
      ['可持续的制作安排','每周先完成一个核心案例，再按时间选择平台版本。'],
      ['内容如何支持业务','先帮助用户完成一次构图练习，再说明课程的系统训练。'],
    ];
    const confirm=page.getByRole('button',{name:'确认当前信息，继续',exact:true});
    for(const [index,[label,value]] of answers.entries()){
      await resetLocalIpWindow();
      await confirm.click({timeout:15000});
      const next=page.getByRole('textbox',{name:label,exact:true});
      await next.waitFor();
      if(index===0){
        const reached=page.getByRole('navigation',{name:'本步骤已到达的问题'}).getByRole('button');
        await expect.poll(()=>reached.count()).toBe(2);
        const before=await reached.allTextContents();
        await reached.nth(0).click();
        await reached.nth(1).click();
        expect(await reached.allTextContents()).toEqual(before);
      }
      await next.fill(value);
      await page.getByText('已自动保存',{exact:true}).waitFor();
      const stepIndex=[0,0,1,2,2,3,4,5][index];
      const fieldId=['platforms','time','reference','audience','difference','roles','cadence','offer'][index];
      await expect.poll(async()=> (await f.service.read(draftId)).information[f.flow.steps[stepIndex].id].values?.[fieldId]?.value,{timeout:10000}).toBe(value);
      if([2,3,5,6,7].includes(index)){
        await page.evaluate(()=>document.fonts.ready);
        await page.screenshot({path:process.env.V3_WORKBENCH_OUTPUT+`/u2-six-stage-${index+2}-1600x900.png`});
      }
    }
    await confirm.click({timeout:15000});
    await expect.poll(async()=>{
      const state=await f.service.read(draftId);
      return state.snapshot.workflow.steps.map((step:{id:string})=>Object.values(state.information[step.id].values??{}).map((entry:{status:string})=>entry.status));
    },{timeout:20000}).toEqual([['confirmed','confirmed','confirmed'],['confirmed'],['confirmed','confirmed'],['confirmed'],['confirmed'],['confirmed']]);
    const final=await f.service.read(draftId);
    expect(final.snapshot.workflow.steps).toHaveLength(6);
    for(const step of final.snapshot.workflow.steps){
      const values=final.information[step.id].values;
      expect(Object.values(values).every((entry:{status:string})=>entry.status==='confirmed')).toBe(true);
    }
    const earlier=page.getByRole('textbox',{name:'已确认：产品与服务'});
    await earlier.fill('摄影入门课程，用真实学员案例讲解取景。');
    await expect.poll(async()=> (await f.service.read(draftId)).information[f.flow.steps[0].id].values?.product?.status,{timeout:15000}).toBe('provisional');
    await autosaveAcknowledged(page, draftId, f.flow.steps[0].id);
    await resetLocalIpWindow();
    await page.reload(); // A saved correction must remain available after the server projection refreshes.
    const reconfirm=page.getByRole('button',{name:'确认这项修改',exact:true}).first();
    await expect.poll(()=>reconfirm.isEnabled(),{timeout:15000}).toBe(true);
    await page.screenshot({path:process.env.V3_WORKBENCH_OUTPUT+'/u2-six-stage-reconfirm-1600x900.png'});
    await reconfirm.click({timeout:15000});
    await expect.poll(async()=> (await f.service.read(draftId)).information[f.flow.steps[0].id].values?.product?.status,{timeout:15000}).toBe('confirmed');
    await expect.poll(async()=> (await f.service.read(draftId)).snapshot.steps[f.flow.steps[0].id].valid,{timeout:15000}).toBe(true);
    // A later explicit deferral must not be relabelled as a pending correction.
    const confirmed=await f.service.read(draftId),stepId=f.flow.steps[0].id;
    await f.service.information({draftId,stepId,requestId:randomUUID(),expectedVersion:confirmed.snapshot.steps[stepId].version,
      values:{...confirmed.information[stepId].values,product:{...confirmed.information[stepId].values.product,status:'deferred'}}});
    await resetLocalIpWindow();
    await page.reload();
    await page.getByRole('textbox',{name:'已确认：准备经营的平台',exact:true}).waitFor();
    expect(await earlier.count()).toBe(0);
    expect((await f.service.read(draftId)).information[stepId].values.product.status).toBe('deferred');
  }catch(error){console.info('U4_GUIDED_FAILURE',error instanceof Error?error.stack:'unknown');throw error;}finally{console.info('U4_GUIDED_CLOSE_START');await browser.close();console.info('U4_GUIDED_CLOSED');}
},240000);

it("OPC: natural-language adoption stays complete after refresh and permits the next turn", async () => {
  const f = await publishedDraft();
  await planFixtureModel(f.moduleId);
  const { browser, page } = await planBrowser(f);
  const path = '/app/positioning/' + f.d.draftId + '/topics';
  try {
    await page.goto(process.env.V3_LOCAL_APP + path);
    await page.getByRole('button', { name: '开始选题工作对话', exact: true }).click();
    await page.getByRole('button', { name: '采用这个选题', exact: true }).first().waitFor({ timeout: 60000 });
    await page.getByLabel('消息', { exact: true }).fill('采用第一条选题');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect.poll(async () => (await f.service.read(f.d.draftId)).handoffs.length, { timeout: 60000 }).toBe(1);
    const before = await f.service.read(f.d.draftId);
    await page.reload();
    await page.getByLabel('消息', { exact: true }).waitFor();
    expect(await page.getByRole('status',{name:'待确认的操作',exact:true}).getByRole('button',{name:'重试',exact:true}).count()).toBe(0);
    expect((await page.getByRole('alert').allTextContents()).join(' ')).not.toContain('原请求身份');
    await page.getByLabel('消息', { exact: true }).fill('请继续修改标题');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect.poll(async () => (await f.service.topicDraftRead(f.d.draftId)).version, { timeout: 60000 }).toBe(2);
    await expect.poll(async () => {
      const latest = await f.service.topicDraftRead(f.d.draftId);
      const stored = await page.evaluate((sessionId) => JSON.parse(localStorage.getItem('opc-topic-candidate:' + sessionId) ?? 'null'),
        (await f.service.topicRead(f.d.draftId)).sessionId);
      return JSON.stringify(stored?.body) === JSON.stringify(latest.body);
    }, { timeout: 10000 }).toBe(true);
    const after = await f.service.read(f.d.draftId);
    expect(after.handoffs).toEqual(before.handoffs);
    expect(after.plans).toEqual(before.plans);
  } finally { await browser.close(); }
}, 240000);

it("OPC: topic invalid messages and legacy invalid pending records remain recoverable without dispatch", async () => {
  const f = await publishedDraft();
  await planFixtureModel(f.moduleId);
  const { browser, page } = await planBrowser(f);
  try {
    await page.goto(process.env.V3_LOCAL_APP + '/app/positioning/' + f.d.draftId + '/topics');
    await page.getByRole('button', { name: '开始选题工作对话', exact: true }).click();
    await page.getByRole('button', { name: '采用这个选题', exact: true }).first().waitFor();
    const workspace = await f.service.topicRead(f.d.draftId);
    const key = 'opc-topic-operation:' + workspace.sessionId;
    const identity = await topicIdentity(f.actor);
    const input = page.getByRole('textbox', { name: '消息', exact: true });
    await input.fill('a'.repeat(8001));
    // The shared composer bounds typed input before dispatch; backend schema
    // validation still protects restored legacy requests below.
    expect((await input.textContent())?.length).toBe(8000);
    expect(await topicIdentity(f.actor)).toEqual(identity);
    expect(await input.isEnabled()).toBe(true);
    // A record frozen by the earlier UI before its schema rejection is equally
    // provable invalid; release it without dispatch while retaining the edit.
    const invalidId = randomUUID();
    await page.evaluate(({ key, id, requestId, sourceVersionId }) => {
      const candidate = JSON.parse(localStorage.getItem('opc-topic-candidate:' + id)!);
      localStorage.setItem(key, JSON.stringify({ kind: 'save', request: {
        draftId: candidate.body.length ? location.pathname.split('/')[2] : '', requestId,
        expectedVersion: 0, sourceVersionId, body: candidate.body.map((row: object) => ({ ...row, title: '' })),
      } }));
    }, { key, id: workspace.sessionId, requestId: invalidId, sourceVersionId: workspace.sourceVersionId });
    await page.reload();
    await page.getByRole('status',{name:'待确认的操作',exact:true}).getByRole('button',{name:'重试',exact:true}).click();
    await expect.poll(() => page.evaluate(k => localStorage.getItem(k), key), { timeout: 30000 }).toBeNull();
    expect(await page.evaluate(k => localStorage.getItem(k), key + ':invalid:' + invalidId)).not.toBeNull();
    await page.getByRole('button', { name: '采用这个选题', exact: true }).first().waitFor();
    expect((await f.service.topicDraftRead(f.d.draftId)).version).toBe(1);
    expect(await topicIdentity(f.actor)).toEqual(identity);
    await input.fill('请修改第一条选题');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect.poll(async () => (await topicIdentity(f.actor)).topicExecutions, { timeout: 30000 }).toBe(2);
  } finally { await browser.close(); }
}, 300000);

it.each([false, true])("OPC: mentor history preserves a saved empty edit after refresh across revision %s", async (reviseRound) => {
  const f = await fixture(1);
  await planFixtureModel(f.moduleId);
  const d = await f.service.start({ requestId: randomUUID(), registration: f.registration, mode: 'mentor' });
  const { browser, page } = await planBrowser({ ...f, d });
  const path = '/app/positioning/' + d.draftId;
  const read = () => f.service.read(d.draftId);
  const title = f.flow.steps[0].information![0].title;
  const reply = '我想帮助刚接触短视频的人';
  try {
    await page.goto(process.env.V3_LOCAL_APP + path);
    await page.getByRole('log', { name: '完整 AI 教练消息' }).getByText('AI 自媒体陪跑教练 · 主动引导 · 1.1', { exact: true }).waitFor();
    const input = page.getByRole('textbox', { name: '给 AI 教练的回复', exact: true });
    await expect.poll(() => input.isEnabled(), { timeout: 30000 }).toBe(true);
    await input.fill(reply);
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect.poll(async () => (await read()).information['step-0'].values?.goal?.value, { timeout: 30000 }).toBe(reply);
    await expect.poll(() => input.inputValue(), { timeout: 30000 }).toBe('');
    const oldIdentity = await planIdentityRows(f.actor);
    if (reviseRound) {
      // Publish/revise via the real business operations, then clear the
      // inherited field through the actual page in the new round.
      let state = (await read()).snapshot.steps['step-0'];
      await f.artifacts.execute({ action: 'save', projectId: d.projectId, roundId: d.roundId,
        requestId: randomUUID(), stepId: 'step-0', expectedVersion: state.version, body: 'Owner confirmed positioning for recovery test', evidenceIds: [] });
      state = (await read()).snapshot.steps['step-0'];
      await f.service.information({ draftId: d.draftId, stepId: 'step-0', requestId: randomUUID(), expectedVersion: state.version,
        values: { goal: { status: 'confirmed', nature: 'decision', value: reply } } });
      state = (await read()).snapshot.steps['step-0'];
      await f.artifacts.execute({ action: 'confirm', projectId: d.projectId, roundId: d.roundId, requestId: randomUUID(),
        stepId: 'step-0', expectedVersion: state.version, expectedReviewVersion: state.reviewVersion });
      state = (await read()).snapshot.steps['step-0'];
      await f.artifacts.execute({ action: 'publish', projectId: d.projectId, roundId: d.roundId, requestId: randomUUID(),
        expectedSteps: { 'step-0': { version: state.version, reviewVersion: state.reviewVersion } } });
      await f.service.revise(d.draftId, randomUUID(), d.roundId);
      await page.reload();
    }
    const field = page.getByRole('textbox', { name: title, exact: true });
    await expect.poll(() => field.inputValue(), { timeout: 30000 }).toBe(reply);
    const beforeClear = (await read()).snapshot.steps['step-0'].version;
    await field.fill('');
    await expect.poll(async () => {
      const saved = await read();
      return [saved.snapshot.steps['step-0'].version, saved.information['step-0'].values.goal.value];
    }, { timeout: 30000 }).toEqual([beforeClear + 1, '']);
    if (reviseRound) await expect.poll(async () => (await read()).turns.filter((t: { roundId: string; kind: string }) => t.roundId !== d.roundId && t.kind === 'opening').length, { timeout: 30000 }).toBe(1);
    await page.reload();
    await page.getByRole('log', { name: '完整 AI 教练消息' }).getByText(reply, { exact: true }).waitFor();
    await page.getByRole('button', { name: '工作信息', exact: true }).click();
    await page.getByRole('dialog', { name: '工作信息', exact: true }).getByRole('button', { name: '重新读取状态', exact: true }).click();
    await expect.poll(() => field.inputValue(), { timeout: 30000 }).toBe('');
    // Wait through the page's autosave interval after history hydration. This
    // would allow the old reply to silently refill and persist the field.
    await page.waitForTimeout(1500);
    const after = await read();
    expect(after.information['step-0'].values.goal.value).toBe('');
    expect(after.snapshot.steps['step-0'].version).toBe(beforeClear + 1);
    expect((await planIdentityRows(f.actor)).filter(row => oldIdentity.includes(row))).toEqual(oldIdentity);
    if (!reviseRound) expect(await planIdentityRows(f.actor)).toEqual(oldIdentity);
    expect(after.turns.find((t: { kind: string }) =>
      ["mentor", "organizer"].includes(t.kind))?.informationVersion).toBe(0);
    const { readFile } = await import('node:fs/promises');
    await sql.query(await readFile(new URL('../../../../db/migrations/0116_opc_mentor_projection_basis.sql', import.meta.url), 'utf8'));
    expect((await read()).turns).toEqual(after.turns);
    const other = await fixture(1);
    await expect(other.service.read(d.draftId)).rejects.toThrow('OPC_DENIED');
  } finally { await browser.close(); }
}, 240000);

it.skipIf(process.env.V3_VERIFY_DELIVERED_PREVIEW !== 'true')("OPC: delivered preview completes the default entry and content journey after curation", async () => {
  const {writeFileSync}=await import('node:fs');
  // The delivered preview starts with the accepted six-stage Skill and a fresh
  // local identity. Older synthetic drafts are deliberately not its baseline.
  const f=await mergedPositioningFixture();
  const modelId=await planFixtureModel(f.moduleId);
  await sql.query('update modules set active=false where id<>$1',[f.moduleId]);
  const saved={credentials:{email:f.email,password:f.password},actor:f.actor,moduleId:f.moduleId,modelId};
  // This journey with #595's history polling exceeds the local IP limit; start a fresh
  // window before each phase (resetLocalIpWindow checks the disposable Redis ownership).
  const {chromium}=await import('../../../../../apps/web/node_modules/@playwright/test');
  const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
  const context=await browser.newContext();
  await context.route('**/*',route=>['127.0.0.1','localhost'].includes(new URL(route.request().url()).hostname)?route.continue():route.abort());
  const page=await context.newPage();page.setDefaultTimeout(60000);
  try {
    await page.setViewportSize({width:1600,height:900});
    await page.goto(process.env.V3_LOCAL_APP+'/login?redirect=/app');
    await page.getByPlaceholder('name@example.com').fill(saved.credentials.email);
    await page.getByPlaceholder('输入你的密码').fill(saved.credentials.password);
    await page.getByRole('button',{name:'登录',exact:true}).last().click();
    await page.waitForURL(url=>url.pathname==='/app');
    await page.getByRole('link',{name:'对话',exact:true}).click();
    await page.waitForURL(url=>url.pathname==='/app/positioning');
    await page.getByRole('heading',{name:'今天，想推进什么？',exact:true}).waitFor();
    await expect.poll(()=>page.getByRole('link',{name:'搜索',exact:true}).count()).toBe(1);
    await expect.poll(()=>page.getByRole('searchbox',{name:'查找账号或工作'}).count()).toBe(0);
    await expect.poll(()=>page.locator('nav[aria-label="工作区功能"] img').evaluateAll(images=>images.length===5&&images.every(image=>image instanceof HTMLImageElement&&image.complete&&image.naturalWidth>0))).toBe(true);
    await expect.poll(()=>page.locator('section[class*="discovery"] [class*="discoverGrid"] > *').count()).toBe(8);
    await page.evaluate(()=>document.fonts.ready);
    await page.screenshot({path:process.env.V3_WORKBENCH_OUTPUT+'/delivered-start-1600x900.png'});
    await page.setViewportSize({width:390,height:844});
    await page.getByRole('button',{name:'打开导航'}).first().click();
    await expect.poll(()=>page.locator('aside[aria-label="工作区导航"]').evaluate(element=>{const bounds=element.getBoundingClientRect();return [bounds.x,bounds.y,bounds.width,bounds.height].map(Math.round).join(',');})).toBe('0,96,272,748');
    await page.screenshot({path:process.env.V3_WORKBENCH_OUTPUT+'/delivered-mobile-nav-390x844.png'});
    await page.getByRole('button',{name:'关闭导航'}).click();
    await page.setViewportSize({width:1600,height:900});
    await page.getByRole('button',{name:'梳理账号定位',exact:true}).first().click();
    await page.screenshot({path:process.env.V3_WORKBENCH_OUTPUT+'/delivered-positioning-choice-1600x900.png'});
    await page.getByRole('dialog',{name:'梳理账号定位'}).getByRole('button',{name:'从头分析新定位'}).click();
    expect(await page.getByRole('combobox',{name:'定位方法'}).count()).toBe(0);
    expect(await page.getByRole('combobox',{name:'所属业务'}).count()).toBe(0);
    // The choice itself starts the mentor draft; there is no business-name form.
    await page.waitForURL(url=>/^\/app\/positioning\/[0-9a-f-]+$/.test(url.pathname));
    const mentorUrl=page.url();
    const draftId=page.url().split('/app/positioning/')[1]?.split('?')[0]??'';
    const steps=page.getByRole('navigation',{name:'定位步骤'}).getByRole('button');
    await expect.poll(()=>steps.count()).toBe(6);
    expect((await steps.allTextContents()).join(' ')).toContain('商业规划');
    await page.getByRole('textbox',{name:'给 AI 教练的回复',exact:true}).fill('我帮助初学摄影的创作者，通过每周一次手机拍摄练习建立作品集。');
    await page.getByRole('button',{name:'发送',exact:true}).click();
    await expect.poll(()=>page.getByRole('textbox',{name:'产品与服务',exact:true}).inputValue(),{timeout:60000}).toContain('摄影');
    await page.reload();
    await expect.poll(()=>page.getByRole('textbox',{name:'产品与服务',exact:true}).inputValue(),{timeout:60000}).toContain('摄影');
    const answers:[string,string][]=[
      ['准备经营的平台','先做公众号和小红书，公众号解释判断，小红书展示练习。'],
      ['每周可用时间','每周稳定投入 3 小时。'],
      ['参考研究结论','借鉴同场景前后对照的讲解方式，不以器材评测为主。'],
      ['优先服务的用户','会操作相机，但不知道如何整理画面的摄影新手。'],
      ['价值与依据','曾带学员在同一街景中移动机位，用前后两张照片解释背景干扰。'],
      ['内容表达与平台安排','公众号解释判断；小红书提供练习清单。'],
      ['可持续的制作安排','每周先完成一个核心案例，再按时间选择平台版本。'],
      ['内容如何支持业务','先帮助用户完成一次构图练习，再说明课程的系统训练。'],
    ];
    const confirm=page.getByRole('button',{name:'确认当前信息，继续',exact:true});
    for(const [label,value] of answers){
      await resetLocalIpWindow();
      await confirm.click();
      await page.getByRole('textbox',{name:label,exact:true}).fill(value);
      await page.getByText('已自动保存',{exact:true}).waitFor();
      if(label==='优先服务的用户'){
        await page.evaluate(()=>document.fonts.ready);
        await page.screenshot({path:process.env.V3_WORKBENCH_OUTPUT+'/delivered-positioning-stage3-1600x900.png'});
      }
    }
    await resetLocalIpWindow();
    await confirm.click();
    const positioningUrl=page.url();
    const confirmed=await f.service.read(draftId);
    expect(confirmed.snapshot.workflow.steps.map((step:{title:string})=>step.title)).toEqual(['需求确认','竞品研究','账号定位','内容策略','运营建议','商业规划']);
    expect(Object.values(confirmed.information).flatMap((step:any)=>Object.values(step.values??{}))).toHaveLength(9);
    await page.getByRole('button',{name:'确认正式定位',exact:true}).click();
    await page.getByRole('dialog').getByRole('button',{name:'继续生成第一周选题',exact:true}).click();
    await page.waitForURL(url=>url.pathname.endsWith('/topics'));
    // Confirming the positioning binds the topic workspace and freezes one
    // opening turn; the workspace recovers that turn on mount.
    const second=page.getByRole('heading',{name:'2. 第二个账号选题',exact:true}).locator('..');
    await second.waitFor();
    await page.screenshot({path:process.env.V3_WORKBENCH_OUTPUT+'/delivered-topics-1600x900.png'});
    await second.getByRole('button',{name:'采用这个选题',exact:true}).click();
    await second.getByRole('link',{name:'继续这条内容工作',exact:true}).waitFor();
    const adopted=await f.service.library({search:'',from:null,to:null});
    expect(adopted.businesses.flatMap((business:{accounts:Array<{items:Array<{title:string}>}>})=>business.accounts.flatMap(account=>account.items.map(item=>item.title)))).toEqual(['第二个账号选题']);
    await resetLocalIpWindow();
    await second.getByRole('link',{name:'继续这条内容工作',exact:true}).click();
    await page.waitForURL(url=>url.pathname==='/app/runtime');
    await page.getByLabel('消息',{exact:true}).fill('请根据这条选题给我一版文章正文建议，先不要定稿。');
    await page.getByRole('button',{name:'发送',exact:true}).click();
    const adoptDraft=page.getByRole('button',{name:'采用为当前草稿',exact:true});
    await adoptDraft.waitFor({timeout:60000});
    await adoptDraft.click();
    await page.getByRole('link',{name:'已采用为草稿 · 查看',exact:true}).waitFor();
    await page.getByLabel('文章正文').fill('先讲真实场景，再说明取景判断，最后安排一次练习。');
    await page.getByRole('status').filter({hasText:'已在服务端保存 v2'}).waitFor();
    await page.getByRole('button',{name:'确认定稿文章',exact:true}).click();
    await expect.poll(async()=>({statuses:await page.getByRole('status').allTextContents(),alerts:await page.getByRole('alert').allTextContents(),version:await page.locator('[class*=version]').allTextContents()}),{timeout:60000}).toMatchObject({statuses:expect.arrayContaining([expect.stringContaining('已定稿')])});
    const contentUrl=page.url();
    await page.screenshot({path:process.env.V3_WORKBENCH_OUTPUT+'/delivered-content-1600x900.png'});
    await page.getByRole('link',{name:'资料库',exact:true}).click();
    await page.waitForURL(url=>url.pathname==='/app/library');
    await page.screenshot({path:process.env.V3_WORKBENCH_OUTPUT+'/delivered-library-1600x900.png'});
    await page.getByRole('main').locator('section').filter({has:page.getByRole('heading',{name:'定位概览'})}).getByRole('button',{name:/proposed-account/}).click();
    const positioningDetail=page.getByRole('dialog',{name:'定位详情'});
    await expect.poll(()=>positioningDetail.locator('details').count()).toBe(6);
    for(const title of ['需求确认','竞品研究','账号定位','内容策略','运营建议','商业规划'])
      await expect.poll(()=>positioningDetail.locator('summary',{hasText:title}).count()).toBe(1);
    await positioningDetail.getByRole('button',{name:'修改定位',exact:true}).click();
    await expect.poll(()=>positioningDetail.getByRole('textbox').count()).toBe(9);
    await positioningDetail.getByRole('button',{name:'关闭定位详情'}).click();
    await page.getByRole('main').getByRole('button',{name:/第二个账号选题/}).first().click();
    await page.getByText('先讲真实场景，再说明取景判断，最后安排一次练习。').waitFor();
    await page.getByRole('button',{name:'关闭窗口',exact:true}).click();
    await page.getByRole('link',{name:'返回当前工作',exact:true}).last().click();
    await page.waitForURL(url=>url.pathname==='/app/runtime');
    // The page consumes the one-shot continue marker after it loads; compare once it is gone.
    await expect.poll(()=>page.url(),{timeout:60000}).toBe(contentUrl);
    await page.reload();
    await page.getByLabel('文章正文').waitFor();
    await page.screenshot({path:process.env.V3_WORKBENCH_OUTPUT+'/default-content-journey.png',fullPage:true});
    writeFileSync(process.env.V3_WORKBENCH_OUTPUT+'/opc-acceptance.json',JSON.stringify({
      url:process.env.V3_LOCAL_APP+'/app/positioning',actor:f.actor,credentials:saved.credentials,
      sessionId:new URL(contentUrl).searchParams.get('session'),moduleId:f.moduleId,modelId,
      mode:'Approved six-stage synthetic Skill; no real model, research, payment or external account creation',
    }),{mode:0o600});
    writeFileSync(process.env.V3_WORKBENCH_OUTPUT+'/default-journey.json',JSON.stringify({mentorUrl,positioningUrl,contentUrl,entry:process.env.V3_LOCAL_APP+'/app/positioning',mode:'synthetic only; all journey mutations through visible default UI'},null,2));
  }finally{await browser.close();}
},360000);

it("OPC: entry projection stays actor-owned and repeatable without granting table access", async()=>{
  const a=await publishedDraft(),b=await publishedDraft();
  const before=await a.service.list();
  expect(before.drafts.map((d:{draftId:string})=>d.draftId)).toContain(a.d.draftId);
  expect(before.drafts.map((d:{draftId:string})=>d.draftId)).not.toContain(b.d.draftId);
  expect(before.drafts.find((d:{draftId:string})=>d.draftId===a.d.draftId)).toMatchObject({state:'published',currentVersion:1});
  const {readFileSync}=await import('node:fs');
  await sql.query(readFileSync('../../packages/db/migrations/0120_opc_entry_projection.sql','utf8'));
  expect(await a.service.list()).toEqual(before);
  const privileges=(await sql.query("select has_function_privilege('authenticated','opc_query(uuid,uuid)','execute') client,has_table_privilege('service_role','opc_businesses','select') business_table,has_function_privilege('service_role','opc_query_before_entry_projection(uuid,uuid)','execute') predecessor")).rows[0];
  expect(privileges).toEqual({client:false,business_table:false,predecessor:false});
},60000);

// These two read the runner's capacity transport sample, which exists only in a
// disposable run whose case pattern names CAPACITY (V3_CAPACITY_CAPTURE).
it.skipIf(process.env.NODE_ENV === 'production')('OPC: Agent-first U1 sample preserves target, partial adoption, document edits and a narrow-screen return',async()=>{
 const f=await publishedDraft();
 const {browser,page}=await planBrowser(f);
 try{
  await page.setViewportSize({width:1440,height:1000});
  await page.goto(process.env.V3_LOCAL_APP+'/app/workbench/agent-first-preview');
  await page.getByRole('heading',{name:'正在做：本周选题',exact:true}).waitFor();
  await page.getByRole('link',{name:'首页',exact:true}).waitFor();
  await page.getByText('交互样片：操作仅保存在本机浏览器，不调用模型、不写入正式资料。',{exact:true}).waitFor();

  // Previewing material does not silently change the operation target.
  await page.getByRole('button',{name:'新手最常见的三种构图误区',exact:true}).click();
  await page.getByRole('heading',{name:'正在做：本周选题',exact:true}).waitFor();
  await page.getByText(/仅查看，操作目标未改变/).waitFor();

  const article=page.getByRole('article').filter({hasText:'新手最常见的三种构图误区'});
  await article.getByRole('button',{name:'继续这条',exact:true}).click();
  await page.getByRole('heading',{name:'正在做：新手最常见的三种构图误区',exact:true}).waitFor();
  await page.getByLabel('文章正文').fill('这是用户在原处修改并保存的文章样片。');
  await page.getByRole('button',{name:'保存修改',exact:true}).click();
  await page.getByRole('heading',{name:'文章草稿 · 第 2 版',exact:true}).waitFor();

  // A result reads the latest view state when it arrives, rather than the view at send time.
  const documentPanel=page.getByRole('complementary',{name:'当前资料文档'});
  await page.getByLabel('消息').fill('请给我一版修改稿');
  await page.getByRole('button',{name:'发送',exact:true}).click();
  await page.getByText('Agent 正在整理…',{exact:true}).waitFor();
  await documentPanel.getByRole('button',{name:'关闭当前资料',exact:true}).click();
  await page.getByText('Agent 正在整理…',{exact:true}).waitFor({state:'hidden'});
  await page.getByRole('button',{name:'当前资料',exact:true}).click();
  await documentPanel.getByText('新草稿已到达。当前视图受保护，点击查看新版本。',{exact:true}).click();

  await page.getByLabel('消息').fill('再给我一版修改稿');
  await page.getByRole('button',{name:'发送',exact:true}).click();
  await documentPanel.getByText('版本',{exact:true}).click();
  await documentPanel.getByRole('button',{name:'历史草稿 · v1',exact:true}).click();
  await documentPanel.getByText('新草稿已到达。当前视图受保护，点击查看新版本。',{exact:true}).waitFor();
  await documentPanel.getByRole('heading',{name:'文章草稿 · 第 1 版',exact:true}).waitFor();
  await documentPanel.getByText('新草稿已到达。当前视图受保护，点击查看新版本。',{exact:true}).click();

  await page.getByLabel('文章正文').fill('这是尚未保存、不能被迟到结果覆盖的修改。');
  await page.getByLabel('消息').fill('请继续修改');
  await page.getByRole('button',{name:'发送',exact:true}).click();
  await documentPanel.getByText('新草稿已到达。当前视图受保护，点击查看新版本。',{exact:true}).waitFor();
  expect(await page.getByLabel('文章正文').inputValue()).toBe('这是尚未保存、不能被迟到结果覆盖的修改。');

  await page.getByRole('button',{name:'采用所选 1 条',exact:true}).click();
  await page.getByText('已采用 2 条 · 草稿 1 条',{exact:true}).waitFor();
  await page.getByText('所选内容已保存，剩余草稿仍可继续讨论。',{exact:true}).waitFor();
  await page.getByRole('button',{name:/查看剩余草稿/}).click();
  await page.getByRole('button',{name:'新手最常见的三种构图误区',exact:true}).waitFor();

  const video=page.getByRole('article').filter({hasText:'一次实拍：把杂乱画面整理清楚'});
  await video.getByRole('button',{name:'继续这条',exact:true}).click();
  await documentPanel.getByRole('button',{name:'暂时结束',exact:true}).click();
  await page.reload();
  await page.getByText('本次视频工作已暂时结束',{exact:true}).first().waitFor();
  await page.getByLabel('工作方法').selectOption('案例叙事方法');
  await page.getByRole('heading',{name:'正在做：一次实拍：把杂乱画面整理清楚',exact:true}).waitFor();

  // Narrow screens use a dismissible document sheet and return to the same composer.
  await page.setViewportSize({width:390,height:844});
  await page.getByRole('button',{name:'当前资料',exact:true}).click();
  const sheet=page.getByRole('dialog');
  await sheet.getByRole('heading',{name:'一次实拍：把杂乱画面整理清楚',exact:true}).waitFor();
  await sheet.getByRole('button',{name:'关闭当前资料',exact:true}).click();
  await page.getByLabel('消息').waitFor();

  await page.getByRole('button',{name:'定位入口',exact:true}).click();
  await page.getByRole('heading',{name:'从同一个 Agent 工作区开始',exact:true}).waitFor();
  await page.getByRole('button',{name:/我是新手/}).click();
  await page.getByRole('button',{name:'定位入口',exact:true}).click();
  await page.getByText('当前入口：新手引导',{exact:true}).waitFor();
 }finally{await browser.close();}
},180000);

it("OPC: library finalization closes only on success and account discussion switches ownership",async()=>{
 const f=await publishedDraft();
 const rows=['ux-account-a','ux-account-b'].map((account,index)=>({id:randomUUID(),platform:'x',account,title:'选题方向 '+index,brief:'讨论方向简报',day:'2026-09-25',contentType:'article' as const}));
 const plan=await f.service.savePlan({draftId:f.d.draftId,requestId:randomUUID(),expectedVersion:0,sourceVersionId:f.sourceVersionId,body:rows});
 const works=await f.service.handoff({draftId:f.d.draftId,requestId:randomUUID(),planId:plan.planId,accounts:rows.map(row=>({platform:row.platform,account:row.account,expectedRevision:null}))});
 const work=works[0];
 await f.service.contentManualSave({workItemId:work.workItemId,requestId:randomUUID(),expectedVersion:0,sourceContentId:null,kind:'brief',status:'draft',title:'独立正文标题',body:'需要定稿的正文'});
 const {browser,page}=await planBrowser(f);
 try{
  await page.goto(process.env.V3_LOCAL_APP+'/app');
  expect(await page.getByRole('link',{name:'继续上次工作',exact:true}).count()).toBe(0);
  await page.goto(process.env.V3_LOCAL_APP+'/app/library');
  const rail=page.getByRole('complementary',{name:'工作区导航'});
  const thread=rail.getByRole('link',{name:/选题方向 0/});
  await thread.waitFor();
  const font=await thread.locator('span').evaluate(el=>getComputedStyle(el).fontSize);
  const strategy=rail.getByRole('button',{name:/定位策略 当前/}).first();
  expect(await strategy.evaluate(el=>getComputedStyle(el).fontSize)).toBe(font);
  await thread.hover();
  await rail.getByRole('button',{name:'选题方向 0的更多操作',exact:true}).click();
  await rail.getByRole('menuitem',{name:'重命名',exact:true}).click();
  const rename=page.getByLabel('重命名对话',{exact:true});
  expect(await rename.evaluate(el=>getComputedStyle(el).fontSize)).toBe(font);
  await rename.fill('改名后的选题方向');await rename.press('Enter');
  await rail.getByRole('link',{name:/改名后的选题方向/}).waitFor();
  const card=page.locator('#item-'+work.workItemId);
  await card.getByRole('button').first().click();
  await card.getByRole('button',{name:'编辑稿件',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'选题详情',exact:true});
  expect(await dialog.getByLabel('稿件标题',{exact:true}).inputValue()).toBe('独立正文标题');
  await dialog.getByRole('button',{name:/选题方向/}).filter({hasText:'改名后的选题方向'}).waitFor();
  await page.route('**/api/trpc/opc.saveContentManual*',route=>route.abort());
  await dialog.getByRole('button',{name:'确认定稿文章',exact:true}).click();
  await dialog.getByRole('alert').filter({hasText:'保存结果待核实'}).waitFor();
  expect(await dialog.isVisible()).toBe(true);
  await page.unroute('**/api/trpc/opc.saveContentManual*');
  await dialog.getByRole('button',{name:'恢复草稿同步',exact:true}).click();
  await dialog.waitFor({state:'hidden'});
  await page.getByText('正文稿件已定稿',{exact:true}).waitFor();
  await card.getByRole('button').first().click();
  await card.getByRole('button',{name:'编辑稿件',exact:true}).click();
  await dialog.getByRole('button',{name:'确认定稿文章',exact:true}).click();
  await dialog.waitFor({state:'hidden'});
  expect((await sql.query('select count(*)::int n from opc_content_versions where work_item_id=$1',[work.workItemId])).rows[0].n).toBe(2);
  // A delayed final response must not discard edits opened after submission.
  await card.getByRole('button').first().click();
  await card.getByRole('button',{name:'编辑稿件',exact:true}).click();
  await dialog.getByLabel('文章正文',{exact:true}).fill('提交定稿的正文');
  let release!:()=>void,arrived!:()=>void;
  let held=new Promise<void>(resolve=>{release=resolve;});
  let submitted=new Promise<void>(resolve=>{arrived=resolve;});
  await page.route('**/api/trpc/opc.saveContentManual*',async route=>{arrived();await held;await route.continue();});
  await dialog.getByRole('button',{name:'确认定稿文章',exact:true}).click();await submitted;
  await dialog.getByRole('button',{name:'展开编辑',exact:true}).click();
  await page.getByLabel('展开编辑正文',{exact:true}).fill('定稿等待期间的展开输入');
  const refreshed=page.waitForResponse(response=>response.url().includes('opc.library')&&response.request().method()==='GET');
  release();
  // The foreground modal correctly hides background status from the accessibility tree.
  await dialog.getByRole('status',{includeHidden:true}).filter({hasText:'已定稿'}).waitFor();
  await (await refreshed).finished();
  await page.waitForTimeout(500); // Let onSaved's continuation run before asserting or confirming later edits.
  expect(await page.getByLabel('展开编辑正文',{exact:true}).inputValue()).toBe('定稿等待期间的展开输入');
  expect(await dialog.isVisible()).toBe(true);
  await page.unroute('**/api/trpc/opc.saveContentManual*');
  await page.getByRole('button',{name:'确认修改',exact:true}).click();
  await dialog.getByRole('alert').filter({hasText:'已有更新版本'}).waitFor();
  expect(await dialog.getByLabel('文章正文',{exact:true}).inputValue()).toBe('定稿等待期间的展开输入');
  await dialog.getByRole('button',{name:/已比较历史，基于服务端/}).click();
  await dialog.getByRole('status').filter({hasText:/已在服务端保存.*草稿/}).waitFor();
  await dialog.getByRole('button',{name:'← 返回详情',exact:true}).click();
  held=new Promise<void>(resolve=>{release=resolve;});submitted=new Promise<void>(resolve=>{arrived=resolve;});
  await page.route('**/api/trpc/opc.saveContentManual*',async route=>{arrived();await held;await route.continue();});
  await dialog.getByRole('button',{name:'确认定稿当前稿件',exact:true}).click();await submitted;
  await dialog.getByRole('button',{name:'编辑稿件',exact:true}).click();
  await dialog.getByRole('button',{name:'展开编辑',exact:true}).click();
  await page.getByLabel('展开编辑正文',{exact:true}).fill('从详情定稿之后开始的输入');
  release();
  await page.getByText('正文稿件已定稿，后续编辑已保留',{exact:true}).waitFor();
  expect(await page.getByLabel('展开编辑正文',{exact:true}).inputValue()).toBe('从详情定稿之后开始的输入');
  expect(await dialog.isVisible()).toBe(true);
  await page.unroute('**/api/trpc/opc.saveContentManual*');
  await page.getByRole('button',{name:'取消',exact:true}).click();
  await dialog.getByRole('button',{name:'关闭窗口',exact:true}).click();
  const destinations:string[]=[];
  for(const name of ['ux-account-a','ux-account-b','ux-account-a']){
   const account=rail.locator('details').filter({has:page.locator('summary').filter({hasText:name})}).last();
   await account.getByRole('button',{name:/定位策略 当前/}).click();
   const strategyDialog=page.getByRole('dialog',{name:'定位详情',exact:true});
   await strategyDialog.getByRole('button',{name:'回到策略讨论',exact:true}).click();
   await strategyDialog.waitFor({state:'hidden'});
   await page.getByRole('heading',{name:name+' · 定位策略',exact:true}).waitFor();
   destinations.push(new URL(page.url()).pathname);
   if(name==='ux-account-a'&&destinations.length===1)await page.getByLabel('给 AI 教练的回复',{exact:true}).fill('只属于账号 A 的未发送消息');
  }
  expect(destinations[0]).not.toBe(destinations[1]);expect(destinations[2]).toBe(destinations[0]);
  expect(await page.getByLabel('给 AI 教练的回复',{exact:true}).textContent()).toBe('只属于账号 A 的未发送消息');
  const accounts=(await f.service.library({search:'',from:null,to:null})).businesses[0].accounts;
  expect(accounts.every((account:{sourceVersionId:string})=>account.sourceVersionId===f.sourceVersionId)).toBe(true);
 }finally{await browser.close();}
},240000);

it('OPC: positioning entry creates a new business or edits only the selected existing account',async()=>{
 const f=await publishedDraft();
 await onlyOwnCatalog([f.moduleId]);
 const rows=['entry-account-a','entry-account-b'].map(account=>({id:randomUUID(),platform:'x',account,title:account+'选题',brief:'保留的选题来源',day:'2026-09-25'}));
 const plan=await f.service.savePlan({draftId:f.d.draftId,requestId:randomUUID(),expectedVersion:0,sourceVersionId:f.sourceVersionId,body:rows});
 await f.service.handoff({draftId:f.d.draftId,requestId:randomUUID(),planId:plan.planId,accounts:rows.map(row=>({platform:row.platform,account:row.account,expectedRevision:null}))});
 const readAccounts=async()=>(await f.service.library({search:'',from:null,to:null})).businesses.flatMap((b:{accounts:Array<{projectId:string;account:string;sourceVersionId:string;pendingStrategyDraftId?:string|null}>})=>b.accounts);
 const before=await readAccounts(),a=before.find((x:{account:string})=>x.account==='entry-account-a')!,b=before.find((x:{account:string})=>x.account==='entry-account-b')!;
 expect(a.sourceVersionId).toBe(f.sourceVersionId);
 expect(b.sourceVersionId).toBe(f.sourceVersionId);
 const originalBusiness=(await sql.query('select business_id::text id from opc_draft_businesses where draft_id=$1',[f.d.draftId])).rows[0].id;
 const {browser,page}=await planBrowser(f);
 try{
  await page.goto(process.env.V3_LOCAL_APP+'/app/positioning');
  await page.getByRole('button',{name:'梳理账号定位',exact:true}).first().click();
  await page.getByRole('dialog',{name:'梳理账号定位',exact:true}).getByRole('button',{name:'从头分析新定位',exact:true}).click();
  expect(await page.getByRole('combobox').count()).toBe(0);
  expect(await page.getByLabel('业务名称',{exact:true}).count()).toBe(0);
  expect(await page.getByRole('button',{name:'开始 Agent 引导',exact:true}).count()).toBe(0);
  await page.waitForURL(url=>/^\/app\/positioning\/[0-9a-f-]+$/.test(url.pathname));
  const createdDraft=new URL(page.url()).pathname.split('/').at(-1)!;
  expect(createdDraft).not.toBe(f.d.draftId);
  const created=(await sql.query('select b.id,b.name from opc_draft_businesses d join opc_businesses b on b.id=d.business_id where d.draft_id=$1',[createdDraft])).rows[0];
  expect(created.name).toBe('未命名业务');expect(created.id).not.toBe(originalBusiness);
  expect(await readAccounts()).toEqual(before);
  await page.goto(process.env.V3_LOCAL_APP+'/app/positioning');
  const draftCount=Number((await sql.query('select count(*)::int n from opc_drafts where actor_id=$1',[f.actor])).rows[0].n);
  await page.getByRole('button',{name:'梳理账号定位',exact:true}).first().click();
  // R15: 我已有定位 starts a manual draft in the Agent workspace instead of sending the user to the library.
  await page.getByRole('dialog',{name:'梳理账号定位',exact:true}).getByRole('button',{name:'我已有定位',exact:true}).click();
  expect(await page.getByLabel('业务名称',{exact:true}).count()).toBe(0);
  expect(await page.getByLabel('定位方法',{exact:true}).count()).toBe(0);
  await page.waitForURL(url=>/^\/app\/positioning\/[0-9a-f-]+$/.test(url.pathname));
  const existingDraft=new URL(page.url()).pathname.split('/').at(-1)!;
  expect((await sql.query('select mode from opc_drafts where draft_id=$1',[existingDraft])).rows[0].mode).toBe('manual');
  const afterExisting=Number((await sql.query('select count(*)::int n from opc_drafts where actor_id=$1',[f.actor])).rows[0].n);
  expect(afterExisting).toBe(draftCount+1);
  await page.goto(process.env.V3_LOCAL_APP+'/app/library');
  expect(await page.getByRole('combobox',{name:'已有定位',exact:true}).count()).toBe(0);
  expect(Number((await sql.query('select count(*)::int n from opc_drafts where actor_id=$1',[f.actor])).rows[0].n)).toBe(afterExisting);
  expect(await readAccounts()).toEqual(before);
  await page.getByRole('navigation',{name:'资料库平台与账号'}).getByRole('button',{name:/^entry-account-a/}).click();
  await page.getByRole('button',{name:'修改定位',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'定位详情',exact:true});
  await dialog.getByRole('button',{name:'修改定位',exact:true}).click();
  await dialog.getByRole('heading',{name:'修改定位',exact:true}).waitFor();
  expect(Number((await sql.query('select count(*)::int n from opc_drafts where actor_id=$1',[f.actor])).rows[0].n)).toBe(afterExisting);
  await dialog.locator('textarea').first().fill('只修订账号A的定位');
  await dialog.getByRole('button',{name:'确认保存',exact:true}).click();
  await dialog.getByRole('status').filter({hasText:'已保存到此账号的待确认定位草稿'}).waitFor();
  const after=await readAccounts(),updated=after.find((x:{projectId:string})=>x.projectId===a.projectId)!;
  expect(after.find((x:{projectId:string})=>x.projectId===b.projectId)).toEqual(b);
  expect(updated.sourceVersionId).toBe(a.sourceVersionId);
  expect(updated.pendingStrategyDraftId).toBeTruthy();
  const changed=await f.service.read(updated.pendingStrategyDraftId!);
  expect(changed.information['step-0'].values.goal.value).toBe('只修订账号A的定位');
  await dialog.getByRole('button',{name:'关闭定位详情',exact:true}).click();
  const savedAccounts=await readAccounts();
  const savedCounts=(await sql.query('select (select count(*)::int from opc_drafts where actor_id=$1) drafts,(select count(*)::int from opc_businesses where actor_id=$1) businesses',[f.actor])).rows[0];
  await page.getByRole('button',{name:'修改定位',exact:true}).click();
  await dialog.getByRole('button',{name:'修改定位',exact:true}).click();
  await dialog.getByRole('heading',{name:'修改定位',exact:true}).waitFor();
  expect(await dialog.locator('textarea').first().inputValue()).toBe('只修订账号A的定位');
  await dialog.locator('textarea').first().fill('取消时不得保存');
  await dialog.getByRole('button',{name:'取消',exact:true}).click();
  expect(await readAccounts()).toEqual(savedAccounts);
  expect((await sql.query('select (select count(*)::int from opc_drafts where actor_id=$1) drafts,(select count(*)::int from opc_businesses where actor_id=$1) businesses',[f.actor])).rows[0]).toEqual(savedCounts);
  expect((await f.service.read(updated.pendingStrategyDraftId!)).information['step-0'].values.goal.value).toBe('只修订账号A的定位');
 }finally{await browser.close();}
},180000);

it('OPC: boundary browser freezes expanded edits across a delayed real adoption and concurrent saves',async()=>{
 const f=await publishedDraft();
 await onlyOwnCatalog([f.moduleId]);await planFixtureModel(f.moduleId);
 const plan=await f.service.savePlan({draftId:f.d.draftId,requestId:randomUUID(),expectedVersion:0,sourceVersionId:f.sourceVersionId,body:[{id:randomUUID(),platform:'x',account:'boundary-article',title:'边界文章',brief:'讨论后采用',day:'2026-09-25',contentType:'article'}]});
 const [work]=await f.service.handoff({draftId:f.d.draftId,requestId:randomUUID(),planId:plan.planId,accounts:[{platform:'x',account:'boundary-article',expectedRevision:null}]});
 const {browser,page}=await planBrowser(f);page.setDefaultTimeout(30000);
 let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});let adopted=false;
 page.on('response',async response=>{if(response.url().includes('opc.saveContentManual')){console.info('BOUNDARY_EDITOR_SAVE',response.status(),await response.text());}});
 const rows=async()=>(await sql.query("select id,version,body,source_content_id from opc_content_versions where work_item_id=$1 and kind='brief' order by version",[work.workItemId])).rows;
 try{
  await page.goto(process.env.V3_LOCAL_APP+'/app/runtime?session='+work.sessionId);
  await page.getByLabel('消息',{exact:true}).fill('请给我第一版正文。');await page.getByRole('button',{name:'发送',exact:true}).click();
  await page.getByRole('button',{name:'采用为当前草稿',exact:true}).waitFor({timeout:60000});
  await page.route('**/api/trpc/opc.saveContentResult*',async route=>{const response=await route.fetch();expect(response.ok()).toBe(true);adopted=true;await held;await route.fulfill({response});});
  await page.getByRole('button',{name:'采用为当前草稿',exact:true}).click();
  await expect.poll(()=>adopted).toBe(true);expect(await rows()).toHaveLength(1);
  await page.getByRole('button',{name:'展开编辑',exact:true}).click();
  await page.getByLabel('展开编辑标题',{exact:true}).fill('我的展开标题');await page.getByLabel('展开编辑正文',{exact:true}).fill('响应到达前写下的正文');
  release();await page.getByText('账号已保存 v1 · 草稿',{exact:true}).waitFor();
  expect(await page.getByLabel('展开编辑正文',{exact:true}).inputValue()).toBe('响应到达前写下的正文');
  await page.getByRole('button',{name:'确认修改',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'已有更新版本'}).waitFor();
  expect(await rows()).toHaveLength(1);expect(await page.getByLabel('文章正文',{exact:true}).inputValue()).toBe('响应到达前写下的正文');
  const savedDraft=await page.evaluate(key=>JSON.parse(localStorage.getItem(key)!),`opc-content-draft:${work.workItemId}:brief`);
  expect(savedDraft).toMatchObject({baseVersion:0,sourceContentId:null,title:'我的展开标题',body:'响应到达前写下的正文'});
  await page.screenshot({path:process.env.V3_WORKBENCH_OUTPUT+'/boundary-adoption-conflict.png'});
  const {writeFileSync}=await import('node:fs');
  writeFileSync(process.env.V3_WORKBENCH_OUTPUT+'/boundary-adoption.json',JSON.stringify({transport:'real local adoption response held after route.fetch',savedDraft,versions:await rows()}));
  await page.getByRole('button',{name:/已比较历史，基于服务端 v1/}).click();
  await expect.poll(async()=>(await rows()).length,{timeout:30000}).toBe(2);
  await page.getByText('账号已保存 v2 · 草稿',{exact:true}).waitFor();
  await page.getByRole('button',{name:'展开编辑',exact:true}).click();await page.getByLabel('展开编辑正文',{exact:true}).fill('取消的正文');await page.getByRole('button',{name:'取消',exact:true}).click();
  expect(await page.getByLabel('文章正文',{exact:true}).inputValue()).toBe('响应到达前写下的正文');
  await page.getByRole('button',{name:'展开编辑',exact:true}).click();await page.getByLabel('展开编辑正文',{exact:true}).fill('普通保存正文');await page.getByRole('button',{name:'确认修改',exact:true}).click();
  await page.getByText('账号已保存 v3 · 草稿',{exact:true}).waitFor();
  const latest=(await rows()).at(-1);
  await page.getByRole('button',{name:'展开编辑',exact:true}).click();await page.getByLabel('展开编辑正文',{exact:true}).fill('并发情况下保留的正文');
  console.info('BOUNDARY_EDITOR_STAGE','concurrent service save starting');
  await f.service.contentManualSave({workItemId:work.workItemId,requestId:randomUUID(),expectedVersion:3,sourceContentId:latest.id,kind:'brief',status:'draft',title:'其他标签',body:'并发服务端正文'});console.info('BOUNDARY_EDITOR_STAGE','concurrent v4 saved');
  await page.getByRole('button',{name:'确认修改',exact:true}).click();console.info('BOUNDARY_EDITOR_STAGE','concurrent confirm clicked');await page.getByRole('alert').filter({hasText:'已有更新版本'}).waitFor();console.info('BOUNDARY_EDITOR_STAGE','concurrent alert visible');
  expect(await rows()).toHaveLength(4);expect(await page.getByLabel('文章正文',{exact:true}).inputValue()).toBe('并发情况下保留的正文');
  console.info('BOUNDARY_EDITOR_STAGE','final assertions passed');
  writeFileSync(process.env.V3_WORKBENCH_OUTPUT+'/boundary-editor-completed.json',JSON.stringify({passed:['delayed real adoption conflict','explicit rebase','cancel preserves input','ordinary save','concurrent conflict preserves input'],versions:await rows(),retainedInput:await page.getByLabel('文章正文',{exact:true}).inputValue()}));
 }catch(error){
  const {writeFileSync}=await import('node:fs');
  writeFileSync(process.env.V3_WORKBENCH_OUTPUT+'/boundary-editor-failure.json',JSON.stringify({error:String(error),body:await page.locator('body').innerText(),versions:await rows()}));
  await page.screenshot({path:process.env.V3_WORKBENCH_OUTPUT+'/boundary-editor-failure.png'});
  throw error;
 }finally{release();console.info('BOUNDARY_EDITOR_STAGE','browser closing');await browser.close();console.info('BOUNDARY_EDITOR_STAGE','browser closed');}
},180000);

it("OPC: business context migration retains legacy material hashes and private helper privileges", async () => {
  const { readFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const previous = readFileSync(resolve(process.cwd(), "../../packages/db/migrations/0107_opc_workbench.sql"), "utf8");
  const next = readFileSync(resolve(process.cwd(), "../../packages/db/migrations/0139_opc_business_context.sql"), "utf8");
  const functionText = (text: string) => text.match(/CREATE OR REPLACE FUNCTION runtime_work_projection\([\s\S]*?END \$\$;/)![0];
  const f = await fixture(2);
  const draft = await f.service.start({ requestId: randomUUID(), registration: f.registration, mode: "mentor", businessName: "Legacy business" });
  // Transaction-local DDL only, invisible to the browser/REST connection. Make
  // the old material through the actual old projection, then validate it with
  // the new projection and original immutable row hash.
  let legacyBefore: unknown;
  await sql.query("BEGIN");
  try {
    await sql.query(functionText(previous));
    await sql.query("select opc_step_material($1,$2,$3,'step-0','mentor','legacy retained input')", [f.actor, draft.draftId, randomUUID()]);
    const before = (await sql.query("select content,content_hash from runtime_scope_material where session_id=$1", [draft.sessionId])).rows[0];
    expect(before.content.work.businessContext).toBeUndefined();
    const material = (await sql.query("select runtime_session_context($1,$2) as context", [f.actor, draft.sessionId])).rows[0].context.scopeMaterial;
    await sql.query(functionText(next));
    await sql.query("select runtime_material_allowed($1,$2)", [f.actor, material]);
    expect((await sql.query("select content,content_hash from runtime_scope_material where session_id=$1", [draft.sessionId])).rows[0]).toEqual(before);
    legacyBefore = before;
    await sql.query("COMMIT");
  } catch (error) { await sql.query("ROLLBACK"); throw error; }
  await sql.query(next);
  await sql.query(next);
  expect((await sql.query("select content,content_hash from runtime_scope_material where session_id=$1", [draft.sessionId])).rows[0]).toEqual(legacyBefore);
  const permissions = (await sql.query("select role, has_function_privilege(role,'opc_business_context(uuid,uuid,uuid)','EXECUTE') as allowed from unnest(array['anon','authenticated','service_role']) role")).rows;
  expect(permissions.every(row => row.allowed === false)).toBe(true);
});

// Shared disposable-harness helpers; importing this file registers its cases,
// which the runner's exact case pattern still filters before execution.
export { mergedPositioningFixture, planBrowser, planFixtureModel, sql, admin };

vi.mock('../turn/admission/newWorkGate', async importOriginal => ({
 ...await importOriginal<typeof import('../turn/admission/newWorkGate')>(),
 ...(await import('../__tests__/fixtures/runtimeGates')).testAdmissionGates,
}));

// RATE-LIMIT front end (plan section 9, A segment), positioning page only: real website,
// PostgreSQL, BILL2, local Redis + SRH and the synthetic provider. Limits and the pause are
// written directly to system_settings, not through the admin card; A0/A2/A6 button/A10,
// A5 (/app/runtime) and A5b (topics) are not covered here (see the PR's Validation handoff).
async function runtimeHoldCase(part: 'guidance' | 'video' | 'refusal', videoCase = -1,
  refusalCase: '' | 'guidance403' | 'video412' | 'video412AbandonFails' | 'materialRefusedOnRecovery' = '') {
  const { execFileSync } = await import("node:child_process");
  const tag = process.env.V3_RATE_LIMIT_TAG;
  if (!tag || !/^[a-z0-9][a-z0-9-]{0,80}$/.test(tag)) throw new Error("local rate limit required");
  expect(execFileSync("docker", ["exec", tag + "-redis", "redis-cli", "FLUSHDB"], { encoding: "utf8" }).trim()).toBe("OK");
  const pausedNotice = "AI服务暂时暂停新调用，请稍后再试。本次被拦截的调用不扣积分。";
  const pause = (stopNewCalls: boolean) => sql.query(
    "insert into system_settings(key,value) values('runtime_rate_limits',$1::jsonb) on conflict(key) do update set value=excluded.value",
    [JSON.stringify({ version: 1, admissionPerMinute: 60, admissionPer24Hours: 5000, callsPerMinute: 180,
      callsPer24Hours: 15000, stopNewCalls })]);
  await pause(false);
  const f = await publishedDraft();
  await planFixtureModel(f.moduleId);
  // Data hygiene only (no assertion or limiter change): keep this case's own Skill visible; see onlyOwnCatalog.
  await onlyOwnCatalog([f.moduleId]);
  const seed = await f.service.savePlan({ draftId: f.d.draftId, requestId: randomUUID(), expectedVersion: 0, sourceVersionId: f.sourceVersionId,
    body: [{ id: randomUUID(), platform: 'x', account: 'existing-account', title: '原工作', brief: '原有账号项目', day: '2026-09-20' }] });
  await f.service.handoff({ draftId: f.d.draftId, requestId: randomUUID(), planId: seed.planId,
    accounts: [{ platform: 'x', account: 'existing-account', expectedRevision: null }] });
  const { browser, page } = await planBrowser(f);
  const unknown503 = JSON.stringify([{ error: { message: "internal diagnostic: upstream unavailable", code: -32603,
    data: { code: "SERVICE_UNAVAILABLE", httpStatus: 503, path: "runtime.prepare" } } }]);
  const plain503 = JSON.stringify({ error: "Service Unavailable", message: "服务暂时繁忙，请稍后再试", retryAfter: 60 });
  // Every browser prepare (guidance and package) and every material call, with the request id each carries.
  const prepares: Array<{ kind: 'guide' | 'package' | 'other'; requestId: string }> = [];
  const abandons: string[] = [];
  page.on('request', request => {
    const body = request.postData() ?? '';
    if (/\/api\/trpc\/runtime\.prepare(?:[?,]|$)/.test(request.url())) {
      const input = Object.values(JSON.parse(body || '{}'))[0] as { requestId?: string; input?: string } | undefined;
      prepares.push({ requestId: input?.requestId ?? '', kind: input?.input?.startsWith('[OPC_WORK_CONTINUE_V1]') ? 'guide'
        : input?.input?.startsWith('[OPC_VIDEO_PACKAGE_V1]') ? 'package' : 'other' });
    }
    if (request.url().includes('opc.prepareVideoMaterial') && body.includes('abandon')) abandons.push(body);
  });
  const sendsOf = (requestId: string) => prepares.filter(item => item.requestId === requestId).length;
  const executionsOf = async (requestId: string, state?: string) => Number((await sql.query(
    "select count(*)::int n from runtime_executions where actor_id=$1 and request_id::text=$2 and ($3::text is null or state=$3)",
    [f.actor, requestId, state ?? null])).rows[0].n);
  /** Credits and BILL2 runs/reservations, read once nothing runs and the values hold still across 2 seconds. */
  async function money() {
    const read = async () => (await sql.query(
      "select (select credits from profiles where id=$1)::text credits,(select count(*) from bill2_runs where actor_id=$1)::int runs," +
      "(select count(*) from credit_transactions where user_id=$1 and reason_code='bill2_reserve')::int reserves," +
      "(select count(*) from runtime_executions where actor_id=$1 and state not in ('completed','cancelled'))::int busy", [f.actor])).rows[0];
    for (let attempt = 0; attempt < 60; attempt++) {
      const first = await read();
      await page.waitForTimeout(2000);
      const second = await read();
      if (!first.busy && JSON.stringify(first) === JSON.stringify(second)) return { credits: first.credits, runs: first.runs, reserves: first.reserves };
    }
    throw new Error('credits and reservations did not settle');
  }
  type Refusal = { name: string; on: () => Promise<void>; off: () => Promise<void> };
  const fulfil = (pattern: string | RegExp, body: string): Refusal['on'] => () => page.route(pattern,
    route => route.fulfill({ status: 503, contentType: 'application/json', body }));
  const refusals: Array<Refusal & { gate: boolean }> = [
    { name: 'paused', gate: true, on: () => pause(true).then(() => undefined), off: () => pause(false).then(() => undefined) },
    { name: 'unknown structured 503', gate: false, on: fulfil('**/api/trpc/runtime.prepare*', unknown503),
      off: () => page.unroute('**/api/trpc/runtime.prepare*') },
    { name: 'plain non-tRPC 503', gate: false, on: fulfil('**/api/trpc/runtime.prepare*', plain503),
      off: () => page.unroute('**/api/trpc/runtime.prepare*') },
  ];
  try {
    await page.goto(process.env.V3_LOCAL_APP + '/app/positioning/' + f.d.draftId + '/topics');
    await page.getByRole('button', { name: '开始选题工作对话', exact: true }).click();
    const card = page.getByRole('heading', { name: '1. 首周选题', exact: true }).first().locator('..');
    await card.getByRole('button', { name: '采用这个选题', exact: true }).click({ timeout: 420000 });
    const link = card.getByRole('link', { name: '继续这条内容工作', exact: true });
    await link.waitFor({ timeout: 420000 });
    const continueUrl = new URL(await link.getAttribute('href') ?? '', process.env.V3_LOCAL_APP).toString();
    expect(new URL(continueUrl).searchParams.get('continue')).toBe('1');
    const sessionId = new URL(continueUrl).searchParams.get('session')!;
    const transcript = page.getByLabel('对话记录', { exact: true });
    const recoverGuide = page.getByRole('status', { name: '引导待重试', exact: true }).getByRole('button', { name: '重试', exact: true });
    const videoKey = 'opc-video-operation:' + sessionId;
    const finalPrompt = page.getByRole('heading', { name: '口播稿已定稿。要先制作分镜脚本吗？', exact: true });
    const scripts = async () => Number((await sql.query(
      "select count(*)::int n from runtime_executions where actor_id=$1 and session_id=$2 and state='completed' and payload->>'input' not like '[OPC_%'",
      [f.actor, sessionId])).rows[0].n);
    let script = 0;
    /** A new finalized script version: a new guidance stage, and a script without a package yet. */
    async function finalizeNewScript() {
      script += 1;
      const before = await scripts();
      await page.getByLabel('消息', { exact: true }).fill('请和我讨论这条视频的口播稿，第 ' + script + ' 版。');
      await page.getByRole('button', { name: '发送', exact: true }).click();
      await expect.poll(scripts, { timeout: 420000 }).toBe(before + 1);
      const finalize = page.getByRole('button', { name: '将这条回复定稿为口播稿', exact: true }).last();
      await finalize.waitFor({ timeout: 420000 });
      // Read the database directly: this long case outlives the fixture client's session.
      const finals = async () => Number((await sql.query(
        "select count(*)::int n from opc_content_versions where actor_id=$1 and kind='script' and status='final'", [f.actor])).rows[0].n);
      const finalsBefore = await finals();
      await finalize.click();
      await expect.poll(finals, { timeout: 420000 }).toBe(finalsBefore + 1);
      // The finalize UI refresh is not under test here, and an overloaded local stack can drop that read: reload.
      await page.reload();
      await finalPrompt.waitFor({ timeout: 420000 }).catch(async error => {
        const text = await page.locator('body').innerText();
        throw new Error('no final-script prompt; page tail: ' + text.slice(-900) + ' / ' + error);
      });
    }
    async function quietAfterReload(check: () => Promise<void>) {
      await page.reload();
      await transcript.waitFor({ timeout: 420000 });
      await page.waitForTimeout(5000);
      await check();
    }

    // P2-1: the continue-work guidance.
    for (const [index, refusal] of (part === 'guidance' ? refusals : []).entries()) {
      if (index > 0) await finalizeNewScript();
      const moneyBefore = await money();
      const sent = prepares.length;
      await refusal.on();
      await page.goto(continueUrl);
      await page.getByRole('alert').filter({ hasText: refusal.gate ? pausedNotice : '引导请求待恢复' }).waitFor({ timeout: 420000 });
      const guides = prepares.slice(sent).filter(item => item.kind === 'guide');
      expect(guides).toHaveLength(1);
      const requestId = guides[0].requestId;
      expect(new URL(page.url()).searchParams.has('continue')).toBe(false);
      await recoverGuide.waitFor({ timeout: 30000 });
      await quietAfterReload(async () => { expect(sendsOf(requestId)).toBe(1); });
      await refusal.off();
      await quietAfterReload(async () => {
        expect(sendsOf(requestId)).toBe(1);
        expect(await executionsOf(requestId)).toBe(0);
      });
      expect(await money()).toEqual(moneyBefore);
      // Test isolation only: this case's own traffic runs close to the local 60/min IP limit, which can 429 the
      // recovery's runtime.execute. This case proves a refused 503 recovers only by hand, not a natural limit
      // window, so this reset is not evidence of rate-limit recovery.
      await resetLocalIpWindow();
      await recoverGuide.click();
      await expect.poll(() => executionsOf(requestId, 'completed'), { timeout: 420000 }).toBe(1);
      expect(sendsOf(requestId)).toBe(2);
      expect(await executionsOf(requestId)).toBe(1);
    }

    // P2-2: the video package, including a shared failure of material preparation and admission.
    const both = /\/api\/trpc\/(?:runtime\.prepare|opc\.prepareVideoMaterial)(?:[?,]|$)/;
    const videoRefusals: Array<Refusal & { gate: boolean; admissionSent: boolean }> = [
      ...refusals.map(refusal => ({ ...refusal, admissionSent: true })),
      { name: 'material and admission both fail', gate: false, admissionSent: false,
        on: fulfil(both, plain503), off: () => page.unroute(both) },
    ];
    if (part === 'video') {
      // Enter the work as the user does (the guidance completes), then finalize the first script.
      await page.goto(continueUrl);
      await page.getByText('【主动引导合成示例，仅验证交互】', { exact: false }).first().waitFor({ timeout: 420000 });
    }
    // One video case per fixture: a long Session history slows every later round on a local stack.
    for (const refusal of part === 'video' ? [videoRefusals[videoCase]] : []) {
      const choice = '先做分镜，再生成剪辑建议';
      await finalizeNewScript();
      await finalPrompt.waitFor({ timeout: 420000 });
      const moneyBefore = await money();
      const sent = prepares.length;
      await refusal.on();
      await page.getByLabel('消息', { exact: true }).fill(choice);
      await page.getByRole('button', { name: '发送', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: refusal.gate ? pausedNotice : '视频工作请求状态待核实' }).waitFor({ timeout: 420000 });
      const held = JSON.parse((await page.evaluate(key => localStorage.getItem(key), videoKey))!);
      expect(held.held).toBe(true);
      expect(held.followup.executionId).toBeUndefined();
      const requestId = held.followup.requestId as string;
      const admissions = refusal.admissionSent ? 1 : 0;
      expect(prepares.slice(sent).filter(item => item.kind === 'package').map(item => item.requestId))
        .toEqual(Array(admissions).fill(requestId));
      expect(abandons).toEqual([]);
      const stillHeld = async () => {
        expect(sendsOf(requestId)).toBe(admissions);
        expect(abandons).toEqual([]);
        expect(JSON.parse((await page.evaluate(key => localStorage.getItem(key), videoKey))!)).toEqual(held);
        expect(await executionsOf(requestId)).toBe(0);
      };
      await quietAfterReload(stillHeld);
      await refusal.off();
      await quietAfterReload(stillHeld);
      expect(await money()).toEqual(moneyBefore);
      await page.getByLabel('消息', { exact: true }).fill(choice);
      await page.getByRole('button', { name: '发送', exact: true }).click();
      await expect.poll(() => page.evaluate(key => localStorage.getItem(key), videoKey), { timeout: 420000 }).toBeNull();
      expect(sendsOf(requestId)).toBe(admissions + 1);
      expect(await executionsOf(requestId, 'completed')).toBe(1);
      expect(await executionsOf(requestId)).toBe(1);
      expect(abandons).toEqual([]);
    }

    // Definite 4xx refusals before admission: the guidance drops its recovery control; a package refused by admission
    // releases its material claim (abandon) so the work can continue. Nothing else is taken as proof of release.
    const prepareRoute = /\/api\/trpc\/runtime\.prepare(?:[?,]|$)/;
    const refusal412 = JSON.stringify([{ error: { message: '本次操作所需模型尚未获准用于当前测试窗口，请联系管理员。', code: -32012,
      data: { code: 'PRECONDITION_FAILED', httpStatus: 412, path: 'runtime.prepare' } } }]);
    const refusal403 = JSON.stringify([{ error: { message: '当前环境不允许访问此工作空间。', code: -32003,
      data: { code: 'FORBIDDEN', httpStatus: 403, path: 'runtime.prepare' } } }]);
    async function ordinaryChatWorks(text: string) {
      const before = await scripts();
      await page.getByLabel('消息', { exact: true }).fill(text);
      await page.getByRole('button', { name: '发送', exact: true }).click();
      await expect.poll(scripts, { timeout: 420000 }).toBe(before + 1);
    }
    if (refusalCase === 'guidance403') {
      const moneyBefore = await money();
      const sent = prepares.length;
      await page.route(prepareRoute, route => route.fulfill({ status: 403, contentType: 'application/json', body: refusal403 }));
      await page.goto(continueUrl);
      await page.getByRole('alert').filter({ hasText: '引导请求已明确拒绝' }).waitFor({ timeout: 420000 });
      const guides = prepares.slice(sent).filter(item => item.kind === 'guide');
      expect(guides).toHaveLength(1);
      const requestId = guides[0].requestId;
      expect(new URL(page.url()).searchParams.has('continue')).toBe(false);
      await page.unroute(prepareRoute);
      await quietAfterReload(async () => {
        expect(sendsOf(requestId)).toBe(1);
        expect(await recoverGuide.count()).toBe(0);
        expect(await executionsOf(requestId)).toBe(0);
        // The refused guidance keeps its record, and the active recovery record is gone.
        const guideKey = 'opc-work-guide:' + sessionId + ':' + requestId;
        expect(JSON.parse((await page.evaluate(key => localStorage.getItem(key), guideKey + ':rejected'))!).requestId).toBe(requestId);
        expect(await page.evaluate(key => localStorage.getItem(key), guideKey)).toBeNull();
      });
      expect(await money()).toEqual(moneyBefore);
      await ordinaryChatWorks('引导被拒后继续普通对话。');
      expect(sendsOf(requestId)).toBe(1);
    }
    if (refusalCase === 'video412' || refusalCase === 'video412AbandonFails') {
      await page.goto(continueUrl);
      await page.getByText('【主动引导合成示例，仅验证交互】', { exact: false }).first().waitFor({ timeout: 420000 });
      await finalizeNewScript();
      const choice = '先做分镜，再生成剪辑建议';
      const moneyBefore = await money();
      const sent = prepares.length;
      const material = /\/api\/trpc\/opc\.prepareVideoMaterial(?:[?,]|$)/;
      await page.route(prepareRoute, route => route.fulfill({ status: 412, contentType: 'application/json', body: refusal412 }));
      if (refusalCase === 'video412AbandonFails') await page.route(material, route => (route.request().postData() ?? '').includes('abandon')
        ? route.fulfill({ status: 503, contentType: 'application/json', body: plain503 }) : route.continue());
      await page.getByLabel('消息', { exact: true }).fill(choice);
      await page.getByRole('button', { name: '发送', exact: true }).click();
      if (refusalCase === 'video412') {
        await page.getByRole('alert').filter({ hasText: '原视频工作请求已明确拒绝' }).waitFor({ timeout: 420000 });
        const packages = prepares.slice(sent).filter(item => item.kind === 'package');
        expect(packages).toHaveLength(1);
        const requestId = packages[0].requestId;
        expect(abandons).toHaveLength(1);
        expect(await page.evaluate(key => localStorage.getItem(key), videoKey)).toBeNull();
        await page.unroute(prepareRoute);
        await quietAfterReload(async () => {
          expect(sendsOf(requestId)).toBe(1);
          expect(await executionsOf(requestId)).toBe(0);
          expect(await page.evaluate(key => localStorage.getItem(key), videoKey)).toBeNull();
        });
        expect(await money()).toEqual(moneyBefore);
        // The released claim no longer blocks the work: ordinary dialogue is admitted again.
        await ordinaryChatWorks('视频包被拒后继续普通对话。');
        expect(sendsOf(requestId)).toBe(1);
      } else {
        await page.getByRole('alert').filter({ hasText: '视频工作请求状态待核实' }).waitFor({ timeout: 420000 });
        const held = JSON.parse((await page.evaluate(key => localStorage.getItem(key), videoKey))!);
        expect(held.held).toBe(true);
        const requestId = held.followup.requestId as string;
        expect(abandons).toHaveLength(1);
        await page.unroute(prepareRoute);
        await page.unroute(material);
        await quietAfterReload(async () => {
          expect(sendsOf(requestId)).toBe(1);
          expect(await executionsOf(requestId)).toBe(0);
          expect(JSON.parse((await page.evaluate(key => localStorage.getItem(key), videoKey))!)).toEqual(held);
        });
        expect(await money()).toEqual(moneyBefore);
        await page.getByLabel('消息', { exact: true }).fill(choice);
        await page.getByRole('button', { name: '发送', exact: true }).click();
        await expect.poll(() => page.evaluate(key => localStorage.getItem(key), videoKey), { timeout: 420000 }).toBeNull();
        expect(sendsOf(requestId)).toBe(2);
        expect(await executionsOf(requestId, 'completed')).toBe(1);
      }
    }
    // Review 5965199920: a held request whose material replay is refused (412, for example "sign in again") still
    // owns its earlier claim. It must stay held under the same identity, then complete once the condition clears.
    if (refusalCase === 'materialRefusedOnRecovery') {
      await page.goto(continueUrl);
      await page.getByText('【主动引导合成示例，仅验证交互】', { exact: false }).first().waitFor({ timeout: 420000 });
      await finalizeNewScript();
      const choice = '先做分镜，再生成剪辑建议';
      const moneyBefore = await money();
      const material = /\/api\/trpc\/opc\.prepareVideoMaterial(?:[?,]|$)/;
      const signIn412 = JSON.stringify([{ error: { message: '登录会话剩余时间不足，请重新登录后继续原请求。', code: -32012,
        data: { code: 'PRECONDITION_FAILED', httpStatus: 412, path: 'opc.prepareVideoMaterial' } } }]);
      // 1. The material is bound, then admission fails uncertainly: held.
      await page.route(prepareRoute, route => route.fulfill({ status: 503, contentType: 'application/json', body: plain503 }));
      await page.getByLabel('消息', { exact: true }).fill(choice);
      await page.getByRole('button', { name: '发送', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: '视频工作请求状态待核实' }).waitFor({ timeout: 420000 });
      const held = JSON.parse((await page.evaluate(key => localStorage.getItem(key), videoKey))!);
      expect(held.held).toBe(true);
      const requestId = held.followup.requestId as string;
      await page.unroute(prepareRoute);
      // 2. The explicit recovery replays the material call, which policy now refuses with a structured 412.
      await page.route(material, route => route.fulfill({ status: 412, contentType: 'application/json', body: signIn412 }));
      await page.getByLabel('消息', { exact: true }).fill(choice);
      await page.getByRole('button', { name: '发送', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: '请重新登录后继续原请求' }).waitFor({ timeout: 420000 });
      expect(await page.getByRole('alert').filter({ hasText: '原视频工作请求已明确拒绝' }).count()).toBe(0);
      const stillHeld = JSON.parse((await page.evaluate(key => localStorage.getItem(key), videoKey))!);
      expect(stillHeld.held).toBe(true);
      expect(stillHeld.followup.requestId).toBe(requestId);
      expect(abandons).toEqual([]);
      await quietAfterReload(async () => {
        expect(sendsOf(requestId)).toBe(1);
        expect(await executionsOf(requestId)).toBe(0);
        expect(JSON.parse((await page.evaluate(key => localStorage.getItem(key), videoKey))!).followup.requestId).toBe(requestId);
      });
      expect(await money()).toEqual(moneyBefore);
      // 3. Once the condition clears, the same request completes exactly once, and ordinary dialogue continues.
      await page.unroute(material);
      await page.getByLabel('消息', { exact: true }).fill(choice);
      await page.getByRole('button', { name: '发送', exact: true }).click();
      await expect.poll(() => page.evaluate(key => localStorage.getItem(key), videoKey), { timeout: 420000 }).toBeNull();
      expect(await executionsOf(requestId, 'completed')).toBe(1);
      expect(await executionsOf(requestId)).toBe(1);
      expect(abandons).toEqual([]);
      await ordinaryChatWorks('视频包恢复后继续普通对话。');
    }
  } finally {
    await sql.query("delete from system_settings where key='runtime_rate_limits'");
    await browser.close();
  }
}
it("OPC: RATE-LIMIT /runtime guidance holds every unadmitted 503 for an explicit retry", () => runtimeHoldCase('guidance'), 2700000);
it.each([[0, 'paused'], [1, 'unknown structured 503'], [2, 'plain non-tRPC 503'], [3, 'material and admission both fail']] as const)(
  "OPC: RATE-LIMIT /runtime video package holds an unadmitted request for an explicit retry (%i: %s)",
  videoCase => runtimeHoldCase('video', videoCase), 1200000);
it.each(['guidance403', 'video412', 'video412AbandonFails', 'materialRefusedOnRecovery'] as const)(
  "OPC: RATE-LIMIT /runtime definite 4xx refusal before admission ends or holds by what it proves (%s)",
  refusalCase => runtimeHoldCase('refusal', -1, refusalCase), 1200000);

it('OPC: CONFIRM_CARD full-page cross-tab review, stable confirmation, saving and deferral', async () => {
  const f = await mergedPositioningFixture(flow => {
    flow.steps[1].information!.push({id:'missing',title:'待补充依据',required:true,profileKey:'missing',elicitation:'user_fact'});
  });
  await planFixtureModel(f.moduleId);
  const d = await f.service.start({requestId:randomUUID(),registration:f.registration,mode:'mentor',businessName:'Confirmation preview'});
  const {chromium,expect:ui} = await import('../../../../../apps/web/node_modules/@playwright/test');
  const browser = await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
  const context = await browser.newContext({viewport:{width:1440,height:1000}});
  await context.route('**/*',route=>['127.0.0.1','localhost'].includes(new URL(route.request().url()).hostname)?route.continue():route.abort());
  const page = await context.newPage(); page.setDefaultTimeout(60000);
  const path='/app/positioning/'+d.draftId;
  const read=()=>f.service.read(d.draftId);
  const card=page.getByRole('region',{name:'本步确认',exact:true});
  const confirm=()=>card.getByRole('button',{name:'没问题，进入下一步',exact:true});
  let releaseSave=()=>{};
  try {
    await page.goto(process.env.V3_LOCAL_APP+'/login?redirect='+encodeURIComponent(path));
    await page.getByPlaceholder('name@example.com').fill(f.email);
    await page.getByPlaceholder('输入你的密码').fill(f.password);
    await page.getByRole('button',{name:'登录',exact:true}).last().click();
    await page.waitForURL('**'+path);
    await ui(page.getByRole('textbox',{name:'给 AI 教练的回复',exact:true})).toBeEnabled({timeout:30000});
    for(const [id,value] of [['product','摄影课程'],['platforms','公众号'],['time','每周三小时']])
      await page.locator('#step-0-'+id).fill(value);
    await expect.poll(async()=>(await read()).information['step-0'].values.time?.value,{timeout:30000}).toBe('每周三小时');
    await ui(confirm()).toBeEnabled();
    const tab=await context.newPage();
    await tab.goto(process.env.V3_LOCAL_APP+path);
    await tab.locator('#step-0-product').fill('另一标签页保存的摄影课程');
    await expect.poll(async()=>(await read()).information['step-0'].values.product?.value,{timeout:30000}).toBe('另一标签页保存的摄影课程');
    await page.bringToFront();
    await confirm().click();
    const review=page.getByRole('dialog',{name:'核对并确认：需求确认'});
    await ui(review).toBeVisible();
    await ui(review.getByText(/内容刚刚有变化/)).toBeVisible();
    await ui(review.getByLabel('核对：产品与服务')).toHaveValue('另一标签页保存的摄影课程');
    expect((await read()).snapshot.steps['step-0'].valid).toBe(false);
    await page.screenshot({path:process.env.V3_WORKBENCH_OUTPUT+'/confirm-card-A5.png'});
    await review.getByRole('button',{name:'关闭核对'}).click();
    // A7: hold an actual autosave; the full page must disable confirmation until its write/read completes.
    const held=new Promise<void>(resolve=>{releaseSave=resolve;});
    await page.route('**/api/trpc/opc.information*',async route=>{await held;await route.continue();});
    await page.locator('#step-0-time').fill('每周四小时');
    await ui(confirm()).toBeDisabled();
    await ui(card.getByText('刚改过的内容正在保存和刷新，完成后就可以确认。')).toBeVisible();
    releaseSave();
    await expect.poll(async()=>(await read()).information['step-0'].values.time?.value,{timeout:30000}).toBe('每周四小时');
    await page.unroute('**/api/trpc/opc.information*');
    await ui(confirm()).toBeEnabled();
    await ui(card).toContainText('每周四小时');
    // A6: only the stabilized, visibly refreshed values may be confirmed.
    await page.waitForTimeout(2100);
    let writes=0;
    page.on('request',request=>{if(request.url().includes('opc.information'))writes++;});
    await confirm().click();
    await expect.poll(async()=>(await read()).snapshot.steps['step-0'].valid,{timeout:30000}).toBe(true);
    expect(writes).toBe(1);
    expect((await read()).information['step-0'].values.product).toMatchObject({value:'另一标签页保存的摄影课程',status:'confirmed'});
    await ui(page.getByRole('textbox',{name:'给 AI 教练的回复',exact:true})).toBeEnabled({timeout:30000});
    await ui(card).toContainText('还差：');
    // A8: the real review accepts a written deferral; no public finalization is performed.
    await card.getByRole('button',{name:'暂时无法确定，写原因暂缓'}).click();
    const nextReview=page.getByRole('dialog',{name:'核对并确认：竞品研究'});
    await nextReview.getByRole('checkbox').nth(1).check();
    await nextReview.getByLabel('核对：待补充依据').fill('需要后续补充真实资料');
    await nextReview.getByRole('button',{name:'确认这一步',exact:true}).click();
    await expect.poll(async()=>(await read()).information['step-1'].values.missing?.status,{timeout:30000}).toBe('deferred');
    await expect.poll(async()=>(await read()).snapshot.steps['step-1'].valid,{timeout:30000}).toBe(true);
    await ui(nextReview).not.toBeVisible();
    await ui(page.getByRole('button',{name:'确认正式定位',exact:true})).toBeDisabled();
    await page.screenshot({path:process.env.V3_WORKBENCH_OUTPUT+'/confirm-card-A8.png'});
  } catch(error) {
    await page.screenshot({path:process.env.V3_WORKBENCH_OUTPUT+'/confirm-card-failure.png'}).catch(()=>{});
    throw error;
  } finally {releaseSave();await browser.close();}
},240000);
