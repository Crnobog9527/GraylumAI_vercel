/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {priceSchema,recordSamples,outputPressurePassed} from './sampling';
import {createR6Plan,R6_ID} from './batch-r6';
import {openRouterAdapter} from '../../packages/api/src/services/bill2/openRouterAdapter';
import {decimal} from '../../packages/api/src/services/bill2/decimal';
import type {CallIdentity,TransportObservation} from '../../packages/api/src/services/bill2/fixtureAdapter';
import type {OpenRouterIdentity} from '../../packages/api/src/services/bill2/openRouterEvidence';
import type {OpenRouterLimits} from '../../packages/api/src/services/bill2/openRouterPolicy';
import {decodeOpenRouterStreamObservation} from '../../packages/api/src/services/bill2/openRouterEvidence';

export type Plan=ReturnType<typeof createR6Plan>;
export type Sample=Plan['manifest']['samples'][number];
export type Event=Record<string,unknown>;
export type Journal={append:(event:Event)=>Promise<void>;events:Event[];
 saveObservation:(sampleId:string,source:string,observation:TransportObservation)=>Promise<void>};
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const integer=(value:unknown):number|null=>typeof value==='string'&&/^\d+$/.test(value)
 &&Number.isSafeInteger(Number(value))?Number(value):null;

export function verifiedPlan(prices:unknown,manifest:unknown,approvedHash:string){
 const id=(manifest as {batch?:{id?:string}}|null)?.batch?.id;
 if(id!==R6_ID)throw new Error('APPROVED_MANIFEST_MISMATCH');
 const plan=createR6Plan(prices);
 if(!isDeepStrictEqual(plan.manifest,manifest)||approvedHash!==plan.manifest.manifestHash)
  throw new Error('APPROVED_MANIFEST_MISMATCH');
 if(!plan.manifest.currentPricesVerified||decimal(plan.manifest.cumulativeUpperUsd)>=decimal('25')
  ||plan.manifest.blockers.some(b=>!['REAL_SAMPLING_NOT_AUTHORIZED','PROFILE_EVIDENCE_NOT_COLLECTED'].includes(b)))
  throw new Error('PLAN_NOT_EXECUTABLE');
 if(new Set(plan.requests.map(r=>r.id)).size!==plan.requests.length)throw new Error('DUPLICATE_SAMPLE');
 return plan;
}

// Only exact, known codes may reach public output; never emit upstream error text.
const failureCodes=new Set([
 'SIBLING_BATCH_UNSETTLED','SIBLING_BATCH_BUDGET_EXCEEDED','PRIOR_ACCOUNTING_MISMATCH','SUPERSEDED_BATCH_ATTEMPTED',
 'PROXY_REQUIRED','PROXY_INVALID','PROXY_BYPASS_NOT_ALLOWED','PROXY_COUNTRY_CHECK_FAILED','PROXY_COUNTRY_NOT_ALLOWED',
 'EXECUTION_AUTHORIZATION_REQUIRED','APPROVED_TEST_CREDENTIAL_MISSING','APPROVED_MANIFEST_MISMATCH',
 'PLAN_NOT_EXECUTABLE','DUPLICATE_SAMPLE','BATCH_ALREADY_ATTEMPTED_NO_AUTOMATIC_RESUME',
 'CATALOG_HASH_MISMATCH','CATALOG_BINDING_MISSING','CATALOG_PRICE_INVALID','PLAN_PRICE_CATALOG_MISMATCH',
 'PLAN_CAPABILITY_CATALOG_MISMATCH','REACHABLE_PRICE_TIER_REPLAN_REQUIRED','CATALOG_UNAVAILABLE',
 'CATALOG_INVALID_RESPONSE','CATALOG_ROUTE_MISMATCH','CATALOG_AMBIGUOUS_BASE_SLUG',
 'CATALOG_DRIFT_REPLAN_REQUIRED','CATALOG_ROUTE_UNAVAILABLE',
]);
export function failureCode(error:unknown){
 return error instanceof Error&&failureCodes.has(error.message)?error.message:'PAYG_EXECUTOR_STOPPED';
}

/** Read-only catalog check immediately before each send; no credential, model or balance call. */
export async function verifyCatalog(prices:unknown,catalog:unknown,model:string,transport:typeof fetch=fetch){
 const parsed=priceSchema.parse(prices);
 if(hash(JSON.stringify(catalog))!==parsed.catalogHash)throw new Error('CATALOG_HASH_MISMATCH');
 const route=parsed.routes.find(r=>r.model===model);
 const saved=(catalog as {routes?:Array<{model:string;endpoint:Record<string,unknown>}>}).routes?.find(r=>r.model===model);
 if(!route||!saved||route.catalogUrl!==`https://openrouter.ai/api/v1/models/${model}/endpoints`)
  throw new Error('CATALOG_BINDING_MISSING');
 const pricing=saved.endpoint.pricing as Record<string,unknown>;
 const scaled=(value:unknown,multiplier:bigint)=>{
  if(typeof value!=='string'||!/^\d+(\.\d+)?$/.test(value))throw new Error('CATALOG_PRICE_INVALID');
  const [whole,fraction='']=value.split('.'),divisor=10n**BigInt(fraction.length);
  return (BigInt(whole+fraction)*multiplier*1000000000000n+divisor-1n)/divisor;
 };
 for(const [field,key] of [['prompt','prompt'],['completion','completion'],['write','input_cache_write'],['read','input_cache_read']] as const)
  if(decimal(route[field])!==scaled(pricing[key],1000000n))throw new Error('PLAN_PRICE_CATALOG_MISMATCH');
 if(decimal(route.request)!==scaled(pricing.request??'0',1n)||route.contextTokens!==saved.endpoint.context_length
  ||route.maxCompletionTokens!==saved.endpoint.max_completion_tokens||route.providerName!==saved.endpoint.provider_name
  ||!isDeepStrictEqual(route.supportedParameters,saved.endpoint.supported_parameters))throw new Error('PLAN_CAPABILITY_CATALOG_MISMATCH');
 const overrides=pricing.overrides as Array<{min_prompt_tokens?:number}>|undefined;
 if(overrides?.some(t=>t.min_prompt_tokens===undefined||t.min_prompt_tokens<=204800))throw new Error('REACHABLE_PRICE_TIER_REPLAN_REQUIRED');

 let response:Response;
 try{response=await transport(route.catalogUrl,{redirect:'error',signal:AbortSignal.timeout(30000)});}
 catch{throw new Error('CATALOG_UNAVAILABLE');}
 if(!response.ok)throw new Error('CATALOG_UNAVAILABLE');
 let data:{data?:{id?:string;endpoints?:Array<Record<string,unknown>>}};
 try{data=await response.json();}
 catch{throw new Error('CATALOG_INVALID_RESPONSE');}
 if(!data||!Array.isArray(data.data?.endpoints))throw new Error('CATALOG_INVALID_RESPONSE');
 const matches=data.data?.endpoints?.filter(e=>e.tag===route.endpointTag)??[];
 if(data.data?.id!==model||matches.length!==1)throw new Error('CATALOG_ROUTE_MISMATCH');
 // A base slug can match new regional variants. Tier endpoints require opt-in and are excluded.
 if(!route.endpointTag.includes('/')&&data.data.endpoints?.some(e=>typeof e.tag==='string'
  &&e.tag.startsWith(route.endpointTag+'/')&&!/\/(fast|flex|priority)$/.test(e.tag)))
  throw new Error('CATALOG_AMBIGUOUS_BASE_SLUG');
 for(const key of ['pricing','context_length','max_completion_tokens','max_prompt_tokens','supported_parameters','tag','provider_name'])
  if(!isDeepStrictEqual(matches[0][key],saved.endpoint[key]))throw new Error('CATALOG_DRIFT_REPLAN_REQUIRED');
 if(matches[0].status!==0)throw new Error('CATALOG_ROUTE_UNAVAILABLE');
}

function identityFor(sample:Sample,prices:unknown):CallIdentity & OpenRouterIdentity {
 const route=priceSchema.parse(prices).routes.find(r=>r.model===sample.model)!;
 const limits:OpenRouterLimits={providerSlug:route.endpointTag,contextTokens:route.contextTokens,
  promptUsdPerMillion:route.prompt,completionUsdPerMillion:route.completion,requestUsd:route.request,
  ...(route.write?{cacheWriteUsdPerMillion:route.write}:{})};
 const pricingHash=hash(JSON.stringify(route));
 return {provider:'openrouter',account:'owner-approved-test-balance',model:route.model,protocol:'openrouter-chat-v1',
  providerLimits:limits,outputLimit:Number(sample.O),upperUsd:String(sample.upperUsd),payg:{
   policyId:'sampling-only',policyVersion:'sampling-only',profileVersion:'NOT_ADMITTED',evidenceVersion:'NOT_COLLECTED',
   pricingHash,endpointTag:route.endpointTag,templateTokens:4096,marginTokens:4096,
   nominalPricing:{version:'nominal-v1',pricingHash,endpointTag:route.endpointTag,
    tiers:[{minPromptTokens:0,prompt:route.prompt,completion:route.completion,request:route.request}],timeOfDay:[]},
   bytes:Number(sample.B),promptTokensUpper:Number(sample.T),messages:Number(sample.messages),
   tools:Number(sample.tools),schemaBytes:Number(sample.schemaBytes)}};
}

/** Reuse production timeout, redirect, exact-money, identity and terminal-receipt handling.
 * Never persist SDK text, credentials, headers or raw error messages to the public report. */
function observationEvent(adapter:ReturnType<typeof openRouterAdapter>,observation:TransportObservation,
 identity:CallIdentity & OpenRouterIdentity,source:'response'|'lookup',sample:Sample,expectedId?:string){
 const evidence=adapter.evidence(observation,identity,source,expectedId);
 const usage=evidence.usage;
 let providerName:unknown=null,finishReason:unknown=null,regionBlocked=false,contentRefused=false;
 try{
  const raw=observation.rawBodyEncoding?decodeOpenRouterStreamObservation(observation).toString('utf8'):observation.rawBody;
  const value=JSON.parse(raw);providerName=source==='lookup'?value.data?.provider_name:value.provider;
  finishReason=source==='lookup'?value.data?.finish_reason:value.choices?.[0]?.finish_reason;
  const nativeFinish=source==='lookup'?value.data?.native_finish_reason:value.choices?.[0]?.native_finish_reason;
  contentRefused=finishReason==='content_filter'||nativeFinish==='refusal';
  regionBlocked=observation.httpStatus===403&&value.error?.code===403
   &&value.error?.metadata?.failed_routing_step==='Gate Endpoints with Geo Restrictions';
 }catch{/* Unknown metadata is not a verified route. */}
 return {type:'observation',sampleId:sample.id,source,providerId:evidence.providerId,sourceHash:evidence.sourceHash,
  httpStatus:observation.httpStatus,complete:observation.complete,final:evidence.final,costUsd:evidence.cost,
  nativePromptTokens:integer(usage?.inputTokens),nativeCompletionTokens:integer(usage?.outputTokens),
  reasoningTokens:integer(usage?.reasoningTokens),cachedTokens:integer(usage?.cachedTokens),
  cacheWriteTokens:integer(usage?.cacheCreationTokens),providerName,finishReason,
  regionBlocked,contentRefused,rejected:'rejectedReason' in evidence?evidence.rejectedReason:null};
}

export async function executePlan(options:{prices:unknown;manifest:unknown;approvedHash:string;journal:Journal;
 credential:()=>Promise<string>;preflight:(model:string)=>Promise<void>;transport?:typeof fetch;egressCountry?:string}){
 const plan=verifiedPlan(options.prices,options.manifest,options.approvedHash);
 const {journal}=options;
 // A used directory never dispatches again: crashes and ambiguous sends need a human audit, not a resume loop.
 if(journal.events.length)throw new Error('BATCH_ALREADY_ATTEMPTED_NO_AUTOMATIC_RESUME');
 const append=async(event:Event)=>{await journal.append(event);journal.events.push(event);};
 await append({type:'batch',manifestHash:plan.manifest.manifestHash,totalCapUsd:plan.manifest.totalUsd,egressCountry:options.egressCountry,version:1});
 const adapter=openRouterAdapter({credential:options.credential,transport:options.transport,allowWorkspaceRead:true});
 const receipts:unknown[]=[];
 const generationIds=new Set<string>();
 let committed=0n;
 for(const sample of plan.manifest.samples){
  const body=plan.requests.find(r=>r.id===sample.id)?.body;
  if(!body||hash(body)!==sample.requestHash||Buffer.byteLength(body)!==sample.B)throw new Error('REQUEST_HASH_MISMATCH');
  const cap=decimal(String(sample.spendCapUsd));
  if(cap!==decimal(String(sample.upperUsd))||cap>decimal(String(sample.approvedCap))
   ||committed+cap>decimal(plan.manifest.totalUsd))throw new Error('SAMPLE_BUDGET_EXCEEDED');
  try{await options.preflight(String(sample.model));}
  catch(error){await append({type:'halt',reason:failureCode(error)});break;}
  const identity=identityFor(sample,options.prices);
  // prepareDispatch is structural/credential-only. It never sends; send is a one-use capability.
  const send=await adapter.prepareDispatch({input:body},identity);
  committed+=cap;
  await append({type:'attempt',sampleId:sample.id,requestHash:sample.requestHash,capUsd:sample.spendCapUsd,
   B:sample.B,T:sample.T,O:sample.O});
  const observations:ReturnType<typeof observationEvent>[]=[];
  try{
   const transport=await send();
   await journal.saveObservation(String(sample.id),'response',transport);
   const observed=observationEvent(adapter,transport,identity,'response',sample);
   observations.push(observed);await append(observed);
  }catch{
   await append({type:'halt',sampleId:sample.id,reason:'AMBIGUOUS_SEND_NO_RETRY',actualUsd:null});
   break;
  }
  if(observations[0].regionBlocked){
   await append({type:'halt',sampleId:sample.id,reason:'PROVIDER_REGION_BLOCKED',actualUsd:null});break;
  }
  if(observations[0].contentRefused){
   await append({type:'halt',sampleId:sample.id,reason:'PROVIDER_CONTENT_REFUSED',
    actualUsd:observations[0].costUsd});break;
  }
  const id=observations[0].providerId;
  if(id&&generationIds.has(id)){
   await append({type:'halt',sampleId:sample.id,reason:'REUSED_GENERATION_ID',actualUsd:null});break;
  }
  if(id)generationIds.add(id);
  // Public /providers and model /endpoints use Google for google-vertex/global, not the UI label.
  // See BILL_PAYG_PROFILE_EXECUTOR.md. Keep exact names; an unverified alias is not a matching receipt.
  const providerName=priceSchema.parse(options.prices).routes.find(r=>r.model===sample.model)!.providerName;
  const complete=(o:ReturnType<typeof observationEvent>)=>o.final&&o.nativePromptTokens!==null
   &&o.nativeCompletionTokens!==null&&o.providerName===providerName;
  // Missing cost, tokens or exact provider metadata: lookup original ID only, at most three times.
  if(id&&!complete(observations[0])&&observations[0].rejected!=='identity_or_response_mismatch'){
   for(let attempt=1;attempt<=3;attempt++){
    await append({type:'lookup-attempt',sampleId:sample.id,providerId:id,attempt});
    try{
     const transport=await adapter.lookup(id,identity);
     await journal.saveObservation(String(sample.id),`lookup-${attempt}`,transport);
     const observed=observationEvent(adapter,transport,identity,'lookup',sample,id);
     observations.push(observed);await append(observed);
     if(observed.contentRefused||complete(observed)||observed.rejected==='identity_or_response_mismatch')break;
    }catch{await append({type:'lookup-unknown',sampleId:sample.id,attempt});}
   }
  }
  if(observations.some(o=>o.contentRefused)){
   await append({type:'halt',sampleId:sample.id,reason:'PROVIDER_CONTENT_REFUSED',actualUsd:null});break;
  }
  const finals=observations.filter(o=>o.final);
  const valid=observations.filter(complete).at(-1);
  const conflict=observations.some(o=>o.rejected==='identity_or_response_mismatch'
   ||o.reasoningTokens!==null&&o.nativeCompletionTokens!==null&&o.reasoningTokens>o.nativeCompletionTokens)
   ||finals.some(o=>o.costUsd!==finals[0]?.costUsd)
   ||observations.some(o=>valid&&((o.nativePromptTokens!==null&&o.nativePromptTokens!==valid.nativePromptTokens)
    ||(o.nativeCompletionTokens!==null&&o.nativeCompletionTokens!==valid.nativeCompletionTokens)));
  if(!valid||conflict){
   await append({type:'halt',sampleId:sample.id,reason:conflict?'RECEIPT_CONFLICT':'UNKNOWN_OR_FAILED',
    actualUsd:conflict?null:finals.at(-1)?.costUsd??null});break;
  }
  const receipt={sampleId:sample.id,requestHash:sample.requestHash,model:sample.model,endpointTag:sample.endpointTag,
   nativePromptTokens:valid.nativePromptTokens,nativeCompletionTokens:valid.nativeCompletionTokens,costUsd:valid.costUsd,
   cachedTokens:valid.cachedTokens??observations[0].cachedTokens,
   cacheWriteTokens:valid.cacheWriteTokens??observations[0].cacheWriteTokens,
   source:valid.source==='response'?'response.prompt_tokens':'lookup.native_tokens_prompt',includesReasoning:true,
   finishReason:typeof valid.finishReason==='string'?valid.finishReason:null};
  receipts.push(receipt);
  const result=recordSamples(plan.manifest,receipts).find(s=>s.id===sample.id)!;
  const outputCapReached=outputPressurePassed(valid.finishReason,valid.nativeCompletionTokens,Number(sample.O),plan.manifest.outputPressureCriterion);
  await append({type:'result',...result,receipt,finishReason:valid.finishReason,outputCapReached});
  if(!['SAMPLE_WITHIN_BOUNDS','OUTPUT_CAP_NOT_REACHED'].includes(result.status)){
   await append({type:'halt',sampleId:sample.id,reason:'BOUND_FAILED_NO_REFILL',
    actualUsd:valid.costUsd});break;
  }
 }
 const amounts=plan.manifest.samples.filter(s=>journal.events.some(e=>e.type==='attempt'&&e.sampleId===s.id)).map(s=>{
  const observations=journal.events.filter(e=>e.type==='observation'&&e.sampleId===s.id&&e.final);
  const costs=[...new Set(observations.map(e=>e.costUsd))];
  const conflict=journal.events.some(e=>e.type==='halt'&&e.sampleId===s.id&&['RECEIPT_CONFLICT','REUSED_GENERATION_ID'].includes(String(e.reason)));
  return !conflict&&costs.length===1&&typeof costs[0]==='string'?costs[0]:null;
 });
 const known=amounts.reduce((sum,cost)=>sum+(cost===null?0n:decimal(cost)),0n);
 const knownUsd=`${known/1000000000000n}.${String(known%1000000000000n).padStart(12,'0')}`;
 const report=recordSamples(plan.manifest,receipts).map(row=>{
  const attempted=journal.events.some(e=>e.type==='attempt'&&e.sampleId===row.id);
  const observed=journal.events.filter(e=>e.type==='observation'&&e.sampleId===row.id&&e.final);
  const costs=[...new Set(observed.map(e=>e.costUsd))];
  const halt=journal.events.find(e=>e.type==='halt'&&e.sampleId===row.id);
  const actualUsd=halt?.reason==='RECEIPT_CONFLICT'||halt?.reason==='REUSED_GENERATION_ID'?null:
   costs.length===1?costs[0]:attempted?null:'0';
  return {...row,status:row.status==='MISSING'?(attempted?'UNKNOWN':'NOT_RUN'):row.status,actualUsd};
 });
 return {manifestHash:plan.manifest.manifestHash,receipts,report,
  actualUsd:amounts.includes(null)?null:knownUsd,knownUsd,unknownCostSamples:amounts.filter(v=>v===null).length,events:journal.events};
}
