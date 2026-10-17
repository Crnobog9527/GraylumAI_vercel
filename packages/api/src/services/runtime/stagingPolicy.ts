/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {z} from 'zod';
import {frozenCallPolicy,type BillingRpc} from '../bill2/service';
import {modelCallPolicies,toolCallPolicies} from '../bill2/runPolicies';
import type {ToolCallPolicy} from '../bill2/toolBilling';
import {decimal} from '../bill2/decimal';
import {openRouterBound} from '../bill2/openRouterPolicy';
import {stagingRuntimeWindow} from './stagingEnvironment';
import {StagingAccessError,stagingRpcFailure} from './stagingErrors';
import {assertWindowMultipliers} from './billingUnitAdmission';
import {productionRuntimeTarget,realRuntimeEnvironment} from './productionEnvironment';
import {assertProductionAccess,loadProductionPolicy} from './productionPolicy';
// RUNTIME-PROD: mode marks a production policy (productionPolicy.ts); a staging window never carries it.
const schema=z.object({mode:z.literal('production').optional(),id:z.string().min(1).max(128),callPolicies:z.array(frozenCallPolicy).min(1).max(16),creditsPerUsd:z.string(),multiplier:z.string(),expiresAt:z.string().datetime({offset:true})}).strict();
/** RESEARCH-TOOLS RT-3b PR-3: the window may also approve tool routes (0255); they are kept apart from the models. */
export type StagingPolicy=z.infer<typeof schema>&{toolPolicies?:ToolCallPolicy[]};
/** Called only after authentication by the server host. The SQL procedure
 * verifies the same actor against the enabled immutable window identity.
 * No credential, client policy or mutable balance is returned here.
 */
export async function loadStagingPolicy(database:BillingRpc,actorId:string,env:Record<string,string|undefined>):Promise<StagingPolicy>{
 // RUNTIME-PROD: the production deployment has no window; the same entry point serves both hosts.
 if(realRuntimeEnvironment(env)==='production')return loadProductionPolicy(database as never,actorId,env);
 const windowId=stagingRuntimeWindow(env);
 const response=await database.rpc('runtime_test_policy',{p_actor_id:z.string().uuid().parse(actorId),p_window_id:windowId});
 if(response.error)stagingRpcFailure(response.error,'RUNTIME_TEST_WINDOW_DENIED','RUNTIME_STAGING_POLICY_DENIED');
 return parseStagingPolicy(response.data,windowId);
}
export function parseStagingPolicy(value:unknown,windowId?:string):StagingPolicy{
 const raw=z.object({callPolicies:z.array(z.object({protocol:z.string()}).passthrough()).max(32)}).passthrough().safeParse(value);
 if(!raw.success)throw new StagingAccessError('RUNTIME_STAGING_POLICY_INVALID');
 let tools:ToolCallPolicy[];
 try{tools=toolCallPolicies(raw.data.callPolicies);}catch{throw new StagingAccessError('RUNTIME_STAGING_POLICY_INVALID');}
 const parsed=schema.safeParse({...raw.data,callPolicies:modelCallPolicies(raw.data.callPolicies)});
 if(!parsed.success)throw new StagingAccessError('RUNTIME_STAGING_POLICY_INVALID');
 const policy:StagingPolicy={...parsed.data,...(tools.length?{toolPolicies:tools}:{})};
 if(!policy.mode&&!z.string().uuid().safeParse(policy.id).success)throw new StagingAccessError('RUNTIME_STAGING_POLICY_INVALID');
 if(windowId!==undefined&&Date.parse(policy.expiresAt)<=Date.now())throw new StagingAccessError('RUNTIME_STAGING_WINDOW_EXPIRED');
 if((windowId!==undefined&&policy.id!==windowId) || decimal(policy.creditsPerUsd)<=0n || decimal(policy.multiplier)<=0n)
  throw new StagingAccessError('RUNTIME_STAGING_POLICY_INVALID');
 const ids=new Set<string>();
 for(const call of policy.callPolicies){
  if(ids.has(call.modelId) || !/^[a-z0-9-]+\/[a-z0-9._-]+$/i.test(call.model)||call.model.startsWith('openrouter/')||call.provider!=='openrouter' || call.protocol!=='openrouter-chat-v1' || !call.providerLimits || !call.lookupSupported)
   throw new StagingAccessError('RUNTIME_STAGING_MODEL_DENIED');
  ids.add(call.modelId);
  if(decimal(openRouterBound(call.providerLimits,call.outputLimit).upperUsd)!==decimal(call.upperUsd))throw new StagingAccessError('RUNTIME_STAGING_QUOTE_CONFLICT');
 }
 assertWindowMultipliers(policy);
 return policy;
}

/** Reads and maintenance remain target-bound after enablement is switched off. */
export async function assertStagingReadAccess(database:BillingRpc,actorId:string,env:Record<string,string|undefined>){
 if(realRuntimeEnvironment(env)==='production'){productionRuntimeTarget(env,true);return assertProductionAccess(database as never,actorId);}
 stagingRuntimeWindow(env,true);
 const r=await database.rpc('runtime_test_actor_access',{p_actor_id:z.string().uuid().parse(actorId)});
 if(r.error)stagingRpcFailure(r.error,'RUNTIME_TEST_ACTOR_DENIED','RUNTIME_STAGING_ACTOR_DENIED');
 if(r.data!==true)throw new StagingAccessError('RUNTIME_STAGING_SERVICE_UNAVAILABLE');
}
/** Only original private bindings, for GET receipt lookup; never SDK/POST. */
export async function loadStagingRecoveryPolicy(database:BillingRpc,actorId:string,executionId:string,env:Record<string,string|undefined>):Promise<StagingPolicy>{
 if(realRuntimeEnvironment(env)==='production'){
  productionRuntimeTarget(env,true);
  const r=await database.rpc('runtime_production_recovery_policy',{p_actor_id:z.string().uuid().parse(actorId),p_execution_id:z.string().uuid().parse(executionId)});
  if(r.error)stagingRpcFailure(r.error,'RUNTIME_TEST_RECOVERY_DENIED','RUNTIME_STAGING_RECOVERY_DENIED');
  const policy=parseStagingPolicy(r.data);
  if(policy.mode!=='production')throw new StagingAccessError('RUNTIME_PRODUCTION_TARGET_DENIED');
  return policy;
 }
 stagingRuntimeWindow(env,true);
 const r=await database.rpc('runtime_test_recovery_policy',{p_actor_id:z.string().uuid().parse(actorId),p_execution_id:z.string().uuid().parse(executionId)});
 if(r.error)stagingRpcFailure(r.error,'RUNTIME_TEST_RECOVERY_DENIED','RUNTIME_STAGING_RECOVERY_DENIED');
 return parseStagingPolicy(r.data);
}
