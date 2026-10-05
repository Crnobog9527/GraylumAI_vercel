/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {expect,it} from 'vitest';
import {mentorText} from './mentorText';
import {NativeProgressProjection} from './nativeProgress';
import {agentTurnResult} from './agentTurnResult';
import {stoppedResult} from './stoppedResult';
import {NativeSession} from './nativeSession';
import {recoverOpenRouterHistory} from './historyRecovery';
import type {AgentInputItem,Session} from '@openai/agents';
const card={message:'接下来的问题。',question:'选择什么？',options:['甲','乙'],recommended:0,recommendationReason:'原因'};
const output=JSON.stringify({card:'question',...card});
it.each([
  ['', '问题', '问题'], ['分析', '问题', '分析\n\n问题'], ['同一段', '同一段', '同一段'],
  ['分析\n\n问题', '问题', '分析\n\n问题'], ['分析问题', '问题继续', '分析问题\n\n问题继续'],
  ['前😀后', '😀后', '前😀后'], ['分析问题尾', '问题', '分析问题尾\n\n问题'],
])('uses exact whole-message suffix deduplication (%s)',(a,b,saved)=>expect(mentorText(a,b)).toBe(saved));
it.each(['分析'.repeat(5000),'',card.message,'分析\n\n'+card.message,'Analysis.\n','Analysis. ','Analysis.\n\n'])('saves and streams the same monotonic body',assistant=>{
  const result=agentTurnResult(assistant,output,true,card.message,true,true);
  expect(result.message).toBe(mentorText(assistant,card.message));
  expect(result.card).toEqual(card);
  const p=new NativeProgressProjection({mode:'agent',toolMessage:true,appendCard:true});
  let visible='';
  const accept=(update:ReturnType<typeof p.appendText>)=>{
    if(!update)return;
    expect(update.replace).toBe(false);expect(update.source).toBe('assistant');
    visible+=update.delta;expect(visible).toBe(update.text);expect(result.message.startsWith(visible)).toBe(true);
  };
  for(const point of Array.from(assistant))accept(p.appendText(point));
  const args=JSON.stringify(card);
  for(let index=0;index<args.length;index++)accept(p.appendToolFrame({choices:[{delta:{tool_calls:[{
    index:0,function:{...(index===0?{name:'ask_question'}:{}),arguments:args[index]},
  }]}}]}));
  accept(p.finish(result.message));expect(visible).toBe(result.message);
});
it('leaves old frozen turns unchanged',()=>{
  expect(agentTurnResult('previous analysis',output,true,card.message,true).message).toBe(card.message);
});
it.each([2,8])('stops in assistant or appended message with the same source (%s)',stopAt=>{
  const result=agentTurnResult('分析😀正文',output,true,card.message,true,true);
  const stopped=stoppedResult({executionId:'synthetic',format:'agent',body:result.body,stopAt,
    source:'assistant',expectedSource:'assistant',primaryComplete:true,attachedOrganizer:false,appendCard:true});
  expect(JSON.parse(stopped!.body)).toMatchObject({message:Array.from(result.message).slice(0,stopAt).join('').trimEnd(),card:null});
});
it('refresh and next-turn Session both carry the saved prose once, without changing receipts',async()=>{
  const saved:AgentInputItem[]=[];
  const inner:Session={getSessionId:async()=> 'synthetic',getItems:async()=>saved,
    addItems:async items=>{saved.push(...items);},popItem:async()=>undefined,clearSession:async()=>{}};
  const session=new NativeSession(inner,true);
  const items:AgentInputItem[]=[{role:'user',content:'输入'},
    {role:'assistant',status:'completed',content:[{type:'output_text',text:'分析'.repeat(5000)}]},
    {type:'function_call',callId:'card',name:'ask_question',arguments:JSON.stringify(card)},
    {type:'function_call_result',callId:'card',name:'ask_question',status:'completed',output:{type:'text',text:output}}];
  const receipt=JSON.stringify(items);
  await session.addItems(items);
  const result=agentTurnResult('分析'.repeat(5000),output,true,card.message,true,true);
  await session.finish(result.body,true,false);
  expect(await session.getItems()).toEqual([{role:'user',content:'输入'},{role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.parse(result.body).message}]}]);
  expect(recoverOpenRouterHistory(saved,new Set(['ask_question']))).toEqual(saved);
  expect(JSON.stringify(items)).toBe(receipt);
});
