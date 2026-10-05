/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {beforeAll,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import prices from '../../../../../scripts/payg-profile/plan-prices.json';
import historical from '../../../../../scripts/payg-profile/plan-prices-vertex-2026-10-05.json';
import catalog from '../../../../../scripts/payg-profile/catalog-2026-10-06-r7.json';
import frozen from '../../../../../docs/launch/evidence/payg-profile-20261006-r7.manifest.json';
import r6 from '../../../../../docs/launch/evidence/payg-profile-20261006-r6.manifest.json';
import {createR6Plan} from '../../../../../scripts/payg-profile/batch-r6';
import {createR7Plan} from '../../../../../scripts/payg-profile/batch-r7';
import {verifiedPlan,verifyCatalog} from '../../../../../scripts/payg-profile/executor';
let plan:ReturnType<typeof createR7Plan>;
beforeAll(()=>{plan=createR7Plan(prices);},30000);
it('r7 regenerates all 76 AI Studio samples and exactly preserves the other 20 requests and bounds',()=>{
 expect(plan.manifest).toEqual(frozen);expect(plan.manifest.calls).toBe(96);
 const previous=createR6Plan(historical);expect(previous.manifest).toEqual(r6);
 const google=plan.manifest.samples.filter(s=>s.model==='google/gemini-3.8-flash');
 expect(google).toHaveLength(76);
 expect(google.filter(s=>s.kind==='matrix')).toHaveLength(60);
 expect(google.filter(s=>s.kind==='messages')).toHaveLength(12);
 const output=google.filter(s=>s.kind==='output');expect(output).toHaveLength(4);
 expect(output.map(s=>s.O)).toEqual([512,512,512,512]);
 expect(output.map(s=>s.reasoning)).toEqual([{parameter:'none'},{parameter:'none'},{effort:'low'},{effort:'low'}]);
 expect(new Set(google.filter(s=>s.kind==='messages').map(s=>s.messages))).toEqual(new Set([64,96,128]));
 for(const s of plan.manifest.samples){
  const request=plan.requests.find(r=>r.id===s.id)!;
  expect(createHash('sha256').update(request.body).digest('hex')).toBe(s.requestHash);
  if(s.model==='google/gemini-3.8-flash'){
   const body=JSON.parse(request.body);expect(s.endpointTag).toBe('google-ai-studio');
   expect(body.provider.only).toEqual(['google-ai-studio']);expect(body.provider.allow_fallbacks).toBe(false);
   expect(body.service_tier).toBeUndefined();expect(body.provider.require_parameters).toBe(true);
   expect(body.reasoning).toBeUndefined();
   expect(body.reasoning_effort).toBe('effort' in (s.reasoning as object)?'low':undefined);
   expect(previous.manifest.samples.some(old=>old.requestHash===s.requestHash)).toBe(false);
  }else{
   expect(s).toEqual(previous.manifest.samples.find(old=>old.id===s.id));
   expect(request).toEqual(previous.requests.find(old=>old.id===s.id));
  }
 }
 expect(plan.manifest.retainedEvidence).toHaveLength(155);
 expect(plan.manifest.retainedEvidence.some(s=>s.model==='google/gemini-3.8-flash')).toBe(false);
 expect(plan.manifest.excludedRouteEvidence).toHaveLength(1);
 expect(plan.manifest.priorAccountedUsd).toBe('4.991984715000');
 expect(plan.manifest.totalUsd).toBe('5.396385750000');
 expect(plan.manifest.cumulativeUpperUsd).toBe('10.388370465000');
 expect(plan.manifest.batch.previous).toEqual(r6.batch.previous);
 expect(plan.manifest.supersedes).toContain(r6.manifestHash);
 expect(()=>verifiedPlan(prices,r6,r6.manifestHash)).toThrow('APPROVED_MANIFEST_MISMATCH');
},30000);
it('catalog binds exact live snapshot, tolerates opt-in tiers but refuses new base variants and unavailable routes',async()=>{
 const endpoint=catalog.routes.find(r=>r.model==='google/gemini-3.8-flash')!.endpoint;
 const model='google/gemini-3.8-flash';
 const transport=vi.fn(async()=>new Response(JSON.stringify({data:{id:model,endpoints:[endpoint,
  {...endpoint,tag:'google-ai-studio/flex'},{...endpoint,tag:'google-ai-studio/priority'}]}})));
 await expect(verifyCatalog(prices,catalog,model,transport)).resolves.toBeUndefined();
 transport.mockResolvedValue(new Response(JSON.stringify({data:{id:model,endpoints:[endpoint,{...endpoint,tag:'google-ai-studio/region'}]}})));
 await expect(verifyCatalog(prices,catalog,model,transport)).rejects.toThrow('CATALOG_AMBIGUOUS_BASE_SLUG');
 transport.mockResolvedValue(new Response(JSON.stringify({data:{id:model,endpoints:[{...endpoint,status:-2}]}})));
 await expect(verifyCatalog(prices,catalog,model,transport)).rejects.toThrow('CATALOG_ROUTE_UNAVAILABLE');
 transport.mockResolvedValue(new Response(JSON.stringify({data:{id:model,endpoints:[{...endpoint,tag:'google-ai-studio/flex'}]}})));
 await expect(verifyCatalog(prices,catalog,model,transport)).rejects.toThrow('CATALOG_ROUTE_MISMATCH');
});
it('no price or route changes are permitted for carried Luna/Sonnet calls',()=>{
 const changed=structuredClone(prices);changed.routes[0].prompt='3';
 expect(()=>createR7Plan(changed)).toThrow('UNCHANGED_ROUTE_REQUIRED');
},30000);
