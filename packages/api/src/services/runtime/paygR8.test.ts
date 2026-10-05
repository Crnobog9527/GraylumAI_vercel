/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {beforeAll,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import prices from '../../../../../scripts/payg-profile/plan-prices.json';
import frozen from '../../../../../docs/launch/evidence/payg-profile-20261006-r8.manifest.json';
import {createR8Plan} from '../../../../../scripts/payg-profile/batch-r8';
import {openRouterRequestBody} from './providerRequest';
import {openRouterBound} from '../bill2/openRouterPolicy';
import {identityFor} from '../../../../../scripts/payg-profile/executor';
import {openRouterAdapter} from '../bill2/openRouterAdapter';
import {paygHostProfile} from './paygHostPolicy';
import drafts from '../../../../../docs/launch/evidence/payg-profile-20261006-r8.profiles-draft.json';
import {decimal} from '../bill2/decimal';
let plan:ReturnType<typeof createR8Plan>;
beforeAll(()=>{plan=createR8Plan(prices);},30000);
it('reproduces 14 probes, exact byte/hash bounds, settled prior accounting and unchanged per-call gates',()=>{
  expect(plan.manifest).toEqual(frozen);
  expect(plan.manifest.calls).toBe(14);
  expect(plan.manifest.priorAccountedUsd).toBe('6.470137565000');
  expect(decimal(plan.manifest.cumulativeUpperUsd)).toBeLessThan(decimal('25'));
  expect(plan.manifest.blockers.filter(b=>b.startsWith('PER_CALL_BUDGET_EXCEEDED:'))).toHaveLength(3);
  expect(plan.manifest.batch.previous.at(-1)).toMatchObject({accountedUsd:'1.478152850000',ownerConfirmedZero:[]});
  expect(new Set(plan.manifest.samples.map(s=>s.requestHash)).size).toBe(14);
  for(const sample of plan.manifest.samples){
    const {body}=plan.requests.find(r=>r.id===sample.id)!;
    const parsed=JSON.parse(body);
    expect(Buffer.byteLength(body)).toBe(sample.B);
    expect(createHash('sha256').update(body).digest('hex')).toBe(sample.requestHash);
    expect(parsed.reasoning_effort).toBe('low');expect(parsed.max_tokens).toBe(sample.O);
    expect(parsed.provider.only).toEqual([sample.endpointTag]);expect(parsed.provider.allow_fallbacks).toBe(false);
    expect(sample.approvedCap).toBe(prices.routes.find(r=>r.model===sample.model)!.perCallCap);
    if(sample.kind==='route'){
      expect(parsed.stream).toBe(true);expect(parsed.stream_options.include_usage).toBe(true);
      expect(sample.O).toBe(8192);expect([4096,196608]).toContain(sample.B);
      if(sample.phase==='report'){
        expect(sample.requestFormat).toBe('agent-turn-v5-stream');expect(sample.cache).toBe('disabled');
        expect(parsed.tools).toBeUndefined();expect(body).not.toContain('cache_control');
      }
      if(sample.id.includes(':mentor:'))expect(parsed.tools[0].function).toMatchObject({name:'ask_question',strict:true});
    }else{
      expect(sample.O).toBe(2048);expect(sample.B).toBe(32768);expect(parsed.stream).toBe(false);
      // Hundreds of explicit fixed-format rows prevent the old short-input echo ending early.
      expect(parsed.messages[1].content.match(/\d{6} \| notebook/g).length).toBeGreaterThan(300);
      expect(JSON.stringify(parsed.messages[0])).toContain('010000');
    }
  }
});
it('does not hide the existing report low primary-role binding failure behind synthetic route probes',()=>{
  const sample=plan.manifest.samples.find(s=>s.phase==='report')!;
  const {body}=plan.requests.find(r=>r.id===sample.id)!;
  const route=prices.routes.find(r=>r.model===sample.model)!;
  const providerLimits={providerSlug:route.endpointTag,contextTokens:route.contextTokens,
    promptUsdPerMillion:route.prompt,completionUsdPerMillion:route.completion,requestUsd:route.request,cacheWriteUsdPerMillion:route.write};
  const policy={modelId:'10000000-0000-4000-8000-000000000001',model:route.model,provider:'openrouter',account:'synthetic',
    protocol:'openrouter-chat-v1' as const,providerLimits,upperUsd:openRouterBound(providerLimits,8192).upperUsd,
    inputLimit:196608,outputLimit:8192,automaticRetry:false as const,hiddenTools:false as const,lookupSupported:true};
  const context={providerRequestFormat:'agent-turn-v5-stream' as const,tools:[],network:'deny',reasoning:{effort:'low' as const}};
  expect(()=>openRouterRequestBody(body,{context,policy,phase:'report',primaryDialogue:false}))
    .toThrow('RUNTIME_PROVIDER_BINDING_DENIED');
  expect(()=>openRouterRequestBody(body,{context,policy,phase:'report',primaryDialogue:true})).not.toThrow();
});

it('all 14 exact requests pass the real adapter structural preflight without sending',async()=>{
  const transport=vi.fn();
  for(const sample of plan.manifest.samples){
    const adapter=openRouterAdapter({credential:async()=>'SYNTHETIC_ONLY',transport,allowWorkspaceRead:true,
      allowAgentTools:sample.requestFormat==='agent-turn-v5-stream'});
    const body=plan.requests.find(r=>r.id===sample.id)!.body;
    await expect(adapter.prepareDispatch({input:body},identityFor(sample,prices))).resolves.toBeTypeOf('function');
  }
  expect(transport).not.toHaveBeenCalled();
});
it('drafts keep only proven reasoning, declared pending scope and the approved expiry',()=>{
  expect(drafts.status).toBe('DRAFT_NOT_FOR_ACTIVATION');
  for(const profile of drafts.profiles){
    expect(paygHostProfile.safeParse(profile).success).toBe(true);
    expect(profile.expiresAt).toBe('2026-10-13T00:00:00Z');
  }
  const sonnet=drafts.profiles.find(p=>p.model.startsWith('anthropic/'))!;
  expect(sonnet.reasoningVariants.map(v=>v.reasoning)).toEqual([{parameter:'none'}]);
  expect(drafts.profiles.find(p=>p.model.startsWith('openai/'))!.purposes).toEqual(['organizer','attached_organizer']);
});
