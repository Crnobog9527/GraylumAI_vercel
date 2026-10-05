/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {fitNativeResult,attachNativeSummary} from './resultCapacity';
import type {NativeProgressProjection,NativeTextUpdate} from './nativeProgress';
import type {AgentTurnOutcome} from '../../shared/agentTurn';
import {z} from 'zod';
import {INVALID_REPLY_NOTICE,questionToolCardSchema} from '../../shared/agentTurn';

/** Mirror the existing public reader: sanitize suggestions, never grant confirmation. */
const patch = z.object({
  value: z.string().refine(value => Boolean(value.trim()) && value.length <= 400).transform(value => value.trim()),
  status: z.unknown().transform(value => value === 'unclear' ? 'unclear' as const : 'provisional' as const),
  nature: z.enum(['fact', 'decision', 'hypothesis', 'unknown']),
  basis: z.unknown().transform(value => value === 'agent_proposal' ? 'agent_proposal' as const : 'user_statement' as const),
});
const patches = z.record(z.string(), z.unknown()).transform(value => Object.fromEntries(
  Object.entries(value).flatMap(([key, item]) => {
    const parsed = patch.safeParse(item);
    return parsed.success ? [[key, parsed.data]] : [];
  }),
));
export const stepEnvelope = z.object({
  message: z.string().describe('Public reply. This must be the first JSON property.'),
  inputKind: z.enum(['answer', 'acknowledgement', 'uncertainty', 'request', 'revision_request']).optional().catch(undefined),
  informationPatch: patches.optional().catch(undefined),
  targetStepId: z.string().min(1).optional().catch(undefined),
});
export function nativeVisible(body:string):string {
  const fallback = () => /^[\s]*[\[{`]/.test(body) ? INVALID_REPLY_NOTICE : body;
  try {
    const value = JSON.parse(body);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback();
    return typeof value.message === 'string' ? value.message : INVALID_REPLY_NOTICE;
  } catch { return fallback(); }
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
  envelopeOrder?:string;length:boolean;attachedOrganizer:boolean;executionId:string;
}) {
  let validEnvelope = false;
  if(options.envelopeOrder){
    metadata={...metadata,messageFirst:/^\s*\{\s*"message"\s*:/.test(body)};
    let value:unknown;try{value=JSON.parse(body);}catch{value=null;}
    const parsed=stepEnvelope.safeParse(value);
    if(options.length && (!parsed.success || !parsed.data.message.trim())) throw new Error('RUNTIME_OUTPUT_TRUNCATED');
    if(parsed.success){body=JSON.stringify(parsed.data);validEnvelope=true;}
  }
  const fitted=fitNativeResult({kind:'usable_result',evidenceRef:options.executionId,evidenceHash:'0'.repeat(64),body,
    ...metadata,completeness:options.length?'length_limit' as const:'complete' as const},
    {attachedOrganizer:options.attachedOrganizer,...(validEnvelope?{validateEnvelope:(value:unknown)=>stepEnvelope.parse(value)}:{})});
  let envelope:Record<string,unknown>|null=null;
  try{envelope=JSON.parse(fitted.body);}catch{/* Plain T1 body. */}
  if(!options.envelopeOrder && envelope?.card)questionToolCardSchema.parse(envelope.card);
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
    const text=nativeVisible(result.body);onProgress?.({type:'text',text,delta:text,replace:true,source:'final'});
  }
  return {...nativeMetadata(result),body:result?.body,
    ...(result?.summary!==undefined?{summary:result.summary}:{}),state:'completed' as const};
}

export function finalizeNativeSummary(body:string,metadata:Record<string,unknown>,summary:string) {
  const result=attachNativeSummary({body,...metadata},summary);
  return {summary:result.summary,metadata:nativeMetadata(result)};
}
