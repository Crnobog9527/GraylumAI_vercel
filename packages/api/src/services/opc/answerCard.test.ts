/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {expect,it} from 'vitest';
import {opcGenerate,resolveAnswerCard,organizerAnswerCard} from './answerCard';
const executionId='10000000-0000-4000-8000-000000000001';
const card={message:'正文',question:'在哪个平台？',options:['甲','乙'],recommended:0,recommendationReason:'理由'};
const request=opcGenerate.parse({draftId:executionId,requestId:executionId,stepId:'step-0',input:'伪造文字',
 purpose:'mentor',questionId:'product',answerSource:{executionId,optionIndex:1}});
const view=(value:unknown,state='completed')=>({executions:[{executionId,state,request:{draftId:executionId,stepId:'step-0',purpose:'mentor',questionId:'product'},body:JSON.stringify({format:'agent-turn.v1',message:'正文',card:value})}]});
it('reads the saved option and organizer context, never the submitted option text',()=>{
 const answer=resolveAnswerCard(view(card),request);
 expect(answer.card.options[answer.optionIndex!]).toBe('乙');
 expect(organizerAnswerCard(answer)).toEqual({answeredCard:{question:card.question,options:card.options,
  selectedOption:'乙',selectedIndex:1,recommended:0}});
});
it('free input carries a card without claiming an option selection',()=>{
 const answer=resolveAnswerCard(view(card),{...request,answerSource:{executionId}});
 expect(organizerAnswerCard(answer)).toMatchObject({answeredCard:{selectedOption:null,selectedIndex:null}});
});
it('old three field cards remain readable',()=>{
 expect(resolveAnswerCard(view({question:'旧问题',options:['甲','乙']}),request).card.recommended).toBeNull();
});
it.each([null,{...card,recommendationReason:null},{...card,options:['甲','甲']}])('rejects invalid saved cards %j',value=>{
 expect(()=>resolveAnswerCard(view(value),request)).toThrow('OPC_ANSWER_SOURCE_DENIED');
});
it.each(['pending','cancelled','cost_pending'])('rejects unfinished source %s',state=>{
 expect(()=>resolveAnswerCard(view(card,state),request)).toThrow('OPC_ANSWER_SOURCE_DENIED');
});
it.each([-1,1.1,5])('rejects invalid option index %s',optionIndex=>{
 expect(opcGenerate.safeParse({...request,answerSource:{executionId,optionIndex}}).success).toBe(false);
});
it('rejects an in-schema option beyond the stored options',()=>{
 expect(()=>resolveAnswerCard(view(card),{...request,answerSource:{executionId,optionIndex:4}})).toThrow('OPC_ANSWER_SOURCE_DENIED');
});

it('only validates the selected source binding in mixed legacy and non-mentor history',()=>{
 const mixed=view(card);
 const unrelated={executionId:'unrelated',state:'completed',body:'{}'};
 expect(resolveAnswerCard({executions:[unrelated,{...unrelated,request:{purpose:'step',questionId:null}},
  ...mixed.executions]},request).questionId).toBe('product');
 for(const binding of [null,{purpose:'step'},{...mixed.executions[0]!.request,stepId:'another-step'}])
  expect(()=>resolveAnswerCard({executions:[{...mixed.executions[0],request:binding}]},request))
   .toThrow('OPC_ANSWER_SOURCE_DENIED');
});
