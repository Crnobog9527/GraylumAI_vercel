/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {describe,expect,it} from 'vitest';
import {AGENT_TURN_MESSAGE_LIMIT,INVALID_REPLY_NOTICE} from '../../shared/agentTurn';
import {agentTurnResult} from './agentTurnResult';
import {INVALID_CARD_RESULT,questionCardToolResult} from './agentTools';

const card={question:'下一步优先做什么？',options:['验证需求','完善样品']};
const output=questionCardToolResult(card);
describe('host-owned Agent turn envelope',()=>{
 it('keeps natural text with quotes and line breaks without asking the model for JSON',()=>{
  const message='用户说“先试试”，我建议 "小步验证"。\n理由如下。';
  const result=agentTurnResult('',message,false);
  expect(JSON.parse(result.body)).toEqual({format:'agent-turn.v1',message,card:null});
  expect(result.truncated).toBe(false);
 });
 it('keeps text preceding a valid card and also allows a card-only turn',()=>{
  for(const message of ['先从最小实验开始。','']){
   const result=agentTurnResult(message,output,true);
   expect(result.card).toEqual(card);
   expect(JSON.parse(result.body)).toEqual({format:'agent-turn.v1',message,card});
  }
 });
 it.each([
  INVALID_CARD_RESULT,'{broken','Error parsing tool arguments',
  JSON.stringify({card:'question',question:'问题',options:['相同',' 相同 ']}),
  JSON.stringify({card:'question',question:'问\u0007题',options:['甲','乙']}),
  JSON.stringify({card:'question',...card,unexpected:true}),
 ])('never exposes invalid tool output as prose (%s)',toolResult=>{
  const result=agentTurnResult('仍保留已付费的分析。',toolResult,true);
  expect(result.message).toBe('仍保留已付费的分析。');expect(result.card).toBeNull();
  expect(agentTurnResult('',toolResult,true).message).toBe(INVALID_REPLY_NOTICE);
 });
 it.each(['','   \n'])('stores the notice when successful output has neither text nor card',empty=>{
  const result=agentTurnResult('',empty,false);
  expect(JSON.parse(result.body)).toEqual({format:'agent-turn.v1',message:INVALID_REPLY_NOTICE,card:null});
 });
 it.each([false,true])('truncates before constructing the envelope (tool=%s)',toolCalled=>{
  const text='字'.repeat(AGENT_TURN_MESSAGE_LIMIT+1);
  const result=agentTurnResult(text,toolCalled?output:text,toolCalled);
  expect(result.message).toHaveLength(AGENT_TURN_MESSAGE_LIMIT);expect(result.truncated).toBe(true);
  expect(JSON.parse(result.body).message).toBe(text.slice(0,AGENT_TURN_MESSAGE_LIMIT));
  expect(JSON.parse(result.body)).not.toHaveProperty('truncated');
  expect(agentTurnResult('',text.slice(1),false).truncated).toBe(false);
 });
 it('requires an actual tool call before interpreting JSON as a card',()=>{
  const result=agentTurnResult('',output,false);
  expect(result.message).toBe(output);expect(result.card).toBeNull();
 });
});
