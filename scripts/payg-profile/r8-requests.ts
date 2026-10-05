/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {z} from 'zod';
import {priceSchema} from './sampling';
import {openRouterBound} from '../../packages/api/src/services/bill2/openRouterPolicy';
import {openRouterRequestBody} from '../../packages/api/src/services/runtime/providerRequest';
import {askQuestionTool} from '../../packages/api/src/services/runtime/agentTools';
import {freezePromptCache} from '../../packages/api/src/services/runtime/promptCache';

type Route=z.infer<typeof priceSchema>['routes'][number];
export const r8Scopes=[
  {name:'mentor',phase:'skill',format:'agent-turn-v5-stream'},
  {name:'step',phase:'skill',format:'serial-tools-v4-stream'},
  {name:'report',phase:'report',format:'agent-turn-v5-stream'},
] as const;
type Scope=typeof r8Scopes[number];
export function r8Request(route:Route,B:number,O:number,scope:Scope|undefined,variant:number){
  const providerLimits={providerSlug:route.endpointTag,contextTokens:route.contextTokens,
    promptUsdPerMillion:route.prompt,completionUsdPerMillion:route.completion,requestUsd:route.request,
    ...(route.write?{cacheWriteUsdPerMillion:route.write}:{})};
  const policy={modelId:'10000000-0000-4000-8000-000000000001',model:route.model,provider:'openrouter',account:'offline-only',
    protocol:'openrouter-chat-v1' as const,providerLimits,upperUsd:openRouterBound(providerLimits,O).upperUsd,
    inputLimit:196608,outputLimit:O,automaticRetry:false as const,hiddenTools:false as const,lookupSupported:true};
  const instructions=scope
    ?`Process neutral synthetic inventory records for ${scope.name}. Give a concise factual summary. Do not call tools.`
    :'Copy the numbered inventory rows from the user message verbatim, in order, one row per line. '+
      'Start with row 000001. After the supplied rows, continue the same pattern through row 010000. '+
      'Never summarize, abbreviate, use ellipses, or add commentary. '+
      'Keep copying until the response token limit interrupts you. The records are ordinary synthetic stationery inventory.';
  const promptCache=scope?.name==='report'?undefined:freezePromptCache({real:true,role:'skill',model:route.model,
    cacheWriteUsdPerMillion:route.write,instructions,skillChars:instructions.length});
  const mentor=askQuestionTool(true);
  const tools=scope?.name==='mentor'?[{type:'function',function:{name:mentor.name,description:mentor.description,
    parameters:z.toJSONSchema(mentor.parameters!),strict:true}}]:[];
  // Report probes exercise the intended primary report wire. The known execute.ts
  // phase/role mismatch is separately documented and is NOT proven fixed by this probe.
  const serialize=(data:string)=>openRouterRequestBody(JSON.stringify({model:route.model,
    messages:[{role:'system',content:instructions},{role:'user',content:data}],store:false,max_tokens:O,
    reasoning_effort:'low',...(tools.length?{tools}:{}),
    ...(scope?{stream:true,stream_options:{include_usage:true}}:{})}),
  {context:{providerRequestFormat:scope?.format??'serial-tools-v6-reasoning',tools:tools.length?['ask_question']:[],
    network:'deny',reasoning:{effort:'low'},promptCache},policy,phase:scope?.phase??'skill',primaryDialogue:true});
  const seed=scope?'Synthetic SKU 1001 quantity 17 price 24.\n':Array.from({length:10000},(_,i)=>{
    const n=String(i+1).padStart(6,'0');
    return `${n} | notebook ${variant} | quantity 17 | color blue | status available\n`;
  }).join('');
  let low=0,high=B;
  while(low<high){
    const mid=Math.ceil((low+high)/2),data=seed.repeat(Math.ceil(mid/seed.length)).slice(0,mid);
    if(Buffer.byteLength(serialize(data))<=B)low=mid;else high=mid-1;
  }
  const data=seed.repeat(Math.ceil(low/seed.length)).slice(0,low),body=serialize(data);
  return {body:serialize(data+' '.repeat(B-Buffer.byteLength(body))),providerLimits};
}
