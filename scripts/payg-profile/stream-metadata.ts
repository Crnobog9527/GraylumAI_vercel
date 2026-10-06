/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type {TransportObservation} from '../../packages/api/src/services/bill2/fixtureAdapter';
import {decodeOpenRouterStreamObservation} from '../../packages/api/src/services/bill2/openRouterEvidence';
import {openRouterStream} from '../../packages/api/src/services/bill2/openRouterStream';
import {AGENT_STREAM_TOOLS} from '../../packages/api/src/services/runtime/agentTools';

/** Use the production bounded SSE parser; never JSON.parse the complete SSE wire.
 * Provider names must agree across all validated frames. The financial adapter
 * remains authoritative for exact cost, usage, model and generation identity. */
export function streamMetadata(observation:TransportObservation,model:string,providerId:string|null){
  let providerName:string|null=null,conflict=false,refused=false;
  const parser=openRouterStream(model,providerId??undefined,data=>{
    const frame=JSON.parse(data);
    if(frame.provider!==undefined&&frame.provider!==null){
      if(typeof frame.provider!=='string'||!frame.provider.trim()||frame.provider.length>128
        ||providerName!==null&&providerName!==frame.provider)conflict=true;
      else providerName=frame.provider;
    }
    if(frame.choices?.some((c:{native_finish_reason?:unknown})=>c.native_finish_reason==='refusal'))refused=true;
  },observation.agentTools?AGENT_STREAM_TOOLS:undefined);
  parser.push(new TextDecoder('utf-8',{fatal:true}).decode(decodeOpenRouterStreamObservation(observation)));
  const parsed=parser.result();
  if(parsed.identityConflict||conflict)return {providerName:null,finishReason:null,contentRefused:false,conflict:true};
  if(!observation.complete||parsed.error||!parsed.sdkResponse)
    return {providerName:null,finishReason:null,contentRefused:false,conflict:false};
  const finishReason=parsed.sdkResponse.choices[0]!.finish_reason;
  return {providerName,finishReason,contentRefused:refused||finishReason==='content_filter',conflict:false};
}
