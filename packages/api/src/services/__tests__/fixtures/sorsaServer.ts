import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {vi} from 'vitest';
import {McpServer} from '@modelcontextprotocol/server';
import {NodeStreamableHTTPServerTransport} from '@modelcontextprotocol/node';
import {z} from 'zod';
import {connectLocalAgentKey,type AdapterOptions} from '../../research/agentKey';
import {sorsaContract,sorsaCapabilities,SORSA_PROFILE,SORSA_TWEETS} from '../../research/sorsaContract';
import type {ResearchStore} from '../../research/store';
import {sampleDiscovery,sampleDescription,sampleProfile,sampleTweets} from './sorsaResponses';

// Real local SDK protocol transport; fictional values replay the observed envelopes.
export async function sorsaReplay(store:ResearchStore, mode:'json'|'sse'='json') {
  const events:string[]=[];
  let mutateDescription=(v:Record<string,unknown>)=>v;
  let mutateResult=(v:unknown)=>v;
  let disconnect=false;
  const mcp=new McpServer({name:'observed-sorsa-replay',version:'fixture'});
  mcp.registerTool('find_tools',{inputSchema:z.object({q:z.string()})},async()=>{
    events.push('find');return {content:[{type:'text',text:JSON.stringify(sampleDiscovery)}],structuredContent:sampleDiscovery};
  });
  mcp.registerTool('describe_tool',{inputSchema:z.object({name:z.string()})},async({name})=>{
    if(name!==SORSA_PROFILE&&name!==SORSA_TWEETS)throw new Error('unreviewed tool');
    events.push('describe');return {content:[{type:'text',text:JSON.stringify(mutateDescription(sampleDescription(name)))}]};
  });
  const sockets=new Set<import('node:net').Socket>();
  mcp.registerTool('execute_tool',{inputSchema:z.object({name:z.string(),params:z.record(z.string(),z.unknown())})},async({name})=>{
    events.push(`execute:${name}`);
    if(disconnect){for(const s of sockets)s.destroy();await new Promise(r=>setTimeout(r,300));}
    if(name!==SORSA_PROFILE&&name!==SORSA_TWEETS)throw new Error('unreviewed tool');
    return {content:[{type:'text',text:JSON.stringify(mutateResult(structuredClone(name===SORSA_PROFILE?sampleProfile:sampleTweets)))}]};
  });
  const transport=new NodeStreamableHTTPServerTransport({sessionIdGenerator:()=>randomUUID(),enableJsonResponse:mode==='json'});
  await mcp.connect(transport);
  const server=createServer((req,res)=>{events.push(req.method==='DELETE'?'close':`http:${req.method}`);void transport.handleRequest(req,res);});
  server.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const port=(server.address() as import('node:net').AddressInfo).port;
  const authorize=vi.fn(async()=>{});
  return {events,authorize,
    setDescription:(fn:typeof mutateDescription)=>{mutateDescription=fn;},
    setResult:(fn:typeof mutateResult)=>{mutateResult=fn;},
    disconnect:()=>{disconnect=true;},
    connect:(overrides:Partial<AdapterOptions>={})=>connectLocalAgentKey({store,authorize,contract:sorsaContract,capabilities:sorsaCapabilities,
      timeoutMs:500,maxResponseBytes:100000,maxCalls:30,maxPages:2,...overrides},new URL(`http://127.0.0.1:${port}/mcp`)),
    async stop(){await mcp.close();for(const s of sockets)s.destroy();await new Promise<void>(r=>server.close(()=>r()));},
  };
}
