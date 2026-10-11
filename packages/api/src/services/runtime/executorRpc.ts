/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {assertPath} from '../skills/loader';
import {SKILL_FILE_TRACE_BYTES,skillFileParameters} from './skillFile';
import {throwIfContentErased} from '../accountErasure/content';
import type {RuntimeProgress} from './progress';
import {createHash} from 'node:crypto';
import {terminalAgentReplyFailure} from './terminalAgentReply';
import {logger} from '../../lib/logger';
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
   throwIfContentErased(result.error);
   // A private, exact identity mismatch permits only the bounded legacy replay
   // below. Authorization, storage and all other failures never trigger it.
   if(name==='runtime_response'&&typeof result.error==='object'&&'message' in result.error
    &&result.error.message==='RUNTIME_RESPONSE_CONFLICT')throw new Error('RUNTIME_RESPONSE_CONFLICT');
   const message=typeof result.error==='object'&&'message' in result.error?result.error.message:undefined;
   if((name==='runtime_tool'&&args.p_name==='read_skill_file'||name==='read_skill_package')&&
    typeof message==='string'&&['Skill unavailable','resource unavailable','RUNTIME_SKILL_FILE_DENIED',
     'RUNTIME_SKILL_FILE_TOO_LARGE','RUNTIME_SKILL_FILE_CONFLICT','RUNTIME_TOOL_DENIED','RUNTIME_TOOL_CLOSED',
     'RUNTIME_TOOL_LIMIT','RUNTIME_TOOL_CONFLICT','RUNTIME_TOOL_RESULT_CONFLICT'].includes(message))
    throw new Error('RUNTIME_SKILL_FILE_REFUSED');
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

export async function recoverExecutorFinancial(rpc:ReturnType<typeof executorRpc>,
  billing:{recoverReceipts:(id:string)=>Promise<unknown>},executionId:string) {
  const args={p_execution_id:z.string().uuid().parse(executionId)};
  const current=await rpc<{runId:string}>('runtime_financial_recovery',args);
  await billing.recoverReceipts(current.runId);
  return rpc<{executionId:string;runId:string;state:string;billing:unknown}>('runtime_financial_recovery',{...args,p_finish:true});
}

export function historyGuard(executionId:string,failed:(code:string)=>void) {
  return <T>(check:()=>T):T=>{
    try{return check();}catch(error){
      if(error instanceof Error&&error.message==='RUNTIME_PROVIDER_HISTORY_DENIED'){
        failed(error.message);
        logger.error('api','runtime_provider_preflight_failed',{executionId,code:error.message});
      }
      throw error;
    }
  };
}

export function terminalReplyGuard(active:boolean,allowsCard:boolean,failed:()=>void,allowsSkillFile=false) {
  let fileRequested=false;
  return (response:unknown,organizer=false)=>{
    const message=(response as {choices?:Array<{message?:{tool_calls?:Array<{id?:string;type?:string;
      function?:{name?:string;arguments?:string}}>}}>})?.choices?.[0]?.message;
    const readsFile=message?.tool_calls?.[0]?.function?.name==='read_skill_file';
    let invalidFileArguments=false;
    if(readsFile){try{
      const call=message!.tool_calls![0]!,{path}=skillFileParameters.parse(JSON.parse(call.function!.arguments!));
      assertPath(path);
      invalidFileArguments=Buffer.from(path).toString('utf8')!==path||call.type!=='function'||
        typeof call.id!=='string'||!call.id.length||Array.from(call.id).length>256||call.id.includes('\0')||
        Buffer.from(call.id).toString('utf8')!==call.id;
     }catch{invalidFileArguments=true;}}
    const oversized=readsFile&&Buffer.byteLength(JSON.stringify(JSON.stringify(message)))>SKILL_FILE_TRACE_BYTES;
    if(active&&(terminalAgentReplyFailure(response,organizer,allowsCard,allowsSkillFile&&!fileRequested)||oversized||invalidFileArguments)){
      failed();
      throw new Error('RUNTIME_TERMINAL_REPLY');
    }
    if(active&&!organizer&&readsFile)fileRequested=true;
  };
}
