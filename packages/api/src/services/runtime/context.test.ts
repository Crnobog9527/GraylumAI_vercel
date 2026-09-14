/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect,it } from 'vitest';
import { selectRuntimeHistory,assertRuntimeRequestCapacity,fixtureInputCapacity } from './context';
it('retains complete required instructions/input and original history while selecting a bounded suffix',()=>{
 const history=[{role:'user',content:'old'.repeat(1000)},{role:'assistant',content:'recent'}],copy=structuredClone(history),incoming=[{role:'user',content:'new'}];
 const selected=selectRuntimeHistory(history,incoming,{instructions:'required method',inputBytes:1500,historyItems:20,toolBytes:0});
 expect(selected).toEqual([history[1],...incoming]);expect(history).toEqual(copy);
 expect(selectRuntimeHistory(history,incoming,{instructions:'method',inputBytes:1500,historyItems:0,toolBytes:0})).toEqual(incoming);
});
it('reserves output capacity per fixture model before selecting input',()=>{
 expect(fixtureInputCapacity(4096,1024,10000)).toBe(3072);
 expect(fixtureInputCapacity(100000,1024,10000)).toBe(10000);
 for(const args of [[100,100,10000],[0,100,10000],[1000,NaN,10000]])expect(()=>fixtureInputCapacity(...args as [number,number,number])).toThrow('RUNTIME_MODEL_CAPACITY');
});
it('rejects oversized complete methods and multi-byte actual request including tools',()=>{
 expect(()=>selectRuntimeHistory([],[],{instructions:'方法'.repeat(1000),inputBytes:1500,historyItems:20,toolBytes:0})).toThrow('REQUIRED_CONTEXT');
 expect(()=>assertRuntimeRequestCapacity(JSON.stringify({tools:[{description:'方法'.repeat(100)}]}),300)).toThrow('COMPLETE_REQUEST');
});

it('keeps interleaved SDK tool calls and results indivisible at item and byte boundaries',()=>{
 const history=[{type:'function_call',callId:'a',arguments:'{}'},{type:'function_call',callId:'b',arguments:'{}'},
  {type:'function_call_result',callId:'a',output:'large'.repeat(200)},{type:'function_call_result',callId:'b',output:'ok'},
  {role:'assistant',content:'answer'}];
 const options={instructions:'method',inputBytes:10000,historyItems:4,toolBytes:0},copy=structuredClone(history);
 expect(selectRuntimeHistory(history,[],options)).toEqual([history[4]]);
 expect(selectRuntimeHistory(history,[],{...options,historyItems:5,inputBytes:1300})).toEqual([history[4]]);
 expect(selectRuntimeHistory(history,[],{...options,historyItems:5})).toEqual(history);
 expect(history).toEqual(copy);
 expect(selectRuntimeHistory(history.slice(2),[],options)).toEqual([]);
 expect(selectRuntimeHistory(history.slice(0,2),[],options)).toEqual([]);
});
