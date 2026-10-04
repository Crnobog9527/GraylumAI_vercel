/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type {RuntimeProgress} from './progress';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {StagingAccessError,type StagingFailure} from './stagingErrors';
import type {RuntimeBudget} from './budget';
import type {RuntimeCallGate} from './newWorkGate';
import type {FrozenRun,BillingTransport} from '../bill2/service';
import type {MatchCandidate} from './matching';
import type {SessionRpc} from './session';
/** Trusted server host only. The public admission layer must construct this context.
 * The default transport is local-only; the Staging host must explicitly supply
 * its allowlisted official adapter and frozen price policy.
 */
export type RuntimeExecutorOptions={budget?:RuntimeBudget;database:SessionRpc;actor:()=>Promise<string>;
 resumePricing?:(policies:FrozenRun['callPolicy'])=>Promise<void>;
 callGate:RuntimeCallGate;endpoint?:string;adapter?:BillingTransport;activateSkill?:(candidate:MatchCandidate)=>Promise<string>};
export function executorRpc(options:{database:SessionRpc;actor:()=>Promise<string>}) {
 return async function rpc<T>(name:string,args:Record<string,unknown>,database=options.database):Promise<T>{
  const result=await database.rpc(name,{...args,p_actor_id:z.string().uuid().parse(await options.actor())});
  if(result.error){
   // A private, exact identity mismatch permits only the bounded legacy replay
   // below. Authorization, storage and all other failures never trigger it.
   if(name==='runtime_response'&&typeof result.error==='object'&&'message' in result.error
    &&result.error.message==='RUNTIME_RESPONSE_CONFLICT')throw new Error('RUNTIME_RESPONSE_CONFLICT');
   const message=typeof result.error==='object'&&'message' in result.error?result.error.message:undefined;
   if(message==='RUNTIME_TEST_WINDOW_DENIED'||message==='RUNTIME_TEST_MODEL_DENIED')
    throw new StagingAccessError('RUNTIME_PRICE_CONFIGURATION_PENDING');
   if(typeof message==='string'&&['RUNTIME_RESUME_CONFLICT','RUNTIME_RESUME_SOURCE_CHANGED',
    'RUNTIME_RESUME_CLOSED','RUNTIME_CHECKPOINT_PENDING','RUNTIME_CALL_LIMIT_REACHED'].includes(message))
    throw new StagingAccessError(message as StagingFailure);
   throw new Error('RUNTIME_DATABASE_UNAVAILABLE');
  }return result.data as T;
 }
}

export const preflightCodes=new Set([
 'RUNTIME_TIME_BUDGET_EXHAUSTED',
 'RUNTIME_PROVIDER_HISTORY_DENIED',
 'RUNTIME_PROVIDER_BINDING_DENIED',
 'BILL2_PROVIDER_REQUEST_DENIED',
 'BILL2_PROVIDER_CREDENTIAL_UNAVAILABLE',
 'BILL2_PROVIDER_IDENTITY_DENIED',
 'BILL2_PROVIDER_MODEL_DENIED',
 'BILL2_PROVIDER_QUOTE_REQUIRED',
 'BILL2_PROVIDER_QUOTE_CONFLICT']);
export const hash=(value:string)=>createHash('sha256').update(value).digest('hex');

export function progressEmitter(onProgress:((event:RuntimeProgress)=>void)|undefined,
  mark:()=>void,closed:()=>boolean) {
  return (event:RuntimeProgress)=>{
    if(closed())return;
    try{if(event.type==='text'&&event.text)mark();onProgress?.(event);}
    catch{/* UI disconnect never interrupts receipt persistence. */}
  };
}
