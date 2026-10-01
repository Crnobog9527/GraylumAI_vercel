/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {expect,it} from 'vitest';
import {z} from 'zod';
import {parseQuestionCard,questionToolCardSchema,readAgentTurnBody} from '../../shared/agentTurn';
import {askQuestionTool,askQuestionParameters,questionParameters,questionCardToolResult} from './agentTools';
import {agentTurnResult} from './agentTurnResult';

const old={question:'优先做什么？',options:['验证需求','完善样品'],recommended:0};
const card={...old,message:'先做小范围验证。',recommendationReason:'已有需求证据更少。'};
it('keeps the legacy schema bytes and nullable representation while requiring five new fields',()=>{
 const schema=z.toJSONSchema(questionParameters);
 expect(schema.required).toEqual(['question','options','recommended','message','recommendationReason']);
 expect(schema.properties!.recommended).toEqual(z.toJSONSchema(askQuestionParameters).properties!.recommended);
 expect(askQuestionTool().parameters).toBe(askQuestionParameters);
 expect(askQuestionTool(true).parameters).toBe(questionParameters);
 expect(()=>questionCardToolResult(old,true)).toThrow('RUNTIME_QUESTION_CARD_INVALID');
 expect(questionCardToolResult(old)).toBe(JSON.stringify({card:'question',...old}));
});
it.each([
 {...card,message:''},{...card,message:'x'.repeat(20001)},
 {...card,recommendationReason:''},{...card,recommendationReason:' '},
 {...card,recommendationReason:null},{...card,recommended:null},
 {...card,recommended:2},{...card,recommended:0.5},
 {...card,question:'x'.repeat(501)},{...card,options:['x'.repeat(201),'b']},
 {...card,options:['a']},{...card,options:['a','b','c','d','e','f']},
 {...card,options:['a',' a ']},{...card,unknown:true},
 {...old,message:'partial new card'},
])('rejects invalid five-field cards without legacy downgrade (%j)',value=>{
 expect(questionToolCardSchema.safeParse(value).success).toBe(false);
 expect(parseQuestionCard(value)).toBeNull();
});
it('uses only validated card message for display, persistence and refresh',()=>{
 for(const value of [card,{...card,recommended:null,recommendationReason:null}]){
  const result=agentTurnResult('Contradictory assistant prose',questionCardToolResult(value,true),true);
  expect(result.message).toBe(value.message);
  expect(result.card).toEqual(value);
  expect(readAgentTurnBody(result.body)).toMatchObject({message:value.message,card:value});
  const divergent=JSON.stringify({...JSON.parse(result.body),message:'Old duplicate text'});
  expect(readAgentTurnBody(divergent).message).toBe(value.message);
 }
 expect(parseQuestionCard(old)).toEqual(old);
 expect(agentTurnResult('Original old prose',questionCardToolResult(old),true).message).toBe('Original old prose');
});

it.each([
 {...card,recommendationReason:null},
 {...card,options:['duplicate','duplicate']},
 {...card,options:['x'.repeat(201),'other']},
])('retains independently valid paid prose when the five-field card is invalid (%j)',async value=>{
 const {questionMessageFromArguments,INVALID_CARD_RESULT}=await import('./agentTools');
 const tool=askQuestionTool(true);
 expect(()=>questionCardToolResult(value,true)).toThrow('RUNTIME_QUESTION_CARD_INVALID');
 expect(tool.invalidResult).toBe(INVALID_CARD_RESULT);
 const message=questionMessageFromArguments(JSON.stringify(value));
 const result=agentTurnResult('',INVALID_CARD_RESULT,true,message);
 expect(result).toMatchObject({message:card.message,card:null,truncated:false});
 expect(readAgentTurnBody(result.body)).toMatchObject({message:card.message,card:null});
});
it.each(['{broken','null','[]','{}',...['',' ','x'.repeat(20001),'unsafe\u0007text',123].map(message=>JSON.stringify({message}))])(
 'rejects an invalid fallback message (%s)',async args=>{
 const {questionMessageFromArguments,INVALID_CARD_RESULT}=await import('./agentTools');
 const {INVALID_REPLY_NOTICE}=await import('../../shared/agentTurn');
 expect(questionMessageFromArguments(args)).toBeNull();
 expect(agentTurnResult('',INVALID_CARD_RESULT,true,questionMessageFromArguments(args)))
  .toMatchObject({message:INVALID_REPLY_NOTICE,card:null});
});
