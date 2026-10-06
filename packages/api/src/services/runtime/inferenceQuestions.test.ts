/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {expect,it} from 'vitest';
import {confirmationQuestions,confirmProseTurn,inferenceQuestion} from './inferenceQuestions';
import {NativeProgressProjection} from './nativeProgress';
import {groundedCardResult} from './groundedCard';
import {questionCardFromResult} from './agentTools';
it('turns explicitly marked deductions into confirmation questions without guessing unmarked intent',()=>{
 expect(confirmationQuestions('已知内容。\n我猜：你更重视稳定。')).toBe('已知内容。\n我猜：你更重视稳定，对吗？');
 expect(confirmationQuestions('推测，待你确认：尚未准备好。')).toBe('我猜：尚未准备好，对吗？');
 expect(confirmationQuestions('我猜：这是临时计划，对吗？')).toBe('我猜：这是临时计划，对吗？');
 expect(confirmationQuestions('用户已明确提供的事实。')).toBe('用户已明确提供的事实。');
 expect(inferenceQuestion('便于准备。')).toBe('我猜：便于准备，对吗？');
});
it('split streaming markers never expose a marked assertion before its confirmation suffix',()=>{
 const p=new NativeProgressProjection({mode:'agent',confirmationQuestions:true});
 expect(p.appendText('我')).toBeNull();expect(p.appendText('猜：可能偏好独立工作。')).toBeNull();
 const update=p.appendText('\n下一段');expect(update?.text).toBe('我猜：可能偏好独立工作，对吗？\n');
 const final=confirmationQuestions('我猜：可能偏好独立工作。\n下一段');p.finish(final);expect(p.text).toBe(final);
 const old=new NativeProgressProjection({mode:'agent'});expect(old.appendText('我猜：旧冻结内容。')?.text).toBe('我猜：旧冻结内容。');
});
it('saves the same corrected prose while leaving checked cards as the only source of their explanation',()=>{
 const turn=confirmProseTurn({message:'我猜：暂时没有准备。',body:'unused',card:null,truncated:false});
 expect(JSON.parse(turn.body).message).toBe(turn.message);expect(turn.message.endsWith('对吗？')).toBe(true);
 const input={intent:'grounded_comparison',requestQuote:'比较甲乙',basisQuotes:['比较甲乙'],question:'哪一种？',
 options:[{text:'甲',reason:'便于集中准备'},{text:'乙',reason:'便于分散安排'}],recommended:0};
 const card=questionCardFromResult(groundedCardResult(input,{current:'比较甲乙',user:[]},true))!;
 expect(card.recommendationReason).toBe('我猜：便于集中准备，对吗？');expect(card.message).toContain(card.recommendationReason);
 expect(card.recommended).toBe(0);expect(card.options).toEqual(['甲','乙']);
});
it('bounds expanded prose and keeps its confirmation suffix and saved representation aligned',()=>{
 const message='我猜：'+'甲'.repeat(262141);
 const turn=confirmProseTurn({message,body:'unused',card:null,truncated:false});
 expect(turn.message.length).toBeLessThanOrEqual(262144);expect(turn.truncated).toBe(true);
 expect(turn.message.endsWith('，对吗？')).toBe(true);expect(JSON.parse(turn.body).message).toBe(turn.message);
 const p=new NativeProgressProjection({mode:'agent',confirmationQuestions:true,appendCard:true});
 p.appendText(message+'\n更多');p.finish(turn.message);expect(p.text).toBe(turn.message);
});
it('bounded expansion preserves completed line prefixes including empty lines',()=>{
 const source='已知内容。\n\n我猜：偏好安静。\n下一行';
 const partial=confirmationQuestions(source,false);
 expect(partial).toBe('已知内容。\n\n我猜：偏好安静，对吗？\n');
 expect(confirmationQuestions(source).startsWith(partial)).toBe(true);
 expect(confirmationQuestions('我猜：'+'😀'.repeat(30),true,30)).not.toMatch(/[\uD800-\uDBFF]，对吗？$/u);
});

it('an unrelated trailing question cannot substitute for confirming a marked deduction',()=>{
 expect(confirmationQuestions('我猜：你偏好独立工作。准备在哪个平台？'))
  .toBe('我猜：你偏好独立工作。准备在哪个平台，对吗？');
 expect(confirmationQuestions('我猜：你偏好独立工作，是这样吗？')).toBe('我猜：你偏好独立工作，是这样吗？');
 expect(confirmationQuestions('Hypothesis: You prefer solo work, is that correct?'))
  .toBe('Hypothesis: You prefer solo work, is that correct?');
});
