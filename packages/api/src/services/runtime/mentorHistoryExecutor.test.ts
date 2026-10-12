/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {expect,it,vi} from 'vitest';
import {freezeHistorySelection} from './hostTurn';
import {runtimeExecutor} from './execute';
import {packageHash,sha256} from '../skills/loader';
import {createRuntimeBudget} from './budget';
import {mentorHistoryToolBytes} from './mentorHistory';
const billing=vi.hoisted(()=>({claimCall:vi.fn(),dispatchOnce:vi.fn(),recoverRun:vi.fn()}));
vi.mock('../bill2/service',async original=>({...await original<typeof import('../bill2/service')>(),authoritativeBilling:()=>billing}));
const id='10000000-0000-4000-8000-000000000001';
const base={packageId:id,revisionId:id,directoryName:'fixture',tasks:{},requiredCapabilities:[],files:[
 {path:'SKILL.md',bytes:0,sha256:sha256(''),mediaType:'text/markdown' as const,requires:[]}]};
const descriptor={...base,packageHash:packageHash(base)};
const earlier={kind:'mentor_history',segment:'segment-1',segments:[{id:'segment-1',turns:[1,1]}],messages:1,
 items:[{turn:1,executionId:id,text:'EARLY_USER_WORDS'}],truncated:false};

// R4: the mentor turn may read the user's earlier messages once, through the same claim/complete freeze as files.
it.each(['answer','twice','malformed','notOffered'] as const)('mentor history read %s',async outcome=>{
 vi.clearAllMocks();
 const offered=outcome!=='notOffered';
 const context={version:'runtime.v1',sdkVersion:'0.18.0',role:'skill',input:'What did I say at the start?',
  instructions:'Mentor.',model:'fixture',maxOutputTokens:1000,maxTurns:2,historyItems:0,
  tools:['ask_question','read_skill_file',...(offered?['read_history']:[])],maxToolCalls:1,
  network:'deny',providerRequestFormat:'agent-turn-v5-stream',reasoning:{parameter:'none'},
  inputSelection:'scope-projection-v2',historySelection:freezeHistorySelection(),
  hostTurnContext:{stepId:'first',opening:false,checklist:[]},nativeOutput:'native-output-v1',mentorText:'append-card-v1',
  opcTurnToken:id,moduleId:id,skillId:id,revisionId:id,skillFile:{packageId:id,revisionId:id,packageHash:descriptor.packageHash},
  ...(offered?{historyRead:{version:'mentor-history-v1',reserve:20480}}:{})};
 const policy={model:'fixture',provider:'fixture',account:'test',protocol:'fixture-cost-v1',upperUsd:'0.01',inputLimit:64000,outputLimit:1000};
 let saved:unknown=null;const requests:string[]=[];
 const receipts=new Map<number,{rawBody:string;hash:string}>();
 const database={rpc:vi.fn(async(name:string,args:Record<string,unknown>)=>{
  let data:unknown={};
  if(name==='runtime_execution'&&args.p_action==='begin')data={live:true,state:'running',sessionId:id,runId:id,
   context,billing:{contractVersion:'bill2.v1',callPolicy:[policy],rules:{},limits:{maxCalls:2}}};
  else if(name==='runtime_session_items')data=args.p_action==='read'?[]:{};
  else if(name==='runtime_response')data=receipts.get(Number(args.p_sequence))??null;
  else if(name==='runtime_tool'){if(args.p_action==='complete')saved=args.p_result;data={result:saved};}
  else if(name==='runtime_mentor_history')data=earlier;
  else if(name==='runtime_cancel')data={state:'cancelled'};
  else if(name==='runtime_execution'&&args.p_action==='complete')data={state:'completed'};
  return {data,error:null};
 })};
 billing.claimCall.mockImplementation(async(_run,sequence)=>({id:String(sequence)}));
 billing.dispatchOnce.mockImplementation(async(callId,request)=>{
  const sequence=Number(callId);requests.push(request);
  const read={role:'assistant',content:null,tool_calls:[{id:'hist_1',type:'function',function:{name:'read_history',
   arguments:outcome==='malformed'?'{"segment":1}':JSON.stringify({query:null})}}]};
  const reads=sequence===1||outcome==='twice';
  const message=reads?read:{role:'assistant',content:'You first said EARLY_USER_WORDS.'};
  receipts.set(sequence,{hash:sha256(request),rawBody:JSON.stringify({usage:{sdkResponse:{
   id:'fixture',object:'chat.completion',created:1,model:'fixture',
   choices:[{index:0,message,finish_reason:reads?'tool_calls':'stop'}]}}})});
  return {dispatched:true};
 });
 const result=await runtimeExecutor({database,actor:async()=>id,callGate:vi.fn(async()=>({ok:true as const})),
  budget:createRuntimeBudget(),adapter:{dispatch:vi.fn()} as never}).execute(id);
 const reads=database.rpc.mock.calls.filter(([name])=>name==='runtime_mentor_history');
 if(outcome!=='answer'){
  expect(result.state).toBe('cancelled');
  expect(reads).toHaveLength(outcome==='twice'?1:0);
  return;
 }
 expect(result.state).toBe('completed');
 expect(reads).toEqual([['runtime_mentor_history',expect.objectContaining({p_execution_id:id,p_query:''})]]);
 expect(database.rpc.mock.calls.filter(([name,args])=>name==='runtime_tool'&&args.p_name==='read_history').map(([,args])=>args.p_action))
  .toEqual(['claim','complete']);
 expect(JSON.parse(requests[0]!).tools.map((tool:{function:{name:string}})=>tool.function.name))
  .toEqual(['ask_question','read_skill_file','read_history']);
 expect(requests[1]).toContain('EARLY_USER_WORDS');
});

it('sizes the history tool like the request carries it',()=>{
 expect(mentorHistoryToolBytes()).toBeGreaterThan(200);expect(mentorHistoryToolBytes()).toBeLessThan(1200);
});
