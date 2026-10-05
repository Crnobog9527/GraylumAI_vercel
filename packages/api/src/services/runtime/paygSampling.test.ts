/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {expect,it,vi} from 'vitest';
import previous from '../../../../../docs/launch/evidence/payg-profile-20261006-r3.manifest.json';
import r4 from '../../../../../docs/launch/evidence/payg-profile-20261006-r4.manifest.json';
import r5 from '../../../../../docs/launch/evidence/payg-profile-20261006-r5.manifest.json';
import prices from '../../../../../scripts/payg-profile/plan-prices.json';
import {createSamplePlan,recordSamples} from '../../../../../scripts/payg-profile/sampling';
import {decimal} from '../bill2/decimal';
it('independent batches preserve completed evidence and untouched requests; reserve both under 25',()=>{
 const fetch=vi.spyOn(globalThis,'fetch').mockImplementation(()=>{throw new Error('NETWORK_FORBIDDEN');});
 try{
  const plans=[createSamplePlan(prices,'r4'),createSamplePlan(prices,'r5')];
  expect(plans.map(p=>p.manifest)).toEqual([r4,r5]);
  expect(plans.map(p=>p.manifest.calls)).toEqual([80,76]);
  const samples=plans.flatMap(p=>p.manifest.samples),requests=plans.flatMap(p=>p.requests);
  expect(new Set(samples.map(s=>s.requestHash)).size).toBe(156);
  expect(plans[0].manifest.samples[0].model).toBe('openai/gpt-6-luna');
  expect(plans[1].manifest.samples.every(s=>s.model==='google/gemini-3.8-flash')).toBe(true);
  for(const {manifest} of plans){
   expect(manifest.retainedEvidence).toHaveLength(79);
   expect(manifest.priorAccountedUsd).toBe('4.810139500000');
   expect(manifest.retainedEvidence.reduce((n,s)=>n+decimal(s.receipt.costUsd),0n)).toBe(decimal(manifest.priorAccountedUsd));
   expect(manifest.cumulativeCapUsd).toBe('25');
   expect(decimal(manifest.cumulativeUpperUsd)).toBe(decimal(manifest.priorAccountedUsd)
    +decimal(plans[0].manifest.totalUsd)+decimal(plans[1].manifest.totalUsd));
   expect(Number(manifest.cumulativeUpperUsd)).toBeLessThan(25);
   expect(manifest.retainedEvidence.filter(s=>s.kind==='output'&&s.outputCapReached)).toHaveLength(1);
   const retained=new Set(manifest.retainedEvidence.map(s=>s.requestHash));
   expect(manifest.samples.every(s=>!retained.has(String(s.requestHash)))).toBe(true);
   expect(manifest.blockers).toEqual(['REAL_SAMPLING_NOT_AUTHORIZED','PROFILE_EVIDENCE_NOT_COLLECTED']);
  }
  for(const sample of samples){
   const body=requests.find(r=>r.id===sample.id)!.body;
   expect(sample.B).toBe(Buffer.byteLength(body));expect(sample.T).toBe(Number(sample.B)+8192);
   expect(Number(sample.upperUsd)).toBeLessThanOrEqual(Number(sample.approvedCap));
   if(sample.kind==='output'){
    expect(sample.O).toBe(sample.model==='anthropic/claude-sonnet-5.5'?2048:512);
    expect(body).toContain('000001 through 010000');
    expect(JSON.parse(body).max_tokens).toBe(sample.O);
   }else expect(sample).toEqual(previous.samples.find(s=>s.id===sample.id));
  }
  for(const route of prices.routes)for(const reasoning of route.reasoning){
   expect(samples.filter(s=>s.kind==='output'&&s.model===route.model&&JSON.stringify(s.reasoning)===JSON.stringify(reasoning)))
    .toHaveLength(2);
  }
  expect(samples.filter(s=>s.model==='anthropic/claude-sonnet-5.5'&&s.kind!=='output')).toHaveLength(0);
  for(const model of ['openai/gpt-6-luna','google/gemini-3.8-flash']){
   expect(samples.filter(s=>s.model===model&&s.kind==='matrix')).toHaveLength(60);
   for(const count of [64,96,128])for(const length of ['short','long']){
    const stress=samples.filter(s=>s.model===model&&s.kind==='messages'&&s.band===`${length}-${count}`);
    expect(stress).toHaveLength(2);expect(stress.every(s=>s.messages===count)).toBe(true);
    const bodies=stress.map(s=>JSON.parse(requests.find(r=>r.id===s.id)!.body));
    expect(bodies[0].messages[0]).toEqual(bodies[1].messages[0]);
    if(length==='long')expect(bodies[0].messages[1].content.length).toBeGreaterThan(1000);
   }
  }
  expect(fetch).not.toHaveBeenCalled();
  const manifest=plans[0].manifest,sample=manifest.samples[0];
  const receipt={sampleId:sample.id,requestHash:sample.requestHash,model:sample.model,endpointTag:sample.endpointTag,
   nativePromptTokens:100,nativeCompletionTokens:512,finishReason:'length',costUsd:'0.001',cachedTokens:25,cacheWriteTokens:0,
   source:'response.prompt_tokens',includesReasoning:true};
  expect(recordSamples(manifest,[receipt])[0]).toMatchObject({P:100,rB:100/Number(sample.B),rT:100/Number(sample.T),status:'SAMPLE_WITHIN_BOUNDS'});
  expect(recordSamples(manifest,[{...receipt,finishReason:'stop'}])[0].status).toBe('OUTPUT_CAP_NOT_REACHED');
  expect(recordSamples(manifest,[{...receipt,nativeCompletionTokens:511}])[0].status).toBe('OUTPUT_CAP_NOT_REACHED');
  expect(recordSamples(manifest,[])[0]).toMatchObject({P:null,status:'MISSING'});
  expect(recordSamples(manifest,[receipt,receipt])[0]).toMatchObject({P:null,status:'CONFLICT'});
  expect(recordSamples(manifest,[{...receipt,endpointTag:'wrong'}])[0]).toMatchObject({P:null,status:'IDENTITY_MISMATCH'});
  expect(recordSamples(manifest,[{...receipt,nativePromptTokens:999999}])[0]).toMatchObject({status:'BOUND_FAILED'});
  expect(recordSamples(manifest,[{...receipt,cachedTokens:90,cacheWriteTokens:20}])[0]).toMatchObject({status:'BOUND_FAILED'});
 }finally{fetch.mockRestore();}
});
