/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import {toolCallFor} from '../bill2/openRouterAdapter';
import {SOURCE_TOOL_NAMES} from './agentTools';

const reasoningDetails=z.array(z.discriminatedUnion('type',[
 z.object({type:z.literal('reasoning.text'),text:z.string(),
  index:z.number().int().nonnegative(),format:z.literal('unknown'),
 }).strict(),
 // OpenRouter's summary schema permits an omitted/null id. Accept only the
 // observed OpenAI format; summaries stay private alongside encrypted data.
 z.object({type:z.literal('reasoning.summary'),format:z.literal('openai-responses-v1'),
  summary:z.string().max(65536),id:z.string().min(1).max(256).nullish(),index:z.number().int().nonnegative().optional(),
 }).strict(),
 // Known OpenRouter OpenAI response metadata only. This is opaque storage,
 // never decoded or forwarded. The local adapter retains at most 64 KiB of
 // response bytes; the string cap is a local bound, not a provider guarantee.
 z.object({type:z.literal('reasoning.encrypted'),format:z.literal('openai-responses-v1'),
  id:z.string().min(1).max(256).nullable(),data:z.string().min(1).max(65536),index:z.number().int().nonnegative().optional(),
 }).strict(),
])).nullish();
const hasOpenAIReasoning=(details:unknown)=>Array.isArray(details)&&details.some(detail=>detail?.type==='reasoning.encrypted'||detail?.type==='reasoning.summary');
const reasoning=z.string().nullish();
const textParts=(toolNames:ReadonlySet<string>)=>z.array(z.object({type:z.literal('text'),text:z.string(),role:z.literal('assistant').optional(),
 // SDK 0.18 streaming always attaches an empty annotations list. Only this
 // empty shape is supported; citations/research metadata remain denied.
 annotations:z.array(z.never()).length(0).optional(),
 refusal:z.null().optional(),reasoning,reasoning_details:reasoningDetails,tool_calls:z.array(toolCallFor(toolNames)).max(1).nullish(),
}).strict());

/** Versioned v2/v3 frozen formats use this projection before request hashing.
 * SDK 0.18 carries response metadata into assistant text parts on later turns.
 * Preserve text and top-level tool semantics; unknown metadata/content fails closed.
 * The original adapter still validates tools, message roles and routing.
 * `toolNames` is the format's tool allowlist; older formats keep `read_source`. */
export function normalizeOpenRouterHistory(request:{messages?:unknown},toolNames:ReadonlySet<string>=SOURCE_TOOL_NAMES):void {
 if(!Array.isArray(request.messages))return;
 request.messages=request.messages.map(message=>{
  if(!message||typeof message!=='object'||Array.isArray(message)||message.role!=='assistant')return message;
  const normalized={...message};
  if(!reasoning.safeParse(message.reasoning).success||!reasoningDetails.safeParse(message.reasoning_details).success)
   throw new Error('RUNTIME_PROVIDER_HISTORY_DENIED');
  let openAIReasoning=hasOpenAIReasoning(message.reasoning_details);
  delete normalized.reasoning;delete normalized.reasoning_details;
  if(Array.isArray(message.content)){
   const parsed=textParts(toolNames).safeParse(message.content);
   if(!parsed.success)throw new Error('RUNTIME_PROVIDER_HISTORY_DENIED');
   for(const part of parsed.data){
    openAIReasoning ||=hasOpenAIReasoning(part.reasoning_details);
    // A duplicated tool field is removable only when the actual top-level calls
    // are identical. Unknown or parallel calls remain for the adapter to reject.
    if(part.tool_calls?.length&&!isDeepStrictEqual(part.tool_calls,message.tool_calls))
     throw new Error('RUNTIME_PROVIDER_HISTORY_DENIED');
   }
   normalized.content=parsed.data.map(part=>part.text).join('');
  }
  // This compatibility path is for completed text from the tool-free
  // organizer. OpenAI reasoning tool continuations need their provider's original
  // reasoning, which this text-only projection does not claim to support.
  if(openAIReasoning&&message.tool_calls!=null&&(!Array.isArray(message.tool_calls)||message.tool_calls.length>0))
   throw new Error('RUNTIME_PROVIDER_HISTORY_DENIED');
  return normalized;
 });
}

const reasoningItem=z.object({type:z.literal('reasoning'),content:z.array(z.never()).length(0),
 rawContent:z.array(z.object({type:z.literal('reasoning_text'),text:z.string()}).strict()).max(1),
}).strict();
/** Sizing-only projection of the locked SDK's items. Validate all candidates
 * before any cut; preserve original Session objects and tool-call boundaries. */
export function projectOpenRouterItemsForSizing(items:unknown[],historyCount=0,toolNames:ReadonlySet<string>=SOURCE_TOOL_NAMES):unknown[] {
 const toolCall=toolCallFor(toolNames);
 const denied=()=>{throw new Error('RUNTIME_PROVIDER_HISTORY_DENIED');};
 let pendingCall:unknown,pendingName:unknown,expectedCalls:unknown;
 const projected=items.map((item,index)=>{
  if(!item||typeof item!=='object'||Array.isArray(item))return denied();
  const value=item as Record<string,unknown>;
  const keys=(allowed:string[])=>Object.keys(value).every(key=>allowed.includes(key));
  const emptyMetadata=(metadata:unknown)=>metadata===undefined||Boolean(metadata&&typeof metadata==='object'&&!Array.isArray(metadata)&&Object.keys(metadata).length===0);
  if(value.type==='reasoning'){
   if(!reasoningItem.safeParse(value).success)return denied();
   return {type:'reasoning',content:[],rawContent:[]};
  }
  if(value.type==='function_call'){
   const call={id:value.callId,type:'function',function:{name:value.name,arguments:value.arguments}};
   if(pendingCall||!keys(['id','type','callId','name','arguments','status','providerData'])||!toolCall.safeParse(call).success)return denied();
   if(value.providerData!==undefined&&!isDeepStrictEqual({...value.providerData as object,id:value.callId},call))return denied();
   if(expectedCalls&&!isDeepStrictEqual(expectedCalls,[call]))return denied();
   expectedCalls=undefined;pendingCall=value.callId;pendingName=value.name;
   return {role:'assistant',content:null,tool_calls:[call]};
  }
  if(value.type==='function_call_result'){
   // The SQL history limit may start at a result. Its shape is still checked;
   // selectors retain responsibility for discarding an incomplete old chain.
   if(!keys(['id','type','callId','name','output','status','providerData'])||
    !z.string().min(1).max(256).safeParse(value.callId).success||
    (pendingCall===undefined?index!==0||historyCount===0:value.callId!==pendingCall)||
    value.name!==undefined&&(!toolNames.has(String(value.name))||pendingCall!==undefined&&value.name!==pendingName)||
    !emptyMetadata(value.providerData))return denied();
   if(typeof value.output!=='string'&&!z.object({type:z.literal('text'),text:z.string()}).strict().safeParse(value.output).success)return denied();
   pendingCall=undefined;return {role:'tool',tool_call_id:value.callId,content:typeof value.output==='string'?value.output:(value.output as {text:string}).text};
  }
  if(pendingCall||expectedCalls||!keys(['id','type','role','content','status','providerData'])||
   !['user','system','developer','assistant'].includes(String(value.role))||
   value.type!==undefined&&value.type!=='message'||!emptyMetadata(value.providerData))return denied();
  if(typeof value.content==='string')return {role:value.role,content:value.content};
  if(!Array.isArray(value.content))return denied();
  const parts=value.content.map(part=>{
   if(!part||typeof part!=='object'||part.type!==(value.role==='assistant'?'output_text':'input_text')||typeof part.text!=='string'||
    Object.keys(part).some(key=>!['type','text','providerData'].includes(key)))return denied();
   const metadata=part.providerData;
   if(metadata!==undefined&&(!metadata||typeof metadata!=='object'||Array.isArray(metadata)||'type' in metadata||'text' in metadata))return denied();
   if(value.role!=='assistant'&&!emptyMetadata(metadata))return denied();
   return {type:'text',text:part.text,...metadata};
  });
  if(value.role!=='assistant')return {role:value.role,content:parts};
  // Reuse the frozen wire projection and require duplicated calls to match the
  // following actual SDK function_call; no unknown/parallel tool can be cut away.
  expectedCalls=parts.find(part=>Array.isArray(part.tool_calls)&&part.tool_calls.length)?.tool_calls;
  const request={messages:[{role:'assistant',content:parts,...(expectedCalls?{tool_calls:expectedCalls}:{})}]};
  normalizeOpenRouterHistory(request,toolNames);
  return {role:'assistant',content:request.messages[0]!.content};
 });
 if(pendingCall||expectedCalls)return denied();
 return projected;
}
