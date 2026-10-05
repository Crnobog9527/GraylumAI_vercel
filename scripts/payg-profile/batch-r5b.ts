/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {createHash} from 'node:crypto';
import {createSamplePlan,priceSchema,requestFor} from './sampling';
import measured from './r4-evidence.json';
import {decimal} from '../../packages/api/src/services/bill2/decimal';
import {openRouterCallBound} from '../../packages/api/src/services/bill2/openRouterPolicy';
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
const money=(n:bigint)=>`${n/1000000000000n}.${String(n%1000000000000n).padStart(12,'0')}`;
export const R5B_ID='payg-profile-20261006-r5b';
export const retiredR5='72a8bc28bbd64a8c1139afafbdec71d8631ac1ceabfec35dbeca7e6dca51c97a';
export const lunaScopes=[
 {phase:'organizer',format:'serial-tools-v6-reasoning'},
 {phase:'attached_organizer',format:'serial-tools-v6-reasoning'},
 {phase:'attached_organizer',format:'serial-tools-v4-stream'},
 {phase:'attached_organizer',format:'agent-turn-v5-stream'},
] as const;
// Exact audited exceptions; no caller-supplied override and no mutation of private UNKNOWN receipts.
const ownerZero=[
 {batch:'4289cffc98ac5fda57b46e93e8a7e3d083b30ab71223428a961d118593bad9c5',
  sampleId:'anthropic/claude-sonnet-5.5:output:chinese:output-stress:0',
  requestHash:'4fca58735d80be64aaa9be0e035fb64b7046eced401ec4314a3c218e6a32a42b'},
 {batch:'596c57a3839de657e46058d16d8a558af2c84d3ea4b79b74e80a9b96e4a10ef7',
  sampleId:'anthropic/claude-sonnet-5.5:matrix:json:large:0',
  requestHash:'b49c9d69841bac7c405b6eb1636a4c1cb580ad33a74ecc7316e9362e7b86ff1f'},
 {batch:'04e92dfa3a33a49090c853da83cf088b5d83555ac447b92760a5b3461725f1db',
  sampleId:'anthropic/claude-sonnet-5.5:output:chinese:output-stress:0:r4',
  requestHash:'5c83223a957cdb02b6883096ab6883d45c04bbda8590e9535265f7d452ae186a'},
];
export function createR5bPlan(input:unknown){
 const r4=createSamplePlan(input,'r4'),r5=createSamplePlan(input,'r5'),prices=priceSchema.parse(input);
 const priorAccounting=[...r4.manifest.batch.previous,{
  manifestHash:r4.manifest.manifestHash,accountedUsd:'0.179168465000',
  decision:'https://github.com/Crnobog9527/GraylumAI_vercel/pull/665#issuecomment-6000132517',
 }].map(p=>({...p,confirmedReceiptUsd:p.accountedUsd,
  ownerConfirmedZero:ownerZero.filter(x=>x.batch===p.manifestHash).map(({sampleId,requestHash})=>({
   sampleId,requestHash,receiptStatus:'UNKNOWN',accountedUsd:'0.000000000000',decision:p.decision}))}));
 const priorAccountedUsd=money(priorAccounting.reduce((n,p)=>n+decimal(p.accountedUsd),0n));
 const samples:typeof r4.manifest.samples=[],requests:typeof r4.requests=[];
 const copy=(plan:typeof r4,sample:typeof samples[number])=>{
  const id=sample.kind==='output'?sample.id.replace(/:r[45]$/,':r5b'):sample.id;
  const body=plan.requests.find(r=>r.id===sample.id)!.body;
  samples.push({...sample,id,phase:'skill',requestFormat:'serial-tools-v6-reasoning'});requests.push({id,body});
 };
 for(const sample of r5.manifest.samples)copy(r5,sample);
 const luna=prices.routes.find(r=>r.model==='openai/gpt-6-luna')!;
 for(const scope of lunaScopes)for(const [variant,reasoning] of luna.reasoning.entries())for(const B of [4096,196608]){
  const O=1024,id=`${luna.model}:route:${scope.phase}:${scope.format}:${variant}:${B}:r5b`;
  const {body,providerLimits}=requestFor(luna,'json',B,variant,O,reasoning,undefined,true,false,scope);
  const parsed=JSON.parse(body),T=B+8192,upperUsd=openRouterCallBound(providerLimits,O,T).upperUsd;
  if(Buffer.byteLength(body)!==B||decimal(upperUsd)>decimal(luna.perCallCap))throw new Error('ROUTE_PROBE_BOUND_INVALID');
  samples.push({id,model:luna.model,endpointTag:luna.endpointTag,kind:'route',category:'json',band:B===4096?'short':'long',variant,
   B,T,O,reasoning,phase:scope.phase,requestFormat:scope.format,primaryDialogue:scope.phase!=='attached_organizer',
   approvedCap:luna.perCallCap,spendCapUsd:upperUsd,requestHash:hash(body),messages:parsed.messages.length,tools:0,schemaBytes:0,
   cache:'repeated-system-prefix',upperUsd,P:null,rB:null,rT:null,status:'NOT_RUN'});
  requests.push({id,body});
 }
 for(const sample of r4.manifest.samples.filter(s=>s.model==='anthropic/claude-sonnet-5.5'))copy(r4,sample);
 const retainedEvidence=[...r4.manifest.retainedEvidence,...measured];
 const totals=Object.fromEntries(prices.routes.map(r=>[r.model,money(samples.filter(s=>s.model===r.model)
  .reduce((n,s)=>n+decimal(s.upperUsd),0n))]));
 const totalUsd=money(samples.reduce((n,s)=>n+decimal(s.upperUsd),0n));
 const cumulativeUpperUsd=money(decimal(priorAccountedUsd)+decimal(totalUsd));
 if(decimal(cumulativeUpperUsd)>=decimal('25'))throw new Error('CUMULATIVE_BUDGET_EXCEEDED');
 const manifest={version:6,batch:{id:R5B_ID,previous:priorAccounting},supersedes:[retiredR5],priorAccountedUsd,
  cumulativeCapUsd:'25',cumulativeUpperUsd,retainedEvidence,retainedEvidenceHash:hash(JSON.stringify(retainedEvidence)),
  pricesHash:r4.manifest.pricesHash,maxMessages:128,priceSource:r4.manifest.priceSource,currentPricesVerified:prices.currentVerified,
  distinctMatrixSamples:60,messageStressSamples:12,outputStressSamples:8,routeProbeSamples:16,calls:samples.length,totals,totalUsd,
  routeEvidenceBase:{staging:'430f9aba7f777e129502af85150d1bd93f8fd03c',priorManifestHash:r4.manifest.manifestHash,scopes:lunaScopes},
  actualCalls:0,actualUsd:'0',blockers:r4.manifest.blockers,samples};
 return {manifest:{...manifest,manifestHash:hash(JSON.stringify(manifest))},requests};
}
