import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/server';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { z } from 'zod';
import { connectLocalAgentKey, contractHash, type ProviderContract, type AdapterOptions } from '../../research/agentKey';
import type { ResearchStore } from '../../research/store';

export const schema={type:'object',properties:{query:{type:'string',maxLength:100}},required:['query'],additionalProperties:false};
// All envelopes below are synthetic. Official docs do not specify these full shapes.
const contract:ProviderContract={
 discovery:v=>z.object({names:z.array(z.string())}).parse(v),
 description:v=>z.object({name:z.string(),schema:z.record(z.string(),z.unknown()),creditsPerCall:z.number(),executeAs:z.unknown().optional()}).parse(v),
 result:v=>z.object({objects:z.array(z.object({id:z.string(),fields:z.record(z.string(),z.unknown()),missingFields:z.array(z.string()),observedAt:z.string().nullable()})),pagination:z.object({complete:z.boolean(),nextCursor:z.string().nullable()}),actualCredits:z.number().nullable()}).parse(v),
};
export async function localMcpFixture(store:ResearchStore,mode:'json'|'sse'='json'){
 const events:string[]=[];let description:Record<string,unknown>={name:'Fixture/Search',schema,creditsPerCall:1};
 let actualCredits:number|null=null;
 let behavior:'success'|'error'|'timeout'|'disconnect'|'oversize'='success';
 const mcp=new McpServer({name:'synthetic-agentkey',version:'test'});
 mcp.registerTool('find_tools',{inputSchema:z.object({q:z.string()})},async()=>{events.push('find');return {content:[{type:'text',text:JSON.stringify({names:['Fixture/Search','Unreviewed/Write']})}]};});
 mcp.registerTool('describe_tool',{inputSchema:z.object({name:z.string()})},async()=>{events.push('describe');return {content:[],structuredContent:description};});
 mcp.registerTool('execute_tool',{inputSchema:z.object({name:z.string(),params:z.record(z.string(),z.unknown())})},async()=>{
  events.push('execute');
  if(behavior==='timeout')await new Promise(r=>setTimeout(r,500));
  if(behavior==='disconnect'){for(const socket of sockets)socket.destroy();await new Promise(r=>setTimeout(r,200));}
  if(behavior==='error')return {isError:true,content:[{type:'text',text:'synthetic error'}]};
  return {content:[],structuredContent:{objects:[{id:'synthetic-1',fields:{title:behavior==='oversize'?'x'.repeat(100001):'Test only'},missingFields:['views'],observedAt:null}],pagination:{complete:true,nextCursor:null},actualCredits}};
 });
 const transport=new NodeStreamableHTTPServerTransport({sessionIdGenerator:()=>randomUUID(),enableJsonResponse:mode==='json'});
 await mcp.connect(transport);
 const sockets=new Set<import('node:net').Socket>();
 const server=createServer((req,res)=>{events.push(req.method==='DELETE'?'close':`http:${req.method}`);void transport.handleRequest(req,res);});
 server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address() as import('node:net').AddressInfo;
 const authorize=vi.fn(async()=>{});
 const connect=(overrides:Partial<AdapterOptions>={})=>connectLocalAgentKey({store,authorize,contract,capabilities:[{internalName:'search',canonicalName:'Fixture/Search',schemaHash:contractHash(schema),parameterKeys:['query'],maxQuoteCredits:1}],timeoutMs:200,maxResponseBytes:100000,maxCalls:30,maxPages:2,...overrides},new URL(`http://127.0.0.1:${address.port}/mcp`));
 return {events,connect,store,authorize,setActualCredits:(value:number|null)=>{actualCredits=value;},setDescription:(v:Record<string,unknown>)=>{description={...description,...v};},setBehavior:(v:typeof behavior)=>{behavior=v;},
  async stop(){await mcp.close();for(const s of sockets)s.destroy();await new Promise<void>(r=>server.close(()=>r()));}};
}
