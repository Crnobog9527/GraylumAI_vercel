import { describe,it,expect,vi } from 'vitest';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/server';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { z } from 'zod';
import { connectLocalAgentKey, contractHash, type ProviderContract } from '../research/agentKey';
import type { ResearchStore,OperationRecord } from '../research/store';

const schema={type:'object',properties:{query:{type:'string',maxLength:100}},required:['query'],additionalProperties:false};
// All envelopes below are synthetic. Official docs do not specify these full shapes.
const contract:ProviderContract={
 discovery:v=>z.object({names:z.array(z.string())}).parse(v),
 description:v=>z.object({name:z.string(),schema:z.record(z.string(),z.unknown()),creditsPerCall:z.number(),executeAs:z.unknown().optional()}).parse(v),
 result:v=>z.object({objects:z.array(z.object({id:z.string(),fields:z.record(z.string(),z.unknown()),missingFields:z.array(z.string()),observedAt:z.string().nullable()})),pagination:z.object({complete:z.boolean(),nextCursor:z.string().nullable()}),actualCredits:z.number().nullable()}).parse(v),
};
function testStore():ResearchStore {
 const records=new Map<string,OperationRecord>();let available=0,cancelled=false;
 return {
  async create(_id,budget){available=budget;},async get(_p,o){return records.get(o)??null;},
  async reserve(_p,o,identityHash,quote){if(cancelled||quote>available)throw new Error('BUDGET');if(records.has(o))return {...records.get(o)!,claimed:false};available-=quote;const r:OperationRecord={state:'prepared',claimed:true,identityHash,token:randomUUID()};records.set(o,r);return r;},
  async dispatch(_p,o){const r=records.get(o)!;if(cancelled||r.state!=='prepared')return false;r.state='dispatched';return true;},
  async finish(_p,o,_t,state,result){records.set(o,{...records.get(o)!,state,result});},async cancel(){cancelled=true;},
 };
}
async function fixture(mode:'json'|'sse'='json'){
 const events:string[]=[];let description:Record<string,unknown>={name:'Fixture/Search',schema,creditsPerCall:1};
 let behavior:'success'|'error'|'timeout'|'disconnect'|'oversize'='success';
 const mcp=new McpServer({name:'synthetic-agentkey',version:'test'});
 mcp.registerTool('find_tools',{inputSchema:z.object({q:z.string()})},async()=>{events.push('find');return {content:[{type:'text',text:JSON.stringify({names:['Fixture/Search','Unreviewed/Write']})}]};});
 mcp.registerTool('describe_tool',{inputSchema:z.object({name:z.string()})},async()=>{events.push('describe');return {content:[],structuredContent:description};});
 mcp.registerTool('execute_tool',{inputSchema:z.object({name:z.string(),params:z.record(z.string(),z.unknown())})},async()=>{
  events.push('execute');
  if(behavior==='timeout')await new Promise(r=>setTimeout(r,500));
  if(behavior==='disconnect'){for(const socket of sockets)socket.destroy();await new Promise(r=>setTimeout(r,200));}
  if(behavior==='error')return {isError:true,content:[{type:'text',text:'synthetic error'}]};
  return {content:[],structuredContent:{objects:[{id:'synthetic-1',fields:{title:behavior==='oversize'?'x'.repeat(100001):'Test only'},missingFields:['views'],observedAt:null}],pagination:{complete:true,nextCursor:null},actualCredits:null}};
 });
 const transport=new NodeStreamableHTTPServerTransport({sessionIdGenerator:()=>randomUUID(),enableJsonResponse:mode==='json'});
 await mcp.connect(transport);
 const sockets=new Set<import('node:net').Socket>();
 const server=createServer((req,res)=>{events.push(req.method==='DELETE'?'close':`http:${req.method}`);void transport.handleRequest(req,res);});
 server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address() as import('node:net').AddressInfo;
 const authorize=vi.fn(async()=>{}),store=testStore();
 const connect=(overrides={})=>connectLocalAgentKey({store,authorize,contract,capabilities:[{internalName:'search',canonicalName:'Fixture/Search',schemaHash:contractHash(schema),parameterKeys:['query'],maxQuoteCredits:1}],timeoutMs:200,maxResponseBytes:100000,maxCalls:30,maxPages:2,...overrides},new URL(`http://127.0.0.1:${address.port}/mcp`));
 return {events,connect,store,authorize,setDescription:(v:Record<string,unknown>)=>{description={...description,...v};},setBehavior:(v:typeof behavior)=>{behavior=v;},
  async stop(){await mcp.close();for(const s of sockets)s.destroy();await new Promise<void>(r=>server.close(()=>r()));}};
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
