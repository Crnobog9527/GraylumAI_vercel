/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { randomUUID } from 'node:crypto';
import { expect,it } from 'vitest';
import { PostgresSession } from './session';

it('freezes the exact selected Session revisions instead of a suffix with the same count',async()=>{
 const calls:Array<{name:string;args:Record<string,unknown>}> = [];
 const items=[{role:'user',content:'first'},{role:'assistant',content:'middle'},{role:'user',content:'last'}];
 const session=new PostgresSession({rpc:async(name,args)=>{
  calls.push({name,args});
  return {data:args.p_action==='read'?items.map((item,index)=>({revision:index+11,item})):args.p_items,error:null};
 }},{actorId:randomUUID(),sessionId:randomUUID(),executionId:randomUUID()});
 const loaded=await session.getItems();
 await session.freezeHistoryItems([loaded[0],loaded[2]]);
 expect(calls.at(-1)?.args.p_items).toEqual([11,13]);
 await expect(session.freezeHistoryItems([structuredClone(loaded[0])])).rejects.toThrow('RUNTIME_HISTORY_SELECTION');
});

it('sends the older-history warning atomically with the exact frozen revisions',async()=>{
 const item={role:'user',content:'Latest synthetic turn'},calls:Record<string,unknown>[]=[];
 const session=new PostgresSession({rpc:async(_name,args)=>{
  calls.push(args);return {data:args.p_action==='read'?[{revision:7,item}]:args.p_items,error:null};
 }},{actorId:randomUUID(),sessionId:randomUUID(),executionId:randomUUID()});
 const items=await session.getItems();await session.freezeHistoryItems(items,true);
 expect(calls.at(-1)).toMatchObject({p_action:'freeze',p_items:{revisions:[7],historyOmitted:true}});
});
// DB-PERF (PR-6 A): consecutive batches in one call; the append ordinal continues after them.
it('writes consecutive batches in one call and continues the batch ordinal',async()=>{
 const calls:Array<Record<string,unknown>>=[];
 const db={rpc:async(name:string,args:Record<string,unknown>)=>{calls.push({name,...args});return {data:null,error:null};}};
 const id='10000000-0000-4000-8000-000000000001';
 const session=new PostgresSession(db,{actorId:id,sessionId:id,executionId:id});
 await session.addItemBatches([[{role:'user',content:'a'}],[{role:'user',content:'b'}]]);
 await session.addItems([{role:'user',content:'c'}]);
 expect(calls.map(c=>[c.p_action,c.p_batch,c.p_items])).toEqual([
  ['append_batches',0,[[{role:'user',content:'a'}],[{role:'user',content:'b'}]]],['append',2,[{role:'user',content:'c'}]]]);
});
