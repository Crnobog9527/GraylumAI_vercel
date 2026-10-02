/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {it,expect} from 'vitest';
import {createHash,randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {configuredReasoning} from '../__tests__/fixtures/runtimeReasoning';
import {mergedPositioningFixture,sql} from './opc.integration';
const poll:typeof expect.poll=(callback,options)=>expect.poll(callback,{timeout:30000,...options});

// Auth, OPC, Runtime, SDK, HTTP streaming and BILL2 are real local paths.
// The isolated staging-host gateway supplies synthetic provider responses and
// controlled pauses only; these tests do not establish real mentor quality.

it.runIf(process.env.V3_LOCAL_STAGING_HOST==='true').each(['normal','refresh','proposal','invalid'] as const)('OPC: MENTOR_STREAM real browser incremental HTTP, editable drafts, frozen input and persistence (%s)',async(scenario)=>{
 const f=await mergedPositioningFixture(scenario==='proposal'?flow=>{
  flow.steps[0]!.information![0] = {...flow.steps[0]!.information![0]!,title:'参考研究结论',elicitation:'agent_proposal'};
 }:undefined),mentorId=randomUUID(),organizerId=randomUUID(),key='SYNTHETIC_BROWSER_'+randomUUID();
 // Real mentor admission requires a verified reasoning policy; the gateway stays synthetic.
 const policies=[[mentorId,'qwen/qwen3.8-27b'],[organizerId,'synthetic/browser-organizer']].map(([modelId,model])=>({multiplier:'1',modelId,model,provider:'openrouter',account:'openrouter-key:'+createHash('sha256').update(key).digest('hex'),protocol:'openrouter-chat-v1',upperUsd:'0.02',inputLimit:32000,outputLimit:100,automaticRetry:false,hiddenTools:false,lookupSupported:true,providerLimits:{providerSlug:'synthetic/fp8',contextTokens:10000,promptUsdPerMillion:'2',completionUsdPerMillion:'0',requestUsd:'0'}}));
 for(const p of policies)await sql.query("insert into ai_models(id,name,model_id,provider,is_active,api_endpoint,api_key,max_tokens,input_limit,config) values($1,'Synthetic browser streaming',$2,'openai','true','https://openrouter.ai/api/v1',$3,1000,10000,$4)",[p.modelId,p.model,key,JSON.stringify(configuredReasoning(p.model))]);
 await sql.query('update modules set model_id=$1 where id=$2',[mentorId,f.moduleId]);
 // BILL-UNIT window: entries carry m_i=1, equal to these models' configured multiplier.
 await sql.query('update ai_models set price_multiplier=1 where id=any($1)',[[mentorId,organizerId]]);
 await sql.query("insert into system_settings(key,value) values('v3_summary_model_id',$1),('v3_summary_max_tokens','128') on conflict(key) do update set value=excluded.value",[JSON.stringify(organizerId)]);
 await sql.query("insert into runtime_test_windows(id,enabled,actor_ids,call_policies,credits_per_usd,multiplier,max_cost_usd,max_calls,expires_at) values($1,true,$2,$3,1000,1,1,40,now()+interval '1 hour') on conflict(id) do update set actor_ids=excluded.actor_ids,call_policies=excluded.call_policies,expires_at=excluded.expires_at",[process.env.V3_RUNTIME_STAGING_WINDOW_ID,[f.actor],JSON.stringify(policies)]);
 const d=await f.service.start({requestId:randomUUID(),registration:f.registration,mode:'mentor',businessName:'Graylum AI'});
 if(scenario==='proposal')expect((await f.service.read(d.draftId)).information['step-0'].schema[0]).toMatchObject({id:'product',title:'参考研究结论',elicitation:'agent_proposal'});
 const {chromium}=await import('../../../../../apps/web/node_modules/@playwright/test');
 const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,
  // Evidence screenshots show where the chat scrollbar sits.
  ignoreDefaultArgs:['--hide-scrollbars']});
 const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();page.setDefaultTimeout(60000);
 await page.addInitScript(()=>{const seen=new Set<string>();(window as unknown as {mentorTextTimes:number[]}).mentorTextTimes=[];(window as unknown as {mentorTextSamples:Array<{at:number;text:string}>}).mentorTextSamples=[];new MutationObserver(()=>{for(const node of document.querySelectorAll('p')){const text=node.textContent??'';if(text.includes('本地流式导师正文：')&&!seen.has(text)){seen.add(text);(window as unknown as {mentorTextTimes:number[]}).mentorTextTimes.push(Date.now());(window as unknown as {mentorTextSamples:Array<{at:number;text:string}>}).mentorTextSamples.push({at:Date.now(),text});}}}).observe(document,{childList:true,subtree:true,characterData:true});});
 type Call={index:number;id:string;model:string;stream:boolean;reasoningEffort:string|null;startedAt:number;firstAt:number|null;finishedAt:number|null};
 const control=async(release?:number):Promise<Call[]>=>{const r=await fetch(process.env.V3_LOCAL_REST+'/__mentor_stream',{method:release?'POST':'GET',headers:{'x-local-control':process.env.V3_LOCAL_CONTROL!},...(release?{body:JSON.stringify({release})}:{})});if(!r.ok)throw new Error('isolated gate failed');return r.json();};
 await fetch(process.env.V3_LOCAL_REST+'/__mentor_stream',{method:'POST',headers:{'x-local-control':process.env.V3_LOCAL_CONTROL!},body:JSON.stringify({reset:true,invalidCard:scenario==='invalid'})});
 let releasePrepare=()=>{};
 const path='/positioning/'+d.draftId,timings:Record<string,number>={};let turnRequests=0,streamRequests=0,prepareRequests=0;const prepares:Array<{started:number;finished?:number}>=[];const prepareIndex=new Map<unknown,number>();
 await context.route('**/*',async route=>{const u=new URL(route.request().url());if(u.hostname==='syntheticstaging.supabase.co'){const response=await route.fetch({url:process.env.V3_LOCAL_REST+u.pathname+u.search});await route.fulfill({response});return;}if(!['127.0.0.1','localhost'].includes(u.hostname)&&!['data:','blob:'].includes(u.protocol)){await route.abort();return;}await route.continue();});
 // U2: each mentor turn is one opc.mentorTurnStream request; the old prepareStep + executeStream pair must not be sent.
 page.on('request',request=>{if(request.url().includes('runtime.executeStream'))streamRequests++;if(request.url().includes('opc.prepareStep'))prepareRequests++;if(request.url().includes('opc.mentorTurnStream')){turnRequests++;prepareIndex.set(request,prepares.length);prepares.push({started:Date.now()});}});
 page.on('response',response=>{const at=prepareIndex.get(response.request());if(at!==undefined)prepares[at]!.finished=Date.now();});
 try{
  await page.goto(process.env.V3_LOCAL_APP+'/login?redirect='+encodeURIComponent(path));
  await page.getByPlaceholder('name@example.com').fill(f.email);await page.getByPlaceholder('输入你的密码').fill(f.password);await page.getByRole('button',{name:'登录',exact:true}).last().click();await page.waitForURL('**'+path);
  await poll(async()=>(await control()).length,{timeout:60000}).toBe(1);
  const composer=page.getByRole('textbox',{name:'给导师的回复'}),send=page.getByRole('button',{name:'发送',exact:true});
  // The whole middle panel is the chat's scroll surface (scrollbar at its right edge), while
  // messages, the current check, composer and notes keep one centered column of at most 720px.
  const log=page.getByRole('log',{name:'完整导师消息'});
  const layout=()=>log.evaluate(node=>{
   const main=node.closest('main')!,panel=main.getBoundingClientRect(),box=node.getBoundingClientRect(),middle=panel.left+panel.width/2;
   const rect=(element:Element|null|undefined)=>{if(!element)return null;const r=element.getBoundingClientRect();return {width:r.width,center:r.left+r.width/2-middle,left:r.left-middle,right:r.right-middle,top:r.top,bottom:r.bottom};};
   const chat=node.parentElement!;
   return {panelWidth:panel.width,panelBottom:panel.bottom,left:box.left-panel.left,right:panel.right-box.right,logTop:box.top,
    overflowY:getComputedStyle(node).overflowY,scrolls:node.scrollHeight>node.clientHeight,
    messages:[...node.querySelectorAll('[data-message-role=assistant]')].map(rect),current:rect(node.querySelector('section[aria-label="当前问题操作"]')),
    composer:rect([...chat.children].find(child=>child.querySelector('textarea[aria-label="给导师的回复"]'))),notes:rect(chat.lastElementChild),
    steps:rect(main.querySelector('nav[aria-label="定位步骤"]')),footer:rect(main.querySelector(':scope>div>footer')),
    pageFits:document.documentElement.scrollWidth<=innerWidth,logFits:node.scrollWidth<=node.clientWidth};
  });
  const expectColumn=async(gutter:number)=>{
   const l=await layout(),column=Math.min(720,l.panelWidth-2*gutter);
   expect(l).toMatchObject({overflowY:'auto',pageFits:true,logFits:true});
   for(const gap of [l.left,l.right])expect(Math.abs(gap)).toBeLessThanOrEqual(1);
   // Composer and notes sit on the CSS gutter; log rows also keep symmetric scrollbar slots, so they may be narrower
   // (the first row keeps its existing 690px cap) but never leave the centered column.
   for(const box of [l.composer!,l.notes!]){expect(Math.abs(box.width-column)).toBeLessThanOrEqual(1);expect(Math.abs(box.center)).toBeLessThanOrEqual(1);}
   expect(l.messages.length).toBeGreaterThan(0);expect(l.current).not.toBeNull();
   for(const box of [...l.messages,l.current]){expect(box!.left).toBeGreaterThanOrEqual(-column/2-1);expect(box!.right).toBeLessThanOrEqual(column/2+1);}
   expect(Math.abs(l.current!.center)).toBeLessThanOrEqual(1);
   // Header and step tabs stay above the log; composer and the publish bar stay below it, inside the panel.
   expect(l.steps!.bottom).toBeLessThanOrEqual(l.logTop+1);expect(l.composer!.bottom).toBeLessThanOrEqual(l.footer!.top+1);
   expect(l.footer!.bottom).toBeLessThanOrEqual(l.panelBottom+1);
   return l;
  };
  await poll(()=>composer.isEditable()).toBe(true);await composer.fill('下一条仍可编辑的草稿');
  await poll(()=>page.getByText(/本地流式导师正文：/).count()).toBeGreaterThan(0);
  const opening=(await control())[0]!;expect(opening.finishedAt).toBeNull();expect([turnRequests,prepareRequests,streamRequests]).toEqual([1,0,0]);timings.openingDispatchToBrowserTextMs=(await page.evaluate(()=>(window as unknown as {mentorTextTimes:number[]}).mentorTextTimes))[0]!-opening.startedAt;
  expect(await send.isDisabled()).toBe(true);expect(await page.locator('body').innerText()).not.toContain('PRIVATE_STREAM_REASONING');
  await page.screenshot({path:process.env.V3_WORKBENCH_OUTPUT+'/mentor-opening-incremental-'+scenario+'.png',fullPage:true});
  await poll(async()=>(await page.evaluate(()=>(window as unknown as {mentorTextTimes:number[]}).mentorTextTimes)).length).toBeGreaterThanOrEqual(3);
  await control(1);await poll(async()=>(await control()).length).toBe(2);await control(2);await poll(()=>send.isEnabled()).toBe(true);
  if(scenario==='normal'){
   // A single opening message must not shrink the chat to its content, also with the right panel collapsed.
   expect((await expectColumn(24)).messages).toHaveLength(1);
   await page.getByRole('button',{name:'收起成果面板'}).click();await page.getByRole('button',{name:'展开右边栏'}).waitFor();
   expect((await expectColumn(24)).panelWidth).toBeGreaterThan(1000);
   await page.screenshot({path:process.env.V3_WORKBENCH_OUTPUT+'/mentor-scroll-surface-single-wide.png'});
   await page.getByRole('button',{name:'展开右边栏'}).click();await page.getByRole('heading',{name:'已确认的定位'}).waitFor();
  }
  // A host-opened turn is admitted without the card tool: text only.
  expect(await page.getByText('请选择当前问题最接近的答案：',{exact:true}).count()).toBe(0);
  if(scenario==='proposal')await poll(async()=>(await f.service.read(d.draftId)).information['step-0'].values?.product).toMatchObject({status:'provisional',nature:'decision',value:'借鉴同场景前后对照的讲解方式，不以器材评测为主。'});
  const openingValue=(await f.service.read(d.draftId)).information['step-0'].values?.product;
  if(scenario==='proposal'){
   const openingExecution=(await sql.query('select result from runtime_executions where actor_id=$1 order by created_at',[f.actor])).rows[0];
   expect(JSON.parse(openingExecution.result.summary).informationPatch.product).toMatchObject({status:'provisional',basis:'agent_proposal',value:openingValue.value});
   await poll(()=>page.getByText(openingValue.value,{exact:true}).count()).toBeGreaterThan(0);
  }
  else expect(openingValue?.value??'').toBe('');
  expect(await composer.inputValue()).toBe('下一条仍可编辑的草稿');
  const openingProgress=await page.evaluate(()=>(window as unknown as {mentorTextSamples:Array<{at:number;text:string}>}).mentorTextSamples);
  expect(openingProgress.length).toBeGreaterThanOrEqual(3);
  expect(openingProgress[1]!.text.length).toBeGreaterThan(openingProgress[0]!.text.length);
  expect(openingProgress[2]!.text.length).toBeGreaterThan(openingProgress[1]!.text.length);
  expect(openingProgress[1]!.text.startsWith(openingProgress[0]!.text)).toBe(true);
  expect(openingProgress[2]!.text.startsWith(openingProgress[1]!.text)).toBe(true);
  const input='我提供摄影入门练习课程，帮助相机初学者完成每周练习。';await composer.fill(input);
  await composer.dispatchEvent('compositionstart');await composer.dispatchEvent('keydown',{key:'Enter',code:'Enter',isComposing:true,keyCode:229});expect((await control()).length).toBe(2);await composer.dispatchEvent('compositionend');
  const prepareGate=new Promise<void>(resolve=>{releasePrepare=resolve;});await page.route('**/api/trpc/opc.mentorTurnStream**',async route=>{await prepareGate;await route.continue();});
  await page.evaluate(text=>{const started=performance.now();(window as unknown as {mentorTiming:unknown}).mentorTiming={started};const observer=new MutationObserver(()=>{const bubbles=[...document.querySelectorAll('[data-message-role="user"][data-request-id]')];if(bubbles.some(b=>b.textContent?.includes(text))){(window as unknown as {mentorTiming:unknown}).mentorTiming={started,bubble:performance.now()};observer.disconnect();}});observer.observe(document.body,{subtree:true,childList:true,characterData:true});},input);
  await send.evaluate(button=>{(button as HTMLButtonElement).click();(button as HTMLButtonElement).click();});
  await poll(()=>page.getByText(input,{exact:true}).count()).toBeGreaterThan(0);
  const feedback=await page.evaluate(()=>(window as unknown as {mentorTiming:{started:number;bubble:number}}).mentorTiming);timings.clickToBubbleMs=feedback.bubble-feedback.started;expect(timings.clickToBubbleMs).toBeLessThan(200);expect(await page.getByText('发送中 · 等待服务器确认',{exact:true}).isVisible()).toBe(true);expect(await page.getByText('上一条发给导师的内容仍在核对。请先用“继续核对这条原请求”恢复，不会重复发送。',{exact:true}).count()).toBe(0);expect(await composer.inputValue()).toBe('');await composer.fill('这是下一条尚未发送的新草稿');releasePrepare();
  await poll(async()=>(await control()).length).toBe(3);
  const second=(await control())[2]!;expect(second.finishedAt).toBeNull();expect([turnRequests,prepareRequests,streamRequests]).toEqual([2,0,0]);
  await page.screenshot({path:process.env.V3_WORKBENCH_OUTPUT+'/mentor-user-incremental-'+scenario+'.png',fullPage:true});
  expect(await page.getByText('DISCARDED_SEPARATE_ASSISTANT_TEXT',{exact:true}).count()).toBe(0);
  await control(3);await poll(async()=>(await control()).length).toBe(4);
  expect((await control())[3]!.finishedAt).toBeNull();expect(await composer.isEditable()).toBe(true);expect(await composer.inputValue()).toBe('这是下一条尚未发送的新草稿');
  await poll(()=>page.getByText(/本地流式导师正文：/).count()).toBeGreaterThan(1);
  await page.screenshot({path:process.env.V3_WORKBENCH_OUTPUT+'/mentor-organizer-pending-'+scenario+'.png',fullPage:true});
  if(scenario==='refresh'){
   const envelope=await page.evaluate(id=>sessionStorage.getItem('opc-step:'+id+':step-0'),d.draftId);expect(envelope).toBeTruthy();
   const executions=(await sql.query('select id,request_id from runtime_executions where actor_id=$1 order by created_at',[f.actor])).rows;
   await page.reload();await poll(()=>composer.isEditable()).toBe(true);expect(await composer.inputValue()).toBe('这是下一条尚未发送的新草稿');expect((await control()).length).toBe(4);
   expect(await page.evaluate(id=>sessionStorage.getItem('opc-step:'+id+':step-0'),d.draftId)).toBe(envelope);
   await page.screenshot({path:process.env.V3_WORKBENCH_OUTPUT+'/mentor-refresh-pending.png',fullPage:true});
   await control(4);await poll(async()=>(await sql.query('select state from runtime_executions where id=$1',[executions.at(-1).id])).rows[0].state).toBe('completed');
   const recovery=page.getByRole('button',{name:'继续核对这条原请求',exact:true});if(await recovery.isVisible())await recovery.click();else await page.reload();
   await poll(async()=>(await f.service.read(d.draftId)).information['step-0'].values?.product?.status).toBe('provisional');
   expect((await control()).length).toBe(4);expect((await sql.query('select id,request_id from runtime_executions where actor_id=$1 order by created_at',[f.actor])).rows).toEqual(executions);
  }else await control(4);
  await poll(()=>send.isEnabled()).toBe(true);expect(await composer.inputValue()).toBe('这是下一条尚未发送的新草稿');
  const source=(await sql.query('select id,result from runtime_executions where actor_id=$1 order by created_at',[f.actor])).rows.at(-1);
  const saved=JSON.parse(source.result.body);
  expect(saved.message).toContain('本地流式导师正文：');
  expect(await page.getByText('DISCARDED_SEPARATE_ASSISTANT_TEXT',{exact:true}).count()).toBe(0);
  if(scenario==='invalid'){
   expect(saved.card).toBeNull();expect(await page.getByRole('region',{name:'导师提问'}).count()).toBe(0);
  }else{
   await poll(()=>page.getByText('请选择当前问题最接近的答案：',{exact:true}).isVisible()).toBe(true);
   const card=page.getByRole('region',{name:'导师提问'}).last();
   await poll(()=>card.getByText('推荐',{exact:true}).isVisible()).toBe(true);
   expect(await card.getByText(saved.card.recommendationReason,{exact:true}).isVisible()).toBe(true);
   // The reason sits directly under the recommended option and describes it.
   const recommendedOption=card.locator('button[aria-describedby]'),reason=card.locator('button[aria-describedby] + p');
   expect(await recommendedOption.count()).toBe(1);expect(await recommendedOption.textContent()).toContain('推荐');
   expect(await reason.textContent()).toBe(saved.card.recommendationReason);
   expect(await reason.getAttribute('id')).toBe(await recommendedOption.getAttribute('aria-describedby'));
   expect(saved.message).toBe(saved.card.message);
   await card.getByRole('button',{name:'其他',exact:true}).click();
   await poll(()=>composer.evaluate(element=>element===document.activeElement)).toBe(true);
  }
  expect(await page.getByRole('button',{name:/我不确定/}).count()).toBe(0);
  expect(await composer.getAttribute('placeholder')).toBe('其他：自己补充');
  expect(await composer.inputValue()).toBe('这是下一条尚未发送的新草稿');
  await page.reload();await poll(()=>send.isEnabled()).toBe(true);
  await poll(()=>page.getByText(saved.message,{exact:true}).count()).toBeGreaterThan(0);
  expect((await control()).length).toBe(4);
  await poll(async()=>(await f.service.read(d.draftId)).information['step-0'].values?.product?.status).toBe('provisional');timings.mentorCompleteToFieldReadMs=Date.now()-(await control())[2]!.finishedAt!;expect((await sql.query('select count(*)::int n from runtime_executions where actor_id=$1',[f.actor])).rows[0].n).toBe(2);expect((await sql.query('select count(*)::int n from opc_turns where draft_id=$1',[d.draftId])).rows[0].n).toBe(2);
  const calls=(await sql.query('select c.id,c.state,c.provider_id,c.payload from bill2_calls c join bill2_runs r on r.id=c.run_id where r.actor_id=$1 order by c.created_at',[f.actor])).rows;expect(calls).toHaveLength(4);expect(new Set(calls.map(c=>c.provider_id)).size).toBe(4);
  // Simulate a stale tab without changing its visible card: a newer completed
  // Session execution exists before admission. The SQL lock must refuse it.
  if(scenario==='normal'){
   const original=(await sql.query('select id,created_at from runtime_executions where actor_id=$1 order by created_at limit 1',[f.actor])).rows[0];
   await sql.query("update runtime_executions set created_at=now()+interval '1 second' where id=$1",[original.id]);
   const requestsBefore=turnRequests;
   await page.getByRole('region',{name:'导师提问'}).last().getByRole('button').first().click();
   await poll(()=>page.getByText('这张卡已经过期，请看最新的回复。',{exact:true}).isVisible()).toBe(true);
   expect(await page.evaluate(id=>sessionStorage.getItem('opc-step:'+id+':step-0'),d.draftId)).toBeNull();
   expect(await page.getByRole('button',{name:'继续核对这条原请求',exact:true}).count()).toBe(0);
   expect(turnRequests).toBe(requestsBefore+1);expect((await control()).length).toBe(4);
   expect((await sql.query('select count(*)::int n from bill2_runs where actor_id=$1',[f.actor])).rows[0].n).toBe(2);
   await page.screenshot({path:process.env.V3_WORKBENCH_OUTPUT+'/mentor-source-denied-released.png',fullPage:true});
   await sql.query('update runtime_executions set created_at=$2 where id=$1',[original.id,original.created_at]);
   await page.reload();await poll(()=>send.isEnabled()).toBe(true);
   await poll(()=>page.getByRole('region',{name:'导师提问'}).last().isVisible()).toBe(true);
  }
  // Exercise both chosen-option and free-input correlation through the real HTTP admission.
  if(scenario==='refresh'||scenario==='invalid'){
   await composer.fill('我主要提供每周摄影练习课程。');await send.click();
  }else await page.getByRole('region',{name:'导师提问'}).last().getByRole('button').first().click();
  await poll(async()=>(await control()).length).toBe(5);await control(5);
  await poll(async()=>(await control()).length).toBe(6);await control(6);await composer.fill('后续尚未发送草稿');
  await poll(()=>send.isEnabled()).toBe(true);
  const answered=(await sql.query('select payload from runtime_executions where actor_id=$1 order by created_at desc limit 1',[f.actor])).rows[0].payload;
  expect(answered.attachedOrganizer.historyItems).toBe(0);
  if(scenario!=='invalid'){
   expect(answered.request.answerSource).toEqual({executionId:source.id,...(scenario==='refresh'?{}:{optionIndex:0})});
   const material=JSON.parse(answered.attachedOrganizer.input).answeredCard;
   expect(material).toMatchObject({question:saved.card.question,recommended:saved.card.recommended,
    selectedIndex:scenario==='refresh'?null:0,selectedOption:scenario==='refresh'?null:saved.card.options[0]});
  }
  await page.getByRole('button',{name:'确认当前信息，继续',exact:true}).click();await poll(async()=>(await control()).length).toBe(7);expect((await control())[6]!.stream).toBe(true);await control(7);await poll(async()=>(await control()).length).toBe(8);await control(8);await poll(()=>send.isEnabled()).toBe(true);
  // A reader at the bottom keeps following the newest mentor message as it arrives.
  if(scenario==='normal')await poll(()=>log.evaluate(node=>
   node.scrollHeight>node.clientHeight+300&&node.scrollHeight-node.clientHeight-node.scrollTop<64)).toBe(true);
  const before=(await sql.query('select id,state from runtime_executions where actor_id=$1 order by created_at',[f.actor])).rows;
  await page.reload();await poll(()=>composer.isEditable()).toBe(true);expect((await control()).length).toBe(8);
  expect((await f.service.read(d.draftId)).information['step-0'].values.product.status).toBe('confirmed');
  await page.getByRole('link',{name:'资料库',exact:true}).click();await page.getByRole('link',{name:'返回当前工作',exact:true}).click();await page.waitForURL('**'+path);
  expect((await control()).length).toBe(8);expect((await sql.query('select id,state from runtime_executions where actor_id=$1 order by created_at',[f.actor])).rows).toEqual(before);
  await page.screenshot({path:process.env.V3_WORKBENCH_OUTPUT+'/mentor-persisted-return-'+scenario+'.png',fullPage:true});
  if(scenario==='normal'){
   expect((await expectColumn(24)).scrolls).toBe(true);
   await log.evaluate(node=>{node.scrollTop=0;});await page.waitForTimeout(300);
   await page.screenshot({path:process.env.V3_WORKBENCH_OUTPUT+'/mentor-scroll-surface-top.png'});
   await page.reload();const loaded=()=>poll(()=>log.locator('[data-message-role=assistant]').count()).toBeGreaterThan(1);await loaded();
   // After refresh the same element is still the full-width scroll surface with the same column.
   expect((await expectColumn(24)).scrolls).toBe(true);
   await log.evaluate(node=>{node.scrollTop=node.scrollHeight;});
   await page.screenshot({path:process.env.V3_WORKBENCH_OUTPUT+'/mentor-scroll-surface-bottom.png'});
   await page.setViewportSize({width:390,height:844});await loaded();
   await expectColumn(14);
   await page.screenshot({path:process.env.V3_WORKBENCH_OUTPUT+'/mentor-scroll-surface-narrow.png'});
   await page.setViewportSize({width:1440,height:1000});
   // A reader who scrolled up keeps that position across a refresh instead of jumping to the newest message.
   expect(await log.evaluate(node=>node.scrollHeight-node.clientHeight)).toBeGreaterThan(300);
   await log.evaluate(node=>{node.scrollTop=120;});await page.waitForTimeout(300);
   await page.reload();await poll(()=>log.locator('[data-message-role=assistant]').count()).toBeGreaterThan(0);
   await poll(()=>log.evaluate(node=>node.scrollTop)).toBe(120);
   await page.waitForTimeout(500);expect(await log.evaluate(node=>node.scrollTop)).toBe(120);
  }
  // Mentor dialogue carries the frozen latency policy; the Luna organizer keeps its original bytes.
  expect((await control()).map(call=>[call.stream,call.reasoningEffort])).toEqual((await control()).map(call=>call.stream?[true,'none']:[false,null]));expect((await control()).some(call=>!call.stream)).toBe(true);
  const settlements=(await sql.query("select r.id,count(t.id)::int spends from bill2_runs r left join credit_transactions t on t.bill2_run_id=r.id and t.reason_code='bill2_spend' where r.actor_id=$1 group by r.id",[f.actor])).rows;
  expect(settlements).toHaveLength(4);expect(settlements.every(row=>row.spends===1)).toBe(true);
  Object.assign(timings,{turnRequests,streamRequests,prepareRequests});await writeFile(process.env.V3_WORKBENCH_OUTPUT+'/mentor-stream-browser-evidence-'+scenario+'.json',JSON.stringify({synthetic:true,qualityProof:false,timings,openingProgress,prepares,calls:await control(),executionIds:before},null,2));
 }catch(error){await page.screenshot({path:process.env.V3_WORKBENCH_OUTPUT+'/mentor-stream-failure.png',fullPage:true}).catch(()=>{});console.info('MENTOR_STREAM_FAILURE',error,await page.locator('body').innerText().catch(()=>''));throw error;}
 finally{releasePrepare();for(const call of await control())await control(call.index);await browser.close();}
},180000);
