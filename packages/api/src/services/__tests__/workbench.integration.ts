/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeAll, afterAll, it, expect } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { saveModuleSkill, type ModuleSkillInput } from '../skills/modulePublication';
import { publishSkillPackage } from "../skills/publication";
import { makePackage, makeWorkflow } from "./fixtures/artifacts";
import { configuredReasoning } from "./fixtures/runtimeReasoning";
import { packageHash, sha256 } from "../skills/loader";
import { workbenchService } from "../artifacts/workbench";
import { seedTestOpenRouterKey } from '../models/openRouterKey.testing';
const requireWeb = createRequire(
  new URL("../../../../../apps/web/package.json", import.meta.url),
);
const { chromium } = requireWeb(
  "@playwright/test",
) as typeof import("../../../../../apps/web/node_modules/@playwright/test");
const url = process.env.V3_LOCAL_REST!,
  app = process.env.V3_LOCAL_APP!,
  output = process.env.V3_WORKBENCH_OUTPUT!;
if (
  !url?.startsWith("http://127.0.0.1:") ||
  !app?.startsWith("http://127.0.0.1:") ||
  !process.env.V3_LOCAL_DB?.endsWith("/v3_disposable")
)
  throw new Error("isolated workbench runner required");
const sql = new pg.Client({ connectionString: process.env.V3_LOCAL_DB });
const db = createClient(url, process.env.V3_LOCAL_SERVICE_JWT!, {
  global:{fetch:async(input,init)=>{
    const settle=String(input).endsWith('/rpc/agent_slice_call')&&typeof init?.body==='string'&&JSON.parse(init.body).p_action==='settle';
    try{const response=await fetch(input,init);if(settle&&!response.ok){const error=await response.clone().json();console.log('SLICE_SETTLE_HTTP_FAILURE',JSON.stringify({status:response.status,code:error.code}));}return response;}
    catch(error){if(settle)console.log('SLICE_SETTLE_TRANSPORT_FAILURE',error instanceof Error?error.name:'unknown');throw error;}
  }},
  auth: { persistSession: false },
});
const password = `Local-${randomUUID()}!`;
let actor: string,
  owner: string,
  browser: Awaited<ReturnType<typeof chromium.launch>>;
let fixtures: Array<{
  label: string;
  moduleId: string;
  pack: ReturnType<typeof makePackage>;
  flow: ReturnType<typeof makeWorkflow>;
  registration: string;
}>;
let credentials: {
  email: string;
  password: string;
};
const outputs: string[] = [];
async function newUser(confirmed = true) {
  const email = `${randomUUID()}@example.test`;
  const r = await db.auth.admin.createUser({
    email,
    password,
    email_confirm: confirmed,
  });
  if (r.error)
    throw new Error(
      "local auth account creation failed: " +
        r.error.message +
        " " +
        r.error.code,
    );
  const id = r.data.user.id;
  await sql.query(
    "insert into profiles(id,email,nickname,role) values($1,$2,$3,$4)",
    [id, email, "Fixture", "user"],
  );
  return { id, email, password };
}
async function authenticated(c = credentials) {
  const client = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { persistSession: false },
  });
  const r = await client.auth.signInWithPassword(c);
  if (r.error) throw new Error("local password login failed");
  return client;
}
async function fixture(config: {
  id: string;
  label: string;
  methodText: string;
  package?: ReturnType<typeof makePackage>;
  workflow: ReturnType<typeof makeWorkflow>;
}) {
  const pack = config.package ?? makePackage(),
    moduleId = randomUUID(),
    registration = config.id,
    flow = config.workflow;
  const entry = pack.files[0],
    text = Buffer.from(entry.base64, "base64").toString() + config.methodText;
  entry.base64 = Buffer.from(text).toString("base64");
  pack.descriptor.files[0].bytes = Buffer.byteLength(text);
  pack.descriptor.files[0].sha256 = sha256(text);
  pack.descriptor.packageHash = packageHash(pack.descriptor);
  await sql.query(
    "insert into skills(id,skill_key,created_by) values($1,$2,$3)",
    [pack.id, registration, owner],
  );
  await sql.query(
    "insert into modules(id,title,skill_id,active) values($1,$2,$3,true)",
    [moduleId, config.label, pack.id],
  );
  await publishSkillPackage(db, owner, pack);
  await sql.query(
    "insert into artifact_workflows(id,module_id,skill_id,revision_id,workflow,label,enabled) values($1,$2,$3,$4,$5,$6,true)",
    [registration, moduleId, pack.id, pack.revisionId, flow, config.label],
  );
  if (flow.kind === "social")
    await sql.query("insert into artifact_accounts values($1,$2,$3,$4)", [
      actor,
      moduleId,
      pack.id,
      "synthetic:local-account",
    ]);
  return { pack, moduleId, flow, registration, label: config.label };
}
async function pageFor(c = credentials, requests?: string[]) {
  const context = await browser.newContext();
  context.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/trpc"))
      requests?.push(path);
  });
  await context.route("**/*", (route) => {
    const u = new URL(route.request().url());
    if (
      ["127.0.0.1", "localhost"].includes(u.hostname) ||
      ["data:", "blob:"].includes(u.protocol)
    )
      return route.continue();
    outputs.push("blocked browser external " + u.hostname);
    return route.abort();
  });
  const page = await context.newPage();
  page.on("response", async (response) => {
    if (response.url().includes("/api/trpc/")) {
      const text = await response.text().catch(() => "");
      expect(text).not.toContain("METHOD_CANARY");
      expect(text).not.toContain("references/step-");
    }
  });
  // Wait for the login page's client query before filling controlled fields.
  // The initial server HTML can be visible before hydration attaches handlers.
  const loginReady = page.waitForResponse((response) =>
    response.url().includes("/api/trpc/settings.getSystemSettings") && response.ok(),
  );
  // LEGACY-CLOSE removed the old /workbench page; sign in through the positioning workspace.
  await page.goto(app + "/login?redirect=/positioning");
  await loginReady;
  await page.getByPlaceholder("name@example.com").fill(c.email);
  await page.getByPlaceholder("输入你的密码").fill(c.password);
  await page.getByRole("button", { name: "登录", exact: true }).last().click();
  // A suffix glob also matches /login?redirect=/positioning before login succeeds.
  await page.waitForURL((url) => url.pathname === "/app/positioning", { timeout: 90000 });
  return { page, context };
}
beforeAll(async () => {
  await sql.connect();
  browser = await chromium.launch({
    executablePath:
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
  });
  if (process.env.V3_WORKBENCH_PHASE === "restore") {
    const saved = JSON.parse(readFileSync(output + "/restore.json", "utf8"));
    credentials = saved.credentials;
    fixtures = saved.fixtures;
    actor = saved.actor;
    owner = saved.owner;
    return;
  }
  const o = await newUser();
  owner = o.id;
  await sql.query("update profiles set role='admin' where id=$1", [owner]);
  const a = await newUser();
  actor = a.id;
  credentials = { email: a.email, password: a.password };
  fixtures = [];
  if (!process.env.V3_REAL_SKILL_INPUT) for (const file of readdirSync(
    new URL("./fixtures/workbench/", import.meta.url),
  ).sort())
    fixtures.push(
      await fixture(
        JSON.parse(
          readFileSync(
            new URL("./fixtures/workbench/" + file, import.meta.url),
            "utf8",
          ),
        ),
      ),
    );
  const boot = await db.rpc("artifact_query", {
    p_actor_id: actor,
    p_action: "projects",
  });
  if (boot.error)
    throw new Error(
      "query bootstrap: " + boot.error.code + " " + boot.error.message,
    );
  // Wait for actual Next HTTP, without replacing its route or authentication.
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(app + "/login")).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
}, 120000);
afterAll(async () => {
  if (process.env.V3_WORKBENCH_PHASE !== "restore") {
    const prior = existsSync(output + "/restore.json") ? JSON.parse(readFileSync(output + "/restore.json", "utf8")) : null;
    const state = prior?.actor === actor ? prior : { credentials, fixtures, actor, owner };
    const service = workbenchService(await authenticated(), db);
    state.expectedSnapshots = [];
    state.expectedProjects = await service.projects();
    const catalogDiagnostic=await db.rpc('artifact_query',{p_actor_id:actor,p_action:'catalog'});
    console.log('WORKBENCH_PRE_RESTART_CATALOG',JSON.stringify({enabledWorkflows:Number((await sql.query('select count(*) n from artifact_workflows where enabled')).rows[0].n),error:catalogDiagnostic.error?.message??null,projects:state.expectedProjects.length}));
    for (const p of state.expectedProjects) {
      const rounds = await service.rounds(p.projectId);
      const current =
        rounds.find((r) => r.state === "draft") ??
        rounds
          .filter((r) => r.state === "published")
          .sort((a, b) => (b.version ?? 0) - (a.version ?? 0))[0] ?? rounds[0];
      state.expectedSnapshots.push(
        await service.read(p.projectId, current.roundId),
      );
    }
    writeFileSync(output + "/restore.json", JSON.stringify(state));
  }
  writeFileSync(output + "/network.txt", outputs.join("\n"));
  console.log("isolated cleanup: closing browser");
  await browser?.close();
  console.log("isolated cleanup: closing SQL connection");
  await sql.end();
  console.log("isolated cleanup complete");
}, 60000);
const aiTest = it.skipIf(process.env.V3_WORKBENCH_PHASE === 'restore');
aiTest('AI: research uses canonical credits and recovers settlement without fetching again',async()=>{
 const {databaseResearchStore}=await import('../research/store'),research=databaseResearchStore(db,actor);
 await sql.query('update profiles set credits=100 where id=$1',[actor]);
 await sql.query("insert into system_settings(key,value) values('search_surcharge_credits','5') on conflict(key) do update set value=excluded.value");
 const planId=randomUUID(),operationId=randomUUID();await research.create(planId,1100000,[{operationId,identityHash:'a'.repeat(64),maxQuoteUnits:1100000}]);
 const r=await research.reserve(planId,operationId,'a'.repeat(64),1100000);
 const charge=async(action:string)=>{const r=await db.rpc('research_user_charge',{p_actor_id:actor,p_plan_id:planId,p_operation_id:operationId,p_action:action});if(r.error)throw r.error;};
 await Promise.all([charge('reserve'),charge('reserve')]);
 expect((await sql.query('select credits from profiles where id=$1',[actor])).rows[0].credits).toBe(95);
 await charge('admit');await research.dispatch(planId,operationId,r.token!);
 await research.finish(planId,operationId,r.token!,'succeeded',{source:'agentkey',fixture:true,canonicalTool:'Tavily/post_search',objects:[],fetchedAt:new Date().toISOString(),pagination:{complete:true,nextCursor:null},error:null,cost:{unit:'agentkey-credit',quoted:1.1,actual:null,status:'unknown'}});
 await sql.query("create function research_test_reject_spend() returns trigger language plpgsql as $$begin raise exception 'test settlement unavailable'; end$$; create trigger research_test_spend before insert on credit_transactions for each row execute function research_test_reject_spend()");
 try {await expect(charge('settle')).rejects.toBeTruthy();expect((await research.get(planId,operationId))?.state).toBe('succeeded');expect((await sql.query('select charged_credits from research_operations where id=$1',[operationId])).rows[0].charged_credits).toBeNull();}
 finally {await sql.query('drop trigger research_test_spend on credit_transactions; drop function research_test_reject_spend()');}
 await Promise.all([charge('settle'),charge('settle')]);
 expect((await sql.query('select credits from profiles where id=$1',[actor])).rows[0].credits).toBe(95);
 expect((await sql.query('select count(*)::int n from credit_transactions where source_id=$1',[operationId])).rows[0].n).toBe(1);
 expect((await sql.query('select charged_credits from research_operations where id=$1',[operationId])).rows[0].charged_credits).toBe(5);
 const denied=createClient(url,process.env.V3_LOCAL_USER_JWT!,{auth:{persistSession:false}});
 expect((await denied.rpc('research_user_charge',{p_actor_id:actor,p_plan_id:planId,p_operation_id:operationId,p_action:'settle'})).error).not.toBeNull();
 const chargedAt=(await sql.query('select charged_at from research_operations where id=$1',[operationId])).rows[0].charged_at;
 const start=new Date(chargedAt).toISOString(),end=new Date(new Date(chargedAt).getTime()+1000).toISOString();
 const totals=await db.rpc('research_billing_summary',{p_start:start,p_end:end});
 expect(totals.error).toBeNull();expect(totals.data).toEqual({count:1,credits:5});
 const excluded=await db.rpc('research_billing_summary',{p_start:start,p_end:start});
 expect(excluded.error).toBeNull();expect(excluded.data).toEqual({count:0,credits:0});
 expect((await denied.rpc('research_billing_summary',{p_start:start,p_end:end})).error).not.toBeNull();
 expect((await db.rpc('research_billing_summary',{p_start:end,p_end:start})).error).not.toBeNull();

},30000);

aiTest('AI: research refunds only a cancelled unsent reservation',async()=>{
 const {databaseResearchStore}=await import('../research/store'),research=databaseResearchStore(db,actor);
 await sql.query('update profiles set credits=100 where id=$1',[actor]);
 await sql.query("insert into system_settings(key,value) values('search_surcharge_credits','5') on conflict(key) do update set value=excluded.value");
 for(const dispatched of [false,true]){
  const planId=randomUUID(),operationId=randomUUID();await research.create(planId,1100000,[{operationId,identityHash:'b'.repeat(64),maxQuoteUnits:1100000}]);const r=await research.reserve(planId,operationId,'b'.repeat(64),1100000);
  const charge=async(action:string)=>{const r=await db.rpc('research_user_charge',{p_actor_id:actor,p_plan_id:planId,p_operation_id:operationId,p_action:action});if(r.error)throw r.error;};
  await charge('reserve');if(dispatched)await research.dispatch(planId,operationId,r.token!);
  await research.cancel(planId);
  if(dispatched)await expect(charge('refund')).rejects.toBeTruthy();else await Promise.all([charge('refund'),charge('refund')]);
  expect((await sql.query('select credits from profiles where id=$1',[actor])).rows[0].credits).toBe(dispatched?95:100);
 }
},30000);

aiTest('AI: research billed store recovers cancellation across recreation and rejects missing price',async()=>{
 const {databaseBilledResearchStore}=await import('../research/store');let research=databaseBilledResearchStore(db,actor);
 await sql.query('update profiles set credits=100 where id=$1',[actor]);
 await sql.query("insert into system_settings(key,value) values('search_surcharge_credits','5') on conflict(key) do update set value=excluded.value");
 const planId=randomUUID(),operations=[0,1].map(()=>({operationId:randomUUID(),identityHash:'c'.repeat(64),maxQuoteUnits:1100000}));
 await research.create(planId,2200000,operations);for(const op of operations)await research.reserve(planId,op.operationId,op.identityHash,1100000);
 expect((await sql.query('select credits from profiles where id=$1',[actor])).rows[0].credits).toBe(90);
 research=databaseBilledResearchStore(db,actor);await research.cancel(planId);await research.cancel(planId);
 expect((await sql.query('select credits from profiles where id=$1',[actor])).rows[0].credits).toBe(100);
 const p=randomUUID(),o=randomUUID();await research.create(p,1100000,[{operationId:o,identityHash:'d'.repeat(64),maxQuoteUnits:1100000}]);
 await sql.query("update system_settings set value='0' where key='search_surcharge_credits'");
 await expect(research.reserve(p,o,'d'.repeat(64),1100000)).rejects.toThrow('RESEARCH_BILLING_UNAVAILABLE');
 expect((await sql.query('select credits from profiles where id=$1',[actor])).rows[0].credits).toBe(100);
 await expect(research.dispatch(p,o,randomUUID())).rejects.toThrow('RESEARCH_BILLING_UNAVAILABLE');
 await sql.query("update system_settings set value='5' where key='search_surcharge_credits'");
 const r=await research.reserve(p,o,'d'.repeat(64),1100000);await research.dispatch(p,o,r.token!);
 await research.finish(p,o,r.token!,'succeeded',{source:'agentkey',fixture:true,canonicalTool:'Tavily/post_search',objects:[],fetchedAt:new Date().toISOString(),pagination:{complete:true,nextCursor:null},error:null,cost:{unit:'agentkey-credit',quoted:1.1,actual:null,status:'unknown'}});
 await databaseBilledResearchStore(db,actor).get(p,o);
 expect((await sql.query('select credits from profiles where id=$1',[actor])).rows[0].credits).toBe(95);
},30000);

// Chat linkage uses the same real local Auth/PostgREST/credit transaction fixture.
aiTest('AI: research explicit provider failure refunds once while unknown stays reserved',async()=>{
 const {databaseBilledResearchStore}=await import('../research/store');const store=databaseBilledResearchStore(db,actor);
 const missing=randomUUID(),lookup={p_actor_id:actor,p_plan_id:missing,p_operation_id:missing};
 expect((await db.rpc('research_lookup',lookup)).data).toBeNull();
 expect((await sql.query('select id from research_plans where id=$1',[missing])).rows).toHaveLength(0);
 const ordinary=await authenticated();expect((await ordinary.rpc('research_lookup',lookup)).error).not.toBeNull();
 const anonymous=createClient(url,process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,{auth:{persistSession:false}});
 expect((await anonymous.rpc('research_lookup',lookup)).error).not.toBeNull();

 await sql.query("insert into system_settings(key,value) values('search_surcharge_credits','5') on conflict(key) do update set value=excluded.value");
 for(const state of ['failed','unknown'] as const){
  await sql.query('update profiles set credits=100 where id=$1',[actor]);
  const id=randomUUID();await store.create(id,1100000,[{operationId:id,identityHash:'d'.repeat(64),maxQuoteUnits:1100000}]);
  const foreign=await newUser();expect((await db.rpc('research_lookup',{p_actor_id:foreign.id,p_plan_id:id,p_operation_id:id})).error).not.toBeNull();
  const reserved=await store.reserve(id,id,'d'.repeat(64),1100000);await store.dispatch(id,id,reserved.token!);
  await store.finish(id,id,reserved.token!,state,{source:'agentkey',fixture:true,canonicalTool:'Tavily/post_search',objects:[],fetchedAt:new Date().toISOString(),pagination:{complete:false,nextCursor:null},error:state==='failed'?'PROVIDER_TOOL_ERROR':'RESULT_UNKNOWN',cost:{unit:'agentkey-credit',quoted:1.1,actual:null,status:'unknown'}});
  await store.get(id,id);await store.get(id,id);
  expect((await sql.query('select credits from profiles where id=$1',[actor])).rows[0].credits).toBe(state==='failed'?100:95);
  expect((await sql.query('select charged_credits from research_operations where id=$1',[id])).rows[0].charged_credits).toBe(state==='failed'?0:null);
 }
},30000);

function adminModuleInput(): ModuleSkillInput {
  const pack = makePackage();
  return { moduleId: randomUUID(), skillId: pack.id, revisionId: pack.revisionId, requestId: pack.requestId,
    expectedUpdatedAt: null, expectedVersion: 0, directoryName: 'synthetic-method', kind: 'document', socialMediaRelated: false,
    files: [...pack.files, { path: 'assets/state.yaml', base64: Buffer.from('state: draft\n').toString('base64') }],
    steps: [{ title: '需求确认', resources: ['references/step-0.md', 'assets/state.yaml'] }, { title: '定位成果', resources: ['references/step-1.md'] }],
    resourcePlanReviewed: true, module: { title: 'ADMIN synthetic method ' + randomUUID(), description: 'Synthetic admin validation', full_description: null,
      model_id: randomUUID(), platform: 'all', category: 'analysis', icon: 'Wand2', image_url: null,
      badge_type: null, badge_text: null, credits_display: null, sort_order: 0, active: true, is_featured: false,
      features: null, examples: null, preparation_questions: null },
  };
}
it('ADMIN: atomic package, YAML template, workflow and module publication with replay, rollback and stale-write protection', async () => {
  const input = adminModuleInput();
  await sql.query("insert into ai_models(id,model_id,name,provider,max_tokens,input_limit,config) values($1,'qwen/qwen3.8-27b','Admin fixture model','openai',4096,800000,$2)", [input.module.model_id, configuredReasoning('qwen/qwen3.8-27b')]);
  await seedTestOpenRouterKey(sql, 'LOCAL_ONLY');
  const result = await saveModuleSkill(db, owner, input);
  expect(result.version).toBe(1);
  expect(await saveModuleSkill(db, owner, input)).toEqual(result);
  const read = await db.rpc('admin_read_skill_module', { p_actor_id: owner, p_module_id: input.moduleId });
  expect(read.error).toBeNull(); expect(read.data.files).toHaveLength(input.files.length);
  expect(read.data.workflow.steps.map((s: any) => s.title)).toEqual(['需求确认','定位成果']);
  expect(read.data.files.find((f: any) => f.path === 'assets/state.yaml').base64).toBe(input.files.at(-1)!.base64);
  const catalog = await db.rpc('artifact_query', { p_actor_id: actor, p_action: 'catalog' });
  expect(catalog.data.filter((w: any) => w.moduleId === input.moduleId)).toHaveLength(1);
  const before = (await sql.query('select updated_at::text from modules where id=$1', [input.moduleId])).rows[0];
  const next = { ...input, revisionId: randomUUID(), requestId: randomUUID(), expectedVersion: 1, expectedUpdatedAt: before.updated_at };
  next.files = input.files.map(f => f.path === 'references/step-0.md' ? { ...f, base64: Buffer.from('Revised private method').toString('base64') } : f);
  next.steps = [
    {title:'需求与目标',resources:['SKILL.md'],information:[{id:'product',title:'产品与服务',required:true,profileKey:'product'}]},
    {title:'受众研究',resources:['SKILL.md'],information:[{id:'audience',title:'优先服务的用户',required:true,profileKey:'audience'}]},
    {title:'效果验证',resources:['SKILL.md'],information:[{id:'measure',title:'如何验证效果',required:true,profileKey:'measure'}]},
  ];
  next.files.push({path:'workflow.yaml',base64:Buffer.from(
    'kind: document\nsteps:\n  - title: 需求与目标\n    resources: [SKILL.md]\n    information:\n      - id: product\n        title: 产品与服务\n        required: true\n        profileKey: product\n  - title: 受众研究\n    resources: [SKILL.md]\n    information:\n      - id: audience\n        title: 优先服务的用户\n        required: true\n        profileKey: audience\n  - title: 效果验证\n    resources: [SKILL.md]\n    information:\n      - id: measure\n        title: 如何验证效果\n        required: true\n        profileKey: measure\n',
  ).toString('base64')});
  expect((await saveModuleSkill(db, owner, next)).version).toBe(2);
  const latest = await db.rpc('admin_read_skill_module',{p_actor_id:owner,p_module_id:input.moduleId});
  expect(latest.error).toBeNull();
  expect(latest.data.workflow.steps.map((step:any)=>step.title)).toEqual(['需求与目标','受众研究','效果验证']);
  expect(latest.data.workflow.steps.map((step:any)=>step.information[0].title))
    .toEqual(['产品与服务','优先服务的用户','如何验证效果']);
  await expect(saveModuleSkill(db, owner, { ...next, revisionId: randomUUID(), requestId: randomUUID() })).rejects.toThrow();
  const history = await db.rpc('read_skill_package', { p_actor_id: actor, p_module_id: input.moduleId, p_skill_id: input.skillId, p_revision_id: input.revisionId });
  expect(history.error).toBeNull();
  expect((await sql.query('select count(*)::int as n from artifact_workflows where module_id=$1 and enabled', [input.moduleId])).rows[0].n).toBe(1);
  const invalid = adminModuleInput(); // Missing model must roll back Skill/module/registration creation.
  await expect(saveModuleSkill(db, owner, invalid)).rejects.toThrow();
  expect((await sql.query('select count(*)::int as n from skills where id=$1', [invalid.skillId])).rows[0].n).toBe(0);
  expect((await sql.query('select count(*)::int as n from modules where id=$1', [invalid.moduleId])).rows[0].n).toBe(0);
});
it('ADMIN: unauthorized users cannot read private configuration or publish, including direct RPC', async () => {
  const input = adminModuleInput();
  await expect(saveModuleSkill(db, actor, input)).rejects.toThrow();
  const denied = await db.rpc('admin_read_skill_module', { p_actor_id: actor, p_module_id: fixtures[0].moduleId });
  expect(denied.error?.code).toBe('42501');
  const user = await authenticated();
  expect((await user.rpc('admin_read_skill_module', { p_actor_id: owner, p_module_id: fixtures[0].moduleId })).error?.code).toBe('42501');
  const privilege = await sql.query("select has_function_privilege('anon','public.admin_read_skill_module(uuid,uuid)','EXECUTE') as anon, has_function_privilege('authenticated','public.admin_publish_skill_module(uuid,uuid,timestamptz,jsonb,uuid,uuid,uuid,integer,jsonb,text,jsonb,jsonb)','EXECUTE') as authenticated");
  expect(privilege.rows[0]).toEqual({ anon: false, authenticated: false });
});
it('ADMIN: browser imports a Skill folder, configures steps, publishes the configured steps and routes the legacy module link to positioning', async () => {
  const admin = await newUser();
  await sql.query("update profiles set role='admin' where id=$1", [admin.id]);
  writeFileSync(output + '/admin-preview.json', JSON.stringify({ url: app, email: admin.email, password: admin.password }), { mode: 0o600 });
  const input = adminModuleInput();
  await sql.query("insert into ai_models(id,model_id,name,provider,max_tokens,input_limit,config) values($1,'qwen/qwen3.8-27b','Browser admin model','openai',4096,800000,$2)", [input.module.model_id, configuredReasoning('qwen/qwen3.8-27b')]);
  await seedTestOpenRouterKey(sql, 'LOCAL_ONLY');
  const directory = output + '/synthetic-method'; mkdirSync(directory, { recursive: true });
  for (const f of input.files) {
    const target = directory + '/' + f.path; mkdirSync(target.slice(0,target.lastIndexOf('/')), { recursive: true });
    writeFileSync(target, Buffer.from(f.base64,'base64'));
  }
  const context = await browser.newContext(), page = await context.newPage();
  try {
    const ready = page.waitForResponse(r => r.url().includes('/api/trpc/settings.getSystemSettings') && r.ok());
    await page.goto(app + '/login?redirect=/admin/prompts'); await ready;
    await page.getByPlaceholder('name@example.com').fill(admin.email);
    await page.getByPlaceholder('输入你的密码').fill(admin.password);
    await page.getByRole('button', { name: '登录', exact: true }).last().click();
    await page.waitForURL(u => u.pathname === '/admin/prompts', { timeout: 90000 });
    const unusedModule = randomUUID();
    await sql.query("insert into modules(id,title,active) values($1,'Inactive deletion browser fixture',false)",[unusedModule]);
    await page.reload();
    // Simulate a browser extension blocking native dialogs; our page dialog must still work.
    await page.evaluate(() => { window.confirm = () => false; });
    await page.getByTestId('admin-prompt-delete-' + unusedModule).click();
    await page.getByRole('button', { name: '取消', exact: true }).click();
    expect((await sql.query('select id from modules where id=$1',[unusedModule])).rowCount).toBe(1);
    await page.getByTestId('admin-prompt-delete-' + unusedModule).click();
    await page.getByRole('button', { name: '确认删除', exact: true }).click();
    await expect.poll(async () => (await sql.query('select id from modules where id=$1',[unusedModule])).rowCount).toBe(0);

    await page.getByRole('button', { name: '新建模块', exact: true }).click();
    await page.getByLabel('功能类型', { exact: true }).selectOption('skill');
    await page.getByLabel('导入 Skill 文件夹', { exact: true }).setInputFiles(directory);
    await page.getByText('已载入 10 个文件', { exact: true }).waitFor();
    await page.getByTestId('prompt-name-input').fill(input.module.title);
    await page.getByLabel('步骤 1 名称', { exact: true }).fill('需求确认');
    await page.getByRole('button', { name: '添加步骤', exact: true }).click();
    await page.getByLabel('步骤 2 名称', { exact: true }).fill('定位成果');
    const modelTrigger = page.getByRole('dialog').getByRole('combobox').filter({ hasText: '不限制' });
    await modelTrigger.click(); await page.getByRole('option', { name: 'Browser admin model', exact: true }).click();
    await page.getByLabel('否', { exact: true }).check();
    await page.getByLabel('我已检查步骤顺序和各步使用的参考文件').check();
    await page.getByTestId('prompt-save').click();
    await expect.poll(() => page.getByRole('dialog').count(), { timeout: 30000 }).toBe(0);
    const module = (await sql.query('select id,skill_id from modules where title=$1', [input.module.title])).rows[0];
    expect(module.skill_id).toBeTruthy();
    // LEGACY-CHAT-OFF (#507): /chat no longer opens module conversations. The browser-configured
    // steps must still be the published workflow, and the old module link must land on positioning.
    const configured = (await sql.query('select workflow from artifact_workflows where module_id=$1 and enabled',[module.id])).rows[0].workflow;
    expect(configured.steps.map((step: any) => step.title)).toEqual(['需求确认', '定位成果']);
    await page.goto(app + '/chat?module=' + module.id);
    await page.waitForURL(u => u.pathname === '/app/positioning', { timeout: 30000 });
    await page.screenshot({ path: output + '/admin-skill-legacy-entry.png' });
    configured.planResources=['SKILL.md'];
    configured.steps.forEach((step: any,i:number)=>{step.information=[{id:'goal',title:'Goal '+i,required:true,profileKey:'goal_'+i}];});
    const original = await db.rpc('admin_read_skill_module',{p_actor_id:admin.id,p_module_id:module.id});
    expect(original.error).toBeNull();
    const timestamp=(await sql.query('select updated_at::text from modules where id=$1',[module.id])).rows[0].updated_at;
    await saveModuleSkill(db,admin.id,{...input,moduleId:module.id,skillId:module.skill_id,revisionId:randomUUID(),requestId:randomUUID(),expectedVersion:original.data.expectedVersion,expectedUpdatedAt:timestamp,directoryName:original.data.directoryName,files:original.data.files,kind:configured.kind,planResources:configured.planResources,steps:configured.steps.map((step:any)=>({title:step.title,resources:step.resources,information:step.information}))});
    await page.goto(app + '/admin/prompts');
    const row = page.getByRole('row').filter({ hasText: input.module.title });
    await row.getByRole('button').first().click();
    await page.getByLabel('步骤 1 名称', { exact: true }).waitFor();
    await expect.poll(() => page.getByLabel('步骤 1 名称', { exact: true }).inputValue(), { timeout: 20000 }).toBe('需求确认');
    await page.screenshot({ path: output + '/admin-skill-editor.png' });
    await page.getByLabel('我已检查步骤顺序和各步使用的参考文件').check();
    await page.getByTestId('prompt-save').click();
    await expect.poll(() => page.getByRole('dialog').count(), {timeout:30000}).toBe(0);
    const republished=(await sql.query('select workflow from artifact_workflows where module_id=$1 and enabled',[module.id])).rows[0].workflow;
    expect(republished.planResources).toEqual(configured.planResources);
    expect(republished.steps.map((step:any)=>step.information)).toEqual(configured.steps.map((step:any)=>step.information));
    await row.getByRole('button').first().click();
    await page.getByLabel('步骤 1 名称', {exact:true}).waitFor();
    // A slow second import must revoke confirmation before bytes finish reading.
    await page.getByLabel('我已检查步骤顺序和各步使用的参考文件').check();
    await page.evaluate(() => {
      const original = File.prototype.arrayBuffer;
      let release!: () => void;
      const pending = new Promise<void>(resolve => { release = resolve; });
      (window as any).releaseAdminImport = () => { File.prototype.arrayBuffer = original; release(); };
      File.prototype.arrayBuffer = async function () { await pending; return original.call(this); };
    });
    await page.getByLabel('导入 Skill 文件夹', { exact: true }).setInputFiles(directory);
    await page.getByText('正在读取 Skill 文件…', { exact: true }).waitFor();
    expect(await page.getByTestId('prompt-save').isEnabled()).toBe(false);
    expect(await page.getByLabel('我已检查步骤顺序和各步使用的参考文件').isChecked()).toBe(false);
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await page.getByRole('button', { name: '新建模块', exact: true }).click();
    await page.getByLabel('功能类型', { exact: true }).selectOption('skill');
    await page.getByLabel('步骤 1 名称', { exact: true }).fill('新会话内容');
    await page.evaluate(() => (window as any).releaseAdminImport());
    // Flush the original read promise through its actual microtask completion.
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve,100)));
    expect(await page.getByLabel('步骤 1 名称', { exact: true }).inputValue()).toBe('新会话内容');
    expect(await page.getByText('已载入 10 个文件', { exact: true }).count()).toBe(0);
    await page.getByRole('button', { name: '取消', exact: true }).click();

  } finally { await context.close(); }
}, 180000);

it('ADMIN: three modules delete in one atomic request and disappear before a slow dashboard refresh', async () => {
  const admin = await newUser();
  await sql.query("update profiles set role='admin' where id=$1", [admin.id]);
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  for (const [i,id] of ids.entries()) await sql.query("insert into modules(id,title,active,sort_order) values($1,$2,false,9999)", [id, `Batch delete fixture ${i}`]);
  const {page,context} = await pageFor(admin);
  let releaseRefresh!: () => void;
  const refreshGate = new Promise<void>(resolve => { releaseRefresh = resolve; });
  try {
    // A referenced member rejects the entire batch, including unused members.
    const rejected = await page.request.post(app + '/api/trpc/admin.removePrompts', {data:{ids:[ids[0],fixtures[0].moduleId]}});
    expect(rejected.status()).toBe(409);
    expect((await sql.query('select id from modules where id=any($1::uuid[])',[ids])).rowCount).toBe(3);
    const ordinary = await pageFor();
    expect((await ordinary.page.request.post(app + '/api/trpc/admin.removePrompts',{data:{ids}})).status()).toBe(403);
    await ordinary.context.close();
    const anon = await browser.newContext();
    expect((await anon.request.post(app + '/api/trpc/admin.removePrompts',{data:{ids}})).status()).toBe(401);
    await anon.close();
    await page.goto(app + '/admin/prompts');
    for (const id of ids) await page.getByRole('row').filter({has:page.getByTestId('admin-prompt-delete-' + id)}).getByRole('checkbox').check();
    await page.getByRole('button',{name:'删除选中',exact:true}).click();
    await page.getByRole('button',{name:'取消',exact:true}).click();
    expect((await sql.query('select id from modules where id=any($1::uuid[])',[ids])).rowCount).toBe(3);
    let mutationCount = 0, refreshStarted = false;
    page.on('request', request => { if (request.url().includes('/api/trpc/admin.removePrompts')) mutationCount++; });
    await page.route('**/api/trpc/admin.getPromptsDashboard*', async route => {
      refreshStarted = true;
      await refreshGate;
      await route.continue();
    });
    await page.getByRole('button',{name:'删除选中',exact:true}).click();
    const started = Date.now();
    const response = page.waitForResponse(response => response.url().includes('/api/trpc/admin.removePrompts'));
    await page.getByTestId('admin-module-confirm').click();
    expect((await response).status()).toBe(200);
    const acknowledged = Date.now();
    await expect.poll(() => page.getByRole('dialog').count()).toBe(0);
    for (const id of ids) expect(await page.getByTestId('admin-prompt-delete-' + id).count()).toBe(0);
    expect(mutationCount).toBe(1);
    await expect.poll(() => refreshStarted).toBe(true);
    expect((await sql.query('select id from modules where id=any($1::uuid[])',[ids])).rowCount).toBe(0);
    console.log('MODULE_DELETE_LOCAL', JSON.stringify({modules:3,deleteRequests:mutationCount,requestMs:acknowledged-started,visibleAfterAckMs:Date.now()-acknowledged,refreshStillBlocked:true}));
    releaseRefresh();
    await page.unrouteAll({behavior:'wait'});
    // Successful replay is harmless; there are no extra deletions.
    const replay = await page.request.post(app + '/api/trpc/admin.removePrompts',{data:{ids}});
    expect(replay.status()).toBe(200);
    expect((await replay.json()).result.data.deletedIds).toEqual([]);
    await page.reload();
    await page.getByRole('heading',{name:'功能模块',exact:true}).waitFor();
    for (const id of ids) expect(await page.getByTestId('admin-prompt-delete-' + id).count()).toBe(0);
  } finally { releaseRefresh(); await context.close(); }
}, 180000);

it('ADMIN: model edits and unused-module deletion work through authenticated HTTP while client writes and referenced deletion are denied', async () => {
  const admin = await newUser();
  await sql.query("update profiles set role='admin' where id=$1", [admin.id]);
  const client = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
  const login = await client.auth.signInWithPassword({ email: admin.email, password: admin.password });
  expect(login.error).toBeNull();
  const context = await browser.newContext(), page = await context.newPage();
  await page.goto(app + '/login?redirect=/admin/prompts');
  await page.getByPlaceholder('name@example.com').fill(admin.email);
  await page.getByPlaceholder('输入你的密码').fill(admin.password);
  await page.getByRole('button', { name: '登录', exact: true }).last().click();
  await page.waitForURL(u => u.pathname === '/admin/prompts', {timeout:90000});
  const call = async (name: string, data: any) => {
    const response = await page.request.post(app + '/api/trpc/' + name, { data });
    return {status: response.status()};
  };
  const previousSummarySetting = (await sql.query("select value from system_settings where key='v3_summary_model_id'")).rows;
  const model = randomUUID(), module = randomUUID();
  await sql.query("insert into ai_models(id,model_id,name) values($1,'local-synthetic','Before')", [model]);
  const response = await call('model.updateModel', { id: model, name: 'After', description: 'Saved without provider call' });
  expect(response.status).toBe(200);
  expect((await sql.query('select name from ai_models where id=$1',[model])).rows[0]).toEqual({name:'After'});
  expect((await client.from('ai_models').update({name:'Denied'}).eq('id',model)).error).not.toBeNull();
  await sql.query("insert into modules(id,title,active) values($1,'Unused test module',false)",[module]);
  const card = randomUUID();
  await sql.query("insert into modules(id,title,active,link_module_id) values($1,'Linked card',true,$2)",[card,module]);
  expect((await call('admin.removePrompt',{id:module})).status).toBe(409);
  expect((await sql.query('select link_module_id from modules where id=$1',[card])).rows[0].link_module_id).toBe(module);
  await sql.query('delete from modules where id=$1',[card]);
  expect((await call('admin.removePrompt',{id:module})).status).toBe(200);
  expect((await sql.query('select id from modules where id=$1',[module])).rowCount).toBe(0);
  expect((await call('admin.removePrompt',{id:module})).status).toBe(200);
  expect((await call('admin.removePrompt',{id:fixtures[0].moduleId})).status).toBe(409);
  expect((await sql.query('select id from modules where id=$1',[fixtures[0].moduleId])).rowCount).toBe(1);
  const ordinary = await pageFor();
  expect((await ordinary.page.request.post(app + '/api/trpc/model.updateModel',{data:{id:model,name:'Denied'}})).status()).toBe(403);
  expect((await ordinary.page.request.post(app + '/api/trpc/admin.removePrompt',{data:{id:fixtures[0].moduleId}})).status()).toBe(403);
  expect((await ordinary.page.request.post(app + '/api/trpc/model.deleteModel',{data:{id:model}})).status()).toBe(403);
  expect((await client.rpc('admin_delete_unused_model',{p_actor_id:admin.id,p_model_id:model})).error?.code).toBe('42501');
  expect((await db.rpc('admin_delete_unused_model',{p_actor_id:actor,p_model_id:model})).error?.code).toBe('42501');
  const target = randomUUID();
  await sql.query("insert into ai_models(id,model_id,name) values($1,'unused-model','Unused deletion model')",[target]);
  await sql.query("insert into system_settings(key,value) values('ai_models',$1)",[JSON.stringify({primaryModelId:target.toUpperCase()})]);
  expect((await call('model.deleteModel',{id:target})).status).toBe(409);
  await sql.query("delete from system_settings where key='ai_models'");
  const prompt = randomUUID();
  await sql.query('insert into prompts(id,model_id) values($1,$2)',[prompt,target]);
  expect((await call('model.deleteModel',{id:target})).status).toBe(409);
  expect((await sql.query('select model_id from prompts where id=$1',[prompt])).rows[0].model_id).toBe(target);
  await sql.query('delete from prompts where id=$1',[prompt]);
  const linkedModule = randomUUID();
  await sql.query("insert into modules(id,title,model_id) values($1,'Model reference',$2)",[linkedModule,target]);
  expect((await call('model.deleteModel',{id:target})).status).toBe(409);
  expect((await sql.query('select model_id from modules where id=$1',[linkedModule])).rows[0].model_id).toBe(target);
  await sql.query('delete from modules where id=$1',[linkedModule]);
  const historicalChat = randomUUID();
  await sql.query("insert into conversations(id,user_id,model_id,title) values($1,$2,$3,'Retained model history')",[historicalChat,admin.id,target]);
  expect((await call('model.deleteModel',{id:target})).status).toBe(409);
  expect((await sql.query('select model_id from conversations where id=$1',[historicalChat])).rows[0].model_id).toBe(target);
  await sql.query('delete from conversations where id=$1',[historicalChat]);
  await page.goto(app + '/admin/models');
  await page.getByTestId('admin-model-delete-' + target).click();
  await page.getByRole('button',{name:'取消',exact:true}).click();
  expect((await sql.query('select id from ai_models where id=$1',[target])).rowCount).toBe(1);
  await page.getByTestId('admin-model-delete-' + target).click();
  await page.getByTestId('admin-model-delete-confirm').click();
  await expect.poll(async () => (await sql.query('select id from ai_models where id=$1',[target])).rowCount).toBe(0);
  expect((await call('model.deleteModel',{id:target})).status).toBe(200);
  expect((await call('model.deleteModel',{id:target})).status).toBe(200);
  expect((await sql.query('select id from ai_models where id=$1',[target])).rowCount).toBe(0);
  await sql.query("insert into system_settings(key,value) values('v3_summary_model_id',$1) on conflict(key) do update set value=excluded.value",[JSON.stringify(model)]);
  await expect(sql.query("update system_settings set value=$1 where key='v3_summary_model_id'",[JSON.stringify(target)])).rejects.toMatchObject({code:'23503'});
  expect((await sql.query("select value from system_settings where key='v3_summary_model_id'")).rows[0].value).toBe(model);
  await expect(sql.query("insert into system_settings(key,value) values('delete-test-untouched','true'),('v3_summary_model_id',$1) on conflict(key) do update set value=excluded.value",[JSON.stringify(target)])).rejects.toMatchObject({code:'23503'});
  expect((await sql.query("select value from system_settings where key='delete-test-untouched'")).rowCount).toBe(0);
  await expect(sql.query("insert into system_settings(key,value) values('ai_models',$1)",[JSON.stringify({haikuModelId:target})])).rejects.toMatchObject({code:'23503'});
  // Unknown setting UUIDs are ordinary content, not model references.
  await sql.query("insert into system_settings(key,value) values('delete-test-note',$1)",[JSON.stringify(target)]);
  // Do not leak the synthetic model-reference fixture into the later full-form
  // settings save, which validates whether the selected summary model is usable.
  await sql.query("delete from system_settings where key in ('v3_summary_model_id','delete-test-note')");
  if (previousSummarySetting.length) await sql.query("insert into system_settings(key,value) values('v3_summary_model_id',$1)", [JSON.stringify(previousSummarySetting[0].value)]);

  await ordinary.context.close(); await context.close();
  const privileges = await sql.query("select has_table_privilege('anon','ai_models','UPDATE') as anon,has_table_privilege('authenticated','modules','DELETE') as authenticated");
  expect(privileges.rows[0]).toEqual({anon:false,authenticated:false});
});
it('ADMIN: re-uploading a declared Skill updates the active steps and questions without editing front-end code', async () => {
  const administrator=await newUser();
  await sql.query("update profiles set role='admin' where id=$1",[administrator.id]);
  const input=adminModuleInput();
  await sql.query("insert into ai_models(id,model_id,name,provider,max_tokens,input_limit,config) values($1,'qwen/qwen3.8-27b','Workflow upload fixture','openai',4096,800000,$2)",[input.module.model_id, configuredReasoning('qwen/qwen3.8-27b')]);
  await seedTestOpenRouterKey(sql, 'LOCAL_ONLY');
  const directory=output+'/synthetic-method';mkdirSync(directory,{recursive:true});
  for(const file of input.files){
    const target=directory+'/'+file.path;mkdirSync(target.slice(0,target.lastIndexOf('/')),{recursive:true});
    writeFileSync(target,Buffer.from(file.base64,'base64'));
  }
  const labels=['需求确认','竞品研究','账号定位','内容策略','运营建议','商业规划','效果验证'];
  const declaration=(count:number,revised:boolean)=>[
    'kind: document','steps:',...labels.slice(0,count).flatMap((title,index)=>[
      `  - title: ${revised&&index===0?'竞品研究':revised&&index===1?'需求与目标':title}`,
      '    resources: [SKILL.md]','    information:',
      `      - id: ${revised&&index===0?'question_revised':`question_${index+1}`}`,
      `        title: ${revised&&index===0?'本期服务目标':`问题 ${index+1}`}`,
      '        required: true',`        profileKey: question_${index+1}`,
    ]),'',
  ].join('\n');
  writeFileSync(directory+'/workflow.yaml',declaration(6,false));
  const context=await browser.newContext(),page=await context.newPage();
  try {
    await page.goto(app+'/login?redirect=/admin/prompts');
    await page.getByPlaceholder('name@example.com').fill(administrator.email);
    await page.getByPlaceholder('输入你的密码').fill(administrator.password);
    await page.getByRole('button',{name:'登录',exact:true}).last().click();
    await page.waitForURL(url=>url.pathname==='/admin/prompts',{timeout:90000});
    await page.getByRole('button',{name:'新建模块',exact:true}).click();
    await page.getByLabel('功能类型',{exact:true}).selectOption('skill');
    await page.getByLabel('导入 Skill 文件夹',{exact:true}).setInputFiles(directory);
    await page.getByText('已载入 11 个文件',{exact:true}).waitFor();
    expect(await page.getByLabel('步骤 6 名称',{exact:true}).inputValue()).toBe('商业规划');
    await page.getByText('问题 1 · 必需',{exact:true}).waitFor();
    await page.getByTestId('prompt-name-input').fill(input.module.title);
    const model=page.getByRole('dialog').getByRole('combobox').filter({hasText:'不限制'});
    await model.click();await page.getByRole('option',{name:'Workflow upload fixture',exact:true}).click();
    await page.getByLabel('否',{exact:true}).check();
    await page.getByLabel('我已检查步骤顺序和各步使用的参考文件').check();
    await page.getByTestId('prompt-save').click();
    await expect.poll(()=>page.getByRole('dialog').count(),{timeout:30000}).toBe(0);
    const module=(await sql.query('select id from modules where title=$1',[input.module.title])).rows[0];
    const current=async()=> (await sql.query('select workflow from artifact_workflows where module_id=$1 and enabled',[module.id])).rows[0].workflow;
    expect((await current()).steps).toHaveLength(6);
    writeFileSync(directory+'/workflow.yaml',declaration(7,true));
    const row=page.getByRole('row').filter({hasText:input.module.title});
    await row.getByRole('button').first().click();
    await page.getByLabel('步骤 1 名称',{exact:true}).waitFor();
    await page.getByLabel('导入 Skill 文件夹',{exact:true}).setInputFiles(directory);
    await expect.poll(()=>page.getByLabel('步骤 7 名称',{exact:true}).inputValue()).toBe('效果验证');
    expect(await page.getByLabel('步骤 1 名称',{exact:true}).inputValue()).toBe('竞品研究');
    expect(await page.getByLabel('步骤 2 名称',{exact:true}).inputValue()).toBe('需求与目标');
    await page.getByText('本期服务目标 · 必需',{exact:true}).waitFor();
    await page.getByLabel('我已检查步骤顺序和各步使用的参考文件').check();
    await page.getByTestId('prompt-save').click();
    await expect.poll(()=>page.getByRole('dialog').count(),{timeout:30000}).toBe(0);
    expect((await current()).steps.map((step:{title:string})=>step.title))
      .toEqual(['竞品研究','需求与目标','账号定位','内容策略','运营建议','商业规划','效果验证']);
    expect((await current()).steps[0].information[0].title).toBe('本期服务目标');
    expect((await current()).steps[0].information[0].id).toBe('question_revised');
    expect((await sql.query('select count(*)::int n from artifact_workflows where module_id=$1 and enabled',[module.id])).rows[0].n).toBe(1);
  }finally{await context.close();}
},180000);


it('ADMIN: model deletion and settings writes serialize in both transaction orders', async () => {
  const admin = await newUser();
  await sql.query("update profiles set role='admin' where id=$1", [admin.id]);
  const holder = new pg.Client({connectionString:process.env.V3_LOCAL_DB});
  const waiter = new pg.Client({connectionString:process.env.V3_LOCAL_DB});
  await holder.connect(); await waiter.connect();
  const pid = (await waiter.query('select pg_backend_pid() as pid')).rows[0].pid;
  const waitForLock = () => expect.poll(async () => (await sql.query("select wait_event_type from pg_stat_activity where pid=$1",[pid])).rows[0]?.wait_event_type, {timeout:2000,interval:20}).toBe('Lock');
  const model = randomUUID();
  await sql.query("insert into ai_models(id,model_id,name) values($1,'concurrent-delete','Concurrent deletion model')",[model]);
  try {
    // Settings writes first: deletion waits, then refuses the committed reference.
    await holder.query('begin');
    await holder.query("insert into system_settings(key,value) values('primary_model_id',$1) on conflict(key) do update set value=excluded.value",[JSON.stringify(model)]);
    const deletion = waiter.query('select admin_delete_unused_model($1,$2)',[admin.id,model]).then(()=>'deleted', e=>e.code);
    await waitForLock(); await holder.query('commit');
    expect(await deletion).toBe('23503');
    expect((await sql.query('select id from ai_models where id=$1',[model])).rowCount).toBe(1);
    await sql.query("delete from system_settings where key='primary_model_id'");
    // Deletion first: the queued stale settings write is rejected after deletion commits.
    await holder.query('begin');
    await holder.query('select admin_delete_unused_model($1,$2)',[admin.id,model]);
    const setting = waiter.query("insert into system_settings(key,value) values('primary_model_id',$1)",[JSON.stringify(model)]).then(()=>'saved', e=>e.code);
    await waitForLock(); await holder.query('commit');
    expect(await setting).toBe('23503');
    expect((await sql.query("select key from system_settings where key='primary_model_id'")).rowCount).toBe(0);
    expect((await sql.query('select id from ai_models where id=$1',[model])).rowCount).toBe(0);
  } finally {
    await holder.query('rollback'); await waiter.query('rollback');
    await holder.end(); await waiter.end();
  }
});


it('ADMIN: settings save recovers under staging column grants without weakening authorization', async () => {
  const admin = await newUser();
  await sql.query("update profiles set role='admin' where id=$1", [admin.id]);
  await sql.query("create table if not exists membership_plans(id uuid primary key,sort_order integer); grant select on membership_plans to service_role; notify pgrst,'reload schema'");
  const { page, context } = await pageFor(admin);
  const beforeSettings = (await sql.query('select key,value from system_settings order by key')).rows;
  const profileColumns = (await sql.query("select column_name from information_schema.columns where table_schema='public' and table_name='profiles'")).rows.map(r => r.column_name);
  const migration = readFileSync(new URL('../../../../db/migrations/0076_admin_settings_writer_profile_read.sql', import.meta.url), 'utf8');
  const request = (name: string, data: unknown) => page.request.post(app + '/api/trpc/' + name, { data });
  const target = { key: 'max_input_characters', value: '10000' };
  try {
    // Reproduce the observed staging posture, instead of the fixture's GRANT ALL.
    await sql.query('revoke select on profiles from service_role');
    await sql.query('revoke select (' + profileColumns.map(c => '"' + c + '"').join(',') + ') on profiles from service_role');
    await sql.query('grant select(id,role,status,nickname,email,credits,membership_level,created_at) on profiles to service_role');
    const deniedRead = await db.from('profiles').select('role,status,is_deleted').eq('id',admin.id).single();
    expect(deniedRead.error?.code).toBe('42501');
    for (const [name,data] of [['settings.updateSystemSettings',target],['settings.updateSystemSettingsBulk',[target]]] as const) {
      const response = await request(name,data);
      expect(response.status()).toBe(503);
      const body = await response.text();
      expect(body).toContain('暂时无法验证设置保存权限');
      expect(body).not.toMatch(/permission denied|42501|is_deleted/);
    }
    await page.goto(app + '/admin/settings');
    await page.getByRole('tab',{name:'功能设置',exact:true}).click();
    await page.getByTestId('admin-setting-max_input_characters').fill('10000');
    await page.getByTestId('admin-setting-search_surcharge_credits').fill('5');
    await page.getByTestId('admin-settings-save-all').click();
    await page.getByText('暂时无法验证设置保存权限，请稍后重试',{exact:true}).waitFor();
    expect((await sql.query('select key,value from system_settings order by key')).rows).toEqual(beforeSettings);

    const grants = () => sql.query("select grantee,column_name,privilege_type from information_schema.column_privileges where table_schema='public' and table_name='profiles' and grantee in ('anon','authenticated','service_role') order by grantee,column_name,privilege_type").then(r=>r.rows);
    const beforeGrants = await grants();
    await sql.query(migration);
    const afterGrants = await grants();
    expect(afterGrants.filter(g=>!beforeGrants.some(b=>JSON.stringify(b)===JSON.stringify(g))))
      .toEqual([{grantee:'service_role',column_name:'is_deleted',privilege_type:'SELECT'}]);
    expect(beforeGrants.every(b=>afterGrants.some(g=>JSON.stringify(b)===JSON.stringify(g)))).toBe(true);
    await sql.query(migration);
    expect(await grants()).toEqual(afterGrants);
    expect((await sql.query('select key,value from system_settings order by key')).rows).toEqual(beforeSettings);

    // The failed draft stays on screen and succeeds with the same Save All click.
    await page.getByTestId('admin-settings-save-all').click();
    await page.getByText('设置保存成功',{exact:true}).waitFor();
    await page.reload();
    await page.getByRole('tab',{name:'功能设置',exact:true}).click();
    expect(await page.getByTestId('admin-setting-max_input_characters').inputValue()).toBe('10000');
    expect(await page.getByTestId('admin-setting-search_surcharge_credits').inputValue()).toBe('5');
    expect((await sql.query("select value from system_settings where key='max_input_characters'")).rows[0].value).toBe('10000');
    expect((await request('settings.updateSystemSettings',{key:'max_input_characters',value:'12000'})).status()).toBe(200);
    await page.screenshot({path:output + '/admin-settings-save-recovered.png'});
    const saved = (await sql.query('select key,value from system_settings order by key')).rows;

    for (const patch of ["is_deleted='true'", "status='disabled'", "status='banned'", "role='user'"]) {
      await sql.query('update profiles set ' + patch + ' where id=$1',[admin.id]);
      for (const [name,data] of [['settings.updateSystemSettings',target],['settings.updateSystemSettingsBulk',[target]]] as const) {
        expect((await request(name,data)).status()).toBe(403);
      }
      expect((await sql.query('select key,value from system_settings order by key')).rows).toEqual(saved);
      await sql.query("update profiles set is_deleted='false',status='active',role='admin' where id=$1",[admin.id]);
    }
    const user = await authenticated();
    const anon = createClient(url,process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,{auth:{persistSession:false}});
    for (const client of [user,anon]) expect((await client.from('system_settings').upsert(target)).error).not.toBeNull();
    for (const [name,data] of [['settings.updateSystemSettings',target],['settings.updateSystemSettingsBulk',[target]]] as const) {
      expect((await fetch(app+'/api/trpc/'+name,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)})).status).toBe(401);
    }
    // Recovery revokes only the new column grant, preserves data, and fails closed.
    await sql.query('revoke select(is_deleted) on profiles from service_role');
    expect((await request('settings.updateSystemSettings',target)).status()).toBe(503);
    expect((await sql.query('select key,value from system_settings order by key')).rows).toEqual(saved);
    await sql.query(migration);
    expect((await request('settings.updateSystemSettings',target)).status()).toBe(200);
  } finally {
    await sql.query('grant select on profiles to service_role');
    await sql.query("update profiles set is_deleted='false',status='active',role='admin' where id=$1",[admin.id]);
    await context.close();
  }
},180000);

it('ADMIN: settings save submits the complete form with selected model records and rejects stale or named models atomically', async () => {
  const admin = await newUser();
  await sql.query("update profiles set role='admin' where id=$1",[admin.id]);
  await sql.query("create table if not exists membership_plans(id uuid primary key,sort_order integer); grant select on membership_plans to service_role; notify pgrst,'reload schema'");
  const primary=randomUUID(),assistant=randomUUID();
  for(const [id,name,model] of [[primary,'Settings Qwen','qwen/qwen3.8-27b'],[assistant,'Settings Luna','openai/gpt-5.6-luna']]) {
    await sql.query("insert into ai_models(id,name,model_id,provider,api_endpoint,max_tokens,input_limit,token_counting_supported,tokenizer_family,input_token_cost,output_token_cost) values($1,$2,$3,'openai','',4096,800000,'false','openai',150000,2000000)",[id,name,model]);
  }
  await seedTestOpenRouterKey(sql, 'SETTINGS_PRIVATE_CANARY');
  const snapshot=()=>sql.query('select key,value from system_settings order by key').then(r=>r.rows);
  const before=await snapshot();
  // Actual canonical model-reference trigger reproduces the user's old failure.
  const oldWrite=await db.from('system_settings').upsert([{key:'max_input_characters',value:'10000'},{key:'primary_model_id',value:'openai/gpt-5.6-luna'}],{onConflict:'key'});
  expect(oldWrite.error?.code).toBe('23503');expect(await snapshot()).toEqual(before);
  const {page,context}=await pageFor(admin);
  try {
    await page.goto(app+'/admin/settings');
    await page.getByRole('tab',{name:'功能设置',exact:true}).click();
    await expect.poll(()=>page.getByLabel('主力模型',{exact:true}).locator('option[value="'+assistant+'"]').count()).toBe(1);
    await page.getByLabel('主力模型',{exact:true}).selectOption(primary);
    await page.getByLabel('步骤成果整理模型',{exact:true}).selectOption(assistant);
    for(const [key,value] of [['max_input_characters','10000'],['search_surcharge_credits','5']])await page.getByTestId('admin-setting-'+key).fill(value);
    let submitted: Record<string,Array<{key:string;value:string}>> | null=null;
    const pattern='**/api/trpc/settings.updateSystemSettingsBulk**';
    const capture=async(route:import('../../../../../apps/web/node_modules/@playwright/test').Route)=>{submitted=route.request().postDataJSON();await route.abort();};
    await page.route(pattern,capture);
    await page.getByTestId('admin-settings-save-all').click();
    await expect.poll(()=>submitted!==null).toBe(true);
    await page.unroute(pattern,capture);
    const full=(submitted! as Record<string,Array<{key:string;value:string}>>)['0'];
    expect(full.length).toBe(34);
    expect(full).toEqual(expect.arrayContaining([{key:'primary_model_id',value:primary},{key:'v3_summary_model_id',value:assistant},{key:'max_input_characters',value:'10000'},{key:'search_surcharge_credits',value:'5'}]));
    // Exercise the full batch envelope, not a single-row surrogate.
    for(const invalid of ['openai/gpt-5.6-luna',randomUUID()]) {
      const payload=full.map(item=>item.key==='primary_model_id'?{...item,value:invalid}:item);
      const response=await page.request.post(app+'/api/trpc/settings.updateSystemSettingsBulk?batch=1',{data:{0:payload}});
      expect(response.status()).toBe(400);expect(await response.text()).not.toContain('SETTINGS_PRIVATE_CANARY');
      expect(await snapshot()).toEqual(before);
    }
    // A model can become unavailable after loading the selector. The actual UI
    // shows the actionable server message and retains every draft value.
    await sql.query("update ai_models set is_active='false' where id=$1",[primary]);
    await page.getByTestId('admin-settings-save-all').click();
    await page.getByText('所选主力模型已删除或停用，请刷新模型列表后重新选择',{exact:true}).waitFor();
    expect(await snapshot()).toEqual(before);
    expect(await page.getByTestId('admin-setting-max_input_characters').inputValue()).toBe('10000');
    await sql.query("update ai_models set is_active='true' where id=$1",[primary]);
    const savedResponse=page.waitForResponse(r=>r.url().includes('settings.updateSystemSettingsBulk')&&r.request().method()==='POST');
    await page.getByTestId('admin-settings-save-all').click();
    expect((await savedResponse).status()).toBe(200);
    await page.getByText('设置保存成功',{exact:true}).waitFor();
    const persisted=await snapshot();
    for(const item of full)expect(persisted.find(row=>row.key===item.key)?.value).toEqual(item.value);
    await page.reload();
    await page.getByRole('tab',{name:'功能设置',exact:true}).click();
    for(const item of full.filter(item=>['primary_model_id','v3_summary_model_id','max_input_characters','search_surcharge_credits'].includes(item.key)))expect(await page.getByTestId('admin-setting-'+item.key).inputValue()).toBe(item.value);
    await page.screenshot({path:output+'/settings-models-full-save.png'});
    // Optional blank selections remain valid and survive reload.
    await page.getByLabel('主力模型',{exact:true}).selectOption('');
    await page.getByTestId('admin-settings-save-all').click();
    await page.getByText('设置保存成功',{exact:true}).waitFor();
    await page.reload();await page.getByRole('tab',{name:'功能设置',exact:true}).click();
    expect(await page.getByLabel('主力模型',{exact:true}).inputValue()).toBe('');
    // The new lightweight catalog neither exposes credentials nor requires a
    // model to be eligible for Skill summary work.
    const catalog=await page.request.get(app+'/api/trpc/settings.getRoutingModels');
    expect(catalog.status()).toBe(200);expect(await catalog.text()).not.toContain('SETTINGS_PRIVATE_CANARY');
    const normal=await pageFor();
    try {expect((await normal.page.request.get(app+'/api/trpc/settings.getRoutingModels')).status()).toBe(403);}
    finally {await normal.context.close();}
    expect((await fetch(app+'/api/trpc/settings.getRoutingModels')).status).toBe(401);
  } finally {
    await context.close();
    await sql.query("update ai_models set is_active='true' where id=$1",[primary]);
  }
},180000);
