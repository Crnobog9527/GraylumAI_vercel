import { Client, StreamableHTTPClientTransport, type CallToolResult } from '@modelcontextprotocol/client';
import Ajv from 'ajv';
import { z } from 'zod';
import { sha256 } from '../skills/loader';
import type { ResearchResult, ResearchStore } from './store';

const ENDPOINT='https://api.agentkey.app/v1/mcp';
export class ResearchError extends Error { constructor(readonly code:string){super(code);this.name='ResearchError';} }
function stop(code:string):never {throw new ResearchError(code);}
const stable=(v:unknown):string=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
export const contractHash=(value:unknown)=>sha256(stable(value));
export interface ReviewedCapability {
  internalName:string; canonicalName:string; schemaHash:string;
  // Exact key allowlist prevents sending Skill/history/plan bodies.
  parameterKeys:readonly string[]; maxQuoteCredits:number;
}
export interface ProviderContract {
  // Public AgentKey docs do not publish these full envelopes. A reviewed decoder
  // must be supplied; no production decoder is guessed from synthetic fixtures.
  discovery(value:unknown):{names:string[]};
  description(value:unknown):{name:string;schema:Record<string,unknown>;creditsPerCall:number;executeAs?:unknown};
  result(value:unknown):Pick<ResearchResult,'objects'|'pagination'> & {actualCredits:number|null};
}
export interface AdapterOptions {
  store:ResearchStore; capabilities:readonly ReviewedCapability[]; contract:ProviderContract;
  authorize:()=>Promise<void>; timeoutMs:number; maxResponseBytes:number; maxCalls:number; maxPages:number;
}
function content(result:CallToolResult):unknown {
  if(result.isError)stop('PROVIDER_TOOL_ERROR');
  if(result.structuredContent)return result.structuredContent;
  if(result.content.length!==1||result.content[0].type!=='text')stop('UNREVIEWED_RESPONSE');
  try{return JSON.parse(result.content[0].text);}catch{return stop('UNREVIEWED_RESPONSE');}
}
function boundedFetch(url:string, key:string|undefined, limit:number, timeout:number):typeof fetch {
  return async(input,init)=>{
    const target=input instanceof Request?input.url:String(input);
    if(target!==url)stop('DESTINATION_DENIED');
    const headers=new Headers(init?.headers);
    if(key)headers.set('Authorization',`Bearer ${key}`);
    const response=await fetch(input,{...init,headers,redirect:'error',signal:AbortSignal.any([AbortSignal.timeout(timeout),...(init?.signal?[init.signal]:[])])});
    if(Number(response.headers.get('content-length'))>limit)stop('RESPONSE_TOO_LARGE');
    if(!response.body)return response;
    let size=0;const reader=response.body.getReader();
    const stream=new ReadableStream<Uint8Array>({
      async pull(controller){try{const next=await reader.read();if(next.done){controller.close();return;}size+=next.value.byteLength;if(size>limit){await reader.cancel();controller.error(new ResearchError('RESPONSE_TOO_LARGE'));return;}controller.enqueue(next.value);}catch{controller.error(new ResearchError('TRANSPORT_FAILURE'));}},
      cancel:()=>reader.cancel(),
    });
    return new Response(stream,{status:response.status,statusText:response.statusText,headers:response.headers});
  };
}
/** Server-only transport. No environment loading, redirects, or caller-controlled production URL. */
export async function connectAgentKey(options:AdapterOptions,apiKey:string){
  if(!apiKey)stop('CREDENTIAL_REQUIRED');
  return connect(options,ENDPOINT,apiKey,false);
}
/** Explicit local test injection, isolated from the production factory. */
export async function connectLocalAgentKey(options:AdapterOptions,endpoint:URL){
  if(endpoint.protocol!=='http:'||!['127.0.0.1','[::1]'].includes(endpoint.hostname)||endpoint.username||endpoint.password)stop('LOCAL_ENDPOINT_REQUIRED');
  return connect(options,endpoint.href,undefined,true);
}
async function connect(options:AdapterOptions,url:string,key:string|undefined,fixture:boolean){
  options={...options,capabilities:structuredClone(options.capabilities)};
  if(typeof window!=='undefined')stop('SERVER_ONLY');
  if(!Number.isInteger(options.timeoutMs)||options.timeoutMs<20||options.timeoutMs>30000
    ||!Number.isInteger(options.maxResponseBytes)||options.maxResponseBytes<256||options.maxResponseBytes>1048576
    ||!Number.isInteger(options.maxCalls)||options.maxCalls<1||options.maxCalls>80
    ||!Number.isInteger(options.maxPages)||options.maxPages<1||options.maxPages>10)stop('LIMIT_REQUIRED');
  const client=new Client({name:'graylum-research',version:'1.0.0'},{capabilities:{}});
  const transport=new StreamableHTTPClientTransport(new URL(url),{
    fetch:boundedFetch(url,key,options.maxResponseBytes,options.timeoutMs),
    reconnectionOptions:{maxRetries:0,initialReconnectionDelay:1000,maxReconnectionDelay:1000,reconnectionDelayGrowFactor:1},
  });
  let calls=0;
  const call=async(name:string,args:Record<string,unknown>)=>{
    if(++calls>options.maxCalls)stop('CALL_LIMIT');
    return content(await client.callTool({name,arguments:args},{timeout:options.timeoutMs}));
  };
  try {
    await options.authorize();
    await client.connect(transport,{timeout:options.timeoutMs});
    const names=new Set<string>();let cursor:string|undefined;
    for(let page=0;page<options.maxPages;page++){
      if(++calls>options.maxCalls)stop('CALL_LIMIT');
      const listed=await client.listTools(cursor?{cursor}:undefined,{timeout:options.timeoutMs});
      for(const t of listed.tools)names.add(t.name);
      cursor=listed.nextCursor;if(!cursor)break;
    }
    if(cursor)stop('PAGE_LIMIT');
    if(!['find_tools','describe_tool','execute_tool'].every(n=>names.has(n)))stop('TOOL_CONTRACT_CHANGED');
  } catch {await client.close().catch(()=>{});stop('CONNECTION_UNAVAILABLE');}
  const discovered=new Set<string>();
  return {
    async discover(query:string){
      await options.authorize();
      if(query.length<1||query.length>200)stop('INVALID_QUERY');
      const result=options.contract.discovery(await call('find_tools',{q:query}));
      if(result.names.length>100)stop('DISCOVERY_LIMIT');
      discovered.clear();
      for(const name of result.names)if(options.capabilities.some(c=>c.canonicalName===name))discovered.add(name);
      return options.capabilities.filter(c=>discovered.has(c.canonicalName)).map(c=>c.internalName);
    },
    async createPlan(planId:string,budgetCredits:number,operations:{operationId:string;capability:string;params:Record<string,unknown>}[]){
      await options.authorize();
      z.string().uuid().parse(planId);
      if(operations.length<1||operations.length>20||new Set(operations.map(o=>o.operationId)).size!==operations.length)stop('INVALID_PLAN');
      const approved=operations.map(op=>{
        z.string().uuid().parse(op.operationId);
        const cap=options.capabilities.find(c=>c.internalName===op.capability);
        if(!cap||!discovered.has(cap.canonicalName))stop('CAPABILITY_DENIED');
        if(Object.keys(op.params).some(k=>!cap.parameterKeys.includes(k))||Buffer.byteLength(stable(op.params))>4096)stop('PARAMETERS_DENIED');
        return {operationId:op.operationId,identityHash:contractHash({capability:cap.canonicalName,schemaHash:cap.schemaHash,params:op.params}),maxQuoteUnits:units(cap.maxQuoteCredits)};
      });
      await options.store.create(planId,units(budgetCredits),approved);
    },
    async execute(input:{planId:string;operationId:string;capability:string;params:Record<string,unknown>}){
      input=structuredClone(input);
      await options.authorize();
      z.string().uuid().parse(input.planId);z.string().uuid().parse(input.operationId);
      const cap=options.capabilities.find(c=>c.internalName===input.capability);
      if(!cap||!discovered.has(cap.canonicalName))stop('CAPABILITY_DENIED');
      if(Object.keys(input.params).some(k=>!cap.parameterKeys.includes(k))||Buffer.byteLength(stable(input.params))>4096)stop('PARAMETERS_DENIED');
      // Replayed identities are checked before returning a persisted result.
      const identityHash=contractHash({capability:cap.canonicalName,schemaHash:cap.schemaHash,params:input.params});
      const previous=await options.store.get(input.planId,input.operationId);
      // reserve compares identity even for terminal records; fresh quote is not needed to recover.
      if(previous && previous.identityHash!==identityHash)stop('OPERATION_CONFLICT');
      if(previous && previous.state!=='prepared'){
        // get alone is deliberately not an identity authorization mechanism.
        return {state:previous.state,result:previous.result??null,recovered:true,identityHash};
      }
      const desc=options.contract.description(await call('describe_tool',{name:cap.canonicalName}));
      if(desc.name!==cap.canonicalName||desc.executeAs!==undefined||contractHash(desc.schema)!==cap.schemaHash)stop('SCHEMA_CHANGED');
      const ajv=new Ajv({strict:true,allErrors:false,validateFormats:false});
      let valid=false;try{valid=ajv.compile(desc.schema)(input.params)===true;}catch{stop('SCHEMA_UNSUPPORTED');}
      if(!valid)stop('INVALID_PARAMETERS');
      if(!Number.isFinite(cap.maxQuoteCredits)||cap.maxQuoteCredits<0||desc.creditsPerCall>cap.maxQuoteCredits)stop('QUOTE_CHANGED');
      const quoteUnits=units(desc.creditsPerCall);
      const reservation=await options.store.reserve(input.planId,input.operationId,identityHash,quoteUnits);
      if(!reservation.claimed)return {state:reservation.state,result:reservation.result??null,recovered:true};
      if(!reservation.token)stop('STATE_INVALID');
      // No call may follow failed admission/reservation/cancellation.
      await options.authorize();
      if(calls>=options.maxCalls)stop('CALL_LIMIT');
      if(!await options.store.dispatch(input.planId,input.operationId,reservation.token))stop('CANCELLED');
      let result:ResearchResult|null=null;
      let state:'succeeded'|'failed'|'unknown'='unknown';
      try {
        const raw=await call('execute_tool',{name:cap.canonicalName,params:input.params});
        const parsed=options.contract.result(raw);
        if(parsed.objects.length>100||parsed.objects.some(x=>!x.id||x.missingFields.length>100))stop('RESULT_LIMIT');
        if(parsed.actualCredits!==null)units(parsed.actualCredits);
        result={source:'agentkey',fixture,canonicalTool:cap.canonicalName,objects:parsed.objects,pagination:parsed.pagination,
          fetchedAt:new Date().toISOString(),error:null,cost:{unit:'agentkey-credit',quoted:desc.creditsPerCall,actual:parsed.actualCredits,status:parsed.actualCredits===null?'unknown':'reported'}};
        state='succeeded';
      }catch(error){
        state=error instanceof ResearchError&&error.code==='PROVIDER_TOOL_ERROR'?'failed':'unknown';
        result={source:'agentkey',fixture,canonicalTool:cap.canonicalName,objects:[],fetchedAt:new Date().toISOString(),
          pagination:{complete:false,nextCursor:null},error:state==='failed'?'PROVIDER_TOOL_ERROR':'RESULT_UNKNOWN',
          cost:{unit:'agentkey-credit',quoted:desc.creditsPerCall,actual:null,status:'unknown'}};
      }
      // A save failure cannot trigger another execute. A durable 'dispatched' row
      // remains an uncertain result; reservation is retained conservatively.
      await options.store.finish(input.planId,input.operationId,reservation.token,state,result);
      return {state,result,recovered:false};
    },
    async cancel(planId:string){await options.authorize();await options.store.cancel(planId);},
    async close(){try{await transport.terminateSession();}finally{await client.close();}},
  };
}
function units(credits:number):number {
  const value=credits*1000000;
  if(!Number.isFinite(credits)||credits<0||!Number.isSafeInteger(value)||value>1000000000)stop('PRICE_UNEXPLAINED');
  return value;
}
