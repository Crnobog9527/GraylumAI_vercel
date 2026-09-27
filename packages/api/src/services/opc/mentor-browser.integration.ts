/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {it,expect} from 'vitest';
import {createHash,randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {mergedPositioningFixture,sql} from './opc.integration';
const poll:typeof expect.poll=(callback,options)=>expect.poll(callback,{timeout:30000,...options});

// Auth, OPC, Runtime, SDK, HTTP streaming and BILL2 are real local paths.
// The isolated staging-host gateway supplies synthetic provider responses and
// controlled pauses only; these tests do not establish real mentor quality.

it.runIf(process.env.V3_LOCAL_STAGING_HOST==='true').each(['normal','refresh'] as const)('OPC: MENTOR_STREAM real browser incremental HTTP, editable drafts, frozen input and persistence (%s)',async(scenario)=>{
 const f=await mergedPositioningFixture(),mentorId=randomUUID(),organizerId=randomUUID(),key='SYNTHETIC_BROWSER_'+randomUUID();
 // Real mentor admission requires a verified reasoning policy; the gateway stays synthetic.
 const policies=[[mentorId,'qwen/qwen3.8-27b'],[organizerId,'synthetic/browser-organizer']].map(([modelId,model])=>({modelId,model,provider:'openrouter',account:'openrouter-key:'+createHash('sha256').update(key).digest('hex'),protocol:'openrouter-chat-v1',upperUsd:'0.02',inputLimit:32000,outputLimit:100,automaticRetry:false,hiddenTools:false,lookupSupported:true,providerLimits:{providerSlug:'synthetic',contextTokens:10000,promptUsdPerMillion:'2',completionUsdPerMillion:'0',requestUsd:'0'}}));
 for(const p of policies)await sql.query("insert into ai_models(id,name,model_id,provider,is_active,api_endpoint,api_key,max_tokens,input_limit) values($1,'Synthetic browser streaming',$2,'openai','true','https://openrouter.ai/api/v1',$3,1000,10000)",[p.modelId,p.model,key]);
 await sql.query('update modules set model_id=$1 where id=$2',[mentorId,f.moduleId]);
 await sql.query("insert into system_settings(key,value) values('v3_summary_model_id',$1),('v3_summary_max_tokens','128') on conflict(key) do update set value=excluded.value",[JSON.stringify(organizerId)]);
 await sql.query("insert into runtime_test_windows(id,enabled,actor_ids,call_policies,credits_per_usd,multiplier,max_cost_usd,max_calls,expires_at) values($1,true,$2,$3,1000,1,1,20,now()+interval '1 hour') on conflict(id) do update set actor_ids=excluded.actor_ids,call_policies=excluded.call_policies,expires_at=excluded.expires_at",[process.env.V3_RUNTIME_STAGING_WINDOW_ID,[f.actor],JSON.stringify(policies)]);
 const d=await f.service.start({requestId:randomUUID(),registration:f.registration,mode:'mentor',businessName:'Graylum AI'});
 const {chromium}=await import('../../../../../apps/web/node_modules/@playwright/test');
 const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();page.setDefaultTimeout(60000);
 await page.addInitScript(()=>{const seen=new Set<string>();(window as unknown as {mentorTextTimes:number[]}).mentorTextTimes=[];new MutationObserver(()=>{for(const node of document.querySelectorAll('p')){const text=node.textContent??'';if(text.includes('本地流式导师正文：')&&!seen.has(text)){seen.add(text);(window as unknown as {mentorTextTimes:number[]}).mentorTextTimes.push(Date.now());}}}).observe(document,{childList:true,subtree:true,characterData:true});});
 type Call={index:number;id:string;model:string;stream:boolean;reasoningEffort:string|null;startedAt:number;firstAt:number|null;finishedAt:number|null};
 const control=async(release?:number):Promise<Call[]>=>{const r=await fetch(process.env.V3_LOCAL_REST+'/__mentor_stream',{method:release?'POST':'GET',headers:{'x-local-control':process.env.V3_LOCAL_CONTROL!},...(release?{body:JSON.stringify({release})}:{})});if(!r.ok)throw new Error('isolated gate failed');return r.json();};
 await fetch(process.env.V3_LOCAL_REST+'/__mentor_stream',{method:'POST',headers:{'x-local-control':process.env.V3_LOCAL_CONTROL!},body:JSON.stringify({reset:true})});
 let releasePrepare=()=>{};
 const path='/positioning/'+d.draftId,timings:Record<string,number>={};let streamRequests=0,prepareRequests=0;const prepares:Array<{started:number;finished?:number}>=[];const prepareIndex=new Map<unknown,number>();
 await context.route('**/*',async route=>{const u=new URL(route.request().url());if(u.hostname==='syntheticstaging.supabase.co'){const response=await route.fetch({url:process.env.V3_LOCAL_REST+u.pathname+u.search});await route.fulfill({response});return;}if(!['127.0.0.1','localhost'].includes(u.hostname)&&!['data:','blob:'].includes(u.protocol)){await route.abort();return;}await route.continue();});
 page.on('request',request=>{if(request.url().includes('runtime.executeStream'))streamRequests++;if(request.url().includes('opc.prepareStep')){prepareRequests++;prepareIndex.set(request,prepares.length);prepares.push({started:Date.now()});}});
 page.on('response',response=>{const at=prepareIndex.get(response.request());if(at!==undefined)prepares[at]!.finished=Date.now();});
 try{
  await page.goto(process.env.V3_LOCAL_APP+'/login?redirect='+encodeURIComponent(path));
  await page.getByPlaceholder('name@example.com').fill(f.email);await page.getByPlaceholder('输入你的密码').fill(f.password);await page.getByRole('button',{name:'登录',exact:true}).last().click();await page.waitForURL('**'+path);
  await poll(async()=>(await control()).length,{timeout:60000}).toBe(1);
  const composer=page.getByRole('textbox',{name:'给导师的回复'}),send=page.getByRole('button',{name:'发送',exact:true});
  await poll(()=>composer.isEditable()).toBe(true);await composer.fill('下一条仍可编辑的草稿');
  await poll(()=>page.getByText(/本地流式导师正文：/).count()).toBeGreaterThan(0);
  const opening=(await control())[0]!;expect(opening.finishedAt).toBeNull();expect(streamRequests).toBe(1);timings.openingDispatchToBrowserTextMs=(await page.evaluate(()=>(window as unknown as {mentorTextTimes:number[]}).mentorTextTimes))[0]!-opening.startedAt;
  expect(await send.isDisabled()).toBe(true);expect(await page.locator('body').innerText()).not.toContain('PRIVATE_STREAM_REASONING');
  await page.screenshot({path:process.env.V3_WORKBENCH_OUTPUT+'/mentor-opening-incremental-'+scenario+'.png',fullPage:true});
  await control(1);await poll(()=>send.isEnabled()).toBe(true);expect(await composer.inputValue()).toBe('下一条仍可编辑的草稿');
  const input='我提供摄影入门练习课程，帮助相机初学者完成每周练习。';await composer.fill(input);
  await composer.dispatchEvent('compositionstart');await composer.dispatchEvent('keydown',{key:'Enter',code:'Enter',isComposing:true,keyCode:229});expect((await control()).length).toBe(1);await composer.dispatchEvent('compositionend');
  const prepareGate=new Promise<void>(resolve=>{releasePrepare=resolve;});await page.route('**/api/trpc/opc.prepareStep**',async route=>{await prepareGate;await route.continue();});
  await page.evaluate(text=>{const started=performance.now();(window as unknown as {mentorTiming:unknown}).mentorTiming={started};const observer=new MutationObserver(()=>{const bubbles=[...document.querySelectorAll('[data-message-role="user"][data-request-id]')];if(bubbles.some(b=>b.textContent?.includes(text))){(window as unknown as {mentorTiming:unknown}).mentorTiming={started,bubble:performance.now()};observer.disconnect();}});observer.observe(document.body,{subtree:true,childList:true,characterData:true});},input);
  await send.evaluate(button=>{(button as HTMLButtonElement).click();(button as HTMLButtonElement).click();});
  await poll(()=>page.getByText(input,{exact:true}).count()).toBeGreaterThan(0);
  const feedback=await page.evaluate(()=>(window as unknown as {mentorTiming:{started:number;bubble:number}}).mentorTiming);timings.clickToBubbleMs=feedback.bubble-feedback.started;expect(timings.clickToBubbleMs).toBeLessThan(200);expect(await page.getByText('发送中 · 等待服务器确认',{exact:true}).isVisible()).toBe(true);expect(await page.getByText('上一条发给导师的内容仍在核对。请先用“继续核对这条原请求”恢复，不会重复发送。',{exact:true}).count()).toBe(0);expect(await composer.inputValue()).toBe('');await composer.fill('这是下一条尚未发送的新草稿');releasePrepare();
  await poll(async()=>(await control()).length).toBe(2);
  const second=(await control())[1]!;expect(second.finishedAt).toBeNull();expect(streamRequests).toBe(2);
  await page.screenshot({path:process.env.V3_WORKBENCH_OUTPUT+'/mentor-user-incremental-'+scenario+'.png',fullPage:true});
  await control(2);await poll(async()=>(await control()).length).toBe(3);
  expect((await control())[2]!.finishedAt).toBeNull();expect(await composer.isEditable()).toBe(true);expect(await composer.inputValue()).toBe('这是下一条尚未发送的新草稿');
  await poll(()=>page.getByText(/本地流式导师正文：/).count()).toBeGreaterThan(1);
  await page.screenshot({path:process.env.V3_WORKBENCH_OUTPUT+'/mentor-organizer-pending-'+scenario+'.png',fullPage:true});
  if(scenario==='refresh'){
   const envelope=await page.evaluate(id=>sessionStorage.getItem('opc-step:'+id+':step-0'),d.draftId);expect(envelope).toBeTruthy();
   const executions=(await sql.query('select id,request_id from runtime_executions where actor_id=$1 order by created_at',[f.actor])).rows;
   await page.reload();await poll(()=>composer.isEditable()).toBe(true);expect(await composer.inputValue()).toBe('这是下一条尚未发送的新草稿');expect((await control()).length).toBe(3);
   expect(await page.evaluate(id=>sessionStorage.getItem('opc-step:'+id+':step-0'),d.draftId)).toBe(envelope);
   await page.screenshot({path:process.env.V3_WORKBENCH_OUTPUT+'/mentor-refresh-pending.png',fullPage:true});
   await control(3);await poll(async()=>(await sql.query('select state from runtime_executions where id=$1',[executions.at(-1).id])).rows[0].state).toBe('completed');
   const recovery=page.getByRole('button',{name:'继续核对这条原请求',exact:true});if(await recovery.isVisible())await recovery.click();else await page.reload();
   await poll(async()=>(await f.service.read(d.draftId)).information['step-0'].values?.product?.status).toBe('provisional');
   expect((await control()).length).toBe(3);expect((await sql.query('select id,request_id from runtime_executions where actor_id=$1 order by created_at',[f.actor])).rows).toEqual(executions);
  }else await control(3);
  await poll(()=>send.isEnabled()).toBe(true);expect(await composer.inputValue()).toBe('这是下一条尚未发送的新草稿');
  await poll(async()=>(await f.service.read(d.draftId)).information['step-0'].values?.product?.status).toBe('provisional');timings.mentorCompleteToFieldReadMs=Date.now()-(await control())[1]!.finishedAt!;expect((await sql.query('select count(*)::int n from runtime_executions where actor_id=$1',[f.actor])).rows[0].n).toBe(2);expect((await sql.query('select count(*)::int n from opc_turns where draft_id=$1',[d.draftId])).rows[0].n).toBe(2);
  const calls=(await sql.query('select c.id,c.state,c.provider_id,c.payload from bill2_calls c join bill2_runs r on r.id=c.run_id where r.actor_id=$1 order by c.created_at',[f.actor])).rows;expect(calls).toHaveLength(3);expect(new Set(calls.map(c=>c.provider_id)).size).toBe(3);
  await page.getByRole('button',{name:'确认当前信息，继续',exact:true}).click();await poll(async()=>(await control()).length).toBe(4);expect((await control())[3]!.stream).toBe(true);await control(4);await poll(()=>send.isEnabled()).toBe(true);
  const before=(await sql.query('select id,state from runtime_executions where actor_id=$1 order by created_at',[f.actor])).rows;
  await page.reload();await poll(()=>composer.isEditable()).toBe(true);expect((await control()).length).toBe(4);
  expect((await f.service.read(d.draftId)).information['step-0'].values.product.status).toBe('confirmed');
  await page.getByRole('link',{name:'资料库',exact:true}).click();await page.getByRole('link',{name:'返回当前工作',exact:true}).click();await page.waitForURL('**'+path);
  expect((await control()).length).toBe(4);expect((await sql.query('select id,state from runtime_executions where actor_id=$1 order by created_at',[f.actor])).rows).toEqual(before);
  await page.screenshot({path:process.env.V3_WORKBENCH_OUTPUT+'/mentor-persisted-return-'+scenario+'.png',fullPage:true});
  // Mentor dialogue carries the frozen latency policy; the Luna organizer keeps its original bytes.
  expect((await control()).map(call=>[call.stream,call.reasoningEffort])).toEqual((await control()).map(call=>call.stream?[true,'none']:[false,null]));expect((await control()).some(call=>!call.stream)).toBe(true);
  Object.assign(timings,{streamRequests,prepareRequests});await writeFile(process.env.V3_WORKBENCH_OUTPUT+'/mentor-stream-browser-evidence-'+scenario+'.json',JSON.stringify({synthetic:true,qualityProof:false,timings,prepares,calls:await control(),executionIds:before},null,2));
 }catch(error){await page.screenshot({path:process.env.V3_WORKBENCH_OUTPUT+'/mentor-stream-failure.png',fullPage:true}).catch(()=>{});console.info('MENTOR_STREAM_FAILURE',error,await page.locator('body').innerText().catch(()=>''));throw error;}
 finally{releasePrepare();for(const call of await control())await control(call.index);await browser.close();}
},180000);
