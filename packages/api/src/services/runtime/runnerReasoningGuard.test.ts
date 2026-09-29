/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {it,expect,vi,afterEach} from 'vitest';
import {runRuntime} from './runner';
import type {ReasoningPolicy} from './reasoningPolicy';
// Intercept the actual SDK request immediately before guardedFetch, not the guard itself.
const attack=vi.hoisted(()=>({patch:null as Record<string,unknown>|null}));
vi.mock('openai',async importOriginal=>{
 const original=await importOriginal<typeof import('openai')>();
 return {...original,default:class extends original.default{
  constructor(options:any){
   const guarded=options.fetch;
   super({...options,fetch:(url:any,init:any)=>{
    const body=JSON.parse(init.body);
    if(attack.patch){delete body.reasoning;delete body.reasoning_effort;Object.assign(body,attack.patch);}
    return guarded(url,{...init,body:JSON.stringify(body)});
   }});
  }
 }};
});
afterEach(()=>{attack.patch=null;});
const session={getSessionId:async()=> 'synthetic',getItems:async()=>[],addItems:async()=>{},popItem:async()=>undefined,clearSession:async()=>{}};
function run(reasoning:ReasoningPolicy,exchange:any){
 return runRuntime({model:'m/x',instructions:'Answer',input:'hello',session,maxOutputTokens:4096,maxTurns:1,tools:[],selectHistory:async(_h,i)=>i,exchange,reasoning});
}
it.each([{}, {reasoning:{enabled:true}}, {reasoning:{enabled:false,exclude:true}}, {reasoning_effort:'none'}, {reasoning:{enabled:false},reasoning_effort:'none'}])('guard refuses changed SDK reasoning before exchange %#',async patch=>{
 attack.patch=patch;const exchange=vi.fn();
 await expect(run({parameter:'reasoning',value:{enabled:false}},exchange)).rejects.toThrow('RUNTIME_EXECUTION_PENDING');
 expect(exchange).not.toHaveBeenCalled();
});
it('guard uses deep equality rather than object identity',async()=>{
 attack.patch={reasoning:{enabled:false}};
 const exchange=vi.fn(async()=>JSON.stringify({id:'local',object:'chat.completion',created:1,model:'m/x',choices:[{index:0,message:{role:'assistant',content:'ok'},finish_reason:'stop'}]}));
 expect(await run({parameter:'reasoning',value:{enabled:false}},exchange)).toBe('ok');
 expect(exchange).toHaveBeenCalledTimes(1);
});
it.each([{parameter:'none'}, {effort:'none'}] as const)('guard refuses reasoning objects on default/legacy policy %#',async reasoning=>{
 attack.patch={reasoning:{enabled:false}};const exchange=vi.fn();
 await expect(run(reasoning,exchange)).rejects.toThrow('RUNTIME_EXECUTION_PENDING');
 expect(exchange).not.toHaveBeenCalled();
});
