/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {createHash} from 'node:crypto';
import type {SupabaseClient} from '@supabase/supabase-js';
import {openRouterAdapter} from '../bill2/openRouterAdapter';
import {isOpenRouterEndpoint,resolveOpenAICompatibleEndpoint} from '../providerUtils';
import type {StagingPolicy} from './stagingPolicy';
/** Reuses the selected model's existing private credential, with no environment
 * key fallback. The namespace binds recovery to the exact original credential.
 */
export function stagingTransport(admin:SupabaseClient,policy:StagingPolicy){
 return openRouterAdapter({credential:async identity=>{
  const quotes=policy.callPolicies.filter(q=>q.account===identity.account&&q.model===identity.model);
  if(quotes.length!==1)throw new Error('RUNTIME_PROVIDER_BINDING_DENIED');
  const row=await admin.from('ai_models').select('id,model_id,provider,api_endpoint,api_key').eq('id',quotes[0]!.modelId).single();
  const model=row.data,key=model?.api_key?.trim();
  if(row.error||model?.model_id!==identity.model||!key||!isOpenRouterEndpoint(resolveOpenAICompatibleEndpoint(model.provider,model.api_endpoint)??'')||
   'openrouter-key:'+createHash('sha256').update(key).digest('hex')!==identity.account)
   throw new Error('RUNTIME_PROVIDER_BINDING_DENIED');
  return key;
 }});
}
