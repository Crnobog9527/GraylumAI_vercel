/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {z} from 'zod';
import {cachedSystemContent,historyCacheIndex} from './cacheMessages';
import {ASK_QUESTION_ARGUMENT_LIMIT,toolArgumentLimit} from '../../shared/agentTurn';
import {OPENROUTER_RESPONSE_BYTE_LIMIT,OPENROUTER_FRAME_BYTE_LIMIT} from './responseCapacity';
import {gzipSync} from 'node:zlib';
import {openRouterStream,OPENROUTER_STREAM_BYTE_LIMIT} from './openRouterStream';
import {withRuntimeBudget,type RuntimeBudget} from '../runtime/budget';
import {openRouterBound,OPENROUTER_RESPONSE_TIMEOUT_MS,OPENROUTER_LOOKUP_TIMEOUT_MS} from './openRouterPolicy';
import {decimal} from './decimal';
import {createHash} from 'node:crypto';
import {openRouterEvidence,validGenerationId,type OpenRouterIdentity} from './openRouterEvidence';
import type {CallIdentity,TransportObservation} from './fixtureAdapter';
import {approvedReasoningEfforts,reasoningObject} from '../runtime/reasoningPolicy';
import {AGENT_STREAM_TOOLS,AGENT_TOOL_NAMES,MAX_AGENT_TOOLS} from '../runtime/agentTools';
// Only this adapter can mint this one-use proof, before invoking transport.
// A timeout or identical Error message from a started transport is not proof.
const unstarted=new WeakMap<object,{requestHash:string;send:()=>Promise<TransportObservation>}>();
export function consumeOpenRouterNotStarted(error:unknown,requestHash:string,send:()=>Promise<TransportObservation>):boolean {
 if(!error||typeof error!=='object')return false;
 const proof=unstarted.get(error);if(proof?.requestHash!==requestHash||proof.send!==send)return false;
 unstarted.delete(error);return true;
}
const requestFields=new Set(['model','stream','stream_options','store','messages','provider','max_tokens','max_completion_tokens','temperature','top_p','parallel_tool_calls','response_format','reasoning_effort','reasoning']);
export const sourceCall=z.object({id:z.string().min(1).max(256),type:z.literal('function'),function:z.object({name:z.literal('read_source'),arguments:z.string().max(4000)}).strict()}).strict();
/** One tool call whose name is in a request format's allowlist. */
export const toolCallFor=(names:ReadonlySet<string>)=>z.object({id:z.string().min(1).max(256),type:z.literal('function'),
 function:z.object({name:z.string().refine(name=>names.has(name)),arguments:z.string().max(ASK_QUESTION_ARGUMENT_LIMIT)}).strict()
  .refine(call=>call.arguments.length<=toolArgumentLimit(call.name),'tool arguments too long')}).strict();
const workspaceMessage=z.union([z.object({role:z.literal('assistant'),content:z.string().nullable(),tool_calls:z.array(sourceCall).min(1).max(1)}).strict(),z.object({role:z.literal('tool'),content:z.string(),tool_call_id:z.string().min(1).max(256)}).strict()]);
const workspaceTools=z.array(z.object({type:z.literal('function'),function:z.object({name:z.literal('read_source'),description:z.string().max(16000).optional(),parameters:z.record(z.string(),z.unknown()),strict:z.boolean().optional()}).strict()}).strict()).max(1);
// Interactive Agent turn tools (AC-1): only the allowlisted names, at most two,
// each once. Their history is one call per assistant message plus its result.
const agentCall=toolCallFor(AGENT_TOOL_NAMES);
const agentTools=z.array(z.object({type:z.literal('function'),function:z.object({name:z.string().refine(name=>AGENT_TOOL_NAMES.has(name)),
 description:z.string().max(16000).optional(),parameters:z.record(z.string(),z.unknown()),strict:z.boolean().optional()}).strict()}).strict())
 .min(1).max(MAX_AGENT_TOOLS).refine(tools=>new Set(tools.map(tool=>tool.function.name)).size===tools.length);
const agentMessage=z.union([
 z.object({role:z.literal('assistant'),content:z.string().nullable(),tool_calls:z.array(agentCall).min(1).max(1)}).strict(),
 z.object({role:z.literal('tool'),content:z.string(),tool_call_id:z.string().min(1).max(256)}).strict(),
]);
type RequestMessage={role?:unknown;tool_calls?:unknown;tool_call_id?:unknown};
/** An Agent turn request offers only the interactive tools, or offers none and
 * replays history whose tool calls (at least one) all use them. */
function agentTurnRequest(parsed:{tools?:unknown;messages?:unknown}):boolean{
 if(parsed.tools!==undefined&&!(Array.isArray(parsed.tools)&&parsed.tools.length===0))return agentTools.safeParse(parsed.tools).success;
 if(!Array.isArray(parsed.messages))return false;
 const calls=(parsed.messages as RequestMessage[]).flatMap(m=>Array.isArray(m?.tool_calls)?m.tool_calls as unknown[]:[]);
 return calls.length>0&&calls.every(call=>agentCall.safeParse(call).success);
}
/** Each Agent tool call is answered by the very next message, a tool result
 * with its id, and every tool result answers the call just before it. */
function agentHistoryPaired(messages:RequestMessage[]):boolean{
 return messages.every((m,i)=>{
  const callId=(message:RequestMessage|undefined)=>Array.isArray(message?.tool_calls)?(message.tool_calls[0] as {id?:unknown})?.id:undefined;
  if(m?.role==='assistant'&&Array.isArray(m.tool_calls))return messages[i+1]?.role==='tool'&&messages[i+1]?.tool_call_id===callId(m);
  if(m?.role==='tool')return messages[i-1]?.role==='assistant'&&callId(messages[i-1])===m.tool_call_id;
  return true;
 });
}
/** Private trusted composition. No environment fallback, browser endpoint or automatic retry.
 * `allowAgentTools` admits the interactive Agent turn tools; the frozen Runtime
 * context separately decides which format and tools one execution may use. */
export function openRouterAdapter(options:{credential:(identity:OpenRouterIdentity)=>Promise<string>;transport?:typeof fetch;
 allowWorkspaceRead?:boolean;allowAgentTools?:boolean;budget?:RuntimeBudget}) {
 const transport=options.budget?withRuntimeBudget(options.budget,options.transport??fetch):options.transport??fetch;
 async function credential(identity:OpenRouterIdentity){
  const key=await options.credential(identity);
  if(!key.trim() || /[\r\n]/.test(key))throw new Error('BILL2_PROVIDER_CREDENTIAL_UNAVAILABLE');
  return key;
 }
 async function request(path:string,key:string,body?:string,send?:()=>Promise<TransportObservation>,streamModel?:string,
  onChunk?:(chunk:string)=>void,agentTurn=false,onIdentity?:(id:string)=>void):Promise<TransportObservation> {
  let timeout=OPENROUTER_LOOKUP_TIMEOUT_MS;
  try{if(body===undefined)options.budget?.assertCanStart(timeout);
   else timeout=options.budget?.modelCallTimeout(OPENROUTER_RESPONSE_TIMEOUT_MS)??OPENROUTER_RESPONSE_TIMEOUT_MS;}
  catch(error){
   if(body===undefined||!send)throw error;
   const proof=new Error('RUNTIME_TIME_BUDGET_EXHAUSTED');
   unstarted.set(proof,{requestHash:createHash('sha256').update(body).digest('hex'),send});throw proof;
  }
  const signal=AbortSignal.timeout(timeout);
  const response=await transport('https://openrouter.ai/api/v1/'+path,{method:body===undefined?'GET':'POST',redirect:'error',
   headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body,signal});
  // This fixed official endpoint is the only source of the optional lookup ID.
  const headerId=response.headers.get('x-generation-id');
  const generationId=validGenerationId(headerId)?headerId:undefined;
  let identityNotified=false;
  const notifyIdentity=(id:string|undefined)=>{
   if(!id||identityNotified)return;identityNotified=true;
   try{onIdentity?.(id);}catch{/* Financial observation must never interrupt streaming. */}
  };
  if(response.ok)notifyIdentity(generationId);
  const stream=streamModel&&response.ok?openRouterStream(streamModel,generationId,onChunk,agentTurn?AGENT_STREAM_TOOLS:undefined):undefined;
  const decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}),byteLimit=streamModel?OPENROUTER_STREAM_BYTE_LIMIT:
   body!==undefined&&response.ok?OPENROUTER_RESPONSE_BYTE_LIMIT:OPENROUTER_FRAME_BYTE_LIMIT;
  const reader=response.body?.getReader(),chunks:Uint8Array[]=[];let bytes=0,observedBytes=0,complete=!reader,transportIssue:string|null=null;
  const observedHash=createHash('sha256');
  if(reader)try{for(;;){const part=await reader.read();if(part.done){complete=true;break;}
   if(streamModel){observedHash.update(part.value);observedBytes+=part.value.length;}
   const keep=part.value.subarray(0,byteLimit-bytes);chunks.push(keep);bytes+=keep.length;
   if(stream){try{stream.push(decoder.decode(keep,{stream:true}));}catch{transportIssue='invalid_text';break;}if(stream.error){transportIssue=stream.error;break;}notifyIdentity(stream.providerId);}
   if(keep.length<part.value.length){transportIssue='body_limit';break;}
  }}catch{transportIssue=signal.aborted?'body_timeout':'body_interrupted';}finally{await reader.cancel().catch(()=>{});}
  if(stream&&complete){try{stream.push(decoder.decode());}catch{complete=false;transportIssue='invalid_text';}}
  const buffer=Buffer.concat(chunks);let rawBody:string;
  try{rawBody=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(buffer);if(rawBody.includes('\0'))throw new Error('invalid_text');}
  catch{rawBody=buffer.toString('utf8').replaceAll('\0','\uFFFD');complete=false;transportIssue??='invalid_text';}
  const retainedHash=createHash('sha256').update(buffer).digest('hex');
  // Keep exact SSE bytes once, reversibly compressed. JSON text plus base64
  // would otherwise exceed the existing receipt row limit for ordinary streams.
  const raw=streamModel?{rawBody:'',rawBodyBase64:gzipSync(buffer).toString('base64'),rawBodyEncoding:'gzip-base64' as const,rawBodyByteLength:buffer.length,rawBodySha256:retainedHash,observedByteLength:observedBytes,sourceHash:observedHash.digest('hex'),stream:true as const,
   // Receipt projection re-parses these bytes with the same tool rules.
   ...(agentTurn?{agentTools:true as const}:{})}:
   buffer.length>OPENROUTER_FRAME_BYTE_LIMIT?{rawBody:'',rawBodyBase64:gzipSync(buffer).toString('base64'),
    rawBodyEncoding:'gzip-base64' as const,rawBodyByteLength:buffer.length,rawBodySha256:retainedHash,
    observedByteLength:buffer.length,sourceHash:retainedHash}:
   {rawBody,rawBodyBase64:buffer.toString('base64'),sourceHash:retainedHash};
  return {...raw,httpStatus:response.status,complete,transportIssue,...(generationId?{generationId}:{})};
 }
 async function prepareDispatch(input:unknown,identity:CallIdentity,onChunk?:(chunk:string)=>void,onIdentity?:(id:string)=>void){
   options.budget?.modelCallTimeout(OPENROUTER_RESPONSE_TIMEOUT_MS);
   if(identity.provider!=='openrouter'||identity.protocol!=='openrouter-chat-v1')throw new Error('BILL2_PROVIDER_IDENTITY_DENIED');
   // Aliases such as :online can enable research without an explicit plugin.
   if(!/^[a-z0-9-]+\/[a-z0-9._-]+$/i.test(identity.model)||identity.model.startsWith('openrouter/'))throw new Error('BILL2_PROVIDER_MODEL_DENIED');
   const body=(input as {input?:unknown})?.input;
   if(typeof body!=='string')throw new Error('BILL2_PROVIDER_REQUEST_DENIED');
   const parsed=JSON.parse(body);
   if(!identity.providerLimits || !identity.outputLimit || !identity.upperUsd)throw new Error('BILL2_PROVIDER_QUOTE_REQUIRED');
   const quote=openRouterBound(identity.providerLimits,identity.outputLimit);
   if(decimal(quote.upperUsd)!==decimal(identity.upperUsd))throw new Error('BILL2_PROVIDER_QUOTE_CONFLICT');
   // An Agent turn request carries only the interactive tools (or none, when it
   // replays their history) and never the optional parallel_tool_calls hint;
   // older requests keep their rules.
   const agentTurn=Boolean(options.allowAgentTools&&parsed&&typeof parsed==='object'&&!Array.isArray(parsed)&&agentTurnRequest(parsed));
   const cachedHistoryIndex=Array.isArray(parsed?.messages)?historyCacheIndex(parsed.messages,agentTurn&&
    identity.model.startsWith('anthropic/')&&identity.providerLimits.cacheWriteUsdPerMillion!==undefined):-1;
   // These routing constraints must already be in the frozen request bytes.
   if(!parsed || typeof parsed!=='object' || Array.isArray(parsed) || Object.keys(parsed).some(key=>!requestFields.has(key)&&!((options.allowWorkspaceRead||agentTurn)&&key==='tools')) ||
     (parsed.tools!==undefined&&!agentTurn&&!workspaceTools.safeParse(parsed.tools).success) ||
     (agentTurn&&(parsed.parallel_tool_calls!==undefined||!Array.isArray(parsed.messages)||!agentHistoryPaired(parsed.messages))) ||
     parsed.model!==identity.model || !((parsed.stream===false&&parsed.stream_options===undefined)||(parsed.stream===true&&JSON.stringify(parsed.stream_options)===JSON.stringify({include_usage:true}))) || parsed.store!==false || !Array.isArray(parsed.messages) ||
     parsed.provider?.allow_fallbacks!==false || parsed.provider?.require_parameters!==true ||
     JSON.stringify(parsed.provider)!==JSON.stringify(quote.routing) ||
     !Number.isSafeInteger(parsed.max_tokens??parsed.max_completion_tokens) || (parsed.max_tokens??parsed.max_completion_tokens)<1 ||
     (parsed.max_tokens??parsed.max_completion_tokens)>identity.outputLimit ||
     (parsed.max_tokens!==undefined && parsed.max_completion_tokens!==undefined) ||
     (parsed.parallel_tool_calls!==undefined && parsed.parallel_tool_calls!==false) ||
     // Structural validation only; Runtime binds values to the frozen context.
     (parsed.reasoning_effort!==undefined && (typeof parsed.reasoning_effort!=='string' || !approvedReasoningEfforts.has(parsed.reasoning_effort))) ||
     (parsed.reasoning!==undefined&&!reasoningObject.safeParse(parsed.reasoning).success) ||
     ('reasoning_effort' in parsed&&'reasoning' in parsed) ||
     parsed.messages.some((message:unknown,index:number)=>{
      if(!message || typeof message!=='object' || Array.isArray(message))return true;
      const m=message as Record<string,unknown>;
      if(index===cachedHistoryIndex)return false;
      if(agentTurn?agentMessage.safeParse(m).success:options.allowWorkspaceRead&&workspaceMessage.safeParse(m).success)return false;
      if(index===0&&m.role==='system'&&identity.model.startsWith('anthropic/')&&
       identity.providerLimits?.cacheWriteUsdPerMillion!==undefined&&Object.keys(m).every(key=>['role','content'].includes(key))&&
       cachedSystemContent.safeParse(m.content).success)return false;
      return Object.keys(m).some(key=>!['role','content'].includes(key)) || !['system','developer','user','assistant'].includes(String(m.role)) ||
       !(typeof m.content==='string' || (Array.isArray(m.content) && m.content.every(part=>part && typeof part==='object' &&
         Object.keys(part).every(key=>['type','text'].includes(key)) && part.type==='text' && typeof part.text==='string')));
     }))
      throw new Error('BILL2_PROVIDER_REQUEST_DENIED');
   const key=await credential({...identity,provider:'openrouter',protocol:'openrouter-chat-v1'});
   options.budget?.modelCallTimeout(OPENROUTER_RESPONSE_TIMEOUT_MS);
   let used=false;
   const send:()=>Promise<TransportObservation>=()=>{
    if(used)throw new Error('BILL2_DISPATCH_CAPABILITY_CONSUMED');
    used=true;return request('chat/completions',key,body,send,parsed.stream===true?identity.model:undefined,onChunk,agentTurn,onIdentity);
   };
   return send;
 }
 return {protocol:'openrouter-chat-v1' as const,lookupSupported:true,evidence:openRouterEvidence,prepareDispatch,
  async dispatch(input:unknown,identity:CallIdentity){return (await prepareDispatch(input,identity))();},
  async lookup(providerId:string,identity:CallIdentity){
   if(identity.provider!=='openrouter'||identity.protocol!=='openrouter-chat-v1')throw new Error('BILL2_PROVIDER_IDENTITY_DENIED');
   options.budget?.assertCanStart(OPENROUTER_LOOKUP_TIMEOUT_MS);
   if(!providerId || providerId.length>256)throw new Error('BILL2_PROVIDER_ID_INVALID');
   return request('generation?id='+encodeURIComponent(providerId),await credential({...identity,provider:'openrouter',protocol:'openrouter-chat-v1'}));
  }
 };
}
