/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Overlay for the exact #497 head. Live requests pass the parent budget boundary.
import assert from 'node:assert/strict';
import {createHash, randomUUID, randomBytes} from 'node:crypto';
import {readFileSync, writeFileSync} from 'node:fs';
import {it} from 'vitest';
import {MemorySession} from '@openai/agents';
import {mergedPositioningFixture, sql, admin} from '../../services/opc/opc.integration.ts';
import {opcService} from '../../services/opc/service.ts';
import {saveModuleSkill, prepareModuleSkill} from '../../services/skills/modulePublication.ts';
import {activateSkill, identityOf} from '../../services/skills/loader.ts';
import {runtimeExecutor} from '../../services/runtime/execute.ts';
import {runRuntime} from '../../services/runtime/runner.ts';
import {agentTurnInstructions} from '../../services/opc/agentTurnPrompt.ts';
import {askQuestionTool, askQuestionToolBytes, QUESTION_CONTRACT_INSTRUCTIONS} from '../../services/runtime/agentTools.ts';
import {agentTurnResult} from '../../services/runtime/agentTurnResult.ts';
import {openRouterRequestBody} from '../../services/runtime/providerRequest.ts';
import {selectRuntimeHistory, assertRuntimeRequestCapacity} from '../../services/runtime/context.ts';
import {projectOpenRouterItemsForSizing} from '../../services/runtime/openRouterHistory.ts';
import {openRouterAdapter} from '../../services/bill2/openRouterAdapter.ts';
import {openRouterBound} from '../../services/bill2/openRouterPolicy.ts';
import {OPENING_INPUT} from '../../shared/opcQuestions.ts';
import {configuredReasoning} from '../../services/__tests__/fixtures/runtimeReasoning.ts';
import {historyItems} from './trial.ts';
import {blindReview} from './blindReview.ts';
import {assertCardDesignScenarios} from './agentTurn.ts';
import {callBoundUsd} from './config.ts';
import {createBudget, memoryLedger, usdToNano, nanoToUsd} from './budget.ts';
import {sseResponse, textDeltas, toolDeltas} from './dryRun.ts';

const hash = value => createHash('sha256').update(value).digest('hex');
const candidates = [
  {id:'G',model:'google/gemini-3.8-flash',route:'google-vertex/global',context:1048576,input:.75,output:3.75},
  {id:'S',model:'anthropic/claude-sonnet-5.5',route:'anthropic',context:1000000,input:2,output:10},
  {id:'L',model:'openai/gpt-6-luna',route:'openai',context:1050000,input:.1,output:.5},
].map(c => ({...c,modelId:randomUUID(),maxTokens:c.id==='L'?2048:8192,
  config:{id:c.id.toLowerCase(),model:c.model,route:c.route,effort:c.id==='L'?'none':'low',maxPrice:{prompt:c.input,completion:c.output}}}));
const policyFor = c => {
  const limits = {providerSlug:c.route,contextTokens:c.context,promptUsdPerMillion:String(c.input),
    completionUsdPerMillion:String(c.output),requestUsd:'0'};
  return {modelId:c.modelId,provider:'openrouter',account:'openrouter-key:'+hash('SYNTHETIC_ONLY'),model:c.model,protocol:'openrouter-chat-v1',
    providerLimits:limits,upperUsd:openRouterBound(limits,c.maxTokens).upperUsd,inputLimit:90000,outputLimit:c.maxTokens,
    automaticRetry:false,hiddenTools:false,lookupSupported:true};
};
const card = {message:'离线合成回复：先明确方向，再收集证据。',question:'先明确哪一项？',
  options:['服务对象','交付形式'],recommended:0,recommendationReason:'便于确定下一步需要的信息。'};
const reply = (c, hasCard, text='离线合成回复，不代表模型质量。') => ({
  id:'gen-offline-'+randomUUID(),object:'chat.completion',created:1,model:c.model,
  choices:[{index:0,message:{role:'assistant',content:hasCard?null:text,
    ...(hasCard?{tool_calls:[{id:'call_offline',type:'function',function:{name:'ask_question',arguments:JSON.stringify(card)}}]}:{})},
  finish_reason:hasCard?'tool_calls':'stop'}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15,cost:0},
});

it('STG_MENTOR: frozen single-turn samples and product two-turn offline preparation', async () => {
  const input = JSON.parse(readFileSync(process.env.V3_REAL_SKILL_INPUT,'utf8'));
  assert.equal(hash(JSON.stringify(input.scenarios)), input.scenariosCanonicalHash);
  assert.equal(input.scenariosSourceHash,'0be012a845999a8d6c345a74df7a66e9cb61e3242dac4db98880ef8ebcd2564a');
  assertCardDesignScenarios(input.scenarios);
  const rows = [],mainTrials=[];
  const live=input.live;
  const forward=async(raw,c,phase,id)=>{
    const response=await fetch(live.url+'/request',{method:'POST',
      headers:{Authorization:'Bearer '+live.secret,'Content-Type':'application/json'},
      body:JSON.stringify({raw,slot:{model:c.id,phase,id}})});
    if(!response.ok)throw new Error('MENTOR_LIVE_STOP');
    return response;
  };
  const budget = createBudget({maxCalls:104,maxUsd:15,ledger:memoryLedger()});
  const capture = (raw,c,phase,id,sample) => {
    const body=JSON.parse(raw), B=Buffer.byteLength(raw);
    assert.equal(body.model,c.model);assert.equal(body.max_tokens,c.maxTokens);
    assert.equal(body.reasoning_effort,c.config.effort);assert.equal(raw.includes('cache_control'),false);
    assert.deepEqual(body.provider,openRouterBound(policyFor(c).providerLimits,c.maxTokens).routing);
    assertRuntimeRequestCapacity(raw,c.id==='L'?32000:90000);
    const estimateConfig=c.id==='L'?{...c.config,maxPrice:{...c.config.maxPrice,prompt:.125}}:c.config;
    const reserveNano=usdToNano(callBoundUsd(estimateConfig,B,c.maxTokens));
    assert.ok(reserveNano<=usdToNano(c.id==='L'?.006:c.id==='G'?.1:.27));
    if(!live)budget.reserve(reserveNano); // Live reservations belong exclusively to the parent boundary.
    rows.push({id,phase,category:sample?.category??'e2e',sampleHash:hash(JSON.stringify(sample??{id})),model:c.model,
      route:c.route,B,K:4096,M:4096,T:B+8192,requestHash:hash(raw),
      prompt_tokens:null,reasoning_tokens:null,providerCostUsd:null,finishReason:null,truncated:null,
      reason:live?'provider evidence in parent mentor-live-results.jsonl':'offline fixture; no provider usage',
      maxTokens:c.maxTokens,effort:c.config.effort,
      reserveNano,reserveUsd:nanoToUsd(reserveNano),productQuoteUsd:policyFor(c).upperUsd});
  };
  const moduleInput=structuredClone(input.moduleSkill);
  const prepared=prepareModuleSkill(moduleInput), descriptor=prepared.descriptor;
  const source={list:async()=>[descriptor],state:async()=> 'enabled',read:async({path})=>
    Buffer.from(moduleInput.files.find(file=>file.path===path).base64,'base64')};
  // #497 freeze item 6: original synthetic sample history is confined to the
  // single-turn harness. It is never inserted into a product Session.
  for(const c of candidates.slice(0,2)) for(const scenario of input.scenarios) {
    const step=moduleInput.steps[scenario.step], question=step.information.find(field=>field.id===scenario.questionId);
    const skill=await activateSkill(source,identityOf(descriptor),{resources:step.resources,maxContextBytes:90000});
    const instructions=skill.forModel()+'\n'+agentTurnInstructions({
      step:{id:scenario.currentStepId,title:step.title,schema:step.information,values:scenario.fieldValues},
      question,questionLabel:null,opening:scenario.opening??false,
      workflowContext:moduleInput.steps.map((s,index)=>({index,title:s.title,information:s.information})),
    })+'\n'+QUESTION_CONTRACT_INSTRUCTIONS;
    const session=new MemorySession();await session.addItems(historyItems(scenario).slice(0,-1));
    const adapter=openRouterAdapter({allowAgentTools:true,credential:async()=> 'SYNTHETIC_ONLY',
      transport:live?async(_url,init)=>forward(String(init.body),c,'main-single-turn',scenario.id):
        async()=>{throw new Error('OFFLINE_TRANSPORT_FORBIDDEN');}});
    let calls=0,toolCalled=false,prose='',providerSettled=false,rawResponse;
    try {
    const result=await runRuntime({model:c.model,instructions,input:scenario.input,session,
      maxOutputTokens:8192,maxTurns:1,reasoning:{effort:'low'},stream:true,firstToolCallOnly:true,
      stopAtToolNames:['ask_question'],allowEmptyResult:true,commitSessionOnSuccess:true,
      tools:[askQuestionTool(true)],onText:text=>{prose+=text;},
      selectHistory:async(history,incoming)=>selectRuntimeHistory(history,incoming,{instructions,inputBytes:90000,
        historyItems:100,toolBytes:askQuestionToolBytes(true),projectItems:projectOpenRouterItemsForSizing}),
      exchange:async(_sequence,request,onChunk)=>{
        assert.equal(++calls,1);
        const raw=openRouterRequestBody(request,{context:{providerRequestFormat:'agent-turn-v5-stream',tools:['ask_question'],
          network:'deny',reasoning:{effort:'low'}},policy:policyFor(c),phase:'mentor',primaryDialogue:true});
        const send=await adapter.prepareDispatch({input:raw},policyFor(c),onChunk);
        capture(raw,c,'main-single-turn',scenario.id,scenario);
        const response=live?await (async()=>{
          const observation=await send();
          providerSettled=observation.complete&&observation.httpStatus===200;
          const evidence=adapter.evidence(observation,policyFor(c),'response');
          if(!evidence.final||!evidence.usage?.sdkResponse)throw new Error('MENTOR_LIVE_EVIDENCE_INVALID');
          return evidence.usage.sdkResponse;
        })():reply(c,['A','B'].includes(scenario.category));
        rawResponse=response;
        toolCalled=Boolean(response.choices[0].message.tool_calls);
        return JSON.stringify(response);
      },
    });
    const projection=agentTurnResult(prose,result,toolCalled);
    if(!live){assert.ok(projection.message);assert.equal(Boolean(projection.card),['A','B'].includes(scenario.category));}
    else {rows[rows.length-1].projection=projection;writeFileSync(process.env.V3_WORKBENCH_OUTPUT+'/mentor-main-results.json',
      JSON.stringify(rows),{mode:0o600});}
    } catch(error) {
      if(!live||!providerSettled)throw error;
      rows[rows.length-1].formatFailure=true;
      writeFileSync(process.env.V3_WORKBENCH_OUTPUT+'/mentor-main-results.json',JSON.stringify(rows),{mode:0o600});
    }
    if(live){
      const message=rawResponse?.choices?.[0]?.message;
      mainTrials.push({configId:c.id,scenarioId:scenario.id,kind:'ask',index:input.scenarios.indexOf(scenario),
        calls:[{facts:{content:message?.content??'',toolCalls:(message?.tool_calls??[]).map(tool=>
          ({name:tool.function.name,arguments:tool.function.arguments}))}}]});
    }
  }

  let passed=['G','S'];
  if(live){
    const blind=blindReview(['G','S'].map(id=>mainTrials.filter(t=>t.configId===id)),randomBytes(32));
    writeFileSync(process.env.V3_WORKBENCH_OUTPUT+'/blind-review.json',JSON.stringify(blind.items),{mode:0o600});
    writeFileSync(process.env.V3_WORKBENCH_OUTPUT+'/private-blind-mapping.json',JSON.stringify(blind.privateMapping),{mode:0o600});
    const response=await fetch(live.url+'/main-complete',{method:'POST',
      headers:{Authorization:'Bearer '+live.secret},body:'{}'});
    if(!response.ok)throw new Error('MENTOR_QUALITY_STOP');
    let review=await response.json();
    while(review.pending){
      await new Promise(resolve=>setTimeout(resolve,5000));
      const status=await fetch(live.url+'/review-status',{method:'POST',
        headers:{Authorization:'Bearer '+live.secret},body:'{}'});
      if(!status.ok)throw new Error('MENTOR_QUALITY_STOP');
      review=await status.json();
    }
    passed=review.passed;
  }
  // Full product path for the six two-turn scenarios. All SQL is through the
  // existing disposable local runner. No remote database or real key is accepted.
  assert.match(process.env.V3_LOCAL_DB,/^postgres:\/\/postgres@127\.0\.0\.1:\d+\/v3_disposable$/);
  const f=await mergedPositioningFixture();
  // Synthetic fixture credits cover the frozen product's full-context reservation.
  await sql.query('update profiles set credits=10000 where id=$1',[f.actor]);
  await sql.query(`insert into credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,
    idempotency_key,balance_before,balance_after) values($1,9000,'addition','grant','opening_grant','system',$2,1000,10000)`,
  [f.actor,randomUUID()]);
  const originalRpc=admin.rpc.bind(admin);
  admin.rpc=(name,args)=>{
    const response=originalRpc(name,args);
    return name==='runtime_admit'?response.then(result=>{
      if(result.error)writeFileSync(process.env.V3_WORKBENCH_OUTPUT+'/private-admission-error.json',
        JSON.stringify(result.error),{mode:0o600});
      if(result.error)console.info('OFFLINE_ADMISSION_CODE',
        /^[A-Z0-9_]+$/.test(result.error.message)?result.error.message:result.error.code);
      return result;
    }):response;
  };
  for(const c of candidates) {
    const config=configuredReasoning(c.model,c.id==='L'?{mode:'off',wire:'reasoning_effort'}:
      {mode:'effort',effort:'low',wire:'reasoning_effort'},c.id==='L'?'organize':'interactive');
    config.reasoning.route=c.route;config.reasoning.catalog.endpoints[0].tag=c.route;
    config.reasoning.catalog.endpoints[0].contextLength=c.context;
    config.reasoning.catalog.endpoints[0].maxCompletionTokens=c.maxTokens;
    await sql.query(`insert into ai_models(id,name,model_id,provider,is_active,api_key,api_endpoint,max_tokens,input_limit,config)
      values($1,'Offline preparation',$2,'openai',true,'SYNTHETIC_ONLY','https://openrouter.ai/api/v1',$3,$4,$5)`,
    [c.modelId,c.model,c.maxTokens,c.context,config]);
  }
  moduleInput.module.model_id=candidates[0].modelId;
  await saveModuleSkill(admin,f.owner,moduleInput);
  const registration=(await sql.query('select id from artifact_workflows where module_id=$1',[moduleInput.moduleId])).rows[0].id;
  await sql.query(`insert into system_settings(key,value) values('v3_summary_model_id',$1),('v3_summary_max_tokens','2048'),
    ('runtime_purpose_budgets',$2) on conflict(key) do update set value=excluded.value`,
  [JSON.stringify(candidates[2].modelId),JSON.stringify({version:1,interactive:{inputBytes:90000,historyItems:100,maxOutputTokens:8192},
    organize:{inputBytes:32000,historyItems:0},report:{inputBytes:90000,historyItems:100,maxOutputTokens:8192}})]);
  const windowId=randomUUID(),policies=candidates.map(policyFor);
  await sql.query(`insert into runtime_test_windows(id,actor_ids,call_policies,credits_per_usd,multiplier,
    max_cost_usd,max_calls,expires_at,enabled) values($1,$2,$3,1000,1,10,104,now()+interval '2 hours',true)`,
  [windowId,[f.actor],JSON.stringify(policies)]);
  const service=opcService(f.user,admin,{id:windowId,callPolicies:policies,creditsPerUsd:'1000',multiplier:'1',
    expiresAt:new Date(Date.now()+3600000).toISOString()});
  for(const mentor of candidates.slice(0,2).filter(c=>passed.includes(c.id))) {
    await sql.query('update modules set model_id=$1 where id=$2',[mentor.modelId,moduleInput.moduleId]);
    for(const scenario of ['opening-answer','card-selection','free-clarification']) {
      const draft=await service.start({requestId:randomUUID(),registration,mode:'mentor'});
      let turn=0,previous,actualCard;
      const adapter=openRouterAdapter({allowAgentTools:true,credential:async()=> 'SYNTHETIC_ONLY',transport:async(url,init)=>{
        assert.equal(String(url),'https://openrouter.ai/api/v1/chat/completions');
        const raw=String(init.body),body=JSON.parse(raw),c=candidates.find(item=>item.model===body.model);
        capture(raw,c,'e2e',mentor.id+'-'+scenario+'-'+turn+'-'+c.id);
        if(live)return forward(raw,c,'e2e',mentor.id+'-'+scenario+'-'+turn+'-'+c.id);
        const hasCard=c.id!=='L'&&scenario!=='opening-answer'&&turn===0;
        const text=c.id==='L'?JSON.stringify({inputKind:'uncertainty',targetStepId:'step-1',informationPatch:{}}):'离线合成回复，不代表模型质量。';
        if(body.stream) {
          const stream=sseResponse(c.model,hasCard?toolDeltas('ask_question',card):textDeltas(text),
            {finish:hasCard?'tool_calls':'stop',usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15,cost:0}});
          return new Response((await stream.text()).replaceAll('gen-dry-run','gen-offline-'+randomUUID()),
            {headers:{'content-type':'text/event-stream'}});
        }
        return new Response(JSON.stringify(reply(c,hasCard,text)),{headers:{'content-type':'application/json'}});
      }});
      for(turn=0;turn<2;turn++) {
        const selected=scenario==='card-selection'&&turn===1;
        const request={draftId:draft.draftId,stepId:'step-1',questionId:moduleInput.steps[0].information[0].id,
          purpose:'mentor',requestId:randomUUID(),input:turn===0&&scenario==='opening-answer'?OPENING_INPUT:
            selected?(live?actualCard.options[0]:card.options[0]):turn===0?'我还不确定，帮我分析一下。':'我是独立开发者，提供账号内容规划服务。',
          ...(turn===0&&scenario==='opening-answer'?{}:{organizeAfter:true}),
          ...(turn===1&&scenario!=='opening-answer'&&(!live||actualCard)?{answerSource:{executionId:previous,...(selected?{optionIndex:0}:{})}}:{})};
        const admitted=await service.prepareStep(request);
        const before=rows.length;
        const result=await runtimeExecutor({database:admin,actor:async()=>f.actor,adapter}).execute(admitted.executionId);
        assert.equal(result.state,'completed');assert.equal(rows.length-before,2);
        const calls=(await sql.query('select c.payload from bill2_calls c join runtime_executions e on e.billing_run_id=c.run_id where e.id=$1',
          [admitted.executionId])).rows;
        assert.deepEqual(calls.map(c=>c.payload.requestHash).sort(),rows.slice(before).map(r=>r.requestHash).sort());
        if(live&&turn===0&&scenario!=='opening-answer'){
          actualCard=result.result?.card??result.card;
          // Read the real saved product reply; never fabricate answerSource/options.
          const execution=(await sql.query('select result from runtime_executions where id=$1',[admitted.executionId])).rows[0];
          actualCard=JSON.parse(execution.result.body).card;
          if(scenario==='card-selection'&&!actualCard?.options?.length)throw new Error('MENTOR_E2E_CARD_PRECONDITION');
        }
        previous=admitted.executionId;
      }
    }
  }
  assert.equal(rows.length,live?80+passed.length*12:104);
  if(!live)assert.throws(()=>budget.reserve(1),/run_call_cap/);
  const unknown=createBudget({maxCalls:2,maxUsd:1,ledger:memoryLedger()});
  unknown.reserve(100);unknown.stop('unknown_result');
  assert.throws(()=>unknown.reserve(100),/unknown_result/);assert.equal(unknown.run.calls,1);
  const limited=createBudget({maxCalls:1,maxUsd:.01,ledger:memoryLedger()});
  assert.throws(()=>limited.reserve(usdToNano(.02)),/run_usd_cap/);assert.equal(limited.run.calls,0);
  const totals=candidates.map(c=>{const own=rows.filter(row=>row.model===c.model);
    return {model:c.model,calls:own.length,minB:Math.min(...own.map(r=>r.B)),maxB:Math.max(...own.map(r=>r.B)),
      reserveUsd:nanoToUsd(own.reduce((sum,row)=>sum+row.reserveNano,0))};});
  const result={version:1,mode:live?'live':'offline-only',frozenHead:'f9afd0db7805e80ccc6f5b7023a3e87b5014f5bd',
    planId:hash(JSON.stringify(rows)),scenariosSourceHash:input.scenariosSourceHash,totals,
    totalReserveUsd:nanoToUsd(rows.reduce((sum,row)=>sum+row.reserveNano,0)),providerRequests:live?rows.length:0,rows};
  writeFileSync(process.env.V3_WORKBENCH_OUTPUT+'/mentor-preparation.json',JSON.stringify(result,null,2)+'\n',{mode:0o600});
  console.info('STG_MENTOR_OFFLINE_RESULT',JSON.stringify({...result,rows:undefined}));
},liveTimeout());
function liveTimeout(){return 24*60*60*1000;}
