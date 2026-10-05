/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {createHash} from 'node:crypto';
import {createR7Plan} from './batch-r7';
import {priceSchema} from './sampling';
import measured from './r7-evidence.json';
import {r8Request,r8Scopes} from './r8-requests';
import {decimal} from '../../packages/api/src/services/bill2/decimal';
import {openRouterCallBound} from '../../packages/api/src/services/bill2/openRouterPolicy';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const money=(n:bigint)=>`${n/1000000000000n}.${String(n%1000000000000n).padStart(12,'0')}`;
export const R8_ID='payg-profile-20261006-r8';
export const r8Decision='https://github.com/Crnobog9527/GraylumAI_vercel/pull/665#issuecomment-6002163766';
export function createR8Plan(input:unknown){
  const prices=priceSchema.parse(input),old=createR7Plan(prices),{manifestHash:priorHash,...prior}=old.manifest;
  if(priorHash!==measured.manifestHash||measured.unknownCostSamples!==0||measured.samples.length!==96
    ||measured.samples.some(s=>!prior.samples.some(p=>p.id===s.id&&p.requestHash===s.requestHash)))
    throw new Error('RETAINED_EVIDENCE_MISMATCH');
  const previous=[...prior.batch.previous,{manifestHash:priorHash,accountedUsd:measured.actualUsd,
    confirmedReceiptUsd:measured.actualUsd,ownerConfirmedZero:[],decision:r8Decision}];
  const priorAccountedUsd=money(previous.reduce((n,p)=>n+decimal(p.accountedUsd),0n));
  if(priorAccountedUsd!=='6.470137565000')throw new Error('PRIOR_ACCOUNTING_MISMATCH');
  const samples:typeof prior.samples=[],requests:typeof old.requests=[];
  const blockers=['REAL_SAMPLING_NOT_AUTHORIZED','PROFILE_EVIDENCE_NOT_COLLECTED'];
  for(const route of prices.routes.filter(r=>!r.model.startsWith('openai/'))){
    const probes=[...(route.model.startsWith('anthropic/')?[0,1].map(variant=>({scope:undefined,variant,B:32768,O:2048})):[]),
      ...r8Scopes.flatMap(scope=>[4096,196608].map(B=>({scope,variant:0,B,O:8192})))];
    for(const {scope,variant,B,O} of probes){
      const {body,providerLimits}=r8Request(route,B,O,scope,variant),parsed=JSON.parse(body);
      const id=`${route.model}:${scope?'route:'+scope.name:'output:low'}:${B}:${variant}:r8`;
      const T=B+8192,upperUsd=openRouterCallBound(providerLimits,O,T).upperUsd;
      const approvedCap=route.perCallCap;
      if(decimal(upperUsd)>decimal(approvedCap))blockers.push(`PER_CALL_BUDGET_EXCEEDED:${id}`);
      const schemaBytes=(parsed.tools??[]).reduce((n:number,t:{function:{parameters:unknown}})=>
        n+Buffer.byteLength(JSON.stringify(t.function.parameters)),0);
      if(Buffer.byteLength(body)!==B||schemaBytes>16384)throw new Error('ROUTE_PROBE_BOUND_INVALID');
      samples.push({id,model:route.model,endpointTag:route.endpointTag,kind:scope?'route':'output',category:'json',
        band:scope?(B===4096?'short':'long'):'output-stress',variant,B,T,O,reasoning:{effort:'low'},phase:scope?.phase??'skill',
        requestFormat:scope?.format??'serial-tools-v6-reasoning',primaryDialogue:true,stream:!!scope,
        approvedCap,spendCapUsd:upperUsd,requestHash:hash(body),messages:parsed.messages.length,
        tools:(parsed.tools??[]).length,schemaBytes,cache:scope?.name==='report'?'disabled':'same-runtime-policy',
        upperUsd,P:null,rB:null,rT:null,status:'NOT_RUN'});
      requests.push({id,body});
    }
  }
  const totalUsd=money(samples.reduce((n,s)=>n+decimal(s.upperUsd),0n));
  const cumulativeUpperUsd=money(decimal(priorAccountedUsd)+decimal(totalUsd));
  if(decimal(cumulativeUpperUsd)>=decimal('25'))throw new Error('CUMULATIVE_BUDGET_EXCEEDED');
  const totals=Object.fromEntries(prices.routes.map(r=>[r.model,
    money(samples.filter(s=>s.model===r.model).reduce((n,s)=>n+decimal(s.upperUsd),0n))]));
  const retainedEvidence=[...prior.retainedEvidence,...measured.samples.filter(s=>s.status==='SAMPLE_WITHIN_BOUNDS')];
  const manifest={...prior,version:9,batch:{id:R8_ID,previous},priorAccountedUsd,cumulativeUpperUsd,
    retainedEvidence,retainedEvidenceHash:hash(JSON.stringify(retainedEvidence)),
    priorResultHash:hash(JSON.stringify(measured)),decision:r8Decision,
    routeEvidenceBase:{staging:'c0efffe28a080c37684d0cc153fd16b34de7441c',scopes:r8Scopes,
      outputBasis:'min(quote.outputLimit, model.max_tokens, PURPOSE_OUTPUT_CAP=8192); conservative O=8192, no database read',
      reportLimitation:'execute.ts report phase differs from skill role; primary low binding needs separate runtime fix'},
    outputStressSamples:2,routeProbeSamples:12,calls:samples.length,totalUsd,totals,blockers,samples};
  return {manifest:{...manifest,manifestHash:hash(JSON.stringify(manifest))},requests};
}
