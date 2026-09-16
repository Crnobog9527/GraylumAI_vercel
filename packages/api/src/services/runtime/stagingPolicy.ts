/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {z} from 'zod';
import {frozenCallPolicy,type BillingRpc} from '../bill2/service';
import {decimal} from '../bill2/decimal';
import {openRouterBound} from '../bill2/openRouterPolicy';
import {stagingRuntimeWindow} from './stagingEnvironment';
const schema=z.object({id:z.string().uuid(),callPolicies:z.array(frozenCallPolicy).min(1).max(16),creditsPerUsd:z.string(),multiplier:z.string(),expiresAt:z.string().datetime({offset:true})}).strict();
export type StagingPolicy=z.infer<typeof schema>;
/** Called only after authentication by the server host. The SQL procedure
 * verifies the same actor against the enabled immutable window identity.
 * No credential, client policy or mutable balance is returned here.
 */
export async function loadStagingPolicy(database:BillingRpc,actorId:string,env:Record<string,string|undefined>):Promise<StagingPolicy>{
 const windowId=stagingRuntimeWindow(env);
 const response=await database.rpc('runtime_test_policy',{p_actor_id:z.string().uuid().parse(actorId),p_window_id:windowId});
 if(response.error)throw new Error('RUNTIME_STAGING_POLICY_DENIED');
 return parsePolicy(response.data,windowId);
}
function parsePolicy(value:unknown,windowId?:string):StagingPolicy{
 const policy=schema.parse(value);
 if((windowId!==undefined&&(policy.id!==windowId||Date.parse(policy.expiresAt)<=Date.now())) || decimal(policy.creditsPerUsd)<=0n || decimal(policy.multiplier)<=0n)
  throw new Error('RUNTIME_STAGING_POLICY_DENIED');
 const ids=new Set<string>();
 for(const call of policy.callPolicies){
  if(ids.has(call.modelId) || !/^[a-z0-9-]+\/[a-z0-9._-]+$/i.test(call.model)||call.model.startsWith('openrouter/')||call.provider!=='openrouter' || call.protocol!=='openrouter-chat-v1' || !call.providerLimits || !call.lookupSupported)
   throw new Error('RUNTIME_STAGING_MODEL_DENIED');
  ids.add(call.modelId);
  if(decimal(openRouterBound(call.providerLimits,call.outputLimit).upperUsd)!==decimal(call.upperUsd))throw new Error('RUNTIME_STAGING_QUOTE_CONFLICT');
 }
 return policy;
}

/** Reads and maintenance remain target-bound after enablement is switched off. */
export async function assertStagingReadAccess(database:BillingRpc,actorId:string,env:Record<string,string|undefined>){
 stagingRuntimeWindow(env,true);
 const r=await database.rpc('runtime_test_actor_access',{p_actor_id:z.string().uuid().parse(actorId)});
 if(r.error||r.data!==true)throw new Error('RUNTIME_STAGING_ACTOR_DENIED');
}
/** Only original private bindings, for GET receipt lookup; never SDK/POST. */
export async function loadStagingRecoveryPolicy(database:BillingRpc,actorId:string,executionId:string,env:Record<string,string|undefined>):Promise<StagingPolicy>{
 stagingRuntimeWindow(env,true);
 const r=await database.rpc('runtime_test_recovery_policy',{p_actor_id:z.string().uuid().parse(actorId),p_execution_id:z.string().uuid().parse(executionId)});
 if(r.error)throw new Error('RUNTIME_STAGING_RECOVERY_DENIED');
 return parsePolicy(r.data);
}
