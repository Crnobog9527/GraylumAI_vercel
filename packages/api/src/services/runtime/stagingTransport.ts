/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type {SupabaseClient} from '@supabase/supabase-js';
import {openRouterAdapter} from '../bill2/openRouterAdapter';
import {openRouterAccount,readOpenRouterKeyOrUnset} from '../models/openRouterKey';
import {isOpenRouterEndpoint,resolveOpenAICompatibleEndpoint} from '../providerUtils';
import type {RuntimeBudget} from './budget';
import type {StagingPolicy} from './stagingPolicy';
import {catalogRead} from './catalogCache';
/** Uses the platform OpenRouter key (admin third-party keys page, Vault; OR-1), with no environment
 * key fallback. The namespace binds recovery to the exact original credential.
 */
export function stagingTransport(admin:SupabaseClient,policy:StagingPolicy,budget?:RuntimeBudget){
 return openRouterAdapter({allowWorkspaceRead:true,allowAgentTools:true,budget,credential:async (identity,signal)=>{
  const quotes=policy.callPolicies.filter(q=>q.account===identity.account&&q.model===identity.model);
  if(quotes.length!==1)throw new Error('RUNTIME_PROVIDER_BINDING_DENIED');
  budget?.assertCanPersist();
  const query=admin.from('ai_models').select('id,model_id,provider,api_endpoint').eq('id',quotes[0]!.modelId);
  const deadline=budget?AbortSignal.timeout(Math.max(1,Math.ceil(budget.remainingPersistence()))):undefined;
  const bounded=signal&&deadline?AbortSignal.any([signal,deadline]):signal??deadline;
  // DB-RW PR-B: the model row is a catalog row; the key below is still read fresh for every call.
  const row=await catalogRead(admin,'models','transport-model:'+quotes[0]!.modelId,()=>(bounded?query.abortSignal(bounded):query).single());
  const model=row.data;
  // A key that cannot be read (not filled, database unavailable) is a refusal, never another key.
  const key=row.error?undefined:await readOpenRouterKeyOrUnset(admin,{fresh:true});
  if(row.error||model?.model_id!==identity.model||!key||!isOpenRouterEndpoint(resolveOpenAICompatibleEndpoint(model.provider,model.api_endpoint)??'')||
   openRouterAccount(key)!==identity.account)
   throw new Error('RUNTIME_PROVIDER_BINDING_DENIED');
  return key;
 }});
}
