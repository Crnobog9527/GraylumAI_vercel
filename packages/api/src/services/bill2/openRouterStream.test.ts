/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {describe,it,expect,vi} from 'vitest';
import {createHash,randomBytes} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {decodeOpenRouterStreamObservation} from './openRouterEvidence';
import {openRouterStream,OPENROUTER_STREAM_BYTE_LIMIT} from './openRouterStream';
import {openRouterAdapter} from './openRouterAdapter';
import {openRouterBound} from './openRouterPolicy';
const identity={provider:'openrouter',account:'test',model:'test/model',protocol:'openrouter-chat-v1',providerLimits:{providerSlug:'synthetic',contextTokens:10000,promptUsdPerMillion:'2',completionUsdPerMillion:'0',requestUsd:'0'},outputLimit:100,upperUsd:'0.02'} as const;
const body=JSON.stringify({model:identity.model,stream:true,stream_options:{include_usage:true},store:false,messages:[],max_tokens:100,provider:openRouterBound(identity.providerLimits,identity.outputLimit).routing});
const chunk=(delta:Record<string,unknown>,finish:string|null=null,extra:Record<string,unknown>={})=>JSON.stringify({id:'gen-stream',model:identity.model,choices:[{index:0,delta,finish_reason:finish}],...extra});
const frame=(data:string)=>`data: ${data}\n\n`;
const start=frame(chunk({role:'assistant',content:'你好'}));
const terminal=frame(chunk({content:'正文'},'stop'));
const accounting=frame(chunk({},'stop',{usage:{cost:0.0000012,prompt_tokens:3,completion_tokens:2,total_tokens:5}}));
const end='data: [DONE]\n\n';
const wire=start+terminal+accounting+end;
const adapterFor=(transport:typeof fetch)=>openRouterAdapter({credential:async()=> 'LOCAL_SYNTHETIC_KEY',transport});

describe('bounded SSE aggregation',()=>{
 it('handles split UTF-8/SSE records and repeated terminal usage without a second completion',()=>{
  const observe=vi.fn(),parser=openRouterStream(identity.model,undefined,observe);
  for(const character of ': OPENROUTER PROCESSING\r\n\r\n'+wire.replaceAll('\n','\r\n'))parser.push(character);
  expect(parser.result()).toMatchObject({sdkResponse:{id:'gen-stream',choices:[{message:{content:'你好正文'},finish_reason:'stop'}]},exactUsage:{cost:'0.0000012'}});
  expect(observe).toHaveBeenCalledTimes(3);
 });
 it('isolates throwing observers from receipt collection',()=>{
  const parser=openRouterStream(identity.model,undefined,()=>{throw new Error('observer');});parser.push(wire);
  expect(parser.result()).toHaveProperty('sdkResponse');
 });
 it('assembles first-party tool deltas with unchanged single-tool boundary',()=>{
  const parser=openRouterStream(identity.model);
  parser.push(frame(chunk({tool_calls:[{index:0,id:'call-1',type:'function',function:{name:'read_source',arguments:'{"que'}}]}))+
   frame(chunk({tool_calls:[{index:0,function:{arguments:'ry":"test"}'}}]},'tool_calls'))+end);
  expect(parser.result()).toMatchObject({sdkResponse:{choices:[{message:{tool_calls:[{id:'call-1',function:{name:'read_source',arguments:'{"query":"test"}'}}]}}]}});
 });
 it('preserves summary and encrypted metadata in the private replay projection',()=>{
  const parser=openRouterStream(identity.model);
  parser.push(frame(chunk({reasoning_details:[{type:'reasoning.summary',index:0,format:'openai-responses-v1',summary:'private summary'},{type:'reasoning.encrypted',index:1,format:'openai-responses-v1',id:'rs-1',data:'opaque'}]}))+wire);
  expect(parser.result()).toMatchObject({sdkResponse:{choices:[{message:{reasoning_details:[{type:'reasoning.summary',summary:'private summary'},{type:'reasoning.encrypted',data:'opaque'}]}}]}});
 });
 it.each([
  ['missing DONE',start+terminal],['unfinished line',wire+'data:'],
  ['duplicate JSON key','data: {"id":"gen-a","id":"gen-b"}\n\n'],
  ['malformed choice',frame(chunk({},null,{choices:[{index:1,delta:{}}]}))],
  ['unknown delta',frame(chunk({private_unknown:'no'}))+end],
  ['post-terminal content',start+terminal+start+end],
  ['post-DONE content',wire+start],['duplicate usage',start+terminal+accounting+accounting+end],
  ['unknown tool',frame(chunk({tool_calls:[{index:0,id:'call-x',function:{name:'search',arguments:'{}'}}]},'tool_calls'))+end],
  ['parallel tool',frame(chunk({tool_calls:[{index:1,id:'call-x',function:{name:'read_source',arguments:'{}'}}]},'tool_calls'))+end],
  ['provider stream error',start+frame(JSON.stringify({error:{message:'failed'}}))+end],
 ])('rejects %s without asserting a final receipt',(_name,input)=>{
  const parser=openRouterStream(identity.model);parser.push(input);expect(parser.result()).toHaveProperty('error');expect(parser.result()).not.toHaveProperty('sdkResponse');
 });
 it.each([
  {id:'gen-other'},{model:'other/model'},
 ])('fails closed on body identity conflict %#',patch=>{
  const parser=openRouterStream(identity.model,'gen-stream');parser.push(start+frame(chunk({},null,patch))+end);
  expect(parser.result()).toMatchObject({identityConflict:true,error:'identity_or_response_mismatch'});
 });
});

describe('stream transport and financial evidence',()=>{
 it('delivers actual partial data before completion and preserves exact raw bytes/hash and decimal',async()=>{
  let controller!:ReadableStreamDefaultController<Uint8Array>;let completed=false;
  const transport=vi.fn<typeof fetch>(async()=>new Response(new ReadableStream({start(c){controller=c;}}),{headers:{'X-Generation-Id':'gen-stream'}}));
  const adapter=adapterFor(transport),observe=vi.fn();const send=await adapter.prepareDispatch({input:body},identity,observe);
  const pending=send().then(v=>{completed=true;return v;});
  await Promise.resolve();controller.enqueue(new TextEncoder().encode(start));
  await vi.waitFor(()=>expect(observe).toHaveBeenCalledTimes(1));expect(completed).toBe(false);
  const remaining=terminal+accounting.replace('0.0000012','1.200000000000e-6')+end;controller.enqueue(new TextEncoder().encode(remaining));controller.close();
  const observed=await pending;const evidence=adapter.evidence(observed,identity,'response');
  expect(transport).toHaveBeenCalledTimes(1);expect(transport.mock.calls[0]?.[1]?.body).toBe(body);
  expect(evidence).toMatchObject({final:true,providerId:'gen-stream',cost:'0.0000012',sourceHash:createHash('sha256').update(start+remaining).digest('hex')});
  expect(evidence.transport.rawBody).toBe('');expect(JSON.parse(evidence.rawBody).choices[0].message.content).toBe('你好正文');
  expect(decodeOpenRouterStreamObservation(observed).toString()).toBe(start+remaining);
  expect(()=>send()).toThrow('CAPABILITY_CONSUMED');
 });
 it('retains body identity on interrupted streams and never invents zero cost',async()=>{
  let controller!:ReadableStreamDefaultController<Uint8Array>;
  const transport=vi.fn<typeof fetch>(async()=>new Response(new ReadableStream({start(c){controller=c;}})));
  const adapter=adapterFor(transport),observe=vi.fn(),send=await adapter.prepareDispatch({input:body},identity,observe),pending=send();
  await Promise.resolve();controller.enqueue(new TextEncoder().encode(start));await vi.waitFor(()=>expect(observe).toHaveBeenCalledOnce());controller.error(new Error('disconnect'));
  const observed=await pending;expect(observed).toMatchObject({complete:false,transportIssue:'body_interrupted',rawBody:''});
  expect(adapter.evidence(observed,identity,'response')).toMatchObject({providerId:'gen-stream',cost:null,final:false,evidenceKind:'transport_observation'});expect(transport).toHaveBeenCalledOnce();
 });
 it('latches header/body/lookup disagreement rather than binding a disputed identity',async()=>{
  const adapter=adapterFor(async()=>new Response(wire,{headers:{'X-Generation-Id':'gen-conflict'}}));
  const observation=await adapter.dispatch({input:body},identity);
  expect(adapter.evidence(observation,identity,'response')).toMatchObject({providerId:null,final:false,rejectedReason:'identity_or_response_mismatch'});
  const clean=adapterFor(async()=>new Response(wire)),valid=await clean.dispatch({input:body},identity);
  expect(clean.evidence(valid,identity,'response','gen-wrong')).toMatchObject({providerId:null,rejectedReason:'identity_or_response_mismatch'});
 });
 it('keeps missing usage cost unresolved while preserving usable terminal text',async()=>{
  const adapter=adapterFor(async()=>new Response(start+terminal+end));
  expect(adapter.evidence(await adapter.dispatch({input:body},identity),identity,'response')).toMatchObject({providerId:'gen-stream',cost:null,final:false,costIssue:'missing_cost',usage:{sdkResponse:{choices:[{message:{content:'你好正文'}}]}}});
 });
 it('bounds stream wire bytes separately from nonstream bodies',async()=>{
  const adapter=adapterFor(async()=>new Response(': '+'x'.repeat(OPENROUTER_STREAM_BYTE_LIMIT)));
  const observation=await adapter.dispatch({input:body},identity);expect(decodeOpenRouterStreamObservation(observation)).toHaveLength(OPENROUTER_STREAM_BYTE_LIMIT);
  expect(observation).toMatchObject({complete:false,transportIssue:'body_limit'});
 });
 it.each([{stream:true},{stream:true,stream_options:{include_usage:false}},{stream:false,stream_options:{include_usage:true}}])('rejects unfrozen or unsupported stream options %#',async patch=>{
  const transport=vi.fn();await expect(adapterFor(transport).dispatch({input:JSON.stringify({...JSON.parse(body),stream_options:undefined,...patch})},identity)).rejects.toThrow('REQUEST_DENIED');expect(transport).not.toHaveBeenCalled();
 });
});

it('decodes fragmented multibyte wire text without changing source bytes',async()=>{
 const bytes=new TextEncoder().encode(wire);let at=0;
 const transport=vi.fn<typeof fetch>(async()=>new Response(new ReadableStream({pull(controller){if(at===bytes.length)controller.close();else controller.enqueue(bytes.slice(at,++at));}})));
 const adapter=adapterFor(transport),observe=vi.fn(),send=await adapter.prepareDispatch({input:body},identity,observe),observed=await send();
 expect(decodeOpenRouterStreamObservation(observed).toString()).toBe(wire);expect(adapter.evidence(observed,identity,'response')).toMatchObject({cost:'0.0000012',final:true});expect(observe).toHaveBeenCalledTimes(3);
});
it('requires terminal DONE even if a prior frame claimed final usage',async()=>{
 const adapter=adapterFor(async()=>new Response(start+terminal+accounting));
 expect(adapter.evidence(await adapter.dispatch({input:body},identity),identity,'response')).toMatchObject({providerId:'gen-stream',cost:null,final:false,evidenceKind:'transport_observation',rejectedReason:'incomplete_stream'});
});
it('permits the OpenAI-compatible empty-choice final usage accounting frame',()=>{
 const parser=openRouterStream(identity.model);parser.push(start+terminal+frame(chunk({},null,{choices:[],usage:{cost:0.01}}))+end);
 expect(parser.result()).toMatchObject({exactUsage:{cost:'0.01'},sdkResponse:{choices:[{finish_reason:'stop'}]}});
});
it('uses the same full-generation deadline for streaming keepalives with no POST retry',async()=>{
 vi.useFakeTimers();const timeout=vi.spyOn(AbortSignal,'timeout').mockImplementation(ms=>{const c=new AbortController();setTimeout(()=>c.abort(),ms);return c.signal;});
 let ended=false;const observe=vi.fn();
 const transport=vi.fn<typeof fetch>(async(_url,init)=>new Response(new ReadableStream({start(controller){
  controller.enqueue(new TextEncoder().encode(start));init!.signal!.addEventListener('abort',()=>controller.error(new Error('aborted')),{once:true});
  setTimeout(()=>controller.enqueue(new TextEncoder().encode(': keepalive\n\n')),119_000);
 }})));
 try{
  const adapter=adapterFor(transport),send=await adapter.prepareDispatch({input:body},identity,observe),pending=send().then(v=>{ended=true;return v;});
  await vi.advanceTimersByTimeAsync(119_999);expect(ended).toBe(false);expect(observe).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);const result=await pending;expect(result).toMatchObject({complete:false,transportIssue:'body_timeout'});
  expect(adapter.evidence(result,identity,'response')).toMatchObject({providerId:'gen-stream',cost:null,final:false});expect(transport).toHaveBeenCalledOnce();expect(timeout).toHaveBeenCalledWith(120_000);
 }finally{timeout.mockRestore();vi.useRealTimers();}
});

it('stores more than 512 KiB of normal 4096-delta SSE reversibly within the receipt limit',async()=>{
 const large=Array.from({length:4096},()=>frame(chunk({content:'x'},null,{object:'chat.completion.chunk',created:1}))).join('')+terminal+accounting+end;
 expect(Buffer.byteLength(large)).toBeGreaterThan(524288);
 const adapter=adapterFor(async()=>new Response(large)),observation=await adapter.dispatch({input:body},identity),evidence=adapter.evidence(observation,identity,'response');
 expect(evidence).toMatchObject({final:true,cost:'0.0000012',sourceHash:createHash('sha256').update(large).digest('hex')});
 expect(decodeOpenRouterStreamObservation(evidence.transport).toString()).toBe(large);
 expect(Buffer.byteLength(JSON.stringify(evidence))).toBeLessThan(524288-16384);
});
it.each(['bad gzip','wrong hash','wrong size','oversize inflate'])('rejects %s compressed evidence without claiming final cost',async(mode)=>{
 const adapter=adapterFor(async()=>new Response(wire,{headers:{'X-Generation-Id':'gen-stream'}})),observation=await adapter.dispatch({input:body},identity);
 if(mode==='bad gzip')observation.rawBodyBase64=Buffer.from('not gzip').toString('base64');
 if(mode==='wrong hash')observation.rawBodySha256='0'.repeat(64);
 if(mode==='wrong size')observation.rawBodyByteLength=1;
 if(mode==='oversize inflate')observation.rawBodyBase64=gzipSync(Buffer.alloc(OPENROUTER_STREAM_BYTE_LIMIT+1)).toString('base64');
 expect(adapter.evidence(observation,identity,'response')).toMatchObject({providerId:'gen-stream',cost:null,final:false,rejectedReason:'invalid_stream_encoding'});
});
it.each([false,true])('bounds incompressible evidence while preserving identity conflict=%s',async(conflict)=>{
 // Valid comment frames do not enlarge canonical output, but their entropy can
 // exceed the durable evidence bound even after compression.
 const padding=Array.from({length:1400},()=>': '+randomBytes(512).toString('base64')+'\n\n').join('');
 const large=padding+wire,adapter=adapterFor(async()=>new Response(large,{headers:{'X-Generation-Id':conflict?'gen-conflict':'gen-stream'}}));
 const observation=await adapter.dispatch({input:body},identity),evidence=adapter.evidence(observation,identity,'response');
 expect(evidence).toMatchObject({providerId:conflict?null:'gen-stream',cost:null,final:false,rejectedReason:conflict?'identity_or_response_mismatch':'receipt_size_limit',transport:{rawBodyOmitted:'receipt_size_limit'}});
 if(conflict)expect(evidence).not.toHaveProperty('evidenceKind','transport_observation');
 expect(Buffer.byteLength(JSON.stringify(evidence))).toBeLessThan(4096);
 expect(evidence.sourceHash).toBe(createHash('sha256').update(large).digest('hex'));
});

it.each(['\0','\ud800'])('keeps PostgreSQL-incompatible text as bounded diagnostics instead of losing identity',async(text)=>{
 const input=frame(chunk({content:text}))+terminal+accounting+end;
 const adapter=adapterFor(async()=>new Response(input)),observation=await adapter.dispatch({input:body},identity),evidence=adapter.evidence(observation,identity,'response');
 expect(evidence).toMatchObject({providerId:'gen-stream',cost:null,final:false,rejectedReason:'invalid_receipt_text',transport:{rawBodyOmitted:'invalid_receipt_text'}});
 expect(evidence.rawBody).toBe('');expect(evidence.usage).toBeNull();
});
it('E1 shape: v4 reasoning-only frames up to the deadline stay incomplete, unpriced and dispatched once with frozen bytes',async()=>{
 vi.useFakeTimers();const timeout=vi.spyOn(AbortSignal,'timeout').mockImplementation(ms=>{const c=new AbortController();setTimeout(()=>c.abort(),ms);return c.signal;});
 const frozen=JSON.stringify({...JSON.parse(body),reasoning_effort:'none'}),observed:string[]=[];let ended=false;
 const reasoningOnly=frame(chunk({role:'assistant',content:'',reasoning:'PRIVATE',reasoning_details:[{type:'reasoning.text',index:0,text:'PRIVATE'}]}));
 const transport=vi.fn<typeof fetch>(async(_url,init)=>new Response(new ReadableStream({start(controller){
  const encoder=new TextEncoder();controller.enqueue(encoder.encode(': OPENROUTER PROCESSING\n\n'));
  const tick=setInterval(()=>controller.enqueue(encoder.encode(reasoningOnly)),1_000);
  init!.signal!.addEventListener('abort',()=>{clearInterval(tick);controller.error(new Error('aborted'));},{once:true});
 }}),{headers:{'x-generation-id':'gen-stream'}}));
 try{
  const adapter=adapterFor(transport),send=await adapter.prepareDispatch({input:frozen},identity,chunk=>observed.push(chunk)),pending=send().then(v=>{ended=true;return v;});
  await vi.advanceTimersByTimeAsync(119_999);expect(ended).toBe(false);
  await vi.advanceTimersByTimeAsync(1);const result=await pending;
  expect(result).toMatchObject({complete:false,transportIssue:'body_timeout',generationId:'gen-stream'});
  expect(adapter.evidence(result,identity,'response')).toMatchObject({providerId:'gen-stream',cost:null,final:false});
  expect(observed.length).toBeGreaterThan(100);expect(observed.every(data=>JSON.parse(data).choices[0].delta.content==='')).toBe(true);
  expect(transport).toHaveBeenCalledOnce();expect(transport.mock.calls[0]![1]!.body).toBe(frozen);
 }finally{timeout.mockRestore();vi.useRealTimers();}
});
