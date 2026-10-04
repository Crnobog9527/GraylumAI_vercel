/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {fitNativeResult,attachNativeSummary} from './resultCapacity';
import type {NativeProgressProjection,NativeTextUpdate} from './nativeProgress';
import type {AgentTurnOutcome} from '../../shared/agentTurn';
import {z} from 'zod';
import {INVALID_REPLY_NOTICE,questionToolCardSchema} from '../../shared/agentTurn';

/** Existing positioning envelope fields, with unknown model fields discarded. */
const patch = z.object({value:z.string(),status:z.enum(['unclear','provisional']),
  nature:z.enum(['fact','decision','hypothesis','unknown']),
  basis:z.enum(['user_statement','agent_proposal']).optional()});
export const stepEnvelope = z.object({
  message:z.string().min(1).describe('Public reply. This must be the first JSON property.'),
  inputKind:z.enum(['answer','acknowledgement','uncertainty','request','revision_request']).optional(),
  informationPatch:z.record(z.string(),patch).optional(),targetStepId:z.string().nullable().optional(),
});
export function nativeVisible(body:string):string {
  try {const value=JSON.parse(body);return typeof value?.message==='string'?value.message:INVALID_REPLY_NOTICE;}
  catch {return INVALID_REPLY_NOTICE;}
}
export function nativeMetadata(result:Record<string,unknown>|null|undefined
):Pick<AgentTurnOutcome,'completeness'|'organized'|'summaryOmitted'|'messageFirst'|'envelopeCompact'> {
  if(!result)return {};
  return {
    ...(result.completeness==='complete'||result.completeness==='length_limit'?{completeness:result.completeness}:{}),
    ...(typeof result.organized==='boolean'?{organized:result.organized}:{}),
    ...(typeof result.summaryOmitted==='boolean'?{summaryOmitted:result.summaryOmitted}:{}),
    ...(typeof result.messageFirst==='boolean'?{messageFirst:result.messageFirst}:{}),
    ...(typeof result.envelopeCompact==='boolean'?{envelopeCompact:result.envelopeCompact}:{}),
  };
}


export function prepareNativePrimary(body:string,metadata:Record<string,unknown>,options:{
  envelopeOrder?:string;length:boolean;attachedOrganizer:boolean;executionId:string;onInvalid?:()=>void;
}) {
  if(options.envelopeOrder){
    metadata={...metadata,messageFirst:/^\s*\{\s*"message"\s*:/.test(body)};
    let value:unknown;try{value=JSON.parse(body);}catch{value=null;}
    const parsed=stepEnvelope.safeParse(value);
    if(!parsed.success){if(!options.length)options.onInvalid?.();
      throw new Error(options.length?'RUNTIME_OUTPUT_TRUNCATED':'RUNTIME_TERMINAL_REPLY');}
    body=JSON.stringify(parsed.data);
  }
  const fitted=fitNativeResult({kind:'usable_result',evidenceRef:options.executionId,evidenceHash:'0'.repeat(64),body,
    ...metadata,completeness:options.length?'length_limit' as const:'complete' as const},
    {attachedOrganizer:options.attachedOrganizer,...(options.envelopeOrder?{validateEnvelope:(value:unknown)=>stepEnvelope.parse(value)}:{})});
  let envelope:Record<string,unknown>|null=null;
  try{envelope=JSON.parse(fitted.body);}catch{/* Plain T1 body. */}
  if(envelope?.card)questionToolCardSchema.parse(envelope.card);
  return {body:fitted.body,metadata:nativeMetadata(fitted)};
}
export function nativeFrameProjection(projection:NativeProgressProjection,progress:(update:NativeTextUpdate)=>void) {
  let first=true;
  const project=(update:NativeTextUpdate|null)=>{
    if(update){progress(first?{...update,replace:true}:update);first=false;}
  };
  return (chunk:string)=>{
    const frame=JSON.parse(chunk),content=frame.choices?.[0]?.delta?.content;
    if(typeof content==='string')project(projection.appendText(content));
    project(projection.appendToolFrame(frame));
  };
}

export function completedOutput(result:({body:string;summary?:string}&Record<string,unknown>)|null,
  context:unknown,onProgress?: (update:NativeTextUpdate)=>void) {
  const saved=context as {nativeOutput?:string;envelopeOrder?:string;providerRequestFormat?:string};
  if(saved.nativeOutput&&(saved.envelopeOrder||saved.providerRequestFormat==='agent-turn-v5-stream')&&result?.body){
    const text=nativeVisible(result.body);onProgress?.({type:'text',text,delta:text,replace:true});
  }
  return {...nativeMetadata(result),body:result?.body,
    ...(result?.summary!==undefined?{summary:result.summary}:{}),state:'completed' as const};
}

export function finalizeNativeSummary(body:string,metadata:Record<string,unknown>,summary:string) {
  const result=attachNativeSummary({body,...metadata},summary);
  return {summary:result.summary,metadata:nativeMetadata(result)};
}
