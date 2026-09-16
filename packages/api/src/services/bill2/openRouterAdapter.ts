/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {openRouterBound} from './openRouterPolicy';
import {decimal} from './decimal';
import {createHash} from 'node:crypto';
import {openRouterEvidence,type OpenRouterIdentity} from './openRouterEvidence';
import type {CallIdentity,TransportObservation} from './fixtureAdapter';
const requestFields=new Set(['model','stream','store','messages','provider','max_tokens','max_completion_tokens','temperature','top_p','parallel_tool_calls','response_format']);
/** Private trusted composition. No environment fallback, browser endpoint or automatic retry. */
export function openRouterAdapter(options:{credential:(identity:OpenRouterIdentity)=>Promise<string>;transport?:typeof fetch}) {
 const transport=options.transport ?? fetch;
 async function credential(identity:OpenRouterIdentity){
  const key=await options.credential(identity);
  if(!key.trim() || /[\r\n]/.test(key))throw new Error('BILL2_PROVIDER_CREDENTIAL_UNAVAILABLE');
  return key;
 }
 async function request(path:string,key:string,body?:string):Promise<TransportObservation> {
  const response=await transport('https://openrouter.ai/api/v1/'+path,{method:body===undefined?'GET':'POST',redirect:'error',
   headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body,signal:AbortSignal.timeout(45000)});
  const reader=response.body?.getReader(),chunks:Uint8Array[]=[];let bytes=0,complete=!reader,transportIssue:string|null=null;
  if(reader)try{for(;;){const part=await reader.read();if(part.done){complete=true;break;}
   const keep=part.value.subarray(0,65536-bytes);chunks.push(keep);bytes+=keep.length;
   if(keep.length<part.value.length){transportIssue='body_limit';break;}
  }}catch{transportIssue='body_interrupted';}finally{await reader.cancel().catch(()=>{});}
  const buffer=Buffer.concat(chunks);let rawBody:string;
  try{rawBody=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(buffer);if(rawBody.includes('\0'))throw new Error('invalid_text');}
  catch{rawBody=buffer.toString('utf8').replaceAll('\0','\uFFFD');complete=false;transportIssue??='invalid_text';}
  return {rawBody,rawBodyBase64:buffer.toString('base64'),sourceHash:createHash('sha256').update(buffer).digest('hex'),httpStatus:response.status,complete,transportIssue};
 }
 async function prepareDispatch(input:unknown,identity:CallIdentity){
   if(identity.provider!=='openrouter'||identity.protocol!=='openrouter-chat-v1')throw new Error('BILL2_PROVIDER_IDENTITY_DENIED');
   // Aliases such as :online can enable research without an explicit plugin.
   if(!/^[a-z0-9-]+\/[a-z0-9._-]+$/i.test(identity.model)||identity.model.startsWith('openrouter/'))throw new Error('BILL2_PROVIDER_MODEL_DENIED');
   const body=(input as {input?:unknown})?.input;
   if(typeof body!=='string')throw new Error('BILL2_PROVIDER_REQUEST_DENIED');
   const parsed=JSON.parse(body);
   if(!identity.providerLimits || !identity.outputLimit || !identity.upperUsd)throw new Error('BILL2_PROVIDER_QUOTE_REQUIRED');
   const quote=openRouterBound(identity.providerLimits,identity.outputLimit);
   if(decimal(quote.upperUsd)!==decimal(identity.upperUsd))throw new Error('BILL2_PROVIDER_QUOTE_CONFLICT');
   // These routing constraints must already be in the frozen request bytes.
   if(!parsed || typeof parsed!=='object' || Array.isArray(parsed) || Object.keys(parsed).some(key=>!requestFields.has(key)) ||
     parsed.model!==identity.model || parsed.stream!==false || parsed.store!==false || !Array.isArray(parsed.messages) ||
     parsed.provider?.allow_fallbacks!==false || parsed.provider?.require_parameters!==true ||
     JSON.stringify(parsed.provider)!==JSON.stringify(quote.routing) ||
     !Number.isSafeInteger(parsed.max_tokens??parsed.max_completion_tokens) || (parsed.max_tokens??parsed.max_completion_tokens)<1 ||
     (parsed.max_tokens??parsed.max_completion_tokens)>identity.outputLimit ||
     (parsed.max_tokens!==undefined && parsed.max_completion_tokens!==undefined) ||
     (parsed.parallel_tool_calls!==undefined && parsed.parallel_tool_calls!==false) ||
     parsed.messages.some((message:unknown)=>{
      if(!message || typeof message!=='object' || Array.isArray(message))return true;
      const m=message as Record<string,unknown>;
      return Object.keys(m).some(key=>!['role','content'].includes(key)) || !['system','developer','user','assistant'].includes(String(m.role)) ||
       !(typeof m.content==='string' || (Array.isArray(m.content) && m.content.every(part=>part && typeof part==='object' &&
         Object.keys(part).every(key=>['type','text'].includes(key)) && part.type==='text' && typeof part.text==='string')));
     }))
      throw new Error('BILL2_PROVIDER_REQUEST_DENIED');
   const key=await credential({...identity,provider:'openrouter',protocol:'openrouter-chat-v1'});
   let used=false;
   return ()=>{
    if(used)throw new Error('BILL2_DISPATCH_CAPABILITY_CONSUMED');
    used=true;return request('chat/completions',key,body);
   };
 }
 return {protocol:'openrouter-chat-v1' as const,lookupSupported:true,evidence:openRouterEvidence,prepareDispatch,
  async dispatch(input:unknown,identity:CallIdentity){return (await prepareDispatch(input,identity))();},
  async lookup(providerId:string,identity:CallIdentity){
   if(identity.provider!=='openrouter'||identity.protocol!=='openrouter-chat-v1')throw new Error('BILL2_PROVIDER_IDENTITY_DENIED');
   if(!providerId || providerId.length>256)throw new Error('BILL2_PROVIDER_ID_INVALID');
   return request('generation?id='+encodeURIComponent(providerId),await credential({...identity,provider:'openrouter',protocol:'openrouter-chat-v1'}));
  }
 };
}
