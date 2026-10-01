/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {parseExactJson} from './decimal';
import {ASK_QUESTION_TOOL,ASK_QUESTION_ARGUMENT_LIMIT,DEFAULT_TOOL_ARGUMENT_LIMIT,toolArgumentLimit} from '../../shared/agentTurn';
import {OPENROUTER_RESPONSE_BYTE_LIMIT,PURPOSE_OUTPUT_CAP} from './responseCapacity';

export const OPENROUTER_STREAM_BYTE_LIMIT=4_194_304;
// Allow separate token/reasoning-detail frames plus role, finish and usage metadata.
export const OPENROUTER_STREAM_FRAME_LIMIT=2*PURPOSE_OUTPUT_CAP+64;
const object=(v:unknown):v is Record<string,unknown>=>Boolean(v&&typeof v==='object'&&!Array.isArray(v));
const id=(v:unknown):v is string=>typeof v==='string'&&/^[a-zA-Z0-9._:-]{1,256}$/.test(v);
const finishes=new Set(['stop','length','content_filter','tool_calls']);
/** Bounded official Chat Completions SSE. Raw frames stay server-side; the SDK
 * receives validated data frames and the browser receives only SDK text deltas.
 * https://openrouter.ai/docs/api/reference/streaming
 */
/** `tools` widens tool-call parsing for an Agent turn request (AC-1): its
 * up to `maxCalls` indexed calls, with bounded unknown names retained only
 * when requested for terminal host handling. This never authorizes tool execution.
 * Without it only one `read_source` call at index 0 is accepted. */
export function openRouterStream(model:string,headerId?:string,onChunk?:(chunk:string)=>void,
 tools:{toolNames:ReadonlySet<string>;maxCalls:number;retainUnknownNames?:boolean}={toolNames:new Set(['read_source']),maxCalls:1}){
 let pending='',frame:string[]=[],done=false,finish:string|null=null,providerId=headerId,failed:string|null=null,identityConflict=false;
 let content='',reasoning='',refusal='',usage:Record<string,unknown>|undefined,exactUsage:Record<string,unknown>|undefined;
 let frameCount=0,usageSeen=false;
 const argumentBufferLimit=tools.toolNames.has(ASK_QUESTION_TOOL)?ASK_QUESTION_ARGUMENT_LIMIT:DEFAULT_TOOL_ARGUMENT_LIMIT;
 const details=new Map<string,Record<string,unknown>>(),calls=new Map<number,{id:string;type:string;function:{name:string;arguments:string}}>();
 const reject=(reason='invalid_stream'):never=>{failed=reason;throw new Error(reason);};
 const conflict=():never=>{identityConflict=true;return reject('identity_or_response_mismatch');};
 function mergeDetails(value:unknown){
  if(!Array.isArray(value)||value.length>64)return reject();
  for(const part of value){
   if(!object(part)||!Number.isSafeInteger(part.index)||Number(part.index)<0||Number(part.index)>63||
    !['reasoning.text','reasoning.summary','reasoning.encrypted'].includes(String(part.type))||
    Object.keys(part).some(k=>!['type','index','format','id','text','summary','data','signature'].includes(k)))return reject();
   // Gemini streams reasoning.text and then its reasoning.encrypted signature
   // at the same index. They are separate details: accumulate per (index,type).
   const index=Number(part.index),slot=`${index}:${String(part.type)}`,old=details.get(slot)??{};
   if(!details.has(slot)&&details.size>=64)return reject();
   for(const [key,value] of Object.entries(part)){
    if(key==='index'){old.index=index;continue;}
    if(['type','format','id'].includes(key)){
     if(value!==null&&typeof value!=='string'||typeof value==='string'&&value.length>256)return reject();
     if(old[key]!==undefined&&old[key]!==value)return reject();old[key]=value;
    }else{
     if(typeof value!=='string'||value.length>65536)return reject();old[key]=String(old[key]??'')+value;
     if(String(old[key]).length>OPENROUTER_RESPONSE_BYTE_LIMIT)return reject();
    }
   }
   details.set(slot,old);
  }
 }
 function event(){
  if(!frame.length)return;const data=frame.join('\n');frame=[];
  if(done)return reject();
  if(data==='[DONE]'){done=true;return;}
  if(++frameCount>OPENROUTER_STREAM_FRAME_LIMIT||Buffer.byteLength(data)>65536)return reject();
  const exact=parseExactJson(data);const value:unknown=JSON.parse(data);
  if(!object(value)||!object(exact))return reject();
  if(value.error)return reject('provider_stream_error');
  if(!id(value.id)||typeof value.model!=='string')return reject();
  if(providerId&&providerId!==value.id||value.model!==model)return conflict();providerId=value.id;
  if(!Array.isArray(value.choices)||value.choices.length>1)return reject();
  if(usageSeen)return reject();
  const choice=value.choices[0];
  if(choice!==undefined){
   if(!object(choice)||choice.index!==0||!object(choice.delta))return reject();
   const delta=choice.delta;
   if(Object.keys(delta).some(k=>!['role','content','refusal','reasoning','reasoning_details','tool_calls'].includes(k))||delta.role!==undefined&&delta.role!=='assistant')return reject();
   const hasDelta=Object.entries(delta).some(([key,v])=>key!=='role'&&v!==null&&v!==''&&!(Array.isArray(v)&&v.length===0));
   if(finish&&hasDelta)return reject();
   for(const key of ['content','refusal','reasoning'] as const){
    const text=delta[key];if(text===undefined||text===null)continue;if(typeof text!=='string')return reject();
    if(key==='content')content+=text;else if(key==='refusal')refusal+=text;else reasoning+=text;
   }
   if(content.length+refusal.length+reasoning.length>OPENROUTER_RESPONSE_BYTE_LIMIT)return reject();
   if(delta.reasoning_details!==undefined&&delta.reasoning_details!==null)mergeDetails(delta.reasoning_details);
   if(delta.tool_calls!==undefined&&delta.tool_calls!==null){
    if(!Array.isArray(delta.tool_calls)||delta.tool_calls.length>tools.maxCalls)return reject();
    for(const part of delta.tool_calls){
     if(!object(part)||!Number.isSafeInteger(part.index)||Number(part.index)<0||Number(part.index)>=tools.maxCalls||
      Object.keys(part).some(k=>!['index','id','type','function'].includes(k)))return reject();
     const index=Number(part.index),call=calls.get(index)??{id:'',type:'function',function:{name:'',arguments:''}};
     if(part.id!==undefined){if(!id(part.id)||call.id&&call.id!==part.id)return reject();call.id=part.id;}
     if(part.type!==undefined&&part.type!=='function')return reject();
     if(part.function!==undefined){if(!object(part.function)||Object.keys(part.function).some(k=>!['name','arguments'].includes(k)))return reject();
      for(const key of ['name','arguments'] as const){if(part.function[key]!==undefined){if(typeof part.function[key]!=='string')return reject();call.function[key]+=part.function[key];}}
     }
     if(call.function.name.length>256||call.function.arguments.length>argumentBufferLimit)return reject();calls.set(index,call);
    }
   }
   const terminal=choice.finish_reason;
   if(terminal!==undefined&&terminal!==null){if(!finishes.has(String(terminal))||finish&&finish!==terminal)return reject();finish=String(terminal);}
  }
  if(value.usage!==undefined&&value.usage!==null){
   if(!finish||!object(value.usage)||!object(exact.usage))return reject();usage=value.usage;exactUsage=exact.usage;usageSeen=true;
  }
  // UI/SDK observers cannot interrupt collection of provider identity/cost.
  try{onChunk?.(data);}catch{/* Observer failure does not erase transport evidence. */}
 }
 function push(text:string){
  if(failed)return;try{
   pending+=text;if(pending.length>OPENROUTER_STREAM_BYTE_LIMIT)return reject();
   for(;;){const newline=pending.indexOf('\n');if(newline<0)break;const line=pending.slice(0,newline).replace(/\r$/,'');pending=pending.slice(newline+1);
    if(!line){event();continue;}if(line.startsWith(':'))continue;
    if(line.startsWith('data:'))frame.push(line.slice(5).replace(/^ /,''));else return reject();
   }
  }catch{failed??='invalid_stream';}
 }
 function result(){
  if(pending.trim()||frame.length||!done)failed??='incomplete_stream';
  if(!finish)failed??='nonterminal_stream';
  // v5 preserves syntactically valid unknown names as paid response evidence;
  // the host terminates an unknown first call without executing it. The older
  // parser still rejects every non-allowlisted name.
  for(const call of calls.values()){
   const validName=tools.toolNames.has(call.function.name)||
    tools.retainUnknownNames&&/^[a-zA-Z0-9_-]{1,256}$/.test(call.function.name);
   if(!call.id||!validName||call.function.arguments.length>toolArgumentLimit(call.function.name))failed??='invalid_stream';
  }
  // Calls are numbered from 0 without gaps; the Agent turn keeps index 0.
  if([...calls.keys()].some(index=>index>=calls.size))failed??='invalid_stream';
  if(failed)return {providerId,identityConflict,error:failed};
  const message={role:'assistant',content:content||null,...(reasoning?{reasoning}:{}),...(refusal?{refusal}:{}),
   // Stable sort: by index, then first appearance within an index.
   ...(details.size?{reasoning_details:[...details.values()].sort((a,b)=>Number(a.index)-Number(b.index))}:{}),
   ...(calls.size?{tool_calls:[...calls.entries()].sort(([a],[b])=>a-b).map(([,call])=>call)}:{})};
  const sdkResponse={id:providerId,object:'chat.completion',model,choices:[{index:0,message,finish_reason:finish}],...(usage?{usage}:{})};
  if(Buffer.byteLength(JSON.stringify(sdkResponse))>OPENROUTER_RESPONSE_BYTE_LIMIT)return {providerId,identityConflict,error:'aggregate_limit'};
  return {providerId,identityConflict,sdkResponse,exactUsage};
 }
 return {push,result,get error(){return failed;},get providerId(){return providerId;},get identityConflict(){return identityConflict;}};
}
