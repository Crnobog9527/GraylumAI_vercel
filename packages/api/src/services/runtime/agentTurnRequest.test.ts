/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {expect,it} from 'vitest';
import type {Session} from '@openai/agents';
import {OPENING_INPUT} from '../../shared/opcQuestions';
import {UNSURE_INPUT} from '../../shared/agentTurn';
import {agentTurnInstructions} from '../opc/agentTurnPrompt';
import {askQuestionTool} from './agentTools';
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
const workflowContext=[{id:step.id,title:step.title,fields:schema.map(field=>field.id)}];
const question=schema[1]!;
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
const sha=(text:string)=>createHash('sha256').update(text).digest('hex');

function planInstructions(opening:boolean){
 const plan=readFileSync(new URL('../../../../../docs/launch/AGENT_TURN_ENABLE_PLAN.md',import.meta.url),'utf8');
 const blocks=Array.from(plan.matchAll(/```text\n([\s\S]*?)```/g),match=>match[1]!);
 const host=blocks.find(block=>block.startsWith('Act as the single continuous mentor'));
 const openingRule=blocks.find(block=>block.startsWith('This turn is opened by the host'));
 expect(host).toBeDefined();expect(openingRule).toBeDefined();
 // Independent expected projection, so changing field role/order/status or the
 // plan's complete public prompt cannot silently regenerate the golden.
 const substitutions:Record<string,string>={
  STEP_ID:'synthetic-stage',STEP_MATERIAL_JSON:JSON.stringify({id:step.id,title:step.title,fields:[
   {id:'evidence',title:'已有证据',required:true,elicit:'user_fact',status:'confirmed'},
   {id:'draft',title:'本轮建议',required:true,elicit:'agent_proposal',status:'provisional'},
   {id:'constraint',title:'待补约束',required:true,elicit:'user_fact',status:'missing'},
   {id:'later',title:'暂缓事项',required:false,elicit:'agent_proposal',status:'deferred'},
  ]}),
  CURRENT_QUESTION_JSON:JSON.stringify({id:'draft',title:'本轮建议',label:'3.2'}),
  CURRENT_FIELD_SPECS_JSON:JSON.stringify([
   {id:'draft',title:'本轮建议',required:true,elicit:'agent_proposal'},
  ]),WORKFLOW_CONTEXT_JSON:JSON.stringify(workflowContext),
 };
 return host!.replace(/\{\{([A-Z_]+)\}\}/g,(_match,key:string)=>substitutions[key]!)+
  (opening?'\n'+openingRule:'');
}

it.each([
 {opening:false,golden:'51c0952d8eac71d84f7e8cc170c30d1ed5a789271036c87e089f72a234bfaaef'},
 {opening:true,golden:'c574e4996fa0b910b1216a37ed1a790c3288feb9ef3cb628c36b8c8e0b3f26b8'},
])('freezes full v5 host prompt, pinned fields and wire request (opening=$opening)',async({opening,golden})=>{
 const instructions=agentTurnInstructions({step,question,questionLabel:'3.2',workflowContext,opening});
 expect(instructions).toBe(planInstructions(opening));
 const requests:string[]=[];
 await runRuntime({model,instructions,input:opening?OPENING_INPUT:UNSURE_INPUT,session:session(),
  // A host-opened turn is admitted without the card tool (see admission.ts).
  maxOutputTokens:4096,maxTurns:1,tools:opening?[]:[askQuestionTool()],stream:true,reasoning,
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
 expect(sent.messages[1]).toEqual({role:'user',content:opening?OPENING_INPUT:UNSURE_INPUT});
 expect(sent.reasoning).toEqual({enabled:false});expect(sent).not.toHaveProperty('reasoning_effort');
 expect(sent.provider.only).toEqual(['deepinfra/fp8']);
 if(opening)expect(sent).not.toHaveProperty('tools');
 else{
  expect(sent.tools.map((tool:{function:{name:string}})=>tool.function.name)).toEqual(['ask_question']);
  expect(sent.tools[0].function).toMatchObject({strict:true,parameters:{additionalProperties:false,
   required:['question','options','recommended'],properties:{question:{minLength:1,maxLength:500},
    options:{minItems:2,maxItems:5,items:{minLength:1,maxLength:200}},
    recommended:{anyOf:[{type:'number'},{type:'null'}]}}}});
 }
 expect(sent).not.toHaveProperty('parallel_tool_calls');expect(sent).not.toHaveProperty('tool_choice');
 expect(sha(requests[0]!)).toBe(golden);
});
