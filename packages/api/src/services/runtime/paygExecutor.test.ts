/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {beforeAll,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import prices from '../../../../../scripts/payg-profile/plan-prices.json';
import catalog from '../../../../../scripts/payg-profile/catalog-2026-10-05.json';
import {createSamplePlan} from '../../../../../scripts/payg-profile/sampling';
import {executePlan,verifiedPlan,verifyCatalog,type Event,type Plan} from '../../../../../scripts/payg-profile/executor';
let plan:Plan;
beforeAll(()=>{plan=createSamplePlan(prices);});
const response=(body:Record<string,unknown>,status=200)=>new Response(JSON.stringify(body),{status});
function fixture(){
 const events:Event[]=[],observations:unknown[]=[];
 const transport=vi.fn(async(_url:Parameters<typeof fetch>[0],init?:RequestInit)=>{
  const request=JSON.parse(String(init?.body));
  const route=prices.routes.find(r=>r.model===request.model)!;
  return response({id:'synthetic-'+createHash('sha256').update(String(init?.body)).digest('hex'),model:request.model,provider:route.providerName,
   choices:[{finish_reason:'length'}],usage:{cost:0.001,prompt_tokens:100,completion_tokens:request.max_tokens,
    prompt_tokens_details:{cached_tokens:20,cache_write_tokens:10},completion_tokens_details:{reasoning_tokens:50}}});
 });
 const credential=vi.fn(async()=>'LOCAL_SYNTHETIC_KEY'),preflight=vi.fn(async()=>{});
 const options={prices,manifest:plan.manifest,approvedHash:plan.manifest.manifestHash,credential,preflight,transport,
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
});
it('real adapter sends every frozen hash once, under its own cap, with canonical receipts',async()=>{
 const f=fixture();const result=await executePlan(f.options);
 expect(f.transport).toHaveBeenCalledTimes(228);expect(result.receipts).toHaveLength(228);
 expect(result.report.every(s=>s.status==='SAMPLE_WITHIN_BOUNDS')).toBe(true);
 expect(f.observations).toHaveLength(228);
 for(let i=0;i<228;i++){
  const [url,init]=f.transport.mock.calls[i];const sample=plan.manifest.samples[i];
  expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
  expect(createHash('sha256').update(String(init?.body)).digest('hex')).toBe(sample.requestHash);
  expect(init?.redirect).toBe('error');
  expect(JSON.parse(String(init?.body))).toMatchObject({store:false,provider:{allow_fallbacks:false,require_parameters:true}});
 }
 expect(result.report[0]).toMatchObject({P:100,cachedTokens:20,cacheWriteTokens:10});
 expect(JSON.stringify(result)).not.toContain('LOCAL_SYNTHETIC_KEY');
 await expect(executePlan(f.options)).rejects.toThrow('BATCH_ALREADY_ATTEMPTED');
 expect(f.transport).toHaveBeenCalledTimes(228);
});
it('ambiguous send never retries, never marks zero cost, never dispatches the next sample',async()=>{
 const f=fixture();f.transport.mockRejectedValue(new Error('private transport detail'));
 await executePlan(f.options);
 expect(f.transport).toHaveBeenCalledTimes(1);
 expect(f.events.at(-1)).toMatchObject({type:'halt',reason:'AMBIGUOUS_SEND_NO_RETRY',actualUsd:null});
 expect(JSON.stringify(f.events)).not.toContain('private transport detail');
});
it('fsync/claim failure prevents dispatch',async()=>{
 const f=fixture();f.options.journal.append=async e=>{if(e.type==='attempt')throw new Error('disk full');};
 await expect(executePlan(f.options)).rejects.toThrow('disk full');expect(f.transport).not.toHaveBeenCalled();
});
it('missing usage looks up only the original ID three times and never resends or refills',async()=>{
 const f=fixture();f.transport.mockImplementation(async(_url,init)=>init?.method==='POST'
  ?response({id:'synthetic-original',model:prices.routes[0].model,choices:[{finish_reason:'stop'}]})
  :response({error:{code:404}},404));
 await executePlan(f.options);
 expect(f.transport.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(1);
 expect(f.transport.mock.calls.filter(([,init])=>init?.method==='GET')).toHaveLength(3);
 for(const [url,init] of f.transport.mock.calls)if(init?.method==='GET')
  expect(url).toBe('https://openrouter.ai/api/v1/generation?id=synthetic-original');
 expect(f.events.at(-1)).toMatchObject({reason:'UNKNOWN_OR_FAILED',actualUsd:null});
});
it('an incomplete response with a header ID may lookup, but never repeats POST',async()=>{
 const f=fixture();f.transport.mockImplementation(async(_url,init)=>init?.method==='POST'
  ?new Response('broken json',{headers:{'x-generation-id':'synthetic-header'}}):response({error:{}},404));
 await executePlan(f.options);
 expect(f.transport).toHaveBeenCalledTimes(4);
 expect(f.events.filter(e=>e.type==='lookup-attempt').every(e=>e.providerId==='synthetic-header')).toBe(true);
});
it('over-bound cost remains failed at the original bound and halts the batch',async()=>{
 const f=fixture();f.transport.mockImplementation(async()=>response({id:'synthetic-over',model:prices.routes[0].model,
  provider:'Anthropic',choices:[{finish_reason:'stop'}],usage:{cost:1,prompt_tokens:100,completion_tokens:10}}));
 const result=await executePlan(f.options);
 expect(f.transport).toHaveBeenCalledTimes(1);expect(result.report[0].status).toBe('BOUND_FAILED');
 expect(f.events.at(-1)).toMatchObject({reason:'BOUND_FAILED_NO_REFILL',actualUsd:'1'});
 expect(result.report[0].upperUsd).toBe(plan.manifest.samples[0].upperUsd);
});
it('provider/identity mismatch cannot be used as a matching-route receipt',async()=>{
 const f=fixture();f.transport.mockImplementation(async()=>response({id:'synthetic-wrong',model:'wrong/model',
  provider:'Anthropic',choices:[{finish_reason:'stop'}],usage:{cost:0.001,prompt_tokens:100,completion_tokens:10}}));
 await executePlan(f.options);expect(f.transport).toHaveBeenCalledTimes(1);
 expect(f.events.at(-1)).toMatchObject({reason:'RECEIPT_CONFLICT',actualUsd:null});
});
it('live read-only preflight requires exact snapshot including prices, route and supported parameters',async()=>{
 const route=catalog.routes[2];
 const transport=vi.fn(async()=>response({data:{id:route.model,endpoints:[route.endpoint]}}));
 await verifyCatalog(prices,catalog,route.model,transport);
 expect(transport.mock.calls[0]).toBeDefined();
 const changed=structuredClone(route.endpoint);changed.pricing.prompt='0.00001';
 transport.mockResolvedValue(response({data:{id:route.model,endpoints:[changed]}}));
 await expect(verifyCatalog(prices,catalog,route.model,transport)).rejects.toThrow('CATALOG_DRIFT');
 await expect(verifyCatalog(prices,{},route.model,transport)).rejects.toThrow('CATALOG_HASH');
});
