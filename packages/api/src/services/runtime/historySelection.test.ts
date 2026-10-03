/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {expect,it} from 'vitest';
import {selectBlockHistory,validateBlockCall,type HistoryOptions} from './historySelection';
import {selectRuntimeHistory} from './context';
import {freezeHistorySelection} from './hostTurn';
import {PostgresSession} from './session';
const history = (count: number, width = 100) => Array.from({length: count}, (_, i) =>
  ({role: i % 2 ? 'assistant' : 'user', content: String(i + 1).padStart(width, 'x')}));
const incoming = [{role: 'user', content: 'hello'}];
const revisions = (count: number) => Array.from({length: count}, (_, i) => i + 1);
const options = (count: number): HistoryOptions => ({instructions: 'fixed', inputBytes: 10000,
  historyItems: 32, toolBytes: 150, historySelection: {...freezeHistorySelection(), currentReserveBytes: 1000},
  revisions: revisions(count)});
const chosen = (h: unknown[], input = incoming, o = options(h.length)) => selectBlockHistory(h, input, o).slice(0, -input.length);

it('G1: 1–48 selects 17–48; session replay, per-call and repeated SQL freeze retain exactly 17–48', async () => {
  const h = history(48), o = options(48), first = chosen(h, incoming, o);
  expect(first).toEqual(h.slice(16));
  const replay = chosen(first, incoming, {...o, revisions: revisions(48).slice(16)});
  expect(replay).toEqual(first);
  expect(validateBlockCall([...first, ...incoming], 32, o)).toEqual([...first, ...incoming]);
  let frozen: unknown;
  const session = new PostgresSession({rpc: async (_name, args) => {
    if (args.p_action === 'read') return {data: h.map((item,i) => ({revision:i+1,item})),error:null};
    if (frozen) expect(args.p_items).toEqual(frozen);
    frozen = args.p_items; return {data:true,error:null};
  }}, {actorId:'10000000-0000-4000-8000-000000000001', sessionId:'10000000-0000-4000-8000-000000000002',
    executionId:'10000000-0000-4000-8000-000000000003'});
  const read = await session.getItems();
  expect(session.getHistoryRevisions()).toEqual(revisions(48));
  await session.freezeHistoryItems(chosen(read)); await session.freezeHistoryItems(chosen(read));
  expect(frozen).toEqual(revisions(48).slice(16));
});
it.each(['count', 'bytes', 'both'])('normal cuts never retreat with alternating inputs/material sizes: %s', mode => {
  let cut = 0;
  for (let count = 40; count < 200; count += 2) {
    const h = history(count), input = [{role:'user',content:'x'.repeat(count % 4 ? 10 : 700)}];
    const o = {...options(count), historyItems:mode==='bytes'?1000:32, inputBytes:mode==='count'?100000:6800};
    const selected = chosen(h,input,o), start = selected.length ? h.findIndex(item => item === selected[0]) : count;
    expect(start).toBeGreaterThanOrEqual(cut); cut=start;
    expect(chosen(selected,input,{...o,revisions:o.revisions!.slice(start)})).toEqual(selected);
  }
});
it('fixed reservation loss: scaled 100 capacity / 80 history / 10 current / 70 reserve keeps 65–80', () => {
  const h=history(80,200), current=[{role:'user',content:'x'.repeat(2000)}];
  const o={...options(80),historyItems:100,inputBytes:22000,
    historySelection:{...freezeHistorySelection(),currentReserveBytes:15500}};
  expect(selectRuntimeHistory(h,current,o).length-current.length).toBe(80);
  expect(chosen(h,current,o)).toEqual(h.slice(64));
});
it.each([false,true])('J1: fallback aligns before freezing, then replays empty/nonempty history (%s)', keepLater => {
  const h=[{role:'user',content:'x'.repeat(3000)},{role:'assistant',content:'ok'},
    ...(keepLater?[{role:'user',content:'next'},{role:'assistant',content:'yes'}]:[])];
  const current=[{role:'user',content:'x'.repeat(1200)}];
  const o={...options(h.length),inputBytes:2500,historyItems:10,toolBytes:0};
  const old=selectRuntimeHistory(h,current,o).slice(0,-1);
  expect(old[0]).toEqual(h[1]);
  const first=chosen(h,current,o);
  expect(first).toEqual(keepLater?h.slice(2):[]);
  expect(chosen(first,current,{...o,revisions:o.revisions!.slice(h.length-first.length)})).toEqual(first);
  expect(validateBlockCall([...first,...current],first.length,o)).toEqual([...first,...current]);
});
it('empty history that cannot fit fails; per-call overflow never deletes frozen history', () => {
  expect(()=>chosen([], [{role:'user',content:'x'.repeat(5000)}], {...options(0),inputBytes:2500}))
    .toThrow('RUNTIME_REQUIRED_CONTEXT_EXCEEDS_CAPACITY');
  const h=history(32);
  expect(()=>validateBlockCall([...h,{role:'user',content:'x'.repeat(10000)}],32,options(32)))
    .toThrow('RUNTIME_REQUIRED_CONTEXT_EXCEEDS_CAPACITY');
  expect(()=>validateBlockCall(h.slice(1),31,options(32))).toThrow('RUNTIME_HISTORY_SELECTION');
});
it('SQL window beginning with orphan result, gaps and unavailable blocks select a safe proven block', () => {
  const h=[{type:'function_call_result',callId:'orphan',output:'ok'},...history(64)];
  const rev=[31,...Array.from({length:64},(_,i)=>i+33)];
  const selected=chosen(h,incoming,{...options(h.length),revisions:rev});
  expect(selected).toEqual(h.slice(33));
  const gapped=history(48), gaps=revisions(48).map(r=>r>16?r+32:r);
  expect(chosen(gapped,incoming,{...options(48),revisions:gaps})).toEqual(gapped.slice(16));
});
it('cuts never split interleaved tool dependencies and incomplete tails degrade to empty', () => {
  const h=[{role:'user',content:'start'},{type:'function_call',callId:'a'},
    {role:'user',content:'inside'},{type:'function_call',callId:'b'},
    {type:'function_call_result',callId:'a'},{type:'function_call_result',callId:'b'},
    {role:'user',content:'safe'},{role:'assistant',content:'reply'}];
  expect(chosen(h,incoming,{...options(8),historyItems:6,
    historySelection:{...freezeHistorySelection(),currentReserveBytes:1}})).toEqual(h.slice(6));
  expect(chosen(h.slice(0,4))).toEqual([]);
});
it('frozen settings survive changed admission defaults; cache availability cannot change history', () => {
  const h=history(80), frozen=options(80);
  const baseline=chosen(h,incoming,frozen);
  const changedDefaults={...freezeHistorySelection(),currentReserveBytes:80000};
  expect(changedDefaults).not.toEqual(frozen.historySelection);
  for(const mode of ['v2','gemini','no-write-price','off'])
    expect(chosen(h,incoming,JSON.parse(JSON.stringify(frozen))), mode).toEqual(baseline);
});
it('fallback does not affect the next normal selection and exact capacity includes 150 marker bytes', () => {
  const h=history(48), o=options(48), normal=chosen(h,incoming,o);
  chosen(h,[{role:'user',content:'x'.repeat(5000)}],o);
  expect(chosen(h,incoming,o)).toEqual(normal);
  const inputBytes=Buffer.byteLength(JSON.stringify({instructions:'fixed',messages:incoming}))+150+1024;
  expect(chosen([],incoming,{...o,revisions:[],inputBytes,historySelection:{...o.historySelection,currentReserveBytes:1}})).toEqual([]);
  expect(()=>chosen([],incoming,{...o,revisions:[],inputBytes:inputBytes-1,historySelection:{...o.historySelection,currentReserveBytes:1}}))
    .toThrow('RUNTIME_REQUIRED_CONTEXT_EXCEEDS_CAPACITY');
});
it('available SQL windows slide by historyItems+128 without moving a normal cut backwards',()=>{
 let previous=0;
 for(let count=160;count<=220;count+=2){
  const all=history(count),windowStart=Math.max(0,count-160),window=all.slice(windowStart);
  const o={...options(window.length),revisions:revisions(count).slice(windowStart)};
  const selected=chosen(window,incoming,o),index=all.findIndex(item=>item===selected[0]);
  expect(index).toBeGreaterThanOrEqual(previous);previous=index;
  expect(Number((selected[0] as {content:string}).content.replace(/^x+/,''))%16).toBe(1);
 }
});
it('material projection is measured before selection, not the superseded full body',()=>{
 const h=history(48,5000),projectHistoryItem=(item:unknown)=>({...item as object,content:'small'});
 const o={...options(48),projectHistoryItem};
 const selected=chosen(h,incoming,o);expect(selected).toEqual(h.slice(16));
 expect(validateBlockCall([...selected,...incoming],32,o).slice(0,32)).toEqual(selected.map(projectHistoryItem));
});
