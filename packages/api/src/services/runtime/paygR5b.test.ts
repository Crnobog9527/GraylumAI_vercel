/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {beforeAll,expect,it,vi} from 'vitest';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import type {Session} from '@openai/agents';
import {createR5bPlan,lunaScopes} from '../../../../../scripts/payg-profile/batch-r5b';
import {checkPriorAccounting} from '../../../../../scripts/payg-profile/prior-accounting';
import prices from '../../../../../scripts/payg-profile/plan-prices-vertex-2026-10-05.json';
import saved from '../../../../../docs/launch/evidence/payg-profile-20261006-r5b.manifest.json';
import r5 from '../../../../../docs/launch/evidence/payg-profile-20261006-r5.manifest.json';
import {decimal} from '../bill2/decimal';
import {openRouterBound} from '../bill2/openRouterPolicy';
import {openRouterRequestBody} from './providerRequest';
import {runRuntime} from './runner';
import type {ReasoningPolicy} from './reasoningPolicy';
let plan:ReturnType<typeof createR5bPlan>;
beforeAll(()=>{plan=createR5bPlan(prices);});
it('freezes 76 Gemini + 16 Luna route probes + 4 new Sonnet; exactly accounts all four prior batches',()=>{
 expect(plan.manifest).toEqual(saved);expect(saved.calls).toBe(96);
 expect(saved.priorAccountedUsd).toBe('4.989307965000');
 expect(decimal(saved.cumulativeUpperUsd)).toBe(decimal(saved.priorAccountedUsd)+decimal(saved.totalUsd));
 expect(decimal(saved.cumulativeUpperUsd)).toBeLessThan(decimal('25'));
 expect(saved.retainedEvidence).toHaveLength(155);
 expect(saved.batch.previous).toHaveLength(4);
 expect(saved.batch.previous.flatMap(p=>p.ownerConfirmedZero)).toHaveLength(3);
 expect(saved.samples.filter(s=>s.model==='google/gemini-3.8-flash')).toHaveLength(76);
 expect(saved.samples.filter(s=>s.model==='anthropic/claude-sonnet-5.5')).toHaveLength(4);
 expect(saved.samples.filter(s=>s.model==='anthropic/claude-sonnet-5.5').every(s=>s.id.endsWith(':r5b')&&s.O===2048)).toBe(true);
 for(const sample of saved.samples.filter(s=>s.model==='google/gemini-3.8-flash')){
  const old=r5.samples.find(s=>s.requestHash===sample.requestHash)!;expect(old).toBeDefined();
  expect(sample.upperUsd).toBe(old.upperUsd);expect(sample.O).toBe(old.O);
 }
 expect(new Set(saved.samples.map(s=>s.requestHash)).size).toBe(96);
 const retained=new Set(saved.retainedEvidence.map(s=>s.requestHash));
 expect(saved.samples.every(s=>!retained.has(s.requestHash))).toBe(true);
 for(const sample of saved.samples){
  const body=plan.requests.find(r=>r.id===sample.id)!.body;
  expect(createHash('sha256').update(body).digest('hex')).toBe(sample.requestHash);
  expect(Buffer.byteLength(body)).toBe(sample.B);expect(sample.T).toBe(sample.B+8192);
  expect(decimal(sample.upperUsd)).toBeLessThanOrEqual(decimal(sample.approvedCap));
 }
});
it.each(lunaScopes)('route probes match actual SDK normalization for $phase / $format',async scope=>{
 const noNetwork=vi.spyOn(globalThis,'fetch').mockImplementation(()=>{throw new Error('NETWORK_FORBIDDEN');});
 try{
  const samples=plan.manifest.samples.filter(s=>s.kind==='route'&&s.phase===scope.phase&&s.requestFormat===scope.format);
  expect(samples).toHaveLength(4);
  for(const sample of samples){
   const wire=JSON.parse(plan.requests.find(r=>r.id===sample.id)!.body);
   const reasoning=sample.reasoning as ReasoningPolicy;
   const session:Session={getSessionId:async()=>'synthetic',getItems:async()=>{throw new Error('HISTORY_FORBIDDEN');},
    addItems:async()=>{},popItem:async()=>undefined,clearSession:async()=>{}};
   let generated='';
   await runRuntime({model:String(sample.model),instructions:wire.messages[0].content,input:wire.messages[1].content,
    maxOutputTokens:1024,maxTurns:1,tools:[],reasoning,session,readSessionHistory:false,persistSession:false,selectHistory:async(_history,incoming)=>incoming,
    exchange:async(_sequence,request)=>{generated=request;return JSON.stringify({id:'synthetic',object:'chat.completion',created:1,
     model:sample.model,choices:[{index:0,message:{role:'assistant',content:'organized'},finish_reason:'stop'}]});}});
   const r=prices.routes.find(r=>r.model===sample.model)!;
   const providerLimits={providerSlug:r.endpointTag,contextTokens:r.contextTokens,promptUsdPerMillion:r.prompt,
    completionUsdPerMillion:r.completion,requestUsd:r.request};
   const normalized=openRouterRequestBody(generated,{context:{providerRequestFormat:scope.format,tools:[],network:'deny',reasoning,
    ...(scope.phase==='attached_organizer'?{attachedOrganizer:{reasoning}}:{})},
    policy:{modelId:'synthetic',model:r.model,provider:'openrouter',account:'synthetic',protocol:'openrouter-chat-v1',
     providerLimits,upperUsd:openRouterBound(providerLimits,1024).upperUsd,inputLimit:196608,outputLimit:1024,
     automaticRetry:false,hiddenTools:false,lookupSupported:true},phase:scope.phase,primaryDialogue:scope.phase!=='attached_organizer'});
   expect(JSON.parse(normalized)).toEqual(wire);expect(wire.stream).toBe(false);expect(wire.tools).toBeUndefined();
  }
  expect(noNetwork).not.toHaveBeenCalled();
 }finally{noNetwork.mockRestore();}
});
it('audited zero-cost exceptions reconcile exact old reports without rewriting; all other discrepancies stop',async()=>{
 const root=await mkdtemp(join(tmpdir(),'payg-accounting-test-'));
 try{
  const prior=plan.manifest.batch.previous;
  for(const b of prior){
   const dir=join(root,b.manifestHash);await mkdir(dir);await writeFile(join(dir,'attempted.lock'),'keep');
   await writeFile(join(dir,'report.json'),JSON.stringify({manifestHash:b.manifestHash,knownUsd:b.confirmedReceiptUsd,
    actualUsd:b.ownerConfirmedZero.length?null:b.confirmedReceiptUsd,unknownCostSamples:b.ownerConfirmedZero.length,
    report:[{id:'known',actualUsd:b.confirmedReceiptUsd},...b.ownerConfirmedZero.map(z=>({
     id:z.sampleId,requestHash:z.requestHash,status:'UNKNOWN',actualUsd:null}))]}));
  }
  const file=join(root,prior[3].manifestHash,'report.json'),original=await readFile(file,'utf8');
  await expect(checkPriorAccounting(root,prior)).resolves.toBeUndefined();expect(await readFile(file,'utf8')).toBe(original);
  for(const patch of [
   (r:{knownUsd:string;actualUsd:string|null;unknownCostSamples:number;report:Array<{id:string;actualUsd:string|null;requestHash?:string}>})=>{r.report[1].requestHash='0'.repeat(64);},
   (r:{knownUsd:string;actualUsd:string|null;unknownCostSamples:number;report:Array<{id:string;actualUsd:string|null;requestHash?:string}>})=>{r.knownUsd='0';},
   (r:{knownUsd:string;actualUsd:string|null;unknownCostSamples:number;report:Array<{id:string;actualUsd:string|null;requestHash?:string}>})=>{r.report.push({id:'unexpected',actualUsd:null});r.unknownCostSamples++;},
   (r:{knownUsd:string;actualUsd:string|null;unknownCostSamples:number;report:Array<{id:string;actualUsd:string|null;requestHash?:string}>})=>{r.actualUsd='0';},
   (r:{knownUsd:string;actualUsd:string|null;unknownCostSamples:number;report:Array<{id:string;actualUsd:string|null;requestHash?:string}>})=>{r.report[0].actualUsd='1';},
  ]){
   const report=JSON.parse(original);patch(report);await writeFile(file,JSON.stringify(report));
   await expect(checkPriorAccounting(root,prior)).rejects.toThrow('PRIOR_ACCOUNTING_MISMATCH');
  }
 }finally{await rm(root,{recursive:true,force:true});}
});
