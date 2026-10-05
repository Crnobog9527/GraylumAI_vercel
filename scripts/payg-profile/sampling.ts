/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {openRouterRequestBody} from '../../packages/api/src/services/runtime/providerRequest';
import {freezePromptCache} from '../../packages/api/src/services/runtime/promptCache';
import {reasoningPolicy,frozenReasoningFields,type ReasoningPolicy} from '../../packages/api/src/services/runtime/reasoningPolicy';
import {openRouterBound,openRouterCallBound} from '../../packages/api/src/services/bill2/openRouterPolicy';
import {decimal} from '../../packages/api/src/services/bill2/decimal';
const amount=z.string().regex(/^\d+(\.\d{1,12})?$/);
const route=z.object({model:z.string(),endpointTag:z.string(),contextTokens:z.number().int().positive(),prompt:amount,
 write:amount.optional(),completion:amount,request:amount,perCallCap:amount,modelCap:amount,reasoning:z.array(reasoningPolicy).min(1)}).strict();
export const priceSchema=z.object({source:z.string(),currentVerified:z.boolean(),routes:z.array(route).length(3)}).strict();
type Route=z.infer<typeof route>;
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
const money=(n:bigint)=>`${n/1000000000000n}.${String(n%1000000000000n).padStart(12,'0')}`;
const categories=['chinese','english','code','json','tools'] as const;
const text={chinese:'中文材料：标点，。！？🙂；é与é。比较观点并保留不确定性。\n',
 english:'Compare antidisestablishmentarianism with 12345678901234567890 and explain uncertainty.\n',
 code:'const id_7f90a = {path: "C:\\synthetic\\data", escape: "\\n", unicode: "λ"};\n',
 json:'{"nested":{"value":"\\u4e2d","array":[1,{"label":"synthetic"}]}}\n',
 tools:'Source record: synthetic finding with provenance and uncertainty; no external tool execution.\n'};
function sized(seed:string,bytes:number){
 const count=Math.floor(bytes/Buffer.byteLength(seed));
 let rest=bytes-count*Buffer.byteLength(seed),tail='';
 for(const character of seed){const n=Buffer.byteLength(character);if(n>rest)break;tail+=character;rest-=n;}
 return seed.repeat(count)+tail+'x'.repeat(rest);
}
function requestFor(r:Route,category:typeof categories[number],target:number,variant:number,O:number,reasoning:ReasoningPolicy){
 const providerLimits={providerSlug:r.endpointTag,contextTokens:r.contextTokens,promptUsdPerMillion:r.prompt,
  completionUsdPerMillion:r.completion,requestUsd:r.request,...(r.write?{cacheWriteUsdPerMillion:r.write}:{})};
 const policy={modelId:'10000000-0000-4000-8000-000000000001',model:r.model,provider:'openrouter',account:'offline-only',
  protocol:'openrouter-chat-v1' as const,providerLimits,upperUsd:openRouterBound(providerLimits,O).upperUsd,
  inputLimit:196608,outputLimit:O,automaticRetry:false as const,hiddenTools:false as const,lookupSupported:true};
 // Same substantive system prefix within a length/category cell; variants differ in user data.
 const instructions=target>4096?sized('Analyze the following synthetic dataset. Preserve its provenance.\n',8192):
  'Analyze the following synthetic dataset. Preserve provenance and uncertainty.';
 const promptCache=freezePromptCache({real:true,role:'skill',model:r.model,cacheWriteUsdPerMillion:r.write,
  instructions,skillChars:instructions.length});
 const toolSample=category==='tools';
 const parameters={type:'object',properties:{query:{type:'string',description:'Find the requested synthetic record.'}},additionalProperties:false};
 if(toolSample&&target>4096){
  const base=Buffer.byteLength(JSON.stringify(parameters));
  parameters.properties.query.description+=sized('Record description and retrieval constraints. ',16384-base);
 }
 const messages:Array<Record<string,unknown>>=[{role:'system',content:instructions}];
 if(toolSample&&target>4096){
  // Ten complete serial call/result/assistant chains + system + final user = 32.
  for(let n=0;n<10;n++)messages.push(
   {role:'assistant',content:null,tool_calls:[{id:`synthetic-${n}`,type:'function',function:{name:'read_source',arguments:'{}'}}]},
   {role:'tool',tool_call_id:`synthetic-${n}`,content:'Synthetic source record.'},
   {role:'assistant',content:'Recorded source and uncertainty.'});
 }
 messages.push({role:'user',content:`Variant ${variant}. `});
 const serialize=(data:string)=>{
  messages[messages.length-1].content=`Category ${category}; variant ${variant}. ${O===8192?
   'Output at least 12000 tokens of numbered synthetic records and explanations. Continue until the output limit. ':''}${data}`;
  return openRouterRequestBody(JSON.stringify({model:r.model,messages,max_tokens:O,...frozenReasoningFields(reasoning),
   ...(toolSample?{tools:[{type:'function',function:{name:'read_source',description:'Read a synthetic owned record',parameters}}]}:{})}),
  {context:{providerRequestFormat:'serial-tools-v6-reasoning',tools:toolSample?['read_source']:[],workspaceContext:toolSample,
   network:'deny',reasoning,promptCache},policy,phase:'skill',primaryDialogue:true});
 };
 const base=serialize('');
 if(target===0)return {body:base,providerLimits};
 if(Buffer.byteLength(base)>target)throw new Error('SAMPLE_BASE_EXCEEDS_TARGET');
 // JSON escaping changes B; search on final normalized, cache-marked wire bytes.
 let low=0,high=target;
 while(low<high){const mid=Math.ceil((low+high)/2);
  if(Buffer.byteLength(serialize(sized(text[category],mid)))<=target)low=mid;else high=mid-1;}
 const data=sized(text[category],low),body=serialize(data);
 return {body:serialize(data+'x'.repeat(target-Buffer.byteLength(body))),providerLimits};
}
export function createSamplePlan(input:unknown){
 const prices=priceSchema.parse(input),samples:Array<Record<string,unknown>>=[],requests:Array<{id:string;body:string}>=[];
 const totals:Record<string,string>={};const blockers=['REAL_SAMPLING_NOT_AUTHORIZED','REUSE_COVERAGE_NOT_VERIFIED',
  'REASONING_WIRE_AND_OUTPUT_CAPACITY_REQUIRE_CURRENT_CATALOG','PROFILE_EVIDENCE_NOT_COLLECTED'];
 if(!prices.currentVerified)blockers.push('PRICES_AND_CONTEXT_ARE_PLAN_ASSUMPTIONS_NOT_CURRENT_QUOTES');
 for(const r of prices.routes){
  let total=0n;
  const add=(category:typeof categories[number],band:string,variant:number,target:number,O:number,reasoning:ReasoningPolicy,kind:string)=>{
   const {body,providerLimits}=requestFor(r,category,target,variant,O,reasoning);
   const B=Buffer.byteLength(body),T=B+8192,parsed=JSON.parse(body);
   const schemaBytes=(parsed.tools??[]).reduce((n:number,t:{function:{parameters:unknown}})=>n+Buffer.byteLength(JSON.stringify(t.function.parameters)),0);
   if(B>196608||parsed.messages.length>32||schemaBytes>16384)throw new Error('SAMPLE_PROFILE_EXCEEDED');
   const upperUsd=openRouterCallBound(providerLimits,O,T).upperUsd,id=`${r.model}:${kind}:${category}:${band}:${variant}`;
   if(decimal(upperUsd)>decimal(r.perCallCap))blockers.push(`PER_CALL_BUDGET_EXCEEDED:${id}`);
   total+=decimal(upperUsd);
   samples.push({id,model:r.model,endpointTag:r.endpointTag,category,band,variant,kind,B,T,O,reasoning,
    requestHash:hash(body),messages:parsed.messages.length,tools:(parsed.tools??[]).length,schemaBytes,
    cache:promptCacheLabel(r),upperUsd,P:null,rB:null,rT:null,status:'NOT_RUN'});
   requests.push({id,body});
  };
  for(const category of categories)for(const [band,maximum] of [['small',4096],['medium',32768],['large',196608]] as const)
   for(let variant=0;variant<4;variant++)add(category,band,variant,band==='small'&&variant===0?0:
    variant===3?maximum:Math.floor(maximum*(0.91+variant*0.025)),1024,{effort:'low'},'matrix');
  for(const [index,reasoning] of r.reasoning.entries())for(let v=0;v<2;v++)
   add(v?'code':'chinese','output-stress',index*2+v,4096,8192,reasoning,'output');
  totals[r.model]=money(total);
  if(total>decimal(r.modelCap))blockers.push(`MODEL_BUDGET_EXCEEDED:${r.model}`);
 }
 const totalUsd=money(Object.values(totals).reduce((sum,n)=>sum+decimal(n),0n));
 if(decimal(totalUsd)>decimal('48'))blockers.push('TOTAL_BUDGET_EXCEEDED');
 const manifest={version:1,priceSource:prices.source,currentPricesVerified:prices.currentVerified,
  distinctMatrixSamples:180,outputStressSamples:samples.length-180,calls:samples.length,totals,totalUsd,
  actualCalls:0,actualUsd:'0',blockers,samples};
 return {manifest:{...manifest,manifestHash:hash(JSON.stringify(manifest))},requests};
}
function promptCacheLabel(r:Route){return r.model.startsWith('anthropic/')?'explicit-ephemeral':'repeated-system-prefix';}
/** Offline projection only: unknown/native-token conflicts remain unknown, never pass as zero.
 * Input receipts must already have been obtained by an separately authorized sampling executor. */
export function recordSamples(manifest:ReturnType<typeof createSamplePlan>['manifest'],receipts:unknown[]){
 const {manifestHash,...contents}=manifest;
 if(hash(JSON.stringify(contents))!==manifestHash)throw new Error('MANIFEST_HASH_MISMATCH');
 const receipt=z.object({sampleId:z.string(),requestHash:z.string(),model:z.string(),endpointTag:z.string(),
  nativePromptTokens:z.number().int().nonnegative(),nativeCompletionTokens:z.number().int().nonnegative(),
  costUsd:amount,cachedTokens:z.number().int().nonnegative().nullable(),cacheWriteTokens:z.number().int().nonnegative().nullable(),
  source:z.enum(['response.prompt_tokens','lookup.native_tokens_prompt']),includesReasoning:z.literal(true)}).strict();
 return manifest.samples.map(sample=>{
  const matching=receipts.filter(r=>typeof r==='object'&&r!==null&&(r as {sampleId?:unknown}).sampleId===sample.id);
  const valid=matching.length===1?receipt.safeParse(matching[0]):null;
  if(!valid?.success)return {...sample,status:matching.length>1?'CONFLICT':'MISSING',P:null,rB:null,rT:null};
  const r=valid.data;
  if(r.requestHash!==sample.requestHash||r.model!==sample.model||r.endpointTag!==sample.endpointTag)
   return {...sample,status:'IDENTITY_MISMATCH',P:null,rB:null,rT:null};
  const P=r.nativePromptTokens,rB=P/Number(sample.B),rT=P/Number(sample.T);
  return {...sample,P,rB,rT,cachedTokens:r.cachedTokens,cacheWriteTokens:r.cacheWriteTokens,costUsd:r.costUsd,
   status:rB<=0.7&&rT<=0.7&&decimal(r.costUsd)<=decimal(String(sample.upperUsd))&&r.nativeCompletionTokens<=Number(sample.O)
    ?'SAMPLE_WITHIN_BOUNDS':'BOUND_FAILED'};
 });
}
