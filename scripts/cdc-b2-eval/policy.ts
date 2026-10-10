/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {createHash} from 'node:crypto';
import {openRouterBound,openRouterCallBound,measureCallInput} from '../../packages/api/src/services/bill2/openRouterPolicy';
export const hash=(raw:string|Buffer)=>createHash('sha256').update(raw).digest('hex');
export const EXPIRES='2026-10-09T15:59:59Z';
export const CAP_NANO=9_000_000_000;
export const profiles={
 mentor:{model:'anthropic/claude-sonnet-5.5',route:'anthropic',prompt:'2.5',completion:'10',context:1_000_000,
  bytes:90000,output:8192,format:'agent-turn-v5-stream',calls:70},
 organizer:{model:'openai/gpt-6-luna',route:'openai',prompt:'0.25',completion:'0.75',context:1_050_000,
  bytes:64000,output:2048,format:'serial-tools-v6-reasoning',calls:30},
} as const;
export type Role=keyof typeof profiles;
export function limits(role:Role){const p=profiles[role];return {providerSlug:p.route,contextTokens:p.context,
 promptUsdPerMillion:p.prompt,cacheWriteUsdPerMillion:p.prompt,completionUsdPerMillion:p.completion,requestUsd:'0'};}
/** Output cap of a role; a local V3 host may raise the organizer cap to the live setting (at most 4096). B2 keeps 2048. */
export function outputCap(role:Role,organizerOutput?:number){
 if(role!=='organizer'||organizerOutput===undefined)return profiles[role].output;
 if(!Number.isSafeInteger(organizerOutput)||organizerOutput<1||organizerOutput>4096)throw new Error('CDC_OUTPUT_CAP');
 return organizerOutput;
}
export function quote(role:Role,modelId:string,organizerOutput?:number){const p=profiles[role],output=outputCap(role,organizerOutput);
 return {modelId,provider:'openrouter',account:'cdc-local',
 model:p.model,protocol:'openrouter-chat-v1' as const,providerLimits:limits(role),upperUsd:openRouterBound(limits(role),output).upperUsd,
 inputLimit:p.bytes,outputLimit:output,automaticRetry:false as const,hiddenTools:false as const,lookupSupported:true};}
export function measure(raw:string,role:Role,organizerOutput?:number){
 const p=profiles[role],output=outputCap(role,organizerOutput),body=JSON.parse(raw),size=measureCallInput(raw,4096,4096);
 if(size.requestBytes>p.bytes||body.model!==p.model||body.max_tokens!==output||body.store!==false||
  JSON.stringify(body.provider)!==JSON.stringify(openRouterBound(limits(role),output).routing))throw new Error('CDC_REQUEST_PROFILE');
 if(body.stream!==(role==='mentor')||(role==='mentor'?JSON.stringify(body.stream_options)!==JSON.stringify({include_usage:true}):
  body.stream_options!==undefined))throw new Error('CDC_STREAM_PROFILE');
 if(role==='mentor' ? body.reasoning_effort!=='low'||body.reasoning!==undefined :
  body.reasoning!==undefined||body.reasoning_effort!==undefined)throw new Error('CDC_REASONING_PROFILE');
 const usd=openRouterCallBound(limits(role),output,size.promptTokensUpper).upperUsd;
 return {...size,reserveNano:Math.ceil(Number(usd)*1e9),reserveUsd:usd,requestHash:hash(raw)};
}
/** One serialized sender; an unsettled reservation is terminal, including after restart. */
export function budget(read:()=>{calls:Record<Role,number>;nano:number;pending:boolean},
 write:(v:ReturnType<typeof read>)=>void){
 let stopped=false;
 return {reserve(role:Role,nano:number){
  const state=read();
  if(stopped||state.pending||!Number.isSafeInteger(nano)||nano<=0||state.nano+nano>CAP_NANO||
   state.calls[role]>=profiles[role].calls)throw new Error('CDC_BUDGET_STOP');
  const next={calls:{...state.calls,[role]:state.calls[role]+1},nano:state.nano+nano,pending:true};write(next);
  let settled=false;
  return (cost:number)=>{
   if(settled||JSON.stringify(read())!==JSON.stringify(next))throw new Error('CDC_LEDGER_CHANGED');
   settled=true;
   if(stopped||!Number.isFinite(cost)||cost<0){stopped=true;throw new Error('CDC_COST_UNKNOWN');}
   const actual=Math.ceil(cost*1e9);if(actual>nano){stopped=true;throw new Error('CDC_BOUND_EXCEEDED');}
   write({...next,nano:next.nano-nano+actual,pending:false});
  };
 },stop(){stopped=true;}};
}
