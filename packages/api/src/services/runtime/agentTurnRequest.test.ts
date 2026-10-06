/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {expect,it} from 'vitest';
import type {Session} from '@openai/agents';
import {OPENING_INPUT} from '../../shared/opcQuestions';
import {UNSURE_INPUT} from '../../shared/agentTurn';
import {captureHostContext} from '../opc/captureContext';
import {hostTurnInput} from './hostTurn';
import {agentTurnInstructions} from '../opc/agentTurnPrompt';
import {groundedCardTool,cardSources} from './groundedCard';
import {runRuntime} from './runner';
import {openRouterRequestBody} from './providerRequest';

// Synthetic pinned revision: order, declared roles and statuses are part of
// these request goldens. No provider call is made by this SDK exchange.
const schema=[
 {id:'evidence',title:'已有证据',required:true,elicitation:'user_fact' as const},
 {id:'draft',title:'本轮建议',required:true,elicitation:'agent_proposal' as const},
 {id:'constraint',title:'待补约束',required:true},
 {id:'later',title:'暂缓事项',required:false,elicitation:'agent_proposal' as const},
];
const step={id:'synthetic-stage',title:'固定修订步骤',schema,values:{
 evidence:{status:'confirmed'},draft:{status:'provisional'},later:{status:'deferred'},
}};
const reasoning={parameter:'reasoning',value:{enabled:false}} as const;
const model='deepseek/deepseek-v4.1-flash';
const policy={modelId:'10000000-0000-4000-8000-000000000001',provider:'openrouter',account:'synthetic',
 model,protocol:'openrouter-chat-v1' as const,upperUsd:'0.0036096',inputLimit:32000,outputLimit:4096,
 automaticRetry:false as const,hiddenTools:false as const,lookupSupported:true,
 providerLimits:{providerSlug:'deepinfra/fp8',contextTokens:32000,
  promptUsdPerMillion:'0.1',completionUsdPerMillion:'0.1',requestUsd:'0'}};
const context=(opening:boolean)=>({providerRequestFormat:'agent-turn-v5-stream' as const,
 tools:opening?[]:['ask_question'],network:'deny',reasoning});
const session=():Session=>({getSessionId:async()=> 'synthetic-pinned-revision',getItems:async()=>[],
 addItems:async()=>{},popItem:async()=>undefined,clearSession:async()=>{}});
it.each(['ordinary','opening','answer-card'] as const)('freezes a complete B2 H1 wire request: %s',async(kind)=>{
 const opening=kind==='opening';
 const instructions=agentTurnInstructions();
 const host=captureHostContext([step],{[step.id]:step},step.id,opening);
 const userText=opening?OPENING_INPUT:kind==='answer-card'?'平台甲':UNSURE_INPUT;
 const input=hostTurnInput(userText,{content:{work:{steps:{[step.id]:{information:step.values}}}}},host);
 const requests:string[]=[];
 await runRuntime({model,instructions,input,session:session(),
  // A host-opened turn is admitted without the card tool (see admission.ts).
  maxOutputTokens:4096,maxTurns:1,tools:opening?[]:[groundedCardTool(()=>cardSources(userText,[]))],stream:true,reasoning,
  firstToolCallOnly:true,...(opening?{}:{stopAtToolNames:['ask_question']}),allowEmptyResult:true,commitSessionOnSuccess:true,
  selectHistory:async(_history,incoming)=>incoming,
  exchange:async(_sequence,body)=>{
   requests.push(openRouterRequestBody(body,{context:context(opening),policy,phase:'skill',primaryDialogue:true}));
   return JSON.stringify({id:'synthetic-reply',object:'chat.completion',created:1,model,
    choices:[{index:0,message:{role:'assistant',content:'先依据已有证据提出一个待核对建议。'},finish_reason:'stop'}]});
  },
 });
 expect(requests).toHaveLength(1);
 const sent=JSON.parse(requests[0]!);
 expect(sent.messages[0]).toEqual({content:instructions,role:'system'});
 expect(sent.messages[1]).toEqual({role:'user',content:input});
 expect(sent.reasoning).toEqual({enabled:false});expect(sent).not.toHaveProperty('reasoning_effort');
 expect(sent.provider.only).toEqual(['deepinfra/fp8']);
 if(opening)expect(sent).not.toHaveProperty('tools');
 else{
  expect(sent.tools.map((tool:{function:{name:string}})=>tool.function.name)).toEqual(['ask_question']);
  expect(sent.tools[0].function).toMatchObject({strict:true,parameters:{additionalProperties:false,
   required:['intent','requestQuote','basisQuotes','question','options','recommended'],properties:{question:{minLength:1,maxLength:500},
    options:{minItems:2,maxItems:5,items:{properties:{text:{minLength:1,maxLength:200}}}},
    recommended:{anyOf:[{type:'number'},{type:'null'}]}}}});
 }
 expect(sent).not.toHaveProperty('parallel_tool_calls');expect(sent).not.toHaveProperty('tool_choice');
 expect(sent).toMatchSnapshot();
});
