/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Overlay for the exact #497 head. Live requests pass the parent budget boundary.
import assert from 'node:assert/strict';
import {createHash, randomUUID, randomBytes} from 'node:crypto';
import {readFileSync, writeFileSync} from 'node:fs';
import {it} from 'vitest';
import {MemorySession} from '@openai/agents';
import {prepareModuleSkill} from '../../services/skills/modulePublication.ts';
import {activateSkill, identityOf} from '../../services/skills/loader.ts';
import {runRuntime} from '../../services/runtime/runner.ts';
import {agentTurnInstructions} from './legacyAgentTurnPrompt.ts';
import {askQuestionTool, askQuestionToolBytes, QUESTION_CONTRACT_INSTRUCTIONS} from '../../services/runtime/agentTools.ts';
import {agentTurnResult} from '../../services/runtime/agentTurnResult.ts';
import {openRouterRequestBody} from '../../services/runtime/providerRequest.ts';
import {selectRuntimeHistory, assertRuntimeRequestCapacity} from '../../services/runtime/context.ts';
import {projectOpenRouterItemsForSizing} from '../../services/runtime/openRouterHistory.ts';
import {openRouterAdapter} from '../../services/bill2/openRouterAdapter.ts';
import {openRouterBound} from '../../services/bill2/openRouterPolicy.ts';
import {historyItems} from './trial.ts';
import {blindReview} from './blindReview.ts';
import {assertCardDesignScenarios} from './agentTurn.ts';
import {callBoundUsd} from './config.ts';
import {createBudget, memoryLedger, usdToNano, nanoToUsd} from './budget.ts';

const hash = value => createHash('sha256').update(value).digest('hex');
const candidates = [
  {id:'G',model:'google/gemini-3.8-flash',route:'google-vertex/global',context:1048576,input:.75,output:3.75},
  {id:'S',model:'anthropic/claude-sonnet-5.5',route:'anthropic',context:1000000,input:2,output:10},
].map(c => ({...c,modelId:randomUUID(),maxTokens:8192,
  config:{id:c.id.toLowerCase(),model:c.model,route:c.route,effort:'low',maxPrice:{prompt:c.input,completion:c.output}}}));
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

it('STG_MENTOR: frozen 80 single-turn samples; stop before independent blind review', async () => {
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
  const budget = createBudget({maxCalls:80,maxUsd:10,ledger:memoryLedger()});
  const capture = (raw,c,phase,id,sample) => {
    const body=JSON.parse(raw), B=Buffer.byteLength(raw);
    assert.equal(body.model,c.model);assert.equal(body.max_tokens,c.maxTokens);
    assert.equal(body.reasoning_effort,c.config.effort);assert.equal(raw.includes('cache_control'),false);
    assert.deepEqual(body.provider,openRouterBound(policyFor(c).providerLimits,c.maxTokens).routing);
    assertRuntimeRequestCapacity(raw,90000);
    const estimateConfig=c.config;
    const reserveNano=usdToNano(callBoundUsd(estimateConfig,B,c.maxTokens));
    assert.ok(reserveNano<=usdToNano(c.id==='G'?.1:.27));
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

  if(live){
    const blind=blindReview(['G','S'].map(id=>mainTrials.filter(t=>t.configId===id)),randomBytes(32));
    writeFileSync(process.env.V3_WORKBENCH_OUTPUT+'/blind-review.json',JSON.stringify(blind.items),{mode:0o600});
    writeFileSync(process.env.V3_WORKBENCH_OUTPUT+'/private-blind-mapping.json',JSON.stringify(blind.privateMapping),{mode:0o600});
    const response=await fetch(live.url+'/main-complete',{method:'POST',
      headers:{Authorization:'Bearer '+live.secret},body:'{}'});
    if(!response.ok)throw new Error('MENTOR_MAIN_INCOMPLETE');
  }
  assert.equal(rows.length,80);
  const totals=candidates.map(c=>{const own=rows.filter(row=>row.model===c.model);
    return {model:c.model,calls:own.length,minB:Math.min(...own.map(r=>r.B)),maxB:Math.max(...own.map(r=>r.B)),
      reserveUsd:nanoToUsd(own.reduce((sum,row)=>sum+row.reserveNano,0))};});
  const result={version:1,mode:live?'live':'offline-only',frozenHead:input.frozenHead,
    planId:hash(JSON.stringify(rows)),scenariosSourceHash:input.scenariosSourceHash,totals,
    totalReserveUsd:nanoToUsd(rows.reduce((sum,row)=>sum+row.reserveNano,0)),providerRequests:live?rows.length:0,rows};
  writeFileSync(process.env.V3_WORKBENCH_OUTPUT+'/mentor-preparation.json',JSON.stringify(result,null,2)+'\n',{mode:0o600});
  console.info('STG_MENTOR_MAIN_RESULT',JSON.stringify({...result,rows:undefined}));
},24*60*60*1000);
