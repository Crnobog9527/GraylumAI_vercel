/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {createR6Plan} from './batch-r6';
import {createSamplePlan,priceSchema} from './sampling';
import historicalPrices from './plan-prices-vertex-2026-10-05.json';
import {decimal} from '../../packages/api/src/services/bill2/decimal';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const money=(n:bigint)=>`${n/1000000000000n}.${String(n%1000000000000n).padStart(12,'0')}`;
export const R7_ID='payg-profile-20261006-r7';
export function createR7Plan(input:unknown){
 const prices=priceSchema.parse(input),old=createR6Plan(historicalPrices);
 for(const route of prices.routes.filter(r=>!r.model.startsWith('google/')))
  if(!isDeepStrictEqual(route,historicalPrices.routes.find(r=>r.model===route.model)))throw new Error('UNCHANGED_ROUTE_REQUIRED');
 const google=prices.routes.find(r=>r.model==='google/gemini-3.8-flash');
 if(google?.endpointTag!=='google-ai-studio'||google.providerName!=='Google AI Studio')throw new Error('AI_STUDIO_ROUTE_REQUIRED');
 const gemini=createSamplePlan(prices,'r5');
 const samples:typeof old.manifest.samples=gemini.manifest.samples.map(s=>({...s,id:s.id+':r7',phase:'skill',requestFormat:'serial-tools-v6-reasoning'}));
 const requests=gemini.requests.map(r=>({...r,id:r.id+':r7'}));
 for(const sample of old.manifest.samples.filter(s=>s.model!=='google/gemini-3.8-flash')){
  samples.push(sample);requests.push(old.requests.find(r=>r.id===sample.id)!);
 }
 const {manifestHash:oldHash,...prior}=old.manifest;
 const retainedEvidence=prior.retainedEvidence.filter(s=>s.model!=='google/gemini-3.8-flash');
 const excludedRouteEvidence=prior.retainedEvidence.filter(s=>s.model==='google/gemini-3.8-flash');
 const totalUsd=money(samples.reduce((n,s)=>n+decimal(s.upperUsd),0n));
 const cumulativeUpperUsd=money(decimal(prior.priorAccountedUsd)+decimal(totalUsd));
 if(decimal(cumulativeUpperUsd)>=decimal('25'))throw new Error('CUMULATIVE_BUDGET_EXCEEDED');
 const totals=Object.fromEntries(prices.routes.map(r=>[r.model,
  money(samples.filter(s=>s.model===r.model).reduce((n,s)=>n+decimal(s.upperUsd),0n))]));
 const manifest={...prior,version:8,batch:{id:R7_ID,previous:prior.batch.previous},supersedes:[...prior.supersedes,oldHash],
  routeDecision:'https://github.com/Crnobog9527/GraylumAI_vercel/pull/665#issuecomment-6001418763',
  retainedEvidence,retainedEvidenceHash:hash(JSON.stringify(retainedEvidence)),excludedRouteEvidence,
  pricesHash:hash(JSON.stringify(prices)),priceSource:prices.source,currentPricesVerified:prices.currentVerified,
  outputStressSamples:8,calls:samples.length,totalUsd,cumulativeUpperUsd,totals,blockers:gemini.manifest.blockers,samples};
 return {manifest:{...manifest,manifestHash:hash(JSON.stringify(manifest))},requests};
}
