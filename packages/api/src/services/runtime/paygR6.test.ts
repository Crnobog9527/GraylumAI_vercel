/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {beforeAll,expect,it} from 'vitest';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {checkPriorAccounting} from '../../../../../scripts/payg-profile/prior-accounting';
import prices from '../../../../../scripts/payg-profile/plan-prices-vertex-2026-10-05.json';
import frozen from '../../../../../docs/launch/evidence/payg-profile-20261006-r6.manifest.json';
import prior from '../../../../../docs/launch/evidence/payg-profile-20261006-r5b.manifest.json';
import measured from '../../../../../scripts/payg-profile/r5b-evidence.json';
import {createR6Plan} from '../../../../../scripts/payg-profile/batch-r6';
import {createR5bPlan} from '../../../../../scripts/payg-profile/batch-r5b';
import {outputPressurePassed,outputPressureCriterion,recordSamples} from '../../../../../scripts/payg-profile/sampling';
import {verifiedPlan} from '../../../../../scripts/payg-profile/executor';
let plan:ReturnType<typeof createR6Plan>;
beforeAll(()=>{plan=createR6Plan(prices);},30000);
it('r6 exactly retains the remaining bodies, hashes, IDs, prices and per-call bounds',()=>{
 const old=createR5bPlan(prices);
 expect(old.manifest).toEqual(prior);expect(plan.manifest).toEqual(frozen);
 expect(plan.manifest.samples).toEqual(prior.samples.slice(1));
 expect(plan.requests).toEqual(old.requests.slice(1));expect(plan.requests).toHaveLength(95);
 expect(plan.requests.some(r=>r.id===measured.id)).toBe(false);
 expect(plan.manifest.totalUsd).toBe('5.385264750000');
 expect(plan.manifest.priorAccountedUsd).toBe('4.991984715000');
 expect(plan.manifest.cumulativeUpperUsd).toBe('10.377249465000');
 expect(plan.manifest.batch.previous).toHaveLength(5);
 expect(plan.manifest.retainedEvidence).toHaveLength(156);
 expect(plan.manifest.retainedEvidence.at(-1)).toMatchObject({originalStatus:'OUTPUT_CAP_NOT_REACHED',
  status:'SAMPLE_WITHIN_BOUNDS',testedOutputLimit:512,receipt:{nativeCompletionTokens:508,includesReasoning:true}});
},30000);
it('historical receipt keeps its original verdict; the reviewed criterion alone changes classification',()=>{
 expect(recordSamples(prior,[measured.receipt])[0].status).toBe('OUTPUT_CAP_NOT_REACHED');
 const manifest={samples:[prior.samples[0]],outputPressureCriterion};
 const manifestHash=createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
 expect(recordSamples({...manifest,manifestHash},[measured.receipt])[0].status).toBe('SAMPLE_WITHIN_BOUNDS');
});
it.each([
 [899,1000,false],[900,1000,true],[1000,1000,true],[1001,1000,false],
 [460,512,false],[461,512,true],[508,512,true],[512,512,true],[513,512,false],
])('output threshold: completion %s / O %s => %s', (completion,O,pass)=>{
 expect(outputPressurePassed('length',completion,O,outputPressureCriterion)).toBe(pass);
 expect(outputPressurePassed('stop',completion,O,outputPressureCriterion)).toBe(false);
});
it('criterion/action tampering and the already attempted r5b are rejected before dispatch',()=>{
 expect(()=>verifiedPlan(prices,prior,prior.manifestHash)).toThrow('APPROVED_MANIFEST_MISMATCH');
 for(const key of ['outputPressureCriterion','outputCapNotReachedAction']){
  const changed={...plan.manifest,[key]:'relaxed'};
  expect(()=>verifiedPlan(prices,changed,plan.manifest.manifestHash)).toThrow('APPROVED_MANIFEST_MISMATCH');
 }
},30000);

it('known-cost historical non-qualifying verdict reconciles without rewriting the lock or report',async()=>{
 const root=await mkdtemp(join(tmpdir(),'payg-r6-accounting-'));
 try{
  const batch=plan.manifest.batch.previous.at(-1)!;
  const dir=join(root,batch.manifestHash);await mkdir(dir);
  const report={manifestHash:batch.manifestHash,knownUsd:batch.confirmedReceiptUsd,actualUsd:batch.confirmedReceiptUsd,
   unknownCostSamples:0,report:[{id:measured.id,requestHash:measured.requestHash,
    status:'OUTPUT_CAP_NOT_REACHED',actualUsd:batch.confirmedReceiptUsd}]};
  const text=JSON.stringify(report);await writeFile(join(dir,'report.json'),text);await writeFile(join(dir,'attempted.lock'),'keep');
  await expect(checkPriorAccounting(root,plan.manifest.batch.previous)).resolves.toBeUndefined();
  expect(await readFile(join(dir,'report.json'),'utf8')).toBe(text);
  expect(await readFile(join(dir,'attempted.lock'),'utf8')).toBe('keep');
  await writeFile(join(dir,'report.json'),JSON.stringify({...report,actualUsd:'0'}));
  await expect(checkPriorAccounting(root,plan.manifest.batch.previous)).rejects.toThrow('PRIOR_ACCOUNTING_MISMATCH');
 }finally{await rm(root,{recursive:true,force:true});}
});
