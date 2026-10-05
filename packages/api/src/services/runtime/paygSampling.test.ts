/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {expect,it,vi} from 'vitest';
import prices from '../../../../../scripts/payg-profile/plan-prices.json';
import {createSamplePlan,recordSamples} from '../../../../../scripts/payg-profile/sampling';
it('offline matrix uses final cache-marked bytes, exact boundaries and conservative per-sample costs',()=>{
 const fetch=vi.spyOn(globalThis,'fetch').mockImplementation(()=>{throw new Error('NETWORK_FORBIDDEN');});
 try{
  const {manifest,requests}=createSamplePlan(prices);
  expect(fetch).not.toHaveBeenCalled();expect(manifest.calls).toBe(190);expect(manifest.actualCalls).toBe(0);
  expect(new Set(manifest.samples.map(s=>s.requestHash)).size).toBe(190);
  expect(manifest.totalUsd).toBe('18.092746375000');
  expect(manifest.blockers.filter(s=>s.startsWith('PER_CALL_BUDGET_EXCEEDED'))).toHaveLength(10);
  for(const sample of manifest.samples){
   const body=requests.find(r=>r.id===sample.id)!.body;
   expect(sample.B).toBe(Buffer.byteLength(body));expect(sample.T).toBe(Number(sample.B)+8192);
   if(sample.variant===3&&sample.kind==='matrix')expect(sample.B).toBe({small:4096,medium:32768,large:196608}[String(sample.band)]);
   if(sample.category==='tools'&&sample.band!=='small'){
    expect(sample.messages).toBe(32);expect(sample.schemaBytes).toBe(16384);
   }
   if(String(sample.model).startsWith('anthropic/'))expect(body).toContain('cache_control');
  }
  const sample=manifest.samples[0];
  const receipt={sampleId:sample.id,requestHash:sample.requestHash,model:sample.model,endpointTag:sample.endpointTag,
   nativePromptTokens:100,nativeCompletionTokens:10,costUsd:'0.001',cachedTokens:25,cacheWriteTokens:0,
   source:'response.prompt_tokens',includesReasoning:true};
  expect(recordSamples(manifest,[receipt])[0]).toMatchObject({P:100,rB:100/Number(sample.B),rT:100/Number(sample.T),status:'SAMPLE_WITHIN_BOUNDS'});
  expect(recordSamples(manifest,[])[0]).toMatchObject({P:null,status:'MISSING'});
  expect(recordSamples(manifest,[receipt,receipt])[0]).toMatchObject({P:null,status:'CONFLICT'});
  expect(recordSamples(manifest,[{...receipt,endpointTag:'wrong'}])[0]).toMatchObject({P:null,status:'IDENTITY_MISMATCH'});
  expect(recordSamples(manifest,[{...receipt,nativePromptTokens:999999}])[0]).toMatchObject({status:'BOUND_FAILED'});
 }finally{fetch.mockRestore();}
});
