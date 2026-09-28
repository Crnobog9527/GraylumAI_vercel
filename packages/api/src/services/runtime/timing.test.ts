/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {it,expect,vi,afterEach} from 'vitest';
import {logger} from '../../lib/logger';
import {createRuntimeBudget,withRuntimeBudget} from './budget';
import {createRequestTiming,currentRequestTiming,timingLabel} from './timing';
afterEach(()=>{vi.restoreAllMocks();});
const clock=()=>{let t=0;return {now:()=>t,advance:(ms:number)=>{t+=ms;}};};
const base='https://project-ref.supabase.co';

it('maps Supabase paths to fixed labels and drops host, query and non-identifier names',()=>{
 expect(timingLabel(base+'/auth/v1/user',true)).toBe('auth/v1/user');
 expect(timingLabel(base+'/auth/v1/token?grant_type=refresh_token',true)).toBe('auth/v1/token');
 expect(timingLabel(base+'/rest/v1/rpc/runtime_admit',true)).toBe('rpc/runtime_admit');
 expect(timingLabel(new URL(base+'/rest/v1/profiles?select=id,email&email=eq.a%40b.test'),true)).toBe('rest/profiles');
 expect(timingLabel(new Request(base+'/rest/v1/modules?id=in.(x)'),true)).toBe('rest/modules');
 expect(timingLabel(base+'/rest/v1/rpc/Robert%27);drop',true)).toBe('rpc/?');
 expect(timingLabel(base+'/rest/v1/'+'a'.repeat(80),true)).toBe('rest/?');
 expect(timingLabel(base+'/storage/v1/object/private/user@example.com/file',true)).toBe('storage/v1');
 expect(timingLabel(base+'/functions/v1/anything?secret=1',true)).toBe('other');
 expect(timingLabel('not a url',true)).toBe('other');
 expect(timingLabel('https://openrouter.ai/api/v1/chat/completions?key=sk-secret',false)).toBe('provider');
});

it('splits round trips into phases, marks the provider POST and restores nested phases',()=>{
 const c=clock(),timing=createRequestTiming(c.now);
 const trip=(label:string,ms:number)=>{const done=timing.begin(label);c.advance(ms);done();};
 trip('auth/v1/user',10);trip('rest/profiles',5);
 timing.enter('policy');trip('rpc/runtime_test_window_policy',7);
 timing.enter('host');trip('rpc/opc_query',3);
 const leave=timing.enter('admission');trip('rest/modules',4);trip('rpc/runtime_admit',6);leave();
 trip('rpc/opc_turn',2);
 timing.enter('execute');trip('rpc/runtime_execution',1);trip('rpc/bill2_dispatch',2);
 c.advance(100);timing.mark('firstModelText');c.advance(20);timing.mark('firstPublicText');timing.mark('firstModelText');
 trip('rpc/bill2_record_receipt',3);
 // Once the provider was called, later phase requests cannot rewrite history.
 timing.enter('policy');trip('rpc/runtime_execution',1);
 const s=timing.summary();
 expect(s.phases).toEqual({
  prelude:{rt:2,rtMs:15,ms:15},policy:{rt:1,rtMs:7,ms:7},host:{rt:2,rtMs:5,ms:5},
  admission:{rt:2,rtMs:10,ms:10},execute:{rt:2,rtMs:3,ms:3},provider:{rt:2,rtMs:4,ms:124},
 });
 expect(s.marks).toEqual({providerPostMs:40,firstModelTextMs:140,firstPublicTextMs:160});
 expect(s.labels['rpc/runtime_execution']).toEqual({rt:2,rtMs:2});
 expect(s).toMatchObject({rt:11,rtMs:44,totalMs:164});
});

it('writes one line only for requests that reached a Runtime or positioning phase',()=>{
 const info=vi.spyOn(logger,'info').mockImplementation(()=>{});
 const ignored=createRequestTiming();ignored.begin('auth/v1/user')();ignored.release();
 expect(info).not.toHaveBeenCalled();
 const timing=createRequestTiming();timing.enter('policy');timing.release();timing.release();
 expect(info).toHaveBeenCalledTimes(1);
 expect(info.mock.calls[0]!.slice(0,2)).toEqual(['api','runtime_request_timing']);
});

it('waits for every streamed procedure in a batch before writing the line',()=>{
 const info=vi.spyOn(logger,'info').mockImplementation(()=>{});
 const timing=createRequestTiming();timing.enter('policy');
 // Route: two batched streams, then its own Response completes.
 timing.retain(2);timing.release();
 timing.release();expect(info).not.toHaveBeenCalled();
 timing.mark('firstPublicText');timing.release();timing.release();
 expect(info).toHaveBeenCalledTimes(1);
 expect((info.mock.calls[0]![2] as {marks:object}).marks).toHaveProperty('firstPublicTextMs');
});

it('logs only labels, counts, milliseconds and internal identifiers',async()=>{
 const secrets=['user@example.com','eyJhbGciOiJIUzI1NiJ9.payload.sig','sk-or-v1-secret','service-role-key',
  '我想做一个摄影自媒体账号','SKILL.md instructions','mentor reply text','refresh_token','grant_type'];
 const info=vi.spyOn(logger,'info').mockImplementation(()=>{});
 const budget=createRuntimeBudget(),execution='6f9d7c9e-3c1a-4b8e-9f00-1234567890ab';
 const transport=vi.fn<typeof fetch>(async()=>new Response(JSON.stringify({message:secrets[6],email:secrets[0]})));
 const database=withRuntimeBudget(budget,transport,true),provider=withRuntimeBudget(budget,transport);
 const auth={headers:{Authorization:'Bearer '+secrets[1],apikey:secrets[3]}};
 budget.timing.setProcedures(['opc.prepareStep','bad path?input='+secrets[0],{email:secrets[0]}]);
 await database(base+'/auth/v1/token?grant_type=refresh_token&email='+encodeURIComponent(secrets[0]),{method:'POST',...auth,body:secrets[2]});
 budget.timing.enter('host');
 await database(base+'/rest/v1/profiles?email=eq.'+encodeURIComponent(secrets[0]),auth);
 await budget.timing.run(async()=>{
  const leave=currentRequestTiming()?.enter('admission');
  await database(base+'/rest/v1/rpc/runtime_admit',{method:'POST',...auth,body:JSON.stringify({input:secrets[4],skill:secrets[5]})});
  leave?.();
 });
 budget.timing.tagExecution(execution);budget.timing.tagExecution(secrets[0]);budget.timing.tagExecution({id:execution});
 await database(base+'/rest/v1/rpc/bill2_dispatch',{method:'POST',...auth});
 await provider('https://openrouter.ai/api/v1/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+secrets[2]},body:secrets[4]});
 budget.timing.mark('firstModelText');budget.timing.mark('firstPublicText');
 budget.timing.release();
 expect(info).toHaveBeenCalledTimes(1);
 const line=JSON.stringify(info.mock.calls[0]);
 for(const secret of secrets)expect(line).not.toContain(secret);
 expect(line).not.toMatch(/https?:|supabase\.co|openrouter\.ai|[?&=@]/);
 const record=info.mock.calls[0]![2] as Record<string,unknown>;
 expect(Object.keys(record).sort()).toEqual(['executionIds','labels','marks','phases','procedures','rt','rtMs','totalMs']);
 expect(record.procedures).toEqual(['opc.prepareStep']);
 expect(record.executionIds).toEqual([execution]);
 expect(Object.keys(record.labels as object).sort()).toEqual(['auth/v1/token','provider','rest/profiles','rpc/bill2_dispatch','rpc/runtime_admit']);
 expect(Object.keys(record.phases as object)).toEqual(['prelude','host','admission','provider']);
 // Every leaf is a number or an allowlisted identifier.
 const leaves=(value:unknown):unknown[]=>value&&typeof value==='object'?Object.values(value).flatMap(leaves):[value];
 for(const leaf of leaves(record))expect(typeof leaf==='number'||/^([a-z]+\.[a-zA-Z]+|[0-9a-f-]{36})$/.test(String(leaf))).toBe(true);
});

it('never fails a transport call when the recorder itself fails',async()=>{
 const budget=createRuntimeBudget(),response=new Response('{}');
 const transport=vi.fn<typeof fetch>(async()=>response);
 const begin=vi.spyOn(budget.timing,'begin').mockImplementation(()=>{throw new Error('recorder broken');});
 expect(await withRuntimeBudget(budget,transport,true)(base+'/rest/v1/rpc/x',{method:'POST'})).toBe(response);
 begin.mockImplementation(()=>()=>{throw new Error('recorder broken');});
 expect(await withRuntimeBudget(budget,transport,true)(base+'/rest/v1/rpc/x',{method:'POST'})).toBe(response);
 expect(transport).toHaveBeenCalledTimes(2);
});

it('keeps the transport call identical and swallows recorder and log failures',async()=>{
 vi.spyOn(logger,'info').mockImplementation(()=>{throw new Error('log sink down');});
 let broken=false;
 const budget=createRuntimeBudget(()=>{if(broken)throw new Error('clock broken');return 0;});
 const response=new Response('{}'),failure=new TypeError('network');
 const transport=vi.fn<typeof fetch>(async()=>response);
 const init={method:'POST',headers:{'x-a':'1'},body:'exact bytes'};
 expect(await withRuntimeBudget(budget,transport,true)(base+'/rest/v1/rpc/x',init)).toBe(response);
 expect(transport.mock.calls[0]![0]).toBe(base+'/rest/v1/rpc/x');
 expect(transport.mock.calls[0]![1]).toMatchObject(init);
 transport.mockRejectedValueOnce(failure);
 await expect(withRuntimeBudget(budget,transport,true)(base+'/rest/v1/rpc/x',init)).rejects.toBe(failure);
 budget.timing.enter('policy');
 broken=true;
 expect(()=>{budget.timing.begin('rpc/x')();budget.timing.enter('host')();budget.timing.mark('firstModelText');budget.timing.release();}).not.toThrow();
});
