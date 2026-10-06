/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {createHash} from 'node:crypto';
import {createR8Plan} from './batch-r8';
import {decimal} from '../../packages/api/src/services/bill2/decimal';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const money=(n:bigint)=>`${n/1000000000000n}.${String(n%1000000000000n).padStart(12,'0')}`;
export const R9_ID='payg-profile-20261006-r9';
export const r9Decision='https://github.com/Crnobog9527/GraylumAI_vercel/pull/665#issuecomment-6010007610';
export function createR9Plan(input:unknown){
  const old=createR8Plan(input),{manifestHash:priorHash,...prior}=old.manifest;
  const previous=[...prior.batch.previous,{manifestHash:priorHash,accountedUsd:'0.067424500000',
    confirmedReceiptUsd:'0.067424500000',ownerConfirmedZero:[],decision:r9Decision}];
  const priorAccountedUsd=money(previous.reduce((n,p)=>n+decimal(p.accountedUsd),0n));
  if(priorAccountedUsd!=='6.537562065000')throw new Error('PRIOR_ACCOUNTING_MISMATCH');
  const samples:typeof prior.samples=prior.samples.filter(s=>s.kind==='route').map(s=>({...s,id:s.id.replace(/:r8$/,':r9')}));
  const requests=old.requests.filter(r=>samples.some(s=>s.id===r.id.replace(/:r8$/,':r9')))
    .map(r=>({...r,id:r.id.replace(/:r8$/,':r9')}));
  const totalUsd=money(samples.reduce((n,s)=>n+decimal(s.upperUsd),0n));
  const cumulativeUpperUsd=money(decimal(priorAccountedUsd)+decimal(totalUsd));
  if(decimal(cumulativeUpperUsd)>=decimal('25'))throw new Error('CUMULATIVE_BUDGET_EXCEEDED');
  const totals=Object.fromEntries(Object.keys(prior.totals).map(model=>[model,
    money(samples.filter(s=>s.model===model).reduce((n,s)=>n+decimal(s.upperUsd),0n))]));
  const manifest={...prior,version:10,batch:{id:R9_ID,previous},priorAccountedUsd,cumulativeUpperUsd,decision:r9Decision,
    priorFailedEvidence:{manifestHash:priorHash,reportHash:'88c73c77ad48917ffa20ad75e998880306d7c97bd0a42396974281769c2192a6',
      qualifiedSamples:0,knownCostUnknownSample:prior.samples[2].id,knownCostUsd:'0.007600500000',status:'UNKNOWN'},
    outputSemanticsDecision:{model:'anthropic/claude-sonnet-5.5',endpointTag:'anthropic',reasoning:{effort:'low'},
      outputSemanticsEvidence:'same-route-none',testedOutputLimit:2048,decision:r9Decision},
    outputStressSamples:0,routeProbeSamples:12,calls:samples.length,totalUsd,totals,samples};
  return {manifest:{...manifest,manifestHash:hash(JSON.stringify(manifest))},requests};
}
