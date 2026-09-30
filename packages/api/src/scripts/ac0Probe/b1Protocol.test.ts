/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {expect,it} from 'vitest';
import {runB1Pair} from './b1Protocol';
import {createBudget,memoryLedger} from './budget';
import {sseResponse,textDeltas,toolDeltas} from './dryRun';
import type {LoadedSkill,Scenario} from './skill';
const resource='references/step.md';
const skill:LoadedSkill={instructions:'---\nname: b1-test\ndescription: Offline B1 test skill.\n---\nAsk one choice.',
 references:new Map([[resource,'Use only provided facts.']]),digest:'synthetic',bytes:100,isFixture:true,
 workflow:[{id:'step-1',title:'Test step',resources:[resource],information:[{id:'choice',title:'Choice',required:true}]}] as any};
const scenario:Scenario={id:'b1-test',kind:'ask',category:'B',input:'Give me categories.',
 history:[{role:'user',content:'I want to categorize my work.'}],step:0,currentStepId:'step-1',questionId:'choice'};
const usage={prompt_tokens:100,completion_tokens:10,total_tokens:110,cost:0.0003};
const args={question:'Which?',options:['Option A','Option B'],recommended:null};
function setup(mode:'ok'|'http'|'unknown'|'no-card'|'long-args'|'sse-error'|'partial-error'='ok'){
 const requests:any[]=[];const ledger=memoryLedger();
 const budget=createBudget({maxCalls:6,maxUsd:1.5,ledger});
 const transport:typeof fetch=async(_url,init)=>{
  const request=JSON.parse(String(init?.body));requests.push(request);
  if(requests.length===1){
   if(mode==='unknown')throw new TypeError('SYNTHETIC_NETWORK_FAILURE');
   if(mode==='no-card')return sseResponse(request.model,textDeltas('A text reply.'),{usage});
   return sseResponse(request.model,[{reasoning:'Private thinking',reasoning_details:[
    {type:'reasoning.text',format:'anthropic-claude-v1',index:0,text:'Private thinking',signature:'synthetic-signature'},
   ]},...textDeltas('Choose a category.'),...toolDeltas('ask_question',
    mode==='long-args'?{...args,options:['a'.repeat(4100),'b']}:args,'call_real_sdk')],{finish:'tool_calls',usage});
  }
  if(mode==='partial-error')return new Response('data: '+JSON.stringify({error:{message:'Incomplete error'}}),{status:200});
  if(mode==='sse-error')return new Response('data: '+JSON.stringify({error:{code:400,message:'SYNTHETIC thinking required'}})+'\n\n',{status:200});
  if(mode==='http')return new Response(JSON.stringify({error:{message:'SYNTHETIC thinking required'}}),{status:400});
  return sseResponse(request.model,textDeltas('We can continue.'),{usage});
 };
 return {requests,ledger,budget,transport};
}
it('runs both admissions and original SDK history through the real transformer and adapter',async()=>{
 const f=setup();const result=await runB1Pair({...f,skill,scenario,credential:async()=> 'offline-only',save:()=>{}});
 expect(result.verdict).toBe('PASS');expect(f.requests).toHaveLength(2);
 expect(result.secondInput).toBe('Option A');
 const messages=f.requests[1].messages,assistant=messages.find((m:any)=>m.tool_calls);
 expect(assistant.tool_calls[0].function.arguments).toBe(JSON.stringify(args));
 expect(assistant).not.toHaveProperty('reasoning');expect(assistant).not.toHaveProperty('reasoning_details');
 expect(messages.at(-1)).toEqual({role:'user',content:'Option A'});
 expect(f.requests[1].reasoning_effort).toBe('low');expect(f.requests[1].max_tokens).toBe(4096);
 expect(result.turns[0]?.history).toHaveLength(1);expect(result.turns[1]?.history!.length).toBeGreaterThan(3);
 expect(f.ledger.read().calls).toBe(2);expect(result.turns.every(t=>t.state==='complete')).toBe(true);
});
it('retains a second-turn supplier rejection without retry',async()=>{
 const f=setup('http');const result=await runB1Pair({...f,skill,scenario,credential:async()=> 'offline',save:()=>{}});
 expect(result.verdict).toBe('FAIL');expect(f.requests).toHaveLength(2);
 expect(result.turns[1]).toMatchObject({httpStatus:400,state:'provider_rejected',normalization:'accepted'});
 expect(result.turns[1]?.error).toContain('SYNTHETIC thinking required');
});
it('stops on an ambiguous first dispatch and retains its conservative reservation',async()=>{
 const f=setup('unknown');const result=await runB1Pair({...f,skill,scenario,credential:async()=> 'offline',save:()=>{}});
 expect(result.verdict).toBe('UNKNOWN');expect(f.requests).toHaveLength(1);expect(f.budget.stopped).toBe('B1_UNKNOWN_RESULT');
 expect(f.ledger.read().nanoUsd).toBeGreaterThan(0);expect(result.turns).toHaveLength(1);
});
it('does not manufacture a card or second request when the first response is prose',async()=>{
 const f=setup('no-card');const result=await runB1Pair({...f,skill,scenario,credential:async()=> 'offline',save:()=>{}});
 expect(result.verdict).toBe('PREREQUISITE_NOT_MET');expect(f.requests).toHaveLength(1);
});

it('counts a complete HTTP 200 SSE error frame as supplier rejection, retaining raw error',async()=>{
 const f=setup('sse-error');const result=await runB1Pair({...f,skill,scenario,credential:async()=> 'offline',save:()=>{}});
 expect(result.verdict).toBe('FAIL');expect(f.requests).toHaveLength(2);
 expect(result.turns[1]).toMatchObject({httpStatus:200,state:'provider_rejected'});
 expect(result.turns[1]?.error).toContain('SYNTHETIC thinking required');
 expect(result.turns[1]?.bookedUsd).toBe(result.turns[1]?.boundUsd);
});

it('keeps an incomplete second-turn error frame unknown and stops all further requests',async()=>{
 const f=setup('partial-error');const result=await runB1Pair({...f,skill,scenario,credential:async()=> 'offline',save:()=>{}});
 expect(result.verdict).toBe('UNKNOWN');expect(f.requests).toHaveLength(2);
 expect(f.budget.stopped).toBe('B1_UNKNOWN_RESULT');
 expect(result.turns[1]?.bookedUsd).toBe(result.turns[1]?.boundUsd);
});
