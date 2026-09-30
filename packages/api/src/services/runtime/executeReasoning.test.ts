/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {it,expect,vi} from 'vitest';
import {runtimeExecutor,runtimeContext} from './execute';
const id='10000000-0000-4000-8000-000000000001';
const base={version:'runtime.v1',sdkVersion:'0.18.0',role:'ordinary',input:'hello',instructions:'Answer',model:'m/x',maxOutputTokens:4096,maxTurns:1,historyItems:0,tools:[],network:'deny'};
it.each([
 ...[undefined,'serial-tools-v1','serial-tools-v2','serial-tools-v3-stream'].flatMap(providerRequestFormat=>[
  {providerRequestFormat,reasoning:{parameter:'none'}},
  {providerRequestFormat,attachedOrganizer:{modelId:id,model:'o/x',maxOutputTokens:4096,reasoning:{parameter:'reasoning',value:{enabled:false}}}},
 ]),
 ...['serial-tools-v4-stream','agent-turn-v5-stream','serial-tools-v6-reasoning'].map(providerRequestFormat=>({providerRequestFormat})),
])('executor refuses incompatible reasoning before billing or SDK %#',async patch=>{
 const database={rpc:vi.fn(async()=>({data:{state:'running',context:{...base,...patch}},error:null}))};
 const adapter={dispatch:vi.fn()};
 await expect(runtimeExecutor({database,actor:async()=>id,adapter:adapter as any}).execute(id)).rejects.toThrow('RUNTIME_CONTEXT_INVALID');
 expect(database.rpc).toHaveBeenCalledTimes(1);expect(adapter.dispatch).not.toHaveBeenCalled();
});
it.each([{effort:'none'},{parameter:'none'},{parameter:'reasoning',value:{enabled:false}},{parameter:'reasoning',value:{effort:'max'}},{parameter:'reasoning',value:{max_tokens:2048}}])('context parses frozen policy %# including attached organizer',reasoning=>{
 expect(runtimeContext.parse({...base,providerRequestFormat:'serial-tools-v4-stream',reasoning,attachedOrganizer:{modelId:id,model:'o/x',maxOutputTokens:4096,reasoning}}).reasoning).toEqual(reasoning);
});
it.each([{parameter:'reasoning',value:{enabled:true}},{parameter:'reasoning',value:{effort:'high',max_tokens:1}},{parameter:'none',effort:'none'}])('context rejects malformed policy %#',reasoning=>{
 expect(runtimeContext.safeParse({...base,reasoning}).success).toBe(false);
 expect(runtimeContext.safeParse({...base,attachedOrganizer:{modelId:id,model:'o/x',maxOutputTokens:4096,reasoning}}).success).toBe(false);
});
it.each([20000,128000])('reads existing frozen output %s without applying the new configuration cap',maxOutputTokens=>{
 const frozen={...base,maxOutputTokens,purposeBudget:{purpose:'interactive',inputBytes:64000,historyItems:0}};
 expect(runtimeContext.parse(frozen)).toEqual({...frozen,maxToolCalls:0});
});
