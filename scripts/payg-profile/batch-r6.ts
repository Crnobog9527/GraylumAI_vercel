/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {createHash} from 'node:crypto';
import {createR5bPlan} from './batch-r5b';
import {outputPressureCriterion,recordSamples} from './sampling';
import measured from './r5b-evidence.json';
import {decimal} from '../../packages/api/src/services/bill2/decimal';
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
const money=(n:bigint)=>`${n/1000000000000n}.${String(n%1000000000000n).padStart(12,'0')}`;
export const R6_ID='payg-profile-20261006-r6';
export const outputDecision='https://github.com/Crnobog9527/GraylumAI_vercel/pull/665#issuecomment-6000858032';
export function createR6Plan(input:unknown){
 const old=createR5bPlan(input),{manifestHash:priorHash,...prior}=old.manifest;
 const first=prior.samples[0];
 // Re-evaluate only the audited first receipt; the original report and stop remain immutable.
 const evidenceManifest={samples:[first],outputPressureCriterion};
 const [qualified]=recordSamples({...evidenceManifest,manifestHash:hash(JSON.stringify(evidenceManifest))},[measured.receipt]);
 if(priorHash!==measured.manifestHash||qualified.status!=='SAMPLE_WITHIN_BOUNDS')throw new Error('RETAINED_EVIDENCE_MISMATCH');
 const retainedEvidence=[...prior.retainedEvidence,{...measured,status:qualified.status,outputCapReached:true,
  outputPressureCriterion,decision:outputDecision}];
 const samples=prior.samples.slice(1),requests=old.requests.slice(1);
 const previous=[...prior.batch.previous,{manifestHash:priorHash,accountedUsd:'0.002676750000',
  confirmedReceiptUsd:'0.002676750000',ownerConfirmedZero:[],decision:outputDecision}];
 const priorAccountedUsd=money(previous.reduce((n,p)=>n+decimal(p.accountedUsd),0n));
 const totalUsd=money(samples.reduce((n,s)=>n+decimal(s.upperUsd),0n));
 const cumulativeUpperUsd=money(decimal(priorAccountedUsd)+decimal(totalUsd));
 if(decimal(cumulativeUpperUsd)>=decimal('25'))throw new Error('CUMULATIVE_BUDGET_EXCEEDED');
 const totals=Object.fromEntries(Object.keys(prior.totals).map(model=>[model,
  money(samples.filter(s=>s.model===model).reduce((n,s)=>n+decimal(s.upperUsd),0n))]));
 const manifest={...prior,version:7,batch:{id:R6_ID,previous},priorAccountedUsd,cumulativeUpperUsd,
  outputPressureCriterion,outputCapNotReachedAction:'record-and-continue',outputDecision,
  retainedEvidence,retainedEvidenceHash:hash(JSON.stringify(retainedEvidence)),
  outputStressSamples:samples.filter(s=>s.kind==='output').length,calls:samples.length,totals,totalUsd,samples};
 return {manifest:{...manifest,manifestHash:hash(JSON.stringify(manifest))},requests};
}
