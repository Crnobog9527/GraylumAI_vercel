/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {expect,it} from 'vitest';
import {cardSources,groundedCardResult,groundedCardTool,groundedCardToolBytes,rejectSeparateCardProse} from './groundedCard';
import {INVALID_CARD_RESULT,questionCardFromResult,askQuestionTool} from './agentTools';
import {agentTurnResult} from './agentTurnResult';
import {hostTurnContextSchema} from './hostTurn';
const sources={current:'我考虑甲或乙，还不确定，帮我比较。',user:['每周共四小时。']};
const choice={intent:'grounded_comparison',requestQuote:'甲或乙',basisQuotes:['每周共四小时。'],
 question:'先选哪种安排？',options:[{text:'甲：每周四小时集中制作',reason:'便于集中准备'},
 {text:'乙：每周两次，各两小时',reason:'便于分别安排'}],recommended:0};
it('allows a grounded comparison despite uncertainty; canonical prose and recommendation share exact options',()=>{
 const output=groundedCardResult(choice,sources),card=questionCardFromResult(output)!;
 expect(card.options).toEqual(choice.options.map(o=>o.text));
 for(const option of choice.options)expect(card.message).toContain(option.text);
 expect(card.message).toContain('建议选择「'+card.options[card.recommended!]+'」');
 expect(card.recommendationReason).toBe('推测，待你确认：便于集中准备');
 expect(card.message).toContain(card.recommendationReason);
 expect(groundedCardToolBytes()).toBeGreaterThan(1000);
});
it.each(['open_personal','insufficient_information','already_answered'])('host rejects %s even with valid card shape and real quotations',intent=>{
 expect(groundedCardResult({...choice,intent},sources)).toBe(INVALID_CARD_RESULT);
});
it('requires current request evidence and earlier USER evidence, rejecting invented or assistant-only quotes',()=>{
 const actual=cardSources(sources.current,[{role:'assistant',content:'每周共四小时。'},
 {role:'system',content:'每周共四小时。'},{role:'user',content:'尚未提供时间。'}]);
 expect(groundedCardResult(choice,actual)).toBe(INVALID_CARD_RESULT);
 expect(groundedCardResult({...choice,requestQuote:'请列选项'},sources)).toBe(INVALID_CARD_RESULT);
 expect(groundedCardResult({...choice,basisQuotes:['每周八小时']},sources)).toBe(INVALID_CARD_RESULT);
 expect(cardSources(sources.current,[{role:'user',content:JSON.stringify({inputFormat:'host-turn-v1',
  userRequest:'每周共四小时。',hostTurnContext:{stepId:'metadata'}})}]).user).toEqual(['每周共四小时。']);
});
it('allows explicitly requested neutral categories but prevents a recommendation or guessed rationale',()=>{
 const neutral={...choice,intent:'requested_neutral_categories',recommended:null,
  requestQuote:'请列常见范围',basisQuotes:['请列常见范围'],options:[{text:'少量',reason:null},{text:'较多',reason:null}]};
 const source={current:'请列常见范围',user:[]};
 expect(questionCardFromResult(groundedCardResult(neutral,source))).toMatchObject({recommended:null,recommendationReason:null});
 expect(groundedCardResult({...neutral,recommended:0},source)).toBe(INVALID_CARD_RESULT);
 expect(groundedCardResult({...neutral,options:choice.options},source)).toBe(INVALID_CARD_RESULT);
});
it('rejects duplicate options, invalid recommendation and independent prose without retracting already streamed text',()=>{
 expect(groundedCardResult({...choice,recommended:10},sources)).toBe(INVALID_CARD_RESULT);
 expect(groundedCardResult({...choice,options:[choice.options[0],choice.options[0]]},sources)).toBe(INVALID_CARD_RESULT);
 const result=agentTurnResult('',groundedCardResult(choice,sources),true,null,true,false);
 const rejected=rejectSeparateCardProse('另一套时间安排。',result);
 expect(rejected.card).toBeNull();expect(JSON.parse(rejected.body).message).toBe('另一套时间安排。');
 expect(rejectSeparateCardProse('',result)).toEqual(result);
});
it('old frozen contexts and tool arguments remain accepted without new fields',async()=>{
 expect(hostTurnContextSchema.parse({stepId:'old',opening:false,checklist:[]})).not.toHaveProperty('cardContract');
 const output=await askQuestionTool(true).execute({question:'choose',options:['a','b'],recommended:0,
  message:'legacy prose',recommendationReason:'legacy reason'},'old');
 expect(questionCardFromResult(output)?.message).toBe('legacy prose');
 expect(groundedCardTool(()=>sources).parameters).not.toHaveProperty('message');
});

it('invalid guarded card keeps paid separate prose and conflicting oversized prose stays bounded',()=>{
 const text='已经输出的分析';
 const invalid=agentTurnResult(text,INVALID_CARD_RESULT,true,undefined,true,false);
 expect(rejectSeparateCardProse(text,invalid)).toMatchObject({card:null,message:text});
 const valid=agentTurnResult('',groundedCardResult(choice,sources),true,undefined,true,false);
 const bounded=rejectSeparateCardProse('x'.repeat(262145),valid);
 expect(bounded.message.length).toBe(262144);expect(bounded.truncated).toBe(true);expect(bounded.card).toBeNull();
});
