/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {beforeAll,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import prices from '../../../../../scripts/payg-profile/plan-prices.json';
import catalog from '../../../../../scripts/payg-profile/catalog-2026-10-06-r7.json';
import {createR9Plan} from '../../../../../scripts/payg-profile/batch-r9';
import r5 from '../../../../../docs/launch/evidence/payg-profile-20261006-r5.manifest.json';
import {executePlan,verifiedPlan,verifyCatalog,failureCode,type Event,type Plan} from '../../../../../scripts/payg-profile/executor';
// Historical plus 12-request regeneration is CPU-bound; shared CI runners exceed Vitest's 5s default.
let plan:Plan;
const firstRoute=prices.routes.find(r=>r.model.startsWith('anthropic/'))!;
beforeAll(()=>{plan=createR9Plan(prices);},30000);
const response=(body:Record<string,unknown>,status=200)=>{
 if(status===200&&Array.isArray(body.choices)&&body.model){
  const usage=body.usage as {prompt_tokens:number;completion_tokens:number}|undefined;
  const chunk={...body,choices:body.choices.map(c=>({...c,index:0,delta:{role:'assistant',content:'Synthetic output'}})),
   ...(usage?{usage:{...usage,total_tokens:usage.prompt_tokens+usage.completion_tokens}}:{})};
  return new Response('data: '+JSON.stringify(chunk)+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
 }
 return new Response(JSON.stringify(body),{status});
};
function wire(body:Record<string,unknown>){return response(body);}
async function decoded(result:Response){
 const text=await result.text();return JSON.parse(text.startsWith('data: ')?text.slice(6).split('\n\n')[0]:text);
}
function fixture(){
 const active=plan;
 const events:Event[]=[],observations:unknown[]=[];
 const lookup=new Map<string,Record<string,unknown>>();
 const transport=vi.fn(async(_url:Parameters<typeof fetch>[0],init?:RequestInit)=>{
  if(init?.method==='GET')return response({data:lookup.get(new URL(String(_url)).searchParams.get('id')!)});
  const request=JSON.parse(String(init?.body));
  const route=prices.routes.find(r=>r.model===request.model)!;
  const body={id:'synthetic-'+createHash('sha256').update(String(init?.body)).digest('hex'),model:request.model,provider:({'anthropic':'Anthropic','google-ai-studio':'Google AI Studio','openai':'OpenAI'} as Record<string,string>)[route.endpointTag],
   choices:[{finish_reason:'length'}],usage:{cost:0.001,prompt_tokens:100,completion_tokens:request.max_tokens,
    prompt_tokens_details:{cached_tokens:20,cache_write_tokens:10},completion_tokens_details:{reasoning_tokens:50}}};
  lookup.set(body.id,{id:body.id,model:body.model,provider_name:body.provider,finish_reason:'length',total_cost:0.001,
   native_tokens_prompt:100,native_tokens_completion:request.max_tokens});
  return wire(body);
 });
 const credential=vi.fn(async()=>'LOCAL_SYNTHETIC_KEY'),preflight=vi.fn(async()=>{});
 const options={prices,manifest:active.manifest,approvedHash:active.manifest.manifestHash,credential,preflight,transport,
  journal:{events,append:async(event:Event)=>{expect(event).toBeDefined();},
   saveObservation:async(_id:string,_source:string,value:unknown)=>{observations.push(value);}}};
 return {options,events,observations,transport,credential,preflight};
}
it('checks exact manifest before credential or network; refuses budget/catalog/candidate tampering',async()=>{
 const f=fixture();f.options.approvedHash='0'.repeat(64);
 await expect(executePlan(f.options)).rejects.toThrow('APPROVED_MANIFEST_MISMATCH');
 expect(f.credential).not.toHaveBeenCalled();expect(f.transport).not.toHaveBeenCalled();
 const manifest=structuredClone(plan.manifest);manifest.samples[0].upperUsd='0.55';
 expect(()=>verifiedPlan(prices,manifest,plan.manifest.manifestHash)).toThrow('APPROVED_MANIFEST_MISMATCH');
},30000);
it('real adapter sends every frozen hash once, under its own cap, with canonical receipts',async()=>{
 const f=fixture();const result=await executePlan(f.options);
 expect(f.transport).toHaveBeenCalledTimes(12);expect(result.receipts).toHaveLength(12);
 expect(result.report.every(s=>s.status==='SAMPLE_WITHIN_BOUNDS')).toBe(true);
 expect(f.observations).toHaveLength(12);
 for(let i=0;i<12;i++){
  const [url,init]=f.transport.mock.calls.filter(([,init])=>init?.method==='POST')[i];const sample=plan.manifest.samples[i];
  expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
  expect(createHash('sha256').update(String(init?.body)).digest('hex')).toBe(sample.requestHash);
  expect(init?.redirect).toBe('error');
  expect(JSON.parse(String(init?.body))).toMatchObject({store:false,provider:{allow_fallbacks:false,require_parameters:true}});
 }
 expect(result.report[0]).toMatchObject({P:100,cachedTokens:20,cacheWriteTokens:10});
 expect(JSON.stringify(result)).not.toContain('LOCAL_SYNTHETIC_KEY');
 await expect(executePlan(f.options)).rejects.toThrow('BATCH_ALREADY_ATTEMPTED');
 expect(f.transport).toHaveBeenCalledTimes(12);
},30000);
it('ambiguous send never retries, never marks zero cost, never dispatches the next sample',async()=>{
 const f=fixture();f.transport.mockRejectedValue(new Error('private transport detail'));
 const result=await executePlan(f.options);
 expect(f.transport).toHaveBeenCalledTimes(1);
 expect(result.report[0]).toMatchObject({status:'UNKNOWN',actualUsd:null});
 expect(result.report[1]).toMatchObject({status:'NOT_RUN',actualUsd:'0'});
 expect(f.events.at(-1)).toMatchObject({type:'halt',reason:'AMBIGUOUS_SEND_NO_RETRY',actualUsd:null});
 expect(JSON.stringify(f.events)).not.toContain('private transport detail');
},30000);
it('fsync/claim failure prevents dispatch',async()=>{
 const f=fixture();f.options.journal.append=async e=>{if(e.type==='attempt')throw new Error('disk full');};
 await expect(executePlan(f.options)).rejects.toThrow('disk full');expect(f.transport).not.toHaveBeenCalled();
},30000);
it('missing usage looks up only the original ID three times and never resends or refills',async()=>{
 const f=fixture();f.transport.mockImplementation(async(_url,init)=>init?.method==='POST'
  ?response({id:'synthetic-original',model:firstRoute.model,choices:[{finish_reason:'stop'}]})
  :response({error:{code:404}},404));
 await executePlan(f.options);
 expect(f.transport.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(1);
 expect(f.transport.mock.calls.filter(([,init])=>init?.method==='GET')).toHaveLength(3);
 for(const [url,init] of f.transport.mock.calls)if(init?.method==='GET')
  expect(url).toBe('https://openrouter.ai/api/v1/generation?id=synthetic-original');
 expect(f.events.at(-1)).toMatchObject({reason:'UNKNOWN_OR_FAILED',actualUsd:null});
},30000);
it('an incomplete response with a header ID may lookup, but never repeats POST',async()=>{
 const f=fixture();f.transport.mockImplementation(async(_url,init)=>init?.method==='POST'
  ?new Response('broken json',{headers:{'x-generation-id':'synthetic-header'}}):response({error:{}},404));
 await executePlan(f.options);
 expect(f.transport).toHaveBeenCalledTimes(4);
 expect(f.events.filter(e=>e.type==='lookup-attempt').every(e=>e.providerId==='synthetic-header')).toBe(true);
},30000);
it('over-bound cost remains failed at the original bound and halts the batch',async()=>{
 const f=fixture();f.transport.mockImplementation(async()=>response({id:'synthetic-over',model:firstRoute.model,
  provider:firstRoute.providerName,choices:[{finish_reason:'stop'}],usage:{cost:1,prompt_tokens:100,completion_tokens:10}}));
 const result=await executePlan(f.options);
 expect(f.transport).toHaveBeenCalledTimes(1);expect(result.report[0].status).toBe('BOUND_FAILED');
 expect(f.events.at(-1)).toMatchObject({reason:'BOUND_FAILED_NO_REFILL',actualUsd:'1'});
 expect(result.report[0].upperUsd).toBe(plan.manifest.samples[0].upperUsd);
},30000);
it('provider/identity mismatch cannot be used as a matching-route receipt',async()=>{
 const f=fixture();f.transport.mockImplementation(async()=>response({id:'synthetic-wrong',model:'wrong/model',
  provider:firstRoute.providerName,choices:[{finish_reason:'stop'}],usage:{cost:0.001,prompt_tokens:100,completion_tokens:10}}));
 await executePlan(f.options);expect(f.transport).toHaveBeenCalledTimes(1);
 expect(f.events.at(-1)).toMatchObject({reason:'RECEIPT_CONFLICT',actualUsd:null});
},30000);
it('live read-only preflight requires exact snapshot including prices, route and supported parameters',async()=>{
 const route=catalog.routes[2];
 const transport=vi.fn(async()=>response({data:{id:route.model,endpoints:[route.endpoint]}}));
 await verifyCatalog(prices,catalog,route.model,transport);
 expect(transport.mock.calls[0]).toBeDefined();
 const changed=structuredClone(route.endpoint);changed.pricing.prompt='0.00001';
 transport.mockResolvedValue(response({data:{id:route.model,endpoints:[changed]}}));
 await expect(verifyCatalog(prices,catalog,route.model,transport)).rejects.toThrow('CATALOG_DRIFT');
 await expect(verifyCatalog(prices,{},route.model,transport)).rejects.toThrow('CATALOG_HASH');
},30000);

it('catalog drift stops before credentials and the first paid request',async()=>{
 const f=fixture();f.preflight.mockRejectedValue(new Error('CATALOG_DRIFT_REPLAN_REQUIRED'));
 await executePlan(f.options);
 expect(f.events.at(-1)).toEqual({type:'halt',reason:'CATALOG_DRIFT_REPLAN_REQUIRED'});
 expect(f.credential).not.toHaveBeenCalled();expect(f.transport).not.toHaveBeenCalled();
 expect(f.events.filter(e=>e.type==='attempt')).toHaveLength(0);
},30000);
it('conflicting response and lookup costs never choose the cheaper receipt',async()=>{
 const f=fixture();f.transport.mockImplementation(async(_url,init)=>init?.method==='POST'
  ?response({id:'synthetic-conflict',model:firstRoute.model,choices:[{finish_reason:'stop'}],
   usage:{cost:0.001,prompt_tokens:100,completion_tokens:10}})
  :response({data:{id:'synthetic-conflict',model:firstRoute.model,provider_name:firstRoute.providerName,
   finish_reason:'stop',total_cost:0.002,native_tokens_prompt:100,native_tokens_completion:10}}));
 const result=await executePlan(f.options);
 expect(f.transport).toHaveBeenCalledTimes(2);expect(result.actualUsd).toBeNull();
 expect(f.events.at(-1)).toMatchObject({reason:'RECEIPT_CONFLICT',actualUsd:null});
},30000);

it.each(['CATALOG_UNAVAILABLE','CATALOG_DRIFT_REPLAN_REQUIRED','private network credentials detail'])(
 'mid-batch preflight halt records only a safe code: %s',async(reason)=>{
 const f=fixture();f.preflight.mockResolvedValueOnce().mockRejectedValue(new Error(reason));
 const result=await executePlan(f.options);
 expect(f.transport).toHaveBeenCalledTimes(1);
 expect(f.events.at(-1)).toEqual({type:'halt',reason:reason.startsWith('CATALOG_')?reason:'PAYG_EXECUTOR_STOPPED'});
 expect(result.report[1]).toMatchObject({status:'NOT_RUN',actualUsd:'0'});
 expect(result.actualUsd).toBe('0.001000000000');
 expect(JSON.stringify(result)).not.toContain('private network credentials detail');
},30000);
it('catalog transport and malformed JSON never expose upstream messages',async()=>{
 const transport=vi.fn(async()=>{throw new Error('private network credentials detail');});
 await expect(verifyCatalog(prices,catalog,firstRoute.model,transport)).rejects.toThrow('CATALOG_UNAVAILABLE');
 await expect(verifyCatalog(prices,catalog,firstRoute.model,async()=>new Response('bad json')))
  .rejects.toThrow('CATALOG_INVALID_RESPONSE');
 expect(failureCode(new Error('CATALOG_UNAVAILABLE extra private detail'))).toBe('PAYG_EXECUTOR_STOPPED');
});
it.each(['Google Vertex','Google','google-ai-studio','unverified-provider'])(
 'does not admit an unverified AI Studio receipt name: %s',async(provider)=>{
 const f=fixture(),send=f.transport.getMockImplementation()!;
 f.transport.mockImplementation(async(url,init)=>{
  if(init?.method==='GET'){
   const prior=await send(url,init),data=(await prior.clone().json()).data;
   return data?.model==='google/gemini-3.8-flash'?response({error:{}},404):prior;
  }
  const result=await send(url,init),body=await decoded(result);
  if(body.model==='google/gemini-3.8-flash')body.provider=provider;
  return wire(body);
 });
 const result=await executePlan(f.options);
 expect(result.receipts).toHaveLength(6);
 expect(f.events.at(-1)).toMatchObject({reason:'UNKNOWN_OR_FAILED'});
 expect(f.events.filter(e=>e.type==='lookup-attempt')).toHaveLength(3);
 expect(f.events.filter(e=>e.type==='attempt')).toHaveLength(7);
},30000);
it('both current canonical provider names are also accepted from original-ID lookup receipts',async()=>{
 const f=fixture(),send=f.transport.getMockImplementation()!;
 const originals=new Map<string,{id:string;model:string;provider:string;usage:{completion_tokens:number}}>();
 f.transport.mockImplementation(async(url,init)=>{
  if(init?.method==='GET'){
   const original=originals.get(new URL(String(url)).searchParams.get('id')!)!;
   return response({data:{id:original.id,model:original.model,provider_name:original.provider,
    finish_reason:'length',total_cost:0.001,native_tokens_prompt:100,native_tokens_completion:original.usage.completion_tokens}});
  }
  const raw=await send(url,init),body=await decoded(raw);originals.set(body.id,body);
  const {provider:unused,...withoutProvider}=body;expect(unused).toBeTruthy();
  return wire(withoutProvider);
 });
 const result=await executePlan(f.options);
 expect(result.receipts).toHaveLength(12);
 expect(result.receipts.every(r=>(r as {source:string}).source==='lookup.native_tokens_prompt')).toBe(true);
 expect(f.events.filter(e=>e.type==='lookup-attempt')).toHaveLength(12);
},30000);

it.each([true,false])('only exact region-gate 403 yields PROVIDER_REGION_BLOCKED (region=%s)',async(region)=>{
 const f=fixture();
 f.transport.mockImplementation(async(_url,init)=>init?.method==='GET'?response({error:{}},404):
  response({error:{code:403,metadata:{failed_routing_step:region?'Gate Endpoints with Geo Restrictions':'Other Gate'}}},403));
 const result=await executePlan(f.options);
 expect(f.events.at(-1)).toMatchObject({reason:region?'PROVIDER_REGION_BLOCKED':'UNKNOWN_OR_FAILED',actualUsd:null});
 expect(result.actualUsd).toBeNull();
 expect(f.transport.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(1);
 expect(JSON.stringify(f.events)).not.toContain('Gate Endpoints');
},30000);

it.each([
 {finish_reason:'content_filter'},
 {finish_reason:'stop',native_finish_reason:'refusal'},
])('content refusal is a distinct immediate halt with no lookup: %j',async(choice)=>{
 const f=fixture();
 f.transport.mockResolvedValue(response({id:'synthetic-refused',model:firstRoute.model,
  provider:firstRoute.providerName,choices:[choice]}));
 const result=await executePlan(f.options);
 expect(f.transport).toHaveBeenCalledTimes(1);
 expect(f.events.at(-1)).toMatchObject({reason:'PROVIDER_CONTENT_REFUSED',actualUsd:null});
 expect(result.actualUsd).toBeNull();expect(result.report[0].status).toBe('UNKNOWN');
 expect(result.report[1].status).toBe('NOT_RUN');
},30000);
it('a refusal with settled cost retains that cost and still stops',async()=>{
 const f=fixture();
 f.transport.mockResolvedValue(response({id:'synthetic-refused-cost',model:firstRoute.model,
  provider:firstRoute.providerName,choices:[{finish_reason:'content_filter'}],
  usage:{cost:0.002,prompt_tokens:100,completion_tokens:10}}));
 const result=await executePlan(f.options);
 expect(f.transport).toHaveBeenCalledTimes(1);expect(result.knownUsd).toBe('0.002000000000');
 expect(f.events.at(-1)).toMatchObject({reason:'PROVIDER_CONTENT_REFUSED'});
},30000);
it('refusal first observed in lookup stops further lookups and dispatch',async()=>{
 const f=fixture();
 f.transport.mockImplementation(async(_url,init)=>init?.method==='POST'
  ?response({id:'synthetic-refusal-lookup',model:firstRoute.model,choices:[{finish_reason:'stop'}]})
  :response({data:{id:'synthetic-refusal-lookup',model:firstRoute.model,native_finish_reason:'refusal'}}));
 await executePlan(f.options);expect(f.transport).toHaveBeenCalledTimes(2);
 expect(f.events.at(-1)).toMatchObject({reason:'PROVIDER_CONTENT_REFUSED'});
},30000);
it('lowered cumulative cap refuses plans even when each call stays within its cap',()=>{
 const changed=structuredClone(prices);
 for(const r of changed.routes.filter(r=>r.model.startsWith('google/'))){r.prompt=String(Number(r.prompt)*20);
  if(r.write)r.write=String(Number(r.write)*20);
  r.perCallCap='100';r.modelCap='100';}
 expect(()=>createR9Plan(changed)).toThrow('CUMULATIVE_BUDGET_EXCEEDED');
},30000);

it.each([{finish:'stop',completion:512},{finish:'length',completion:460}])(
 'route probes do not require output saturation and do not halt: %j',async({finish,completion})=>{
 const f=fixture();f.transport.mockResolvedValueOnce(response({id:'synthetic-small',model:firstRoute.model,
 provider:firstRoute.providerName,choices:[{finish_reason:finish}],usage:{cost:0.001,prompt_tokens:100,completion_tokens:completion}}));
 const result=await executePlan(f.options);
 expect(f.transport).toHaveBeenCalledTimes(12);expect(result.report[0].status).toBe('SAMPLE_WITHIN_BOUNDS');
 expect(result.report.slice(1).every(r=>r.status==='SAMPLE_WITHIN_BOUNDS')).toBe(true);
 expect(f.events.some(e=>e.type==='halt')).toBe(false);
 expect(result.actualUsd).toBe('0.012000000000');expect(result.unknownCostSamples).toBe(0);
},30000);
it.each([7373,8191,8192])('length completion %s within 90 to 100 percent continues as qualified',async(completion)=>{
 const f=fixture();f.transport.mockResolvedValueOnce(response({id:'synthetic-near-cap',model:firstRoute.model,
 provider:firstRoute.providerName,choices:[{finish_reason:'length'}],usage:{cost:0.001,prompt_tokens:100,completion_tokens:completion,
 completion_tokens_details:{reasoning_tokens:400}}}));
 const result=await executePlan(f.options);
 expect(f.transport).toHaveBeenCalledTimes(12);expect(result.report[0].status).toBe('SAMPLE_WITHIN_BOUNDS');
 expect(f.events.find(e=>e.type==='result')).toMatchObject({outputCapReached:true});
},30000);
it('route output cap includes reasoning and does not allow a one-token overrun',async()=>{
 const f=fixture();f.transport.mockResolvedValue(response({id:'synthetic-small-over',model:firstRoute.model,
 provider:firstRoute.providerName,choices:[{finish_reason:'length'}],usage:{cost:0.001,prompt_tokens:100,completion_tokens:8193,
 completion_tokens_details:{reasoning_tokens:400}}}));
 const result=await executePlan(f.options);expect(result.report[0].status).toBe('BOUND_FAILED');
 expect(f.transport).toHaveBeenCalledTimes(1);
},30000);

it('superseded r5 cannot dispatch even with its former exact hash',()=>{
 expect(()=>verifiedPlan(prices,r5,r5.manifestHash)).toThrow('APPROVED_MANIFEST_MISMATCH');
});
