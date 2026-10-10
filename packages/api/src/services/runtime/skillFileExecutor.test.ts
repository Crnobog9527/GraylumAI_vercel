/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {expect,it,vi} from 'vitest';
import {runtimeExecutor} from './execute';
import {packageHash,sha256,clearSkillResourceCache} from '../skills/loader';
import {createRuntimeBudget} from './budget';
const billing=vi.hoisted(()=>({claimCall:vi.fn(),dispatchOnce:vi.fn(),recoverRun:vi.fn()}));
vi.mock('../bill2/service',async original=>({...await original<typeof import('../bill2/service')>(),authoritativeBilling:()=>billing}));
const id='10000000-0000-4000-8000-000000000001';
it.each(['answer','repeat','oversized','denied','large','revoked','malformed','transient'] as const)('settles file continuation %s and replays without another dispatch',async outcome=>{
 vi.clearAllMocks();
 clearSkillResourceCache();
 const content='Synthetic reference';
 const base={packageId:id,revisionId:id,directoryName:'fixture',tasks:{},requiredCapabilities:[],files:[
  {path:'SKILL.md',bytes:0,sha256:sha256(''),mediaType:'text/markdown' as const,requires:[]},
  {path:'ref.md',bytes:Buffer.byteLength(content),sha256:sha256(content),mediaType:'text/markdown' as const,requires:[]},
 ]};
 const descriptor={...base,packageHash:packageHash(base)};
 const context={version:'runtime.v1',sdkVersion:'0.18.0',role:'skill',input:'Explain the reference',instructions:'Read then answer.',
  model:'fixture',maxOutputTokens:1000,maxTurns:2,historyItems:0,tools:['ask_question','read_skill_file'],maxToolCalls:1,
  network:'deny',providerRequestFormat:'agent-turn-v5-stream',reasoning:{parameter:'none'},
  inputSelection:'scope-projection-v1',nativeOutput:'native-output-v1',mentorText:'append-card-v1',
  moduleId:id,skillId:id,revisionId:id,skillFile:{packageId:id,revisionId:id,packageHash:descriptor.packageHash}};
 const policy={model:'fixture',provider:'fixture',account:'test',protocol:'fixture-cost-v1',upperUsd:'0.01',inputLimit:64000,outputLimit:1000};
 let live=true,saved:unknown=null,result:unknown;
 const receipts=new Map<number,{rawBody:string;hash:string}>(),requests:string[]=[],history:unknown[]=[];
 const failures:Record<string,string>={denied:'RUNTIME_SKILL_FILE_DENIED',large:'RUNTIME_SKILL_FILE_TOO_LARGE',
  revoked:'Skill unavailable',transient:'connection reset'};
 const database={rpc:vi.fn(async(name:string,args:Record<string,unknown>)=>{
  let data:unknown={};
  if(name==='runtime_execution'&&args.p_action==='begin')data={live,state:'running',sessionId:id,runId:id,
   context,billing:{contractVersion:'bill2.v1',callPolicy:[policy],rules:{},limits:{maxCalls:2}}};
  else if(name==='runtime_session_items'){
   if(args.p_action==='read')data=[];
   if(args.p_action==='append')history.push(args.p_items);
  }else if(name==='runtime_response'){
   const receipt=receipts.get(Number(args.p_sequence));
   if(receipt)expect(args.p_request_hash).toBe(receipt.hash);
   data=receipt??null;
  }else if(name==='runtime_tool'){
   if(['denied','large','revoked','transient'].includes(outcome))return {data:null,error:{message:
    failures[outcome]}};
   if(args.p_action==='complete')saved=Object.fromEntries(Object.entries(args.p_result as object).reverse());
   data={result:saved};
  }else if(name==='read_skill_package')data=args.p_path===null?descriptor:args.p_path===''?true:Buffer.from(content).toString('base64');
  else if(name==='runtime_cancel')data={state:'cancelled'};
  else if(name==='runtime_execution'&&args.p_action==='complete'){result=args.p_result;data={state:'completed'};}
  return {data,error:null};
 })};
 billing.claimCall.mockImplementation(async(_run,sequence)=>({id:String(sequence)}));
 billing.dispatchOnce.mockImplementation(async(callId,request)=>{
  const sequence=Number(callId);requests.push(request);
  const message=sequence===1||outcome==='repeat'?{role:'assistant',content:outcome==='oversized'?'x'.repeat(9000):null,tool_calls:[{id:'read_1',type:'function',
   function:{name:'read_skill_file',arguments:outcome==='malformed'?'{':'{"path":"ref.md"}'}}]}:{role:'assistant',content:'Grounded answer'};
  receipts.set(sequence,{hash:sha256(request),rawBody:JSON.stringify({usage:{sdkResponse:{
   id:'fixture',object:'chat.completion',created:1,model:'fixture',
   choices:[{index:0,message,finish_reason:sequence===1?'tool_calls':'stop'}],
  }}})});
  return {dispatched:true};
 });
 const budget=createRuntimeBudget(),timing=budget.timing;
 const options={database,actor:async()=>id,callGate:vi.fn(async()=>({ok:true as const})),
  budget,adapter:{dispatch:vi.fn()} as never};
 const first=await runtimeExecutor(options).execute(id);
 const count=['answer','repeat'].includes(outcome)?2:1;
 if(outcome!=='answer'){
  expect(first.state).toBe(outcome==='transient'?'pending':'cancelled');
  expect(history).toEqual([]);
  live=false;
  expect(await runtimeExecutor({...options,budget:createRuntimeBudget()}).execute(id)).toEqual(first);
  expect(billing.dispatchOnce).toHaveBeenCalledTimes(count);
  expect(database.rpc.mock.calls.filter(([name,args])=>name==='runtime_tool'&&args.p_action==='claim')).toHaveLength(
   ['oversized','malformed'].includes(outcome)?0:2);
  expect(database.rpc.mock.calls.some(([name])=>name==='runtime_cancel')).toBe(outcome!=='transient');
  return;
 }
 expect(first.state).toBe('completed');
 expect(JSON.stringify(result)).toContain('Grounded answer');
 expect(JSON.stringify(result)).not.toContain(content);
 expect(requests[1]).toContain(content);
 expect(timing.summary().skillFileRead).toBe(true);
 expect(JSON.stringify(history)).toContain('read_1');
 live=false;
 const replay=await runtimeExecutor({...options,budget:createRuntimeBudget()}).execute(id);
 expect(replay).toEqual(first);
 expect(billing.dispatchOnce).toHaveBeenCalledTimes(2);
 expect(billing.claimCall).toHaveBeenCalledTimes(2);
});
