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
const repaired=process.env.CHAT_BASELINE==='1'?it.skip:it;
const app = process.env.V3_LOCAL_APP!, api = process.env.V3_LOCAL_REST!;
if (![app,api].every(v => v?.startsWith('http://127.0.0.1:')) || !process.env.V3_LOCAL_DB?.endsWith('/v3_disposable')) throw new Error('Disposable local runner required');
const sql = new pg.Client({connectionString:process.env.V3_LOCAL_DB});
const admin = createClient(api,process.env.V3_LOCAL_SERVICE_JWT!,{auth:{persistSession:false}});
const baseline = process.env.CHAT_BASELINE === '1';
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
 if(!baseline){const rows=await sql.query('select request_id,state,pre_deduct_id,stop_requested_at from ordinary_chat_requests where user_id=$1 order by created_at',[actor]);
 writeFileSync(resolve(process.env.V3_WORKBENCH_OUTPUT!,'ordinary-chat-observed.json'),JSON.stringify(rows.rows,null,2));}
 await browser?.close();await sql.end();
},60000);
const make = (mode='OK') => ({requestId:randomUUID(),modelId,message:'CHAT_CASE_'+mode+'_'+randomUUID().replaceAll('-','')});
async function send(body:ReturnType<typeof make>&{conversationId?:string;moduleId?:string},access=token){const r=await fetch(app+'/api/ai/stream',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+access},body:JSON.stringify(body)});return {status:r.status,body:await r.text()};}
async function calls(key:string){const data=await (await fetch(api+'/__chat_calls')).json() as Array<{key:string}>;return data.filter(c=>c.key===key).length;}
async function accounting(requestId:string){return (await sql.query("select operation_type,count(*)::int count from billing_history where user_id=$1 and (metadata->>'requestId'=$2 or metadata->>'preDeductId' in (select id::text from billing_history where metadata->>'requestId'=$2)) group by operation_type",[actor,requestId])).rows;}
it('sequential replay dispatches the provider once',async()=>{
  const body=make(); const first=await send(body),second=await send(body);
  expect(first.status).toBe(200);expect(first.body).toContain('"type":"complete"');
  const observed={providerCalls:await calls(body.message),accounting:await accounting(body.requestId)};
  console.log('SEQUENTIAL_OBSERVED',JSON.stringify(observed));
  expect(observed.providerCalls).toBe(baseline?2:1);
  if(!baseline)expect(second.body).toContain('Local answer');
},90000);
it('concurrent replay dispatches the provider once',async()=>{
  const body=make(); const responses=await Promise.all([send(body),send(body)]);
  const observed={providerCalls:await calls(body.message),accounting:await accounting(body.requestId),statuses:responses.map(r=>r.status)};
  console.log('CONCURRENT_OBSERVED',JSON.stringify(observed));
  expect(observed.providerCalls).toBe(baseline?2:1);
},90000);

async function state(id:string,access=token,method='GET') {
 const r=await fetch(app+'/api/ai/requests?requestId='+id,{method,headers:{Authorization:'Bearer '+access}});
 return {status:r.status,...await r.json()};
}
async function waitState(id:string,expected:string) {
 let result:any;
 for(let i=0;i<80;i++){result=await state(id);if(result.request?.state===expected)return result.request;await new Promise(r=>setTimeout(r,150));}
 throw new Error('Expected '+expected+', got '+JSON.stringify(result));
}
async function totals(id:string) {
 const row=(await sql.query('select * from ordinary_chat_requests where request_id=$1',[id])).rows[0];
 return {row,billing:await accounting(id),messages:(await sql.query('select role,content from messages where conversation_id=$1 order by created_at',[row.conversation_id])).rows,
  usage:(await sql.query('select status from ai_usage_logs where request_id=$1',[id])).rows,
  tokens:(await sql.query('select count(*)::int n from token_stats where conversation_id=$1',[row.conversation_id])).rows[0].n};
}
async function release(body:ReturnType<typeof make>){await fetch(api+'/__chat_release/'+encodeURIComponent(body.message));}
async function start(body:ReturnType<typeof make>) {
 const response=await fetch(app+'/api/ai/stream',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify(body)});
 expect(response.status).toBe(200);
 const reader=response.body!.getReader();await reader.read();return reader;
}
repaired('response loss keeps execution and recovers original answer, cost and message IDs',async()=>{
 const before=(await sql.query('select credits from profiles where id=$1',[actor])).rows[0].credits;
 const body=make('HOLD');const reader=await start(body);await reader.cancel();
 expect((await state(body.requestId)).request.state).toBe('running');
 await send(body);expect(await calls(body.message)).toBe(1);
 await release(body);const first=await waitState(body.requestId,'succeeded'),second=(await state(body.requestId)).request;
 expect(second).toEqual(first);expect(first.billing.state).toBe('settled');
 expect(before-(await sql.query('select credits from profiles where id=$1',[actor])).rows[0].credits).toBe(first.billing.credits);
 const rows=await totals(body.requestId);expect(rows.messages).toHaveLength(2);expect(rows.tokens).toBe(1);expect(rows.usage).toEqual([{status:'success'}]);
 expect(rows.billing).toEqual(expect.arrayContaining([{operation_type:'pre_deduct',count:1},{operation_type:'settle',count:1}]));
 expect(rows.billing).toHaveLength(2);expect(await calls(body.message)).toBe(1);
},90000);
repaired.each(['REFUSED','REFUSED_STRING'])('strict provider refusal %s restores once and preserves failed input; replay does not regenerate',async mode=>{
 const before=(await sql.query('select credits from profiles where id=$1',[actor])).rows[0].credits;
 const body=make(mode);await send(body);const snapshot=await waitState(body.requestId,'failed');
 expect((await sql.query('select credits from profiles where id=$1',[actor])).rows[0].credits).toBe(before);
 expect(snapshot.input.message).toBe(body.message);expect(snapshot.retryable).toBe(true);expect(snapshot.billing.state).toBe('released');
 await Promise.all([send(body),send(body),state(body.requestId)]);
 const rows=await totals(body.requestId);expect(rows.billing).toEqual(expect.arrayContaining([{operation_type:'pre_deduct',count:1},{operation_type:'refund',count:1}]));
 expect(rows.messages).toHaveLength(0);expect(rows.tokens).toBe(0);expect(await calls(body.message)).toBe(1);
});
repaired('truncated provider response remains unknown with reservation and no automatic refund or retry',async()=>{
 const body=make('UNKNOWN');await send(body);const snapshot=await waitState(body.requestId,'unknown');
 expect(snapshot.content).toContain(body.message);expect(snapshot.input.message).toBe(body.message);expect(snapshot.retryable).toBe(false);expect(snapshot.billing.state).toBe('reserved');
 await Promise.all([send(body),send(body),state(body.requestId,token,'POST')]);
 const rows=await totals(body.requestId);expect(rows.billing).toEqual([{operation_type:'pre_deduct',count:1}]);expect(rows.messages).toHaveLength(0);expect(await calls(body.message)).toBe(1);
 for(const params of [{},null,{p_reason:null}])expect((await admin.rpc('ordinary_chat_transition',{p_user_id:actor,p_request_id:body.requestId,p_writer_token:rows.row.writer_token,p_action:'failure',p_params:params})).error).toBeTruthy();
 expect(await accounting(body.requestId)).toEqual([{operation_type:'pre_deduct',count:1}]);
});
repaired('stop/completion race and repeated stops preserve one actual settlement and late response',async()=>{
 const body=make('HOLD');const reader=await start(body);
 await Promise.all([state(body.requestId,token,'POST'),reader.cancel(),release(body)]);
 const snapshot=await waitState(body.requestId,'succeeded');
 await Promise.all([state(body.requestId,token,'POST'),send(body),state(body.requestId)]);
 const rows=await totals(body.requestId);expect(rows.billing).toHaveLength(2);expect(rows.billing.find(r=>r.operation_type==='refund')).toBeUndefined();
 expect(snapshot.content).toContain(body.message);expect(rows.messages).toHaveLength(2);expect(rows.tokens).toBe(1);expect(await calls(body.message)).toBe(1);
},90000);
repaired('saved metered response survives atomic settlement rollback and concurrent recovery without another provider call',async()=>{
 const body=make();
 await sql.query(`CREATE TABLE chat_test_fail(enabled boolean); INSERT INTO chat_test_fail VALUES(true);
 CREATE FUNCTION chat_test_block_message() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM chat_test_fail WHERE enabled) AND NEW.content LIKE 'CHAT_CASE_OK_%' THEN RAISE EXCEPTION 'local settlement fault'; END IF; RETURN NEW; END $$;
 CREATE TRIGGER chat_test_message BEFORE INSERT ON messages FOR EACH ROW EXECUTE FUNCTION chat_test_block_message();`);
 try {
  await send(body);expect((await state(body.requestId)).request.state).toBe('responded');
  let rows=await totals(body.requestId);expect(rows.messages).toHaveLength(0);expect(rows.tokens).toBe(0);expect(rows.billing).toEqual([{operation_type:'pre_deduct',count:1}]);
  await sql.query('update chat_test_fail set enabled=false');
  const recovered=await Promise.all([state(body.requestId),state(body.requestId),send(body)]);
  expect(recovered[0].request.state).toBe('succeeded');rows=await totals(body.requestId);expect(rows.messages).toHaveLength(2);expect(rows.tokens).toBe(1);expect(rows.billing).toHaveLength(2);expect(await calls(body.message)).toBe(1);
 }finally{await sql.query('DROP TRIGGER chat_test_message ON messages; DROP FUNCTION chat_test_block_message(); DROP TABLE chat_test_fail;');}
});
repaired('identity binds actor, conversation, text and model; current access is checked on recovery',async()=>{
 const body=make();await send(body);const snapshot=await waitState(body.requestId,'succeeded');
 for(const change of [{message:'replacement'},{modelId:randomUUID()},{conversationId:randomUUID()},{moduleId:randomUUID()}])expect((await send({...body,...change})).status).toBe(409);
 expect((await send(body,otherToken)).status).toBe(403);expect((await state(body.requestId,otherToken)).status).toBe(403);
 expect((await state(body.requestId,otherToken,'POST')).status).toBe(403);
 await sql.query("update profiles set is_deleted='true' where id=$1",[actor]);
 try{expect((await state(body.requestId)).status).toBe(403);expect((await send(body)).status).toBe(403);}finally{await sql.query("update profiles set is_deleted='false' where id=$1",[actor]);}
 await sql.query("update profiles set status='disabled' where id=$1",[actor]);
 try{expect((await state(body.requestId)).status).not.toBe(200);expect((await send(body)).status).toBe(403);}finally{await sql.query("update profiles set status='active' where id=$1",[actor]);}
 await sql.query("update conversations set is_deleted='true',deleted_at=now() where id=$1",[snapshot.conversationId]);
 expect((await state(body.requestId)).status).toBe(403);expect((await send(body)).status).toBe(403);expect(await calls(body.message)).toBe(1);
});
repaired('a completed paid request remains recoverable after balance/consumption limits change',async()=>{
 const body=make();await send(body);const original=(await state(body.requestId)).request;
 const credits=(await sql.query('select credits from profiles where id=$1',[actor])).rows[0].credits;
 const logId=randomUUID();
 await sql.query('update profiles set credits=0 where id=$1',[actor]);
 await sql.query("insert into billing_history(id,user_id,operation_type,amount) values($1,$2,'settle',-50000)",[logId,actor]);
 try{expect((await state(body.requestId)).request).toEqual(original);expect(JSON.parse((await send(body)).body).request).toEqual(original);expect(await calls(body.message)).toBe(1);}
 finally{await sql.query('delete from billing_history where id=$1',[logId]);await sql.query('update profiles set credits=$2 where id=$1',[actor,credits]);}
});
repaired('free chat has the same dispatch and message idempotency without a reservation',async()=>{
 const credits=(await sql.query('select credits from profiles where id=$1',[actor])).rows[0].credits;
 await sql.query('update profiles set credits=0 where id=$1',[actor]);
 await sql.query("insert into system_settings(key,value) values('enable_free_tier','true'),('free_tier_messages','100000') on conflict(key) do update set value=excluded.value");
 try{const body=make();await Promise.all([send(body),send(body)]);await waitState(body.requestId,'succeeded');await send(body);const rows=await totals(body.requestId);expect(await calls(body.message)).toBe(1);expect(rows.billing).toHaveLength(0);expect(rows.messages).toHaveLength(2);expect(rows.tokens).toBe(1);}
 finally{await sql.query("update system_settings set value='false' where key='enable_free_tier'");await sql.query('update profiles set credits=$2 where id=$1',[actor,credits]);}
});
repaired('database denies client table writes/RPCs and incorrect dispatch capabilities',async()=>{
 const body=make();await send(body);const rows=await totals(body.requestId);
 for(const access of [process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,token,otherToken]){
  const client=createClient(api,process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,{global:{headers:{Authorization:'Bearer '+access}},auth:{persistSession:false}});
  expect((await client.from('ordinary_chat_requests').select('*')).error).toBeTruthy();
  expect((await client.from('ordinary_chat_requests').update({state:'preparing'}).eq('request_id',body.requestId)).error).toBeTruthy();
  expect((await client.rpc('ordinary_chat_claim',{p_user_id:actor,p_request_id:randomUUID(),p_input:rows.row.input,p_writer_token:randomUUID()})).error).toBeTruthy();
  expect((await client.rpc('ordinary_chat_transition',{p_user_id:actor,p_request_id:body.requestId,p_writer_token:rows.row.writer_token,p_action:'dispatch'})).error).toBeTruthy();
 }
 for(const badToken of [randomUUID(),null])expect((await admin.rpc('ordinary_chat_transition',{p_user_id:actor,p_request_id:body.requestId,p_writer_token:badToken,p_action:'stop'})).error).toBeTruthy();
 expect((await admin.rpc('ordinary_chat_transition',{p_user_id:null,p_request_id:body.requestId,p_writer_token:rows.row.writer_token,p_action:'stop'})).error).toBeTruthy();
 expect((await admin.rpc('ordinary_chat_transition',{p_user_id:actor,p_request_id:body.requestId,p_writer_token:rows.row.writer_token,p_action:'dispatch'})).error).toBeTruthy();
 expect(await calls(body.message)).toBe(1);
});
repaired.each(['disabled','banned','pending'])('retains #403 admission for %s users with zero provider/reservation',async status=>{
 const body=make();await sql.query('update profiles set status=$2 where id=$1',[actor,status]);
 try{expect((await send(body)).status).toBe(status==='pending'?503:403);expect(await calls(body.message)).toBe(0);expect(await accounting(body.requestId)).toHaveLength(0);}finally{await sql.query("update profiles set status='active' where id=$1",[actor]);}
});
repaired('retains #403 unverified and unreadable-consumption denials',async()=>{
 const body=make();await sql.query('update auth.users set email_confirmed_at=null where id=$1',[actor]);
 await sql.query("update auth.identities set identity_data=jsonb_set(identity_data,'{email_verified}','false') where user_id=$1",[actor]);
 try{expect((await send(body)).status).toBe(403);}finally{await sql.query('update auth.users set email_confirmed_at=now() where id=$1',[actor]);await sql.query("update auth.identities set identity_data=jsonb_set(identity_data,'{email_verified}','true') where user_id=$1",[actor]);}
 await sql.query('revoke select(user_id,operation_type,amount,created_at) on billing_history from authenticated');
 try{expect((await send(body)).status).toBe(503);}finally{await sql.query('grant select(user_id,operation_type,amount,created_at) on billing_history to authenticated');}
 expect(await calls(body.message)).toBe(0);expect(await accounting(body.requestId)).toHaveLength(0);
});
async function pageFor() {
 const context=await browser.newContext();await context.route('**/*',r=>{const u=new URL(r.request().url());return ['127.0.0.1','localhost'].includes(u.hostname)||['data:','blob:'].includes(u.protocol)?r.continue():r.abort();});
 const page=await context.newPage();const ready=page.waitForResponse(r=>r.url().includes('/api/trpc/settings.getSystemSettings')&&r.ok());
 await page.goto(app+'/login?redirect=/chat');await ready;
 await page.getByPlaceholder('name@example.com').fill(credentials.email);await page.getByPlaceholder('输入你的密码').fill(credentials.password);await page.getByRole('button',{name:'登录',exact:true}).last().click();
 await page.waitForURL(u=>u.pathname==='/chat',{timeout:90000});await page.getByTestId('chat-input').waitFor();
 return {page,context};
}
repaired('browser reload before init restores the original request ID/input; late completion renders once',async()=>{
 const {page,context}=await pageFor();const body=make('HOLD');let submitted:any;
 // Hold the app's stream response at the browser boundary, after real HTTP
 // delivery. Reload therefore loses init and the new conversation URL.
 let releaseResponse!:()=>void;const gate=new Promise<void>(r=>{releaseResponse=r;});
 await context.route('**/api/ai/stream',async route=>{submitted=route.request().postDataJSON();const response=await route.fetch();await gate;await route.fulfill({response}).catch(()=>{});});
 try{
  await page.getByTestId('chat-input').fill(body.message);await page.getByRole('button',{name:'发送',exact:true}).click();
  for(let i=0;i<100&&!submitted;i++)await new Promise(r=>setTimeout(r,100));expect(submitted.requestId).toMatch(/^[a-f0-9-]{36}$/);
  for(let i=0;i<100&&await calls(body.message)===0;i++)await new Promise(r=>setTimeout(r,100));
  await page.reload();await page.getByText(body.message,{exact:true}).waitFor({timeout:45000});
  await page.waitForURL(u=>!!u.searchParams.get('conversation'),{timeout:45000});
  expect(await calls(body.message)).toBe(1);await release(body);releaseResponse();
  await page.getByText('Local answer '+body.message,{exact:true}).waitFor({timeout:45000});
  expect(await page.getByText('Local answer '+body.message,{exact:true}).count()).toBe(1);
  const snapshot=await waitState(submitted.requestId,'succeeded');expect(snapshot.billing.state).toBe('settled');
  await page.reload();await page.getByText('Local answer '+body.message,{exact:true}).waitFor({timeout:45000});
  expect(await calls(body.message)).toBe(1);expect((await totals(submitted.requestId)).messages).toHaveLength(2);
  await page.screenshot({path:resolve(process.env.V3_WORKBENCH_OUTPUT!,'chat-restored.png'),fullPage:true});
 }finally{releaseResponse();await release(body);await context.close();}
},180000);
repaired('browser failed input and explicit regeneration are separate from recovery; unknown and stopped requests never auto-resend',async()=>{
 const {page,context}=await pageFor();const refused=make('REFUSED');let submitted:any;
 page.on('request',r=>{if(r.url().endsWith('/api/ai/stream'))submitted=r.postDataJSON();});
 try{
  await page.getByTestId('chat-input').fill(refused.message);await page.getByRole('button',{name:'发送',exact:true}).click();
  await page.getByText('本次请求已明确失败，输入已保留，预扣已处理。',{exact:true}).waitFor({timeout:45000});
  const original=submitted.requestId;await page.reload();await page.getByRole('button',{name:'恢复输入',exact:true}).click();
  expect(await page.getByTestId('chat-input').inputValue()).toBe(refused.message);
  await page.getByRole('button',{name:'恢复原请求',exact:true}).click();expect(await calls(refused.message)).toBe(1);
  await page.getByRole('button',{name:'重新生成（新请求，重新计费）',exact:true}).click();
  for(let i=0;i<100&&submitted.requestId===original;i++)await new Promise(r=>setTimeout(r,100));
  expect(submitted.requestId).not.toBe(original);await waitState(submitted.requestId,'failed');expect(await calls(refused.message)).toBe(2);
  await page.goto(app+'/chat');const unknown=make('UNKNOWN');await page.getByTestId('chat-input').fill(unknown.message);await page.getByRole('button',{name:'发送',exact:true}).click();
  await page.getByText('原请求结果尚不确定，预扣状态保留。请恢复状态，暂不能重新生成。',{exact:true}).waitFor({timeout:45000});
  await page.reload();await page.getByRole('button',{name:'恢复原请求',exact:true}).click();
  expect(await page.getByRole('button',{name:'重新生成（新请求，重新计费）',exact:true}).count()).toBe(0);expect(await calls(unknown.message)).toBe(1);
  await page.goto(app+'/chat');const hold=make('HOLD');await page.getByTestId('chat-input').fill(hold.message);await page.getByRole('button',{name:'发送',exact:true}).click();
  for(let i=0;i<100&&await calls(hold.message)===0;i++)await new Promise(r=>setTimeout(r,100));
  expect(await calls(hold.message)).toBe(1);
  await page.getByRole('button',{name:'停止等待',exact:true}).click();
  await page.getByText('已停止等待。后台可能继续生成，将按实际结果结算。',{exact:true}).waitFor();
  await release(hold);await page.getByText('Local answer '+hold.message,{exact:true}).waitFor({timeout:45000});expect(await calls(hold.message)).toBe(1);
 }finally{await context.close();}
},180000);
repaired('browser refresh restores the latest request together with earlier conversation messages',async()=>{
 const {page,context}=await pageFor();const first=make(),second=make();let submitted:any;
 page.on('request',r=>{if(r.url().endsWith('/api/ai/stream'))submitted=r.postDataJSON();});
 try{
  for(const body of [first,second]){
   await page.getByTestId('chat-input').fill(body.message);await page.getByRole('button',{name:'发送',exact:true}).click();
   await page.getByText('Local answer '+body.message,{exact:true}).waitFor({timeout:45000});
  }
  await page.reload();await page.getByText('Local answer '+second.message,{exact:true}).waitFor({timeout:45000});
  await page.getByText('Local answer '+first.message,{exact:true}).waitFor({timeout:10000});
  expect(await page.getByText('Local answer '+first.message,{exact:true}).count()).toBe(1);
  expect(await page.getByText('Local answer '+second.message,{exact:true}).count()).toBe(1);
  expect(await calls(first.message)).toBe(1);expect(await calls(second.message)).toBe(1);
  expect((await totals(submitted.requestId)).messages).toHaveLength(4);
 }finally{await context.close();}
},180000);
repaired('two browser tabs preserve both requests across an interleaved storage write and refresh',async()=>{
 const {page,context}=await pageFor();const seedA=make(),seedB=make();await send(seedA);await send(seedB);
 const conversationA=(await state(seedA.requestId)).request.conversationId,conversationB=(await state(seedB.requestId)).request.conversationId;
 const secondPage=await context.newPage();const a=make('HOLD'),b=make('HOLD');let submittedA:any,submittedB:any;
 page.on('request',r=>{if(r.url().endsWith('/api/ai/stream'))submittedA=r.postDataJSON();});
 secondPage.on('request',r=>{if(r.url().endsWith('/api/ai/stream'))submittedB=r.postDataJSON();});
 let hit!:()=>void,unblock!:()=>void;const barrierHit=new Promise<void>(r=>{hit=r;}),barrier=new Promise<void>(r=>{unblock=r;});
 await context.route('**/__chat_storage_barrier',async route=>{hit();await barrier;await route.fulfill({status:200,body:'released'});});
 try{
  await page.goto(app+'/chat?conversation='+conversationA);await secondPage.goto(app+'/chat?conversation='+conversationB);
  await page.getByTestId('chat-input').fill(a.message);await page.getByRole('button',{name:'发送',exact:true}).click();
  for(let i=0;i<100&&await calls(a.message)===0;i++)await new Promise(r=>setTimeout(r,100));expect(await calls(a.message)).toBe(1);
  // Pause A immediately before its storage write. In the original array layout
  // A has already read the old list; B creates a new logical request meanwhile.
  // This affects only a local browser scheduling boundary, not runtime SQL/Auth.
  await page.evaluate(id=>{
   const original=Storage.prototype.setItem;let once=true;
   Storage.prototype.setItem=function(k,v){
    if(once&&k.startsWith('ordinary-chat:v1:')&&v.includes(id)){
     once=false;const request=new XMLHttpRequest();request.open('GET','/__chat_storage_barrier',false);request.send();
    }
    return original.call(this,k,v);
   };
  },submittedA.requestId);
  const stopping=page.getByRole('button',{name:'停止等待',exact:true}).click();
  await Promise.race([barrierHit,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Storage barrier not reached')),15000))]);
  await secondPage.getByTestId('chat-input').fill(b.message);await secondPage.getByRole('button',{name:'发送',exact:true}).click();
  for(let i=0;i<100&&await calls(b.message)===0;i++)await new Promise(r=>setTimeout(r,100));expect(await calls(b.message)).toBe(1);
  unblock();await stopping;
  const stored=await secondPage.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith('ordinary-chat:v1:')).flatMap(k=>{const value=JSON.parse(localStorage.getItem(k)!);return Array.isArray(value)?value:[value];}));
  expect(stored.map(p=>p.requestId)).toEqual(expect.arrayContaining([submittedA.requestId,submittedB.requestId]));
  await Promise.all([page.reload(),secondPage.reload()]);
  await page.getByText(a.message,{exact:true}).waitFor({timeout:45000});await secondPage.getByText(b.message,{exact:true}).waitFor({timeout:45000});
  await Promise.all([release(a),release(b)]);
  await page.getByText('Local answer '+a.message,{exact:true}).waitFor({timeout:45000});await secondPage.getByText('Local answer '+b.message,{exact:true}).waitFor({timeout:45000});
  expect(await calls(a.message)).toBe(1);expect(await calls(b.message)).toBe(1);
  for(const id of [submittedA.requestId,submittedB.requestId]){const rows=await totals(id);expect(rows.billing).toHaveLength(2);expect(rows.messages).toHaveLength(4);}
 }finally{unblock();await Promise.all([release(a),release(b)]);await context.close();}
},180000);
repaired('unsupported native transport fails before provider calls or reservation and preserves input',async()=>{
 const body=make();await sql.query("update ai_models set provider='anthropic',api_endpoint='https://api.anthropic.com/v1/messages',token_counting_method='anthropic_count_tokens',tokenizer_family='anthropic' where id=$1",[modelId]);
 try{
  expect((await send(body)).status).toBe(500);const snapshot=await waitState(body.requestId,'failed');
  expect(snapshot.input.message).toBe(body.message);expect(snapshot.retryable).toBe(true);expect(await calls(body.message)).toBe(0);
  expect((await totals(body.requestId)).billing).toHaveLength(0);await send(body);expect(await calls(body.message)).toBe(0);
 }finally{await sql.query("update ai_models set provider='openai',api_endpoint='https://openrouter.ai/api/v1',token_counting_method=null,tokenizer_family='openai' where id=$1",[modelId]);}
});
repaired('document chat keeps module method binding; recovery denies revoked module access',async()=>{
 const skillId=randomUUID(),moduleId=randomUUID();
 await sql.query("insert into skills(id,skill_key,draft_content) values($1::uuid,$1::text,'METHOD_CANARY_DOCUMENT Private document instruction')",[skillId]);
 await sql.query("insert into modules(id,title,skill_id,model_id,active) values($1,'Document lifecycle',$2,$3,true)",[moduleId,skillId,modelId]);
 await sql.query("update profiles set role='admin' where id=$1",[actor]);
 const published=await admin.rpc('atomic_publish_skill',{p_skill_id:skillId,p_published_by:actor});await sql.query("update profiles set role='user' where id=$1",[actor]);expect(published.error).toBeNull();
 const body={...make(),moduleId};await send(body);const snapshot=await waitState(body.requestId,'succeeded');
 await send(body);expect(snapshot.input.moduleId).toBe(moduleId);expect(snapshot.content).not.toContain('METHOD_CANARY');expect(await calls(body.message)).toBe(1);
 const rows=await totals(body.requestId);expect(rows.messages).toHaveLength(2);expect(rows.tokens).toBe(1);
 await sql.query('update modules set active=false where id=$1',[moduleId]);
 try{expect((await state(body.requestId)).status).not.toBe(200);expect((await send(body)).status).not.toBe(200);}finally{await sql.query('update modules set active=true where id=$1',[moduleId]);}
 expect(await calls(body.message)).toBe(1);
});
repaired('unknown request context defers deletion while terminal retention prevents old identity redispatch',async()=>{
 const body=make('UNKNOWN');await send(body);const row=(await totals(body.requestId)).row;
 const deleted=await sql.query('delete from conversations where id=$1 returning id',[row.conversation_id]);expect(deleted.rows).toHaveLength(0);
 const terminal=make('REFUSED');await send(terminal);const old=(await totals(terminal.requestId)).row;
 await sql.query('delete from conversations where id=$1',[old.conversation_id]);
 expect((await sql.query('select request_id from ordinary_chat_requests where request_id=$1',[terminal.requestId])).rows).toHaveLength(0);
 expect((await send(terminal)).status).toBe(409);expect(await calls(terminal.message)).toBe(1);
});
repaired('pre-dispatch key failure releases only its own reservation and keeps input recoverable',async()=>{
 const body=make();await sql.query('update ai_models set api_key=null where id=$1',[modelId]);
 try{
  expect((await send(body)).status).toBe(500);const snapshot=await waitState(body.requestId,'failed');expect(snapshot.input.message).toBe(body.message);expect(await calls(body.message)).toBe(0);
  const rows=await totals(body.requestId);expect(rows.usage).toEqual([{status:'failed'}]);expect(rows.billing).toHaveLength(2);expect(rows.billing).toEqual(expect.arrayContaining([{operation_type:'pre_deduct',count:1},{operation_type:'refund',count:1}]));
  await send(body);expect(await calls(body.message)).toBe(0);expect((await totals(body.requestId)).billing).toEqual(rows.billing);
 }finally{await sql.query("update ai_models set api_key='LOCAL_SYNTHETIC_KEY' where id=$1",[modelId]);}
});
repaired.each(['REFUSED_METERED','REFUSED_PARTIAL','REFUSED_HTML','REFUSED_SERVER_ERROR','REFUSED_STRING_METERED','REFUSED_STRING_PARTIAL','REFUSED_STRING_HTTP200'])('ambiguous refusal %s retains reservation and blocks automatic retry',async mode=>{
 const body=make(mode);await send(body);const snapshot=await waitState(body.requestId,'unknown');expect(snapshot.retryable).toBe(false);expect(snapshot.billing.state).toBe('reserved');
 await send(body);expect(await calls(body.message)).toBe(1);expect((await totals(body.requestId)).billing).toEqual([{operation_type:'pre_deduct',count:1}]);
});
repaired('expired running status remains recoverable and a late response still settles the original request',async()=>{
 const body=make('HOLD');const reader=await start(body);await reader.cancel();
 await sql.query("update ordinary_chat_requests set updated_at=now()-interval '3 minutes' where request_id=$1",[body.requestId]);
 expect((await state(body.requestId)).request.state).toBe('unknown');await send(body);expect(await calls(body.message)).toBe(1);
 await release(body);await waitState(body.requestId,'succeeded');expect((await totals(body.requestId)).messages).toHaveLength(2);expect(await calls(body.message)).toBe(1);
},90000);

repaired('browser absent request suspends polling while explicit delivery keeps the same identity',async()=>{
 const {page,context}=await pageFor();const body=make();let submitted:any;let reads=0;
 try{
  await page.route('**/api/ai/stream',async route=>{submitted=route.request().postDataJSON();await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Local pre-claim rejection'})});});
  page.on('request',r=>{if(r.url().includes('/api/ai/requests?')&&r.method()==='GET')reads++;});
  await page.getByTestId('chat-input').fill(body.message);await page.getByRole('button',{name:'发送',exact:true}).click();
  await page.getByText('尚未确认服务器接收。可使用原请求标识继续提交。',{exact:true}).waitFor();
  const before=reads;await page.waitForTimeout(6500);expect(reads).toBe(before);expect(await calls(body.message)).toBe(0);
  const id=submitted.requestId;await page.unroute('**/api/ai/stream');
  await page.getByRole('button',{name:'继续提交原请求',exact:true}).click();
  await page.getByText('Local answer '+body.message,{exact:true}).waitFor({timeout:45000});
  expect(await calls(body.message)).toBe(1);expect((await totals(id)).usage).toEqual([{status:'success'}]);
 }finally{await context.close();}
},90000);

repaired.each(['pricing','balance'])('preflight %s failure has one failed usage row and no reservation',async kind=>{
 const body=make();
 const balance=(await sql.query('select credits from profiles where id=$1',[actor])).rows[0].credits;
 if(kind==='pricing')await sql.query('update ai_models set input_token_cost=null where id=$1',[modelId]);
 else await sql.query('update profiles set credits=0 where id=$1',[actor]);
 try{
  expect((await send(body)).status).toBe(kind==='pricing'?503:402);
  await waitState(body.requestId,'failed');await send(body);
  const rows=await totals(body.requestId);expect(rows.usage).toEqual([{status:'failed'}]);expect(rows.billing).toHaveLength(0);expect(await calls(body.message)).toBe(0);
 }finally{
  await sql.query('update ai_models set input_token_cost=150000 where id=$1',[modelId]);
  await sql.query('update profiles set credits=$2 where id=$1',[actor,balance]);
 }
});

repaired('boolean soft-delete schema permits active recovery and replay but rejects deleted profiles',async()=>{
 await sql.query("alter table profiles alter column is_deleted drop default, alter column is_deleted type boolean using is_deleted::boolean, alter column is_deleted set default false");
 const body=make();
 try{
  expect((await send(body)).status).toBe(200);
  expect((await state(body.requestId)).status).toBe(200);await waitState(body.requestId,'succeeded');
  expect((await send(body)).status).toBe(200);expect(await calls(body.message)).toBe(1);
  await sql.query('update profiles set is_deleted=true where id=$1',[actor]);
  expect((await state(body.requestId)).status).toBe(403);expect((await send(body)).status).toBe(403);expect(await calls(body.message)).toBe(1);
 }finally{
  await sql.query('update profiles set is_deleted=false where id=$1',[actor]);
  await sql.query("alter table profiles alter column is_deleted drop default, alter column is_deleted type text using is_deleted::text, alter column is_deleted set default 'false'");
 }
});
