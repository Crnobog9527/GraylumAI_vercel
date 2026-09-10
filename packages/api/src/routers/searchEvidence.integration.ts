/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeAll, afterAll, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const requireWeb=createRequire(new URL('../../../../apps/web/package.json',import.meta.url));
const {chromium}=requireWeb('@playwright/test') as typeof import('../../../../apps/web/node_modules/@playwright/test');
let browser:Awaited<ReturnType<typeof chromium.launch>>;
let credentials:{email:string;password:string},otherToken:string;
const repaired=process.env.SEARCH_BASELINE==='1'?it.skip:it;
const app = process.env.V3_LOCAL_APP!, api = process.env.V3_LOCAL_REST!;
if (![app,api].every(v => v?.startsWith('http://127.0.0.1:')) || !process.env.V3_LOCAL_DB?.endsWith('/v3_disposable')) throw new Error('Disposable local runner required');
const sql = new pg.Client({connectionString:process.env.V3_LOCAL_DB});
const admin = createClient(api,process.env.V3_LOCAL_SERVICE_JWT!,{auth:{persistSession:false}});
const baseline = process.env.SEARCH_BASELINE === '1';
let actor:string, token:string, modelId:string;
beforeAll(async () => {
  await sql.connect();
  const email=randomUUID()+'@example.test',password='Local-'+randomUUID()+'!';
  const created=await admin.auth.admin.createUser({email,password,email_confirm:true});
  if(created.error)throw created.error; actor=created.data.user.id;
  await sql.query("insert into profiles(id,email,nickname,role,credits) values($1,$2,'Chat fixture','user',100000)",[actor,email]);
  credentials={email,password};
  const login=await createClient(api,process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,{auth:{persistSession:false}}).auth.signInWithPassword({email,password}); if(login.error)throw login.error; token=login.data.session.access_token;
  modelId=randomUUID();
  await sql.query("insert into ai_models(id,model_id,name,provider,api_key,api_endpoint,max_tokens,input_limit,token_counting_supported,tokenizer_family,input_token_cost,output_token_cost) values($1,'openai/gpt-4o-mini-2024-07-18','Chat fixture','openai','LOCAL_SYNTHETIC_KEY','https://openrouter.ai/api/v1',4096,128000,'true','openai',150000,600000)",[modelId]);
  await sql.query("insert into system_settings(key,value) values('primary_model_id',$1),('assistant_model_id',$1),('enable_free_tier','false') on conflict(key) do update set value=excluded.value",[JSON.stringify(modelId)]);
  expect((await sql.query("select has_table_privilege('service_role','billing_history','SELECT') broad,has_column_privilege('service_role','billing_history','user_id','SELECT') as can_filter")).rows[0]).toEqual({broad:false,can_filter:false});
  const otherEmail=randomUUID()+'@example.test';
  const other=await admin.auth.admin.createUser({email:otherEmail,password,email_confirm:true});if(other.error)throw other.error;
  await sql.query("insert into profiles(id,email,credits) values($1,$2,100000)",[other.data.user.id,otherEmail]);
  const otherLogin=await createClient(api,process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,{auth:{persistSession:false}}).auth.signInWithPassword({email:otherEmail,password});if(otherLogin.error)throw otherLogin.error;otherToken=otherLogin.data.session.access_token;
  browser=await chromium.launch({headless:true,...(process.platform==='darwin'?{executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'}:{})});
  for(let i=0;i<180;i++){try{if((await fetch(app+'/login')).ok)return;}catch{}await new Promise(r=>setTimeout(r,500));}
  throw new Error('Local app not ready');
},180000);
afterAll(async()=>{
 {const rows=await sql.query('select request_id,state,pre_deduct_id,stop_requested_at from ordinary_chat_requests where user_id=$1 order by created_at',[actor]);
 writeFileSync(resolve(process.env.V3_WORKBENCH_OUTPUT!,'search-observed.json'),JSON.stringify(rows.rows,null,2));}
 await browser?.close();await sql.end();
},60000);
const make = (mode='OK') => ({requestId:randomUUID(),modelId,message:'SEARCH_CASE_'+mode+'_'+randomUUID().replaceAll('-','')});
async function send(body:ReturnType<typeof make>&{conversationId?:string;moduleId?:string},access=token){const r=await fetch(app+'/api/ai/stream',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+access},body:JSON.stringify(body)});return {status:r.status,body:await r.text()};}
async function calls(key:string){const data=await (await fetch(api+'/__search_calls')).json() as Array<{key:string}>;return data.filter(c=>c.key===key).length;}
async function accounting(requestId:string){return (await sql.query("select operation_type,count(*)::int count from billing_history where user_id=$1 and (metadata->>'requestId'=$2 or metadata->>'preDeductId' in (select id::text from billing_history where metadata->>'requestId'=$2)) group by operation_type",[actor,requestId])).rows;}
async function setting(key:string,value:unknown){await sql.query('insert into system_settings(key,value) values($1,$2) on conflict(key) do update set value=excluded.value',[key,JSON.stringify(value)]);}
async function native(model='gemini-3-flash-preview',enabled=true,endpoint:string|null=null){
 await sql.query("update ai_models set model_id=$2,provider='google',api_endpoint=$3,enable_web_search=$4,token_counting_method='provider_usage',tokenizer_family='gemini',web_search_cost=14000000 where id=$1",[modelId,model,endpoint,enabled?'true':'false']);
 await setting('enable_smart_search_decision',true);await setting('search_surcharge_credits','7');
}
async function snapshot(id:string){const r=await fetch(app+'/api/ai/requests?requestId='+id,{headers:{Authorization:'Bearer '+token}});expect(r.status).toBe(200);return (await r.json()).request;}
async function row(id:string){return (await sql.query('select * from ordinary_chat_requests where request_id=$1',[id])).rows[0];}
async function observed(body:ReturnType<typeof make>){const r=await row(body.requestId);const provider=(await (await fetch(api+'/__search_calls')).json()).filter((c:any)=>c.key===body.message.match(/SEARCH_CASE_[a-zA-Z0-9_-]+/)?.[0]);return {provider,r,ledger:await accounting(body.requestId),public:await snapshot(body.requestId)};}
const request=(mode:string,prefix='搜索最新资料后改写：')=>{const body=make(mode);body.message=prefix+body.message;return body;};
it.each(['不要联网，解释今天这个词：','Don’t search the web; answer from memory: ','Do not perform a web search. Tell me the current weather: ','不需要搜索最新资料，直接总结：'])('explicit prohibition %s prevents tools and search reservation',async prefix=>{
 await native();const body=request('ONE',prefix);await send(body);const v=await observed(body);
 console.log('SEARCH_PROHIBITION',JSON.stringify({tools:v.provider[0]?.tools,reservation:v.r.reservation,search:v.public.search}));
 expect(v.provider).toHaveLength(1);expect(v.provider[0].tools).toEqual([]);expect(v.public.search).toMatchObject({executed:false,queryCount:0});
});
it('mixed intent really offers the native tool and records execution',async()=>{
 await native();const body=request('ONE');await send(body);const v=await observed(body);
 console.log('SEARCH_MIXED',JSON.stringify({tools:v.provider[0]?.tools,search:v.public.search,ledger:v.ledger}));
 expect(v.provider[0].tools).toEqual([{google_search:{}}]);expect(v.public.search).toMatchObject({status:'verified',queryCount:1,providerUnits:1});
});
it('zero executions never count tool availability as one search',async()=>{
 await native();const body=request('ZERO','搜索最新资料：');await send(body);const v=await observed(body);
 console.log('SEARCH_ZERO',JSON.stringify({savedSearchCount:v.r.response_params?.p_search_count,search:v.public.search}));
 expect(v.r.response_params?.p_search_count).toBe(0);expect(v.public.search).toMatchObject({executed:false,queryCount:0,providerUnits:0,surchargeCredits:0});
});
it('unavailable compatible transport adds no search pre-deduction',async()=>{
 await native('gemini-2.5-flash',true,'https://openrouter.ai/api/v1');
 const body=request('ONE','搜索最新资料：');await send(body);const first=await observed(body);
 await setting('search_surcharge_credits','9000');await sql.query('update ai_models set web_search_cost=90000000 where id=$1',[modelId]);
 const secondBody=request('ONE','搜索最新资料：');await send(secondBody);const second=await observed(secondBody);
 const reserved=(r:any)=>Number(r.reservation.balance_before)-Number(r.reservation.balance_after);
 console.log('SEARCH_UNAVAILABLE',JSON.stringify({first:reserved(first.r),second:reserved(second.r)}));
 expect(first.provider[0].tools).toEqual([]);expect(reserved(first.r)).toBe(reserved(second.r));expect(second.public.search).toMatchObject({available:false,status:'unavailable',surchargeCredits:0});
});
repaired.each(['ZERO','ONE','MULTI','MULTI_DUPLICATE'])('actual %s execution settles and recovers once',async mode=>{
 await native();const body=request(mode);await send(body);const v=await observed(body);const count=mode==='ZERO'?0:mode==='ONE'?1:3;
 expect(v.public.state).toBe('succeeded');expect(v.public.search).toMatchObject({queryCount:count,providerUnits:count,surchargeCredits:count?7:0});
 expect(Number(v.r.response_params.p_total_cost_usd)).toBeCloseTo(0.000138+count*0.014,6);
 expect(v.r.response_params.p_search_count).toBe(count);expect(v.provider).toHaveLength(1);
 await Promise.all([send(body),send(body),snapshot(body.requestId)]);expect((await observed(body)).provider).toHaveLength(1);
 expect(v.ledger).toEqual(expect.arrayContaining([{operation_type:'pre_deduct',count:1},{operation_type:'settle',count:1}]));
});
repaired('Gemini 2.5 cost uses one grounded prompt and retains three queries',async()=>{
 await native('gemini-2.5-flash');const body=request('MULTI');await send(body);const v=await observed(body);
 expect(v.public.search).toMatchObject({queryCount:3,providerUnit:'grounded-prompt',providerUnits:1});
});
repaired.each(['MISSING','CORRUPT','TIMEOUT','TRANSPORT_LOSS'])('%s stays unknown, retains original input and never redispatches or refunds',async mode=>{
 await native();const body=request(mode);await send(body);const v=await observed(body);
 expect(v.public.state).toBe('unknown');expect(v.public.input.message).toBe(body.message);if(['MISSING','CORRUPT'].includes(mode))expect(v.public.content).toContain('Local answer');
 await Promise.all([send(body),send(body),snapshot(body.requestId)]);const after=await observed(body);expect(after.provider).toHaveLength(1);expect(after.ledger).toEqual([{operation_type:'pre_deduct',count:1}]);
});
repaired.each(['disabled','model-disabled','unreviewed'])('%s has zero search fee and no tools',async mode=>{
 await native(mode==='unreviewed'?'gemini-unreviewed':'gemini-3-flash-preview',mode!=='model-disabled');if(mode==='disabled')await setting('enable_smart_search_decision',false);
 await setting('search_surcharge_credits','invalid');const body=request('ONE');await send(body);const v=await observed(body);expect(v.public.state).toBe('succeeded');expect(v.provider[0].tools).toEqual([]);expect(v.public.search.surchargeCredits).toBe(0);
});
repaired.each([null,'','invalid',-1,1000000])('invalid stored search price %j denies before reservation and HTTP',async price=>{
 await native();await setting('search_surcharge_credits',price);const body=request('ONE');const response=await send(body);expect(response.status).toBe(503);const v=await observed(body);expect(v.provider).toHaveLength(0);expect(v.ledger).toEqual([]);
});
repaired('admin price save / SQL read / chat consumption preserve number and canonical string',async()=>{
 await native();await sql.query("update profiles set role='admin' where id=$1",[actor]);
 const login=await createClient(api,process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,{auth:{persistSession:false}}).auth.signInWithPassword(credentials);if(login.error)throw login.error;
 const {createServerClient}=requireWeb('@supabase/ssr');const cookies:any[]=[];const client=createServerClient(api,process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,{cookies:{getAll:()=>[],setAll:(v:any[])=>cookies.push(...v)}});await client.auth.setSession(login.data.session);
 const update=async(value:unknown)=>fetch(app+'/api/trpc/settings.updateSystemSettingsBulk',{method:'POST',headers:{Cookie:cookies.map(c=>c.name+'='+c.value).join('; '),'Content-Type':'application/json'},body:JSON.stringify([{key:'search_surcharge_credits',value}])});
 try{
  for(const price of [7,'7',0,'0']){const response=await update(price);expect(response.status).toBe(200);expect((await sql.query("select value from system_settings where key='search_surcharge_credits'")).rows[0].value).toBe(price);const body=request('ONE');await send(body);expect((await snapshot(body.requestId)).search.surchargeCredits).toBe(Number(price));}
  for(const price of [null,'',-1,'01',1000000])expect((await update(price)).status).toBe(400);
 }finally{await sql.query("update profiles set role='user' where id=$1",[actor]);}
});
repaired('browser response loss and refresh restore original sources and cannot execute provider HTML',async()=>{
 await native();await setting('chat_show_model_selector',false);const context=await browser.newContext();await context.route('**/*',r=>['127.0.0.1','localhost'].includes(new URL(r.request().url()).hostname)?r.continue():r.abort());const page=await context.newPage();let submitted:any;
 try{
  await page.goto(app+'/login?redirect=/chat');await page.getByPlaceholder('name@example.com').fill(credentials.email);await page.getByPlaceholder('输入你的密码').fill(credentials.password);await page.getByRole('button',{name:'登录',exact:true}).last().click();await page.waitForURL(u=>u.pathname==='/chat',{timeout:90000});
  await page.route('**/api/ai/stream',async route=>{submitted=route.request().postDataJSON();await route.fetch();await route.abort();});
  const body=request('MULTI_DUPLICATE');await page.getByTestId('chat-input').fill(body.message);await page.getByRole('button',{name:'发送',exact:true}).click();
  await page.getByRole('link',{name:'Local verified source'}).waitFor({timeout:60000});await page.reload();await page.getByRole('link',{name:'Local verified source'}).waitFor({timeout:45000});
  expect(await page.getByRole('link',{name:'Local verified source'}).getAttribute('href')).toBe('https://example.test/search-source');expect(await page.getByText('UNSAFE',{exact:true}).count()).toBe(0);
  expect((await observed(submitted)).provider).toHaveLength(1);await page.screenshot({path:resolve(process.env.V3_WORKBENCH_OUTPUT!,'search-recovery.png')});
 }finally{await context.close();}
},120000);
repaired('search result survives settlement rollback, denied new spending and same-request recovery',async()=>{
 await native();const body=request('MULTI');
 await sql.query(`CREATE TABLE search_test_fail(enabled boolean); INSERT INTO search_test_fail VALUES(true);
 CREATE FUNCTION search_test_block_message() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM search_test_fail WHERE enabled) THEN RAISE EXCEPTION 'local search settlement fault'; END IF; RETURN NEW; END $$;
 CREATE TRIGGER search_test_message BEFORE INSERT ON messages FOR EACH ROW EXECUTE FUNCTION search_test_block_message();`);
 try{
  await send(body);const saved=await snapshot(body.requestId);expect(saved.state).toBe('responded');expect(saved.search.queryCount).toBe(3);expect(saved.search.sources[0].title).toBe('Local verified source');
  await sql.query('update search_test_fail set enabled=false');await sql.query('update profiles set credits=0 where id=$1',[actor]);
  const results=await Promise.all([snapshot(body.requestId),send(body),snapshot(body.requestId)]);expect(results[0].state).toBe('responded');expect(results[0].search.queryCount).toBe(3);
  // Actual multi-query cost exceeds the estimate; insufficient remaining balance
  // must retain the saved result, not forgive or fabricate settlement.
  expect((await observed(body)).provider).toHaveLength(1);
  await sql.query('update profiles set credits=100000 where id=$1',[actor]);expect((await snapshot(body.requestId)).state).toBe('succeeded');const v=await observed(body);expect(v.provider).toHaveLength(1);expect(v.ledger).toEqual(expect.arrayContaining([{operation_type:'pre_deduct',count:1},{operation_type:'settle',count:1}]));
  expect((await fetch(app+'/api/ai/requests?requestId='+body.requestId,{headers:{Authorization:'Bearer '+otherToken}})).status).toBe(403);
 }finally{await sql.query('DROP TRIGGER search_test_message ON messages; DROP FUNCTION search_test_block_message(); DROP TABLE search_test_fail;');await sql.query('update profiles set credits=100000 where id=$1',[actor]);}
});
repaired('existing free-tier behavior records provider units but no site search surcharge',async()=>{
 await native();await sql.query('update profiles set credits=0 where id=$1',[actor]);await setting('enable_free_tier',true);await setting('free_tier_messages',1000);
 try{const body=request('ONE');await send(body);const v=await observed(body);expect(v.public.state).toBe('succeeded');expect(v.public.search).toMatchObject({providerUnits:1,surchargeCredits:0});expect(v.public.billing.credits).toBe(0);expect(v.ledger.some((r:any)=>r.operation_type==='pre_deduct')).toBe(false);}
 finally{await setting('enable_free_tier',false);await sql.query('update profiles set credits=100000 where id=$1',[actor]);}
});
