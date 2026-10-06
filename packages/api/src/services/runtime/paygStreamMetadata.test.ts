/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import prices from '../../../../../scripts/payg-profile/plan-prices.json';
import manifest from '../../../../../docs/launch/evidence/payg-profile-20261006-r9.manifest.json';
import {r8Request,r8Scopes} from '../../../../../scripts/payg-profile/r8-requests';
import {priceSchema} from '../../../../../scripts/payg-profile/sampling';
import {identityFor,observationEvent} from '../../../../../scripts/payg-profile/executor';
import {openRouterAdapter} from '../bill2/openRouterAdapter';
const sample=manifest.samples[0],route=priceSchema.parse(prices).routes.find(r=>r.model===sample.model)!;
const {body}=r8Request(route,4096,8192,r8Scopes[0],0);
const base={id:'synthetic-stream-id',model:route.model};
const frame=(extra:Record<string,unknown>)=>'data: '+JSON.stringify({...base,...extra})+'\n\n';
const start=frame({provider:'Anthropic',choices:[{index:0,delta:{role:'assistant',content:'Synthetic'},finish_reason:null}]});
const finish=(reason='stop',native?:string)=>frame({choices:[{index:0,delta:{content:' output'},finish_reason:reason,
 ...(native?{native_finish_reason:native}:{})}]});
const usage=(cost:number|undefined=0.000012345678)=>frame({choices:[],usage:{prompt_tokens:123,completion_tokens:456,
 total_tokens:579,...(cost===undefined?{}:{cost}),completion_tokens_details:{reasoning_tokens:50}}});
const done='data: [DONE]\n\n';
async function observe(wire:string){
 const bytes=new TextEncoder().encode(wire);
 const transport=vi.fn(async()=>new Response(new ReadableStream({start(controller){
  for(let i=0;i<bytes.length;i+=7)controller.enqueue(bytes.slice(i,i+7));controller.close();
 }}),{headers:{'content-type':'text/event-stream'}}));
 const adapter=openRouterAdapter({credential:async()=>'SYNTHETIC_ONLY',transport,allowAgentTools:true});
 const identity=identityFor(sample,prices);
 const raw=await adapter.dispatch({input:body},identity);
 return observationEvent(adapter,raw,identity,'response',sample);
}
it('uses provider/terminal/usage across fragmented SSE and generation ID from the stream without a header',async()=>{
 const wire=start+finish()+usage()+done,event=await observe(wire);
 expect(event).toMatchObject({providerId:base.id,providerName:'Anthropic',finishReason:'stop',final:true,
  costUsd:'0.000012345678',nativePromptTokens:123,nativeCompletionTokens:456,reasoningTokens:50,rejected:null});
 expect(event.sourceHash).toBe(createHash('sha256').update(wire).digest('hex'));
});
it.each(['Other Provider',123,''])('conflicting or malformed provider %s is never adopted',async(provider)=>{
 const e=await observe(start+frame({provider,choices:[]})+finish()+usage()+done);
 expect(e.providerName).toBeNull();expect(e.rejected).toBe('identity_or_response_mismatch');
});
it('missing provider stays unknown without inventing the manifest provider',async()=>{
 const e=await observe(start.replace('"provider":"Anthropic",','')+finish()+usage()+done);
 expect(e.providerName).toBeNull();expect(e.costUsd).toBe('0.000012345678');
});
it('generation identity conflict refuses terminal evidence',async()=>{
 const e=await observe(start+finish().replace(base.id,'synthetic-other')+usage()+done);
 expect(e.rejected).toBe('identity_or_response_mismatch');expect(e.final).toBe(false);
});
it.each([start+finish()+usage(),start+finish()+usage()+done+'data: {}\n\n'])(
 'incomplete or trailing stream cannot certify metadata',async(wire)=>{
  const e=await observe(wire);expect(e.final).toBe(false);expect(e.providerName).toBeNull();
 });
it.each([['content_filter',undefined],['stop','refusal']] as const)('preserves refusal %s/%s',async(reason,native)=>{
 expect((await observe(start+finish(reason,native)+usage()+done)).contentRefused).toBe(true);
});
it('missing cost retains validated metadata but requires original-ID accounting',async()=>{
 const e=await observe(start+finish()+usage().replace(/,"cost":[^,}]+/,'')+done);
 expect(e.final).toBe(false);expect(e.costUsd).toBeNull();expect(e.providerId).toBe(base.id);expect(e.providerName).toBe('Anthropic');
});
