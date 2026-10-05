/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { readPaygHostPolicies, type PaygHostProfile } from './paygHostPolicy';
import type { StagingPolicy } from './stagingPolicy';
const id = '10000000-0000-4000-8000-000000000001';
const env = { VERCEL: '1', VERCEL_PROJECT_PRODUCTION_URL: 'auth-staging.graylum.com',
  VERCEL_GIT_COMMIT_REF: 'staging', VERCEL_GIT_REPO_OWNER: 'Crnobog9527', VERCEL_GIT_REPO_SLUG: 'GraylumAI_vercel',
  VERCEL_PROJECT_ID: 'fixture-project', V3_RUNTIME_STAGING_PROJECT_ID: 'fixture-project',
  V3_RUNTIME_STAGING_DATABASE_HOST: 'fixture.supabase.co', NEXT_PUBLIC_SUPABASE_URL: 'https://fixture.supabase.co',
  V3_RUNTIME_STAGING_WINDOW_ID: id, V3_RUNTIME_STAGING_ENABLED: 'true' };
// Synthetic evidence exercises validation only. It is never shipped as a real admission profile.
function fixture() {
  const profile: PaygHostProfile = { model: 'anthropic/claude-sonnet-5.5', endpointTag: 'anthropic', protocol:'openrouter-chat-v1',
    profileVersion: 'test-only', evidenceVersion: 'test-only', admissionPath:'empirical',
    templateTokens:4096,marginTokens:4096,maxBytes:196608,maxMessages:128,maxTools:2,maxSchemaBytes:16384,
    purposes:['ordinary','skill','organizer','skill_matching','attached_organizer'],
    requestFormats:['serial-tools-v2','agent-turn-v5-stream','serial-tools-v4-stream','serial-tools-v6-reasoning'],
    reasoningVariants:[{reasoning:{parameter:'none'},outputLimit:8192,testedOutputLimit:512,evidenceReference:'test-only',
      manifestHash:'b'.repeat(64),outputStressSamples:2,includesReasoning:true}],outputLimit:8192,expiresAt:'2099-01-01T00:00:00Z',
    evidence:{reference:'test-only',manifestHash:'a'.repeat(64),distinctSamples:60,messageStressSamples:12,maxVerifiedMessages:128,completeCells:15,variantsPerCell:4,
      maxPromptToBytes:0.5,maxPromptToUpper:0.4,outputLimit:8192,testedOutputLimit:512,outputSemantics:'max-tokens-includes-reasoning',includesReasoning:true,cacheCovered:true,costBoundPassed:true} };
  const policy: StagingPolicy['callPolicies'][number] = { modelId:id,model:profile.model,provider:'openrouter',
    account:'test-only',protocol:'openrouter-chat-v1',inputLimit:196608,outputLimit:8192,upperUsd:'1',
    automaticRetry:false,hiddenTools:false,lookupSupported:true,
    providerLimits:{providerSlug:profile.endpointTag,contextTokens:212992,promptUsdPerMillion:'1',completionUsdPerMillion:'1',requestUsd:'0'} };
  const window: StagingPolicy = {id,callPolicies:[policy],creditsPerUsd:'100',multiplier:'3',expiresAt:profile.expiresAt};
  const config = {version:1,enabled:true,windowId:id,profiles:[profile]};
  const single=vi.fn(async()=>({data:{value:config} as {value:unknown}|null,error:null as unknown}));
  const db={from:vi.fn(()=>({select:()=>({eq:()=>({maybeSingle:single})})}))};
  const run=(phase:PaygHostProfile['purposes'][number]='ordinary',outputLimit=8192)=>readPaygHostPolicies(db as unknown as SupabaseClient,
    window,[policy],[{modelId:id,phase,outputLimit,requestFormat:'serial-tools-v2'}],env);
  return {profile,policy,window,config,db,single,run};
}
it.each(['ordinary','skill','organizer','skill_matching','attached_organizer'] as const)('wires %s only with an exact validated profile',async phase=>{
  const f=fixture();const result=await f.run(phase);
  expect(result?.[0].payg).toMatchObject({admissionPath:'empirical',templateTokens:4096,marginTokens:4096});
  expect({...result![0],payg:undefined}).toEqual({...f.policy,payg:undefined});
});
it('defaults off, switches back to v1, and never rewrites previously frozen policies',async()=>{
  const f=fixture();const original=await f.run();const saved=structuredClone(original);
  f.config.enabled=false;f.profile.expiresAt='2000-01-01T00:00:00Z';
  expect(await f.run()).toBeUndefined();expect(original).toEqual(saved);
  f.single.mockResolvedValue({data:null,error:null});expect(await f.run()).toBeUndefined();
});
it('refuses production before reading settings even if the flag is on',async()=>{
  const f=fixture();await expect(readPaygHostPolicies(f.db as unknown as SupabaseClient,f.window,[f.policy],[],
    {...env,VERCEL_GIT_COMMIT_REF:'main'})).rejects.toThrow('RUNTIME_STAGING_TARGET_DENIED');
  expect(f.db.from).not.toHaveBeenCalled();
});
it.each([
  (f:ReturnType<typeof fixture>)=>{f.profile.evidence.outputLimit=1024;},
  f=>{f.policy.providerLimits!.contextTokens=212991;},
  f=>{f.profile.endpointTag='synthetic/other';},
  f=>{f.profile.purposes=['organizer'];},
  f=>{f.profile.reasoningVariants[0].reasoning={effort:'low'};},
  f=>{f.profile.model='unapproved/model';f.policy.model='unapproved/model';},
  f=>{f.profile.requestFormats=['agent-turn-v5-stream'];},
  f=>{f.profile.expiresAt='2000-01-01T00:00:00Z';},
  f=>{f.profile.evidence.maxPromptToUpper=0.71;},
  f=>{delete (f.profile.evidence as Partial<PaygHostProfile['evidence']>).maxVerifiedMessages;},
  f=>{f.config.profiles.push({...f.profile});},
  f=>{f.config.profiles=[];},
  f=>{f.config.windowId='20000000-0000-4000-8000-000000000002';},
])('refuses incomplete/mismatched evidence and capacity, never silently downgrades (%#)',async mutate=>{
  const f=fixture();mutate(f);await expect(f.run()).rejects.toThrow('RUNTIME_PAYG_PROFILE_REQUIRED');
});
it('a smaller verified O cannot admit a larger purpose O',async()=>{
  const f=fixture();f.profile.outputLimit=1024;f.profile.evidence.outputLimit=1024;f.profile.reasoningVariants[0].outputLimit=1024;
  expect(await f.run('ordinary',1024)).toBeDefined();await expect(f.run()).rejects.toThrow('RUNTIME_PAYG_PROFILE_REQUIRED');
});
it('a read failure is not a disabled flag',async()=>{
  const f=fixture();f.single.mockResolvedValue({data:null,error:{code:'unavailable'}});
  await expect(f.run()).rejects.toThrow('RUNTIME_PAYG_CONFIG_UNAVAILABLE');
});
it('one model/route admits ordinary and configured reasoning with independent output evidence',async()=>{
 const f=fixture();f.profile.reasoningVariants.push({...f.profile.reasoningVariants[0],reasoning:{effort:'low'}});
 const requirements=[{modelId:id,phase:'ordinary' as const,outputLimit:8192,requestFormat:'serial-tools-v2'},
  {modelId:id,phase:'attached_organizer' as const,outputLimit:8192,requestFormat:'serial-tools-v6-reasoning',reasoning:{effort:'low' as const}}];
 expect(await readPaygHostPolicies(f.db as unknown as SupabaseClient,f.window,[f.policy],requirements,env)).toHaveLength(1);
 f.profile.reasoningVariants[1].outputLimit=1024;
 await expect(readPaygHostPolicies(f.db as unknown as SupabaseClient,f.window,[f.policy],requirements,env))
  .rejects.toThrow('RUNTIME_PAYG_PROFILE_REQUIRED');
});
it('requires profile validity through the frozen execution deadline',async()=>{
 const f=fixture();f.profile.expiresAt='2098-01-01T00:00:00Z';
 await expect(f.run()).rejects.toThrow('RUNTIME_PAYG_PROFILE_REQUIRED');
});

it('legacy serialized emergency off is honored, while malformed string values fail closed',async()=>{
 const f=fixture();f.single.mockResolvedValue({data:{value:'{"enabled":false}'},error:null});
 expect(await f.run()).toBeUndefined();
 f.single.mockResolvedValue({data:{value:'{"enabled":"false"}'},error:null});
 await expect(f.run()).rejects.toThrow('RUNTIME_PAYG_PROFILE_REQUIRED');
});

it.each([512,2048])('strict truncation semantics tested at %i permit the authorized 8192 cap',async tested=>{
 const f=fixture();f.profile.evidence.testedOutputLimit=tested;
 f.profile.reasoningVariants[0].testedOutputLimit=tested;
 await expect(f.run('ordinary',8192)).resolves.toBeDefined();
 await expect(f.run('ordinary',8193)).rejects.toThrow('RUNTIME_PAYG_PROFILE_REQUIRED');
});
it.each([
 (f:ReturnType<typeof fixture>)=>{delete (f.profile.evidence as Partial<PaygHostProfile['evidence']>).testedOutputLimit;},
 f=>{delete (f.profile.evidence as Partial<PaygHostProfile['evidence']>).outputSemantics;},
 f=>{f.profile.evidence.testedOutputLimit=2048;},
 f=>{f.profile.reasoningVariants[0].testedOutputLimit=0;},
 f=>{f.profile.reasoningVariants[0].testedOutputLimit=8193;},
 f=>{f.profile.reasoningVariants[0].outputStressSamples=1;},
 f=>{Reflect.set(f.profile.reasoningVariants[0],'includesReasoning',false);},
 f=>{Reflect.set(f.profile.evidence,'outputSemantics','completion-excludes-reasoning');},
 f=>{f.profile.outputLimit=8193;},
])('rejects missing or inconsistent semantic evidence (%#)',async mutate=>{
 const f=fixture();mutate(f);await expect(f.run()).rejects.toThrow('RUNTIME_PAYG_PROFILE_REQUIRED');
});
it('each requested reasoning setting independently needs two semantic probes',async()=>{
 const f=fixture();f.profile.reasoningVariants.push({...f.profile.reasoningVariants[0],reasoning:{effort:'low'},outputStressSamples:1});
 await expect(f.run()).rejects.toThrow('RUNTIME_PAYG_PROFILE_REQUIRED');
});
