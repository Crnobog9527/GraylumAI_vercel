/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Run against the existing run-workbench.mjs --settings-only --serve fixture.
// ADMISSION_LOCAL_EVIDENCE is its local output directory; V3_LOCAL_DB must be
// the matching disposable database. Never accepts a remote application or DB.
import { beforeAll, beforeEach, afterAll, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import pg from 'pg';
const evidence = process.env.ADMISSION_LOCAL_EVIDENCE;
const connection = new URL(process.env.V3_LOCAL_DB ?? 'http://invalid');
if (!evidence || connection.hostname !== '127.0.0.1' || connection.pathname !== '/v3_disposable') {
  throw new Error('An explicit existing disposable workbench fixture is required');
}
const acceptance = JSON.parse(readFileSync(resolve(evidence, 'acceptance.json'), 'utf8'));
const app = new URL(acceptance.url);
if (app.hostname !== '127.0.0.1' || app.protocol !== 'http:' || !acceptance.mode.startsWith('Synthetic local transport only')) {
  throw new Error('Only the synthetic local workbench application is allowed');
}
const sql = new pg.Client({ connectionString: connection.href });
const requireWeb = createRequire(new URL('../../../../apps/web/package.json', import.meta.url));
const { chromium } = requireWeb('@playwright/test') as typeof import('../../../../apps/web/node_modules/@playwright/test');
let browser: Awaited<ReturnType<typeof chromium.launch>>;
let actor: string, token: string, modelId: string;
let publicApi: string, publicKey: string;
let authBefore: {email_confirmed_at: string; raw_app_meta_data: unknown};
let identitiesBefore: Array<{id: string; identity_data: unknown}>;

beforeAll(async () => {
  await sql.connect();
  browser = await chromium.launch({headless:true, ...(process.platform === 'darwin' ? {executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'} : {})});
  const context = await browser.newContext();
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    return ['127.0.0.1','localhost'].includes(url.hostname) || ['data:','blob:'].includes(url.protocol)
      ? route.continue() : route.abort();
  });
  let captureLogin!: (value:{session:any;origin:string;key:string})=>void;
  const signedIn = new Promise<{session:any;origin:string;key:string}>(resolve=>{captureLogin=resolve;});
  await context.route('**/auth/v1/token**',async route=>{
    const origin=new URL(route.request().url()).origin;
    if(new URL(origin).hostname!=='127.0.0.1')return route.abort();
    // Capture the real local Auth response before navigation discards Chrome's
    // response buffer; this still performs the actual GoTrue login request.
    const response=await route.fetch({maxRedirects:0}),session=await response.json();
    await route.fulfill({response});
    if(response.ok())captureLogin({session,origin,key:route.request().headers().apikey});
  });
  const page = await context.newPage();
  const ready = page.waitForResponse(r=>r.url().includes('/api/trpc/settings.getSystemSettings') && r.ok());
  await page.goto(app.origin+'/login?redirect=/chat');
  await ready;
  await page.getByPlaceholder('name@example.com').fill(acceptance.credentials.email);
  await page.getByPlaceholder('输入你的密码').fill(acceptance.credentials.password);
  await page.getByRole('button',{name:'登录',exact:true}).last().click();
  const loginResponse = await signedIn;
  publicApi = loginResponse.origin;
  publicKey = loginResponse.key;
  const session = loginResponse.session;
  token = session.access_token; actor = session.user.id;
  await context.close();
  authBefore = (await sql.query('select email_confirmed_at, raw_app_meta_data from auth.users where id=$1',[actor])).rows[0];
  identitiesBefore = (await sql.query('select id, identity_data from auth.identities where user_id=$1',[actor])).rows;
  if (!authBefore || !actor || !identitiesBefore.length) throw new Error('Application/database fixture identity mismatch');
  // Reuse this suite's synthetic model when rerunning against the same fixture;
  // duplicate provider aliases would make the production price lookup ambiguous.
  modelId = (await sql.query("select id from ai_models where name='Admission fixture' and api_key='LOCAL_SYNTHETIC_KEY' limit 1")).rows[0]?.id;
  if (!modelId) {
    modelId = randomUUID();
    await sql.query("insert into ai_models(id,model_id,name,provider,api_key,api_endpoint,max_tokens,input_limit,token_counting_supported,tokenizer_family,input_token_cost,output_token_cost) values($1,'openai/gpt-4o-mini-2024-07-18','Admission fixture','openai','LOCAL_SYNTHETIC_KEY','https://openrouter.ai/api/v1',4096,128000,'true','openai',150000,600000)",[modelId]);
  }
  await sql.query("insert into system_settings(key,value) values('primary_model_id',$1),('assistant_model_id',$1) on conflict(key) do update set value=excluded.value",[JSON.stringify(modelId)]);
  // Replace the broad billing scaffold with the repository's 0063 service-role
  // read shape; caller consumption is supplied only by migration 0079.
  await sql.query('revoke select on billing_history from service_role; revoke select(user_id) on billing_history from service_role; grant select(operation_type,amount,created_at) on billing_history to service_role');
  const canonical = readFileSync(new URL('../../../../packages/db/migrations/0001_ai_billing_tables.sql',import.meta.url),'utf8');
  const consumptionMigration=readFileSync(new URL('../../../../packages/db/migrations/0079_ai_consumption_read_contract.sql',import.meta.url),'utf8');
  await sql.query(consumptionMigration);await sql.query(consumptionMigration);
  for (const table of ['ai_usage_logs']) {
    const name = `users_own_${table}_select`;
    const start = canonical.indexOf(`CREATE POLICY "${name}"`), end = canonical.indexOf(';',start)+1;
    if (start < 0 || end <= start) throw new Error('Missing canonical own-row policy');
    await sql.query(`drop policy if exists "${name}" on ${table}; grant select on ${table} to authenticated`);
    await sql.query(canonical.slice(start,end));
  }
  expect((await sql.query("select has_table_privilege('service_role','billing_history','SELECT') as broad, has_column_privilege('service_role','billing_history','user_id','SELECT') as filter")).rows[0]).toEqual({broad:false,filter:false});
}, 90000);

beforeEach(async () => {
  await sql.query("update profiles set status='active',credits=100000,role='user' where id=$1",[actor]);
  await sql.query('update auth.users set email_confirmed_at=$2,raw_app_meta_data=$3 where id=$1',[actor,authBefore.email_confirmed_at,authBefore.raw_app_meta_data]);
  for (const row of identitiesBefore) await sql.query('update auth.identities set identity_data=$2 where id=$1',[row.id,row.identity_data]);
  await sql.query('delete from billing_history where user_id=$1',[actor]);
  await sql.query('delete from ai_usage_logs where user_id=$1',[actor]);
  await sql.query("insert into system_settings(key,value) values('enable_free_tier','false'),('maintenance_mode','false') on conflict(key) do update set value=excluded.value");
});
afterAll(async () => {
  // All identities, SQL and records belong to the disposable runner and are
  // destroyed when it exits. No external service or commercial model is used.
  await browser?.close();
  await sql.end();
});

async function send(access: string | null = token) {
  const response = await fetch(app.origin+'/api/ai/stream', {
    method:'POST',headers:{'Content-Type':'application/json',...(access ? {Authorization:`Bearer ${access}`} : {})},
    body:JSON.stringify({message:'Hello from isolated admission verification',modelId,requestId:randomUUID()}),
  });
  const body = await response.text();
  const rows = (await sql.query("select operation_type,count(*)::integer as count from billing_history where user_id=$1 group by operation_type",[actor])).rows;
  const reservations = rows.find(r=>r.operation_type==='pre_deduct')?.count ?? 0;
  return {status:response.status,body,reservations};
}
async function deny(status: number, access: string | null = token) {
  const result = await send(access);
  expect({status:result.status,reservations:result.reservations}).toEqual({status,reservations:0});
  expect(result.body).not.toContain('"type":"init"');
  expect(result.body).not.toContain('permission denied');
  expect(result.body).not.toContain('SELECT');
}
async function unverify() {
  await sql.query('update auth.users set email_confirmed_at=null where id=$1',[actor]);
  await sql.query("update auth.identities set identity_data=jsonb_set(identity_data,'{email_verified}','false') where user_id=$1",[actor]);
}

it('direct HTTP rejects missing and invalid sessions with no reservation',async()=>{await deny(401,null);await deny(401,'invalid-local-token');});
it('direct HTTP rejects an actually unverified Auth identity, ignoring editable metadata',async()=>{
  await unverify();
  await sql.query("update auth.users set raw_user_meta_data=jsonb_set(coalesce(raw_user_meta_data,'{}'),'{email_verified}','true') where id=$1",[actor]);
  await deny(403);
});
it.each(['disabled','banned','pending'])('direct HTTP denies database profile status %s',async status=>{
  await sql.query('update profiles set status=$2 where id=$1',[actor,status]);await deny(status==='pending'?503:403);
});
it.each([['hour',10000,'30 minutes'],['day',50000,'2 hours']] as const)('direct HTTP enforces the public %s limit against real SQL',async(_name,amount,age)=>{
  await sql.query("insert into billing_history(user_id,operation_type,amount,created_at) values($1,'settle',$2,now()-$3::interval)",[actor,-amount,age]);await deny(403);
});
it('direct HTTP fails closed when consumption SELECT is denied',async()=>{
  await sql.query('revoke select(user_id,operation_type,amount,created_at) on billing_history from authenticated');
  try {await deny(503);} finally {await sql.query('grant select(user_id,operation_type,amount,created_at) on billing_history to authenticated');}
});
it('direct HTTP fails closed when profile state cannot be read',async()=>{
  await sql.query('revoke select(status,role) on profiles from authenticated');
  try {await deny(503);} finally {await sql.query('grant select(status,role) on profiles to authenticated');}
});
it('direct HTTP keeps maintenance and paid balance rejection',async()=>{
  await sql.query("update system_settings set value='true' where key='maintenance_mode'");await deny(503);
  await sql.query("update system_settings set value='false' where key='maintenance_mode'");
  await sql.query('update profiles set credits=0 where id=$1',[actor]);await deny(402);
});
it.each(['email','google'])('direct HTTP allows legitimate %s identities with one real reservation and completed answer',async provider=>{
  if(provider==='google') {await unverify();await sql.query("update auth.users set raw_app_meta_data=jsonb_build_object('provider','google','providers',jsonb_build_array('google')) where id=$1",[actor]);}
  const result=await send();expect(result.status).toBe(200);expect(result.reservations).toBe(1);expect(result.body).toContain('"type":"complete"');
  expect(result.body).toContain('Synthetic local free/document reply');
});
it('direct HTTP preserves eligible free trial without pre-deduction',async()=>{
  await sql.query('update profiles set credits=0 where id=$1',[actor]);
  await sql.query("insert into system_settings(key,value) values('enable_free_tier','true'),('free_tier_messages','100000') on conflict(key) do update set value=excluded.value");
  const result=await send();expect(result.status).toBe(200);expect(result.reservations).toBe(0);expect(result.body).toContain('"type":"complete"');
});
it('direct HTTP excludes another user consumption and the own-row policy hides it',async()=>{
  const other = (await sql.query('select id from profiles where id<>$1 limit 1',[actor])).rows[0].id;
  const entry = (await sql.query("insert into billing_history(user_id,operation_type,amount) values($1,'settle',-50000) returning id",[other])).rows[0].id;
  try {
    const response = await fetch(`${publicApi}/rest/v1/billing_history?select=amount&user_id=eq.${other}`,{headers:{apikey:publicKey,Authorization:`Bearer ${token}`}});
    expect(response.status).toBe(200);expect(await response.json()).toEqual([]);
    const result=await send();expect(result.status).toBe(200);expect(result.reservations).toBe(1);
  } finally {await sql.query('delete from billing_history where id=$1',[entry]);}
});
it('direct HTTP rejects exhausted free trial using readable real usage rows',async()=>{
  await sql.query('update profiles set credits=0 where id=$1',[actor]);
  await sql.query("insert into system_settings(key,value) values('enable_free_tier','true'),('free_tier_messages','1') on conflict(key) do update set value=excluded.value");
  await sql.query("insert into ai_usage_logs(user_id,request_id,model_id,status) values($1,$2,'admission-fixture','success')",[actor,randomUUID()]);
  const read = await fetch(`${publicApi}/rest/v1/ai_usage_logs?select=id&user_id=eq.${actor}`,{headers:{apikey:publicKey,Authorization:`Bearer ${token}`}});
  expect(read.status).toBe(200);expect(await read.json()).toHaveLength(1);
  await deny(402);
});
