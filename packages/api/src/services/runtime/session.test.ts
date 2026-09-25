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
