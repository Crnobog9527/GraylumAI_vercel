/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { readPaygHostPolicies, paygHostProfile, type PaygHostProfile } from './paygHostPolicy';
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
  f=>{delete (f.profile.evidence as Record<string,unknown>).maxVerifiedMessages;},
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
it('staging-shaped profile (no v2) rejects old free chat and admits v6 + low; unknown models stay denied',async()=>{
 const f=fixture();
 f.profile.requestFormats=['agent-turn-v5-stream','serial-tools-v4-stream','serial-tools-v6-reasoning'];
 f.profile.purposes=['skill','report','ordinary','skill_matching'];
 f.profile.reasoningVariants.push({...f.profile.reasoningVariants[0],reasoning:{effort:'low'}});
 const read=(requestFormat:string,reasoning?:{effort:'low'},policy=f.policy)=>readPaygHostPolicies(f.db as unknown as SupabaseClient,
  f.window,[policy],[{modelId:id,phase:'ordinary',outputLimit:8192,requestFormat,reasoning}],env);
 await expect(read('serial-tools-v2')).rejects.toThrow('RUNTIME_PAYG_PROFILE_REQUIRED');
 expect(await read('serial-tools-v6-reasoning',{effort:'low'})).toHaveLength(1);
 // A model without an evidenced route profile (e.g. gpt-6.1-sol) is still refused.
 await expect(read('serial-tools-v6-reasoning',{effort:'low'},{...f.policy,model:'openai/gpt-6.1-sol',
  providerLimits:{...f.policy.providerLimits!,providerSlug:'openai'}})).rejects.toThrow('RUNTIME_PAYG_PROFILE_REQUIRED');
});
it('admits the Fusion panel routes only on their evidenced route; other models stay denied',async()=>{
 const read=async(model:string,endpointTag:string)=>{
  const f=fixture();
  f.profile.model=model;f.profile.endpointTag=endpointTag;
  f.profile.purposes=['fusion_review','fusion_summary'];f.profile.requestFormats=['fusion-json-v1-stream'];
  f.profile.reasoningVariants=[{...f.profile.reasoningVariants[0]!,reasoning:{effort:'low'}}];
  const policy={...f.policy,model,providerLimits:{...f.policy.providerLimits!,providerSlug:endpointTag}};
  return readPaygHostPolicies(f.db as unknown as SupabaseClient,f.window,[policy],
   [{modelId:id,phase:'fusion_review',outputLimit:4096,requestFormat:'fusion-json-v1-stream',reasoning:{effort:'low'}}],env);
 };
 expect(await read('openai/gpt-6.1-sol','openai')).toHaveLength(1);
 expect(await read('anthropic/claude-opus-5.5','anthropic')).toHaveLength(1);
 await expect(read('openai/gpt-6.1-sol','azure')).rejects.toThrow('RUNTIME_PAYG_PROFILE_REQUIRED');
 await expect(read('anthropic/claude-opus-5.5','amazon-bedrock')).rejects.toThrow('RUNTIME_PAYG_PROFILE_REQUIRED');
 await expect(read('qwen/qwen3.8-max-0902','alibaba')).rejects.toThrow('RUNTIME_PAYG_PROFILE_REQUIRED');
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

it.each([
 ['google-ai-studio','google-ai-studio',true],
 ['google-vertex/global','google-vertex/global',false],
 ['google-ai-studio/flex','google-ai-studio/flex',false],
 ['google-ai-studio/priority','google-ai-studio/priority',false],
 ['google-ai-studio','google-vertex/global',false],
 ['google-vertex/global','google-ai-studio',false],
] as const)('Gemini exact route binding: profile %s / policy %s',async(profileTag,policyTag,accepted)=>{
 const f=fixture();f.profile.model=f.policy.model='google/gemini-3.8-flash';
 f.profile.endpointTag=profileTag;f.policy.providerLimits!.providerSlug=policyTag;
 const frozen=structuredClone(f.policy);
 if(accepted)expect(await f.run()).toBeDefined();
 else await expect(f.run()).rejects.toThrow('RUNTIME_PAYG_PROFILE_REQUIRED');
 expect(f.policy).toEqual(frozen);
});
it('AI Studio still refuses incomplete output evidence',async()=>{
 const f=fixture();f.profile.model=f.policy.model='google/gemini-3.8-flash';
 f.profile.endpointTag=f.policy.providerLimits!.providerSlug='google-ai-studio';
 f.profile.reasoningVariants[0].outputStressSamples=1;
 await expect(f.run()).rejects.toThrow('RUNTIME_PAYG_PROFILE_REQUIRED');
});

it('Sonnet low may cite same-route none evidence only under the precise approved relation',()=>{
 const f=fixture(),p=f.profile;
 p.evidence.testedOutputLimit=2048;p.reasoningVariants[0]!.testedOutputLimit=2048;
 const source=p.reasoningVariants[0]!;
 p.reasoningVariants.push({...source,reasoning:{effort:'low'},outputStressSamples:0,outputSemanticsEvidence:'same-route-none'});
 expect(paygHostProfile.safeParse(p).success).toBe(true);
 const bad=[
  {...p,model:'google/gemini-3.8-flash',endpointTag:'google-ai-studio'},
  {...p,endpointTag:'anthropic/other'},
  {...p,reasoningVariants:[p.reasoningVariants[1]]},
  {...p,reasoningVariants:[{...source,outputStressSamples:1},p.reasoningVariants[1]]},
  {...p,reasoningVariants:[source,{...p.reasoningVariants[1],evidenceReference:'different'}]},
  {...p,reasoningVariants:[source,{...p.reasoningVariants[1],manifestHash:'c'.repeat(64)}]},
  {...p,reasoningVariants:[source,{...p.reasoningVariants[1],reasoning:{effort:'high'}}]},
  {...p,reasoningVariants:[source,{...p.reasoningVariants[1],outputSemanticsEvidence:undefined}]},
 ];
 for(const value of bad)expect(paygHostProfile.safeParse(value).success).toBe(false);
});

it('requires a 32768-authorized profile and sufficient context; rejects cap plus one', async () => {
 const f=fixture();
 await expect(f.run('ordinary',32768)).rejects.toThrow('RUNTIME_PAYG_PROFILE_REQUIRED');
 f.profile.outputLimit=32768;f.profile.evidence.outputLimit=32768;
 f.profile.reasoningVariants[0].outputLimit=32768;
 f.policy.outputLimit=32768;
 f.policy.providerLimits!.contextTokens=237568;
 await expect(f.run('ordinary',32768)).resolves.toBeDefined();
 await expect(f.run('ordinary',32769)).rejects.toThrow('RUNTIME_PAYG_PROFILE_REQUIRED');
 f.policy.providerLimits!.contextTokens=237567;
 await expect(f.run('ordinary',32768)).rejects.toThrow('RUNTIME_PAYG_PROFILE_REQUIRED');
 f.profile.outputLimit=32769;
 expect(paygHostProfile.safeParse(f.profile).success).toBe(false);
});
// B1 (0250) / RT-3b PR-2 (0267): profiles may carry 2–9 tools; anything above 9 stays a configuration error.
it.each([2,3,9] as const)('accepts a %s-tool profile and freezes it unchanged',async maxTools=>{
  const f=fixture();f.profile.maxTools=maxTools;
  expect((await f.run())?.[0].payg).toMatchObject({maxTools});
});
it.each([1,4.5,10])('refuses a %s-tool profile outside the 2–9 range (0267 ceiling)',async maxTools=>{
  const f=fixture();(f.profile as {maxTools:number}).maxTools=maxTools;
  await expect(f.run()).rejects.toThrow();
});
// FUSION-PROFILE (Owner 2026-10-17, plan B): a profile used only for Fusion review/summary calls may cite evidence taken
// on the real Fusion request shape instead of the full #665 matrix; every other purpose still needs the full matrix.
function fusionOnly(model='anthropic/claude-opus-5.5',endpointTag='anthropic'){
 const f=fixture();
 f.profile.model=f.policy.model=model;f.profile.endpointTag=f.policy.providerLimits!.providerSlug=endpointTag;
 f.profile.purposes=['fusion_summary'];f.profile.requestFormats=['fusion-json-v1-stream'];
 f.profile.reasoningVariants=[{...f.profile.reasoningVariants[0]!,reasoning:{effort:'low'},testedOutputLimit:2048}];
 (f.profile as {evidence:unknown}).evidence={scope:'fusion-request-shape',reference:'test-only',manifestHash:'a'.repeat(64),
  distinctSamples:6,sizeBands:2,maxVerifiedBytes:186000,maxPromptToBytes:0.4,maxPromptToUpper:0.38,outputLimit:8192,testedOutputLimit:2048,
  outputSemantics:'max-tokens-includes-reasoning',includesReasoning:true,cacheCovered:true,costBoundPassed:true};
 const read=(phase:PaygHostProfile['purposes'][number]='fusion_summary',requestFormat='fusion-json-v1-stream')=>readPaygHostPolicies(
  f.db as unknown as SupabaseClient,f.window,[f.policy],[{modelId:id,phase,outputLimit:8192,requestFormat,reasoning:{effort:'low'}}],env);
 return {...f,read};
}
it('admits a Fusion-only profile on Fusion-shape evidence',async()=>{
 const f=fusionOnly();
 expect(paygHostProfile.safeParse(f.profile).success).toBe(true);
 expect(await f.read()).toHaveLength(1);
 const sol=fusionOnly('openai/gpt-6.1-sol','openai');sol.profile.purposes=['fusion_review','fusion_summary'];
 expect(await sol.read('fusion_review')).toHaveLength(1);
});
it('Fusion-shape evidence never covers another purpose or request format',async()=>{
 for(const purpose of ['ordinary','skill','report','organizer','skill_matching','attached_organizer'] as const){
  const f=fusionOnly();f.profile.purposes=['fusion_summary',purpose];
  expect(paygHostProfile.safeParse(f.profile).success).toBe(false);
  await expect(f.read()).rejects.toThrow('RUNTIME_PAYG_PROFILE_REQUIRED');
 }
 const f=fusionOnly();f.profile.requestFormats=['fusion-json-v1-stream','serial-tools-v6-reasoning'];
 expect(paygHostProfile.safeParse(f.profile).success).toBe(false);
});
it('Fusion-shape evidence keeps its own bounds',()=>{
 const bad:Array<(e:Record<string,unknown>)=>void>=[
  e=>{e.distinctSamples=3;},e=>{e.sizeBands=1;},e=>{e.maxVerifiedBytes=120000;},e=>{e.maxVerifiedBytes=196609;},
  e=>{e.maxPromptToBytes=0.71;},e=>{e.maxPromptToUpper=0.71;},e=>{e.costBoundPassed=false;},e=>{e.cacheCovered=false;},
  e=>{e.scope='other';},e=>{e.extra=1;},e=>{delete e.testedOutputLimit;},
 ];
 for(const change of bad){
  const f=fusionOnly();change(f.profile.evidence as unknown as Record<string,unknown>);
  expect(paygHostProfile.safeParse(f.profile).success).toBe(false);
 }
 // Output evidence still applies: two stress samples, and the variant's tested limit must match the evidence.
 const f=fusionOnly();f.profile.reasoningVariants[0]!.outputStressSamples=1;
 expect(paygHostProfile.safeParse(f.profile).success).toBe(false);
 const g=fusionOnly();g.profile.reasoningVariants[0]!.testedOutputLimit=512;
 expect(paygHostProfile.safeParse(g.profile).success).toBe(false);
});


it('Argon admits evidenced review low only on google-ai-studio; alternatives and other purposes stay denied', async () => {
 const f=fusionOnly('google/gemini-4-argon','google-ai-studio');
 f.profile.purposes=['fusion_review'];
 expect(await f.read('fusion_review')).toHaveLength(1);
 for(const purpose of ['ordinary','fusion_summary','fusion_compare'] as const)
  await expect(f.read(purpose)).rejects.toThrow('RUNTIME_PAYG_PROFILE_REQUIRED');
 for(const route of ['google-vertex/global','google-ai-studio/flex','google-ai-studio/priority']){
  const other=fusionOnly('google/gemini-4-argon',route);other.profile.purposes=['fusion_review'];
  await expect(other.read('fusion_review')).rejects.toThrow('RUNTIME_PAYG_PROFILE_REQUIRED');
 }
 f.profile.reasoningVariants[0]!.outputStressSamples=1;
 await expect(f.read('fusion_review')).rejects.toThrow('RUNTIME_PAYG_PROFILE_REQUIRED');
});
