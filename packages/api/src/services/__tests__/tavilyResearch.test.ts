/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe,it,expect } from 'vitest';
import { tavilyContract,TAVILY_SEARCH,tavilyCapabilities } from '../research/tavilyContract';
import { tavilySchema } from '../research/tavilySchema';
const params={query:'Fictional exhibition planning',search_depth:'basic',max_results:3,auto_parameters:false,include_answer:false,include_raw_content:false,include_images:false,include_usage:true,topic:'general'};
const context={canonicalName:TAVILY_SEARCH,params};
const description=()=>({name:TAVILY_SEARCH,category:'Search',provider:'Tavily',params:structuredClone(tavilySchema),cost:{credits_per_call:1.1},health:{healthy:true},execute_as:{name:TAVILY_SEARCH,params:{query:'<The search query to execute with Tavily.>'}}});
const response=()=>({category:'search',provider:'Tavily',took_ms:125,data:{query:params.query,answer:null,follow_up_questions:null,images:[],response_time:0.12,results:[{id:'fictional-1',title:'Fictional exhibition guide',url:'https://example.test/exhibition',content:'Fictional planning notes.',score:0.9,raw_content:null}],usage:{credits:1}}});
describe('reviewed Tavily basic search contract',()=>{
 it('normalizes only the observed template and keeps the AgentKey quote separate from provider usage',()=>{
  expect(tavilyContract.description(description())).toMatchObject({name:TAVILY_SEARCH,creditsPerCall:1.1});
  expect(tavilyCapabilities[0].maxQuoteCredits).toBe(1.1);
  const out=tavilyContract.result(response(),context);
  expect(out.actualCredits).toBeNull();
  expect(out.objects[0]).toMatchObject({id:'fictional-1',sourceUrl:'https://example.test/exhibition',observedAt:null,missingFields:['publishedAt'],fields:{title:'Fictional exhibition guide',content:'Fictional planning notes.',coverage:'ranked-results-not-exhaustive',providerUsage:{unit:'tavily-credit',credits:1}}});
  expect(out.pagination).toEqual({complete:true,nextCursor:null});
 });
 it.each([{search_depth:'advanced'},{auto_parameters:true},{include_answer:true},{include_raw_content:true},{include_images:true},{max_results:4},{topic:'news'},{privateSkillBody:'never send'},{query:''},{query:' leading space'},{query:'trailing space '}])('rejects unapproved parameters before admission: %j',patch=>{
  expect(()=>tavilyContract.validateInput!({...context,params:{...params,...patch}})).toThrow();
 });
 it('rejects parameter schema drift and alternate execution templates',()=>{
  const schema={...description(),params:{...tavilySchema,properties:{...tavilySchema.properties,query:{...tavilySchema.properties.query,description:'changed contract'}}}};
  expect(()=>tavilyContract.description(schema)).toThrow('SCHEMA_CHANGED');
  const template=description();template.execute_as.params.query='replacement';
  expect(()=>tavilyContract.description(template)).toThrow();
 });
 it.each(['javascript:alert(1)','data:text/html,test','https://user:secret@example.test/'])('rejects unsafe source links %s',link=>{
  const v=response();v.data.results[0].url=link;expect(()=>tavilyContract.result(v,context)).toThrow();
 });
 it('rejects mismatched query, duplicate IDs, excessive results, and unexpected generated content',()=>{
  const mismatch=response();mismatch.data.query='different';expect(()=>tavilyContract.result(mismatch,context)).toThrow('RESULT_IDENTITY_MISMATCH');
  const duplicate=response();duplicate.data.results.push({...duplicate.data.results[0]});expect(()=>tavilyContract.result(duplicate,context)).toThrow('DUPLICATE_RESULT_ID');
  expect(()=>tavilyContract.result(response(),{...context,params:{...params,max_results:0}})).toThrow();
  const generated={...response(),data:{...response().data,answer:'Unexpected provider-generated answer'}};expect(()=>tavilyContract.result(generated,context)).toThrow();
 });
 it('accepts zero matches without inventing evidence or actual AgentKey charges',()=>{
  const empty=response();empty.data.results=[];expect(tavilyContract.result(empty,context)).toEqual({objects:[],pagination:{complete:true,nextCursor:null},actualCredits:null});
 });
});

import {randomUUID} from 'node:crypto';
import {localMcpFixture} from './fixtures/agentKeyServer';
import type {ResearchStore,OperationRecord} from '../research/store';
function memoryStore():ResearchStore {
 const records=new Map<string,OperationRecord>();let budget=0;
 return {async create(_p,b){budget=b;},async get(_p,o){return records.get(o)??null;},async reserve(_p,o,identityHash,quote){if(quote>budget)throw new Error('BUDGET');budget-=quote;const value:OperationRecord={identityHash,state:'prepared',claimed:true,token:randomUUID()};records.set(o,value);return value;},async dispatch(_p,o){const row=records.get(o)!;if(row.state!=='prepared')return false;row.state='dispatched';return true;},async finish(_p,o,_t,state,result){records.set(o,{...records.get(o)!,state,result});},async cancel(){budget=0;}};
}
describe('Tavily contract through local official MCP transport',()=>{
 it.each(['json','sse'] as const)('executes once and recovers without losing cost-unit boundaries via %s',async mode=>{
  const f=await localMcpFixture(memoryStore(),mode,{discovery:{tools:[{name:TAVILY_SEARCH}]},description:description(),result:response()});
  const a=await f.connect({contract:tavilyContract,capabilities:tavilyCapabilities,timeoutMs:1000});
  try{
   expect(await a.discover(params.query)).toEqual(['tavily.webSearch']);
   const request={planId:randomUUID(),operationId:randomUUID(),capability:'tavily.webSearch',params};
   await a.createPlan(request.planId,1.1,[request]);
   const result=await a.execute(request);expect(result.state).toBe('succeeded');expect(result.result?.fixture).toBe(true);
   expect(result.result?.cost).toEqual({unit:'agentkey-credit',quoted:1.1,actual:null,status:'unknown'});
   expect((await a.execute(request)).recovered).toBe(true);expect(f.events.filter(x=>x==='execute')).toHaveLength(1);
   await expect(a.execute({...request,params:{...params,query:'Different'}})).rejects.toThrow('OPERATION_CONFLICT');
  }finally{await a.close();await f.stop();}
 });
 it('rejects a changed AgentKey quote before sending the paid tool request',async()=>{
  const f=await localMcpFixture(memoryStore(),'json',{discovery:{tools:[{name:TAVILY_SEARCH}]},description:{...description(),cost:{credits_per_call:2}},result:response()});
  const a=await f.connect({contract:tavilyContract,capabilities:tavilyCapabilities,timeoutMs:1000});
  try{
   await a.discover(params.query);const request={planId:randomUUID(),operationId:randomUUID(),capability:'tavily.webSearch',params};await a.createPlan(request.planId,1.1,[request]);
   await expect(a.execute(request)).rejects.toThrow();expect(f.events).not.toContain('execute');
  }finally{await a.close();await f.stop();}
 });
});
