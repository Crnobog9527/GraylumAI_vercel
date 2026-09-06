import { describe,it,expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { connectLocalAgentKey, creditsToUnits } from '../research/agentKey';
import { localMcpFixture } from './fixtures/agentKeyServer';
import type { ResearchStore,OperationRecord } from '../research/store';

const fixture=(mode:'json'|'sse'='json')=>localMcpFixture(testStore(),mode);
function testStore():ResearchStore {
 const records=new Map<string,OperationRecord>();let available=0,cancelled=false;
 return {
  async create(_id,budget){available=budget;},async get(_p,o){return records.get(o)??null;},
  async reserve(_p,o,identityHash,quote){if(cancelled||quote>available)throw new Error('BUDGET');if(records.has(o))return {...records.get(o)!,claimed:false};available-=quote;const r:OperationRecord={state:'prepared',claimed:true,identityHash,token:randomUUID()};records.set(o,r);return r;},
  async dispatch(_p,o){const r=records.get(o)!;if(cancelled||r.state!=='prepared')return false;r.state='dispatched';return true;},
  async finish(_p,o,_t,state,result){records.set(o,{...records.get(o)!,state,result});},async cancel(){cancelled=true;},
 };
}
const input=()=>({planId:randomUUID(),operationId:randomUUID(),capability:'search',params:{query:'synthetic query'}});
describe('actual official SDK MCP transport; synthetic supplier fixtures',()=>{
 it.each(['json','sse'] as const)('initializes, lists, discovers, describes and executes via %s then closes',async mode=>{
  const f=await fixture(mode);try{const a=await f.connect();expect(await a.discover('test')).toEqual(['search']);const i=input();await a.createPlan(i.planId,2,[i]);const r=await a.execute(i);expect(r.state).toBe('succeeded');expect(r.result?.fixture).toBe(true);expect(r.result?.cost.actual).toBeNull();expect(f.events.filter(x=>['find','describe','execute'].includes(x))).toEqual(['find','describe','execute']);
   const recovered=await a.execute(i);expect(recovered.recovered).toBe(true);expect(f.events.filter(x=>x==='execute')).toHaveLength(1);
   await expect(a.execute({...i,params:{query:'different'}})).rejects.toThrow('OPERATION_CONFLICT');await a.close();expect(f.events).toContain('close');
  }finally{await f.stop();}
 });
 it.each(['schema','quote','missing-price','execute-as','params','budget','denied','cancelled'])('prevents execute on %s failure',async kind=>{
  const f=await fixture();try{const a=await f.connect();await a.discover('test');const i=input();await a.createPlan(i.planId,kind==='budget'?0.5:2,[i]);
   if(kind==='schema')f.setDescription({schema:{type:'string'}});
   if(kind==='quote')f.setDescription({creditsPerCall:2});
   if(kind==='missing-price')f.setDescription({creditsPerCall:undefined});
   if(kind==='execute-as')f.setDescription({executeAs:{name:'Unreviewed/Write'}});
   if(kind==='params')i.params={query:'x'.repeat(101)};
   if(kind==='denied')f.authorize.mockRejectedValue(new Error('denied'));
   if(kind==='cancelled')await a.cancel(i.planId);
   await expect(a.execute(i)).rejects.toThrow();expect(f.events.filter(x=>x==='execute')).toHaveLength(0);await a.close();
  }finally{await f.stop();}
 });
 it.each(['error','timeout','disconnect','oversize'] as const)('preserves %s outcome without retry',async kind=>{
  const f=await fixture('sse');try{const a=await f.connect();await a.discover('test');const i=input();await a.createPlan(i.planId,2,[i]);f.setBehavior(kind);const r=await a.execute(i);expect(r.state).toBe(kind==='error'?'failed':'unknown');await a.execute(i);expect(f.events.filter(x=>x==='execute')).toHaveLength(1);await a.close().catch(()=>{});
  }finally{await f.stop();}
 });
 it('rejects nonlocal injected endpoint without any request',async()=>{
  await expect(connectLocalAgentKey({} as never,new URL('https://api.agentkey.app/v1/mcp'))).rejects.toThrow('LOCAL_ENDPOINT_REQUIRED');
 });
 it('retains dispatched state when saving fails and never reexecutes',async()=>{
  const f=await fixture();try{const original=f.store.finish;f.store.finish=async()=>{throw new Error('save unavailable');};const a=await f.connect();await a.discover('test');const i=input();await a.createPlan(i.planId,2,[i]);await expect(a.execute(i)).rejects.toThrow('save unavailable');f.store.finish=original;expect((await a.execute(i)).state).toBe('dispatched');expect(f.events.filter(x=>x==='execute')).toHaveLength(1);await a.close();}finally{await f.stop();}
 });
});

describe('exact decimal AgentKey credit units',()=>{
 it.each([[0,0],[0.000001,1],[0.000123,123],[0.001001,1001],[1.000001,1000001],[1000,1000000000]])('converts %s to %s units',(credits,expected)=>{
  expect(creditsToUnits(credits)).toBe(expected);
 });
 it.each([0.0000001,0.0001234,1.0000001,0.1+0.2,-0.000001,NaN,Infinity,-Infinity,1000.000001,Number.MIN_VALUE])('rejects unrepresentable or out-of-range %s',credits=>{
  expect(()=>creditsToUnits(credits)).toThrow('PRICE_UNEXPLAINED');
 });
});
