/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {expect,it} from 'vitest';
import {cardSources,groundedCardFallback,groundedCardParameters,groundedCardResult,groundedCardTool,groundedCardToolBytes,groundedTurn,rejectSeparateCardProse} from './groundedCard';
import {INVALID_CARD_RESULT,questionCardFromResult,askQuestionTool} from './agentTools';
import {agentTurnResult} from './agentTurnResult';
import {INVALID_REPLY_NOTICE,readAgentTurnBody} from '../../../shared/agentTurn';
import {projectMentorHistory} from '../mentorPrompt';
import {mentorReplyBody} from '../mentorInput';
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
// Owner 2026-11-26, option A (restoring 2026-09-29 item 20): staging had 0 cards in about 2,400 mentor replies because a
// neutral card needed the user to ask for options in the same message.
const neutral={intent:'neutral_categories',requestQuote:null,basisQuotes:[],question:'你每周大概能拿出多少时间？',
 options:[{text:'3 小时以内',reason:null},{text:'3 到 6 小时',reason:null},{text:'6 小时以上',reason:null}],recommended:null};
it('a neutral range card needs no request and no quotation from the user, and never carries a recommendation or reasons',()=>{
 const none={current:'我想获客，我们是做餐饮收银软件的。',user:[]};
 expect(questionCardFromResult(groundedCardResult(neutral,none))).toMatchObject({question:neutral.question,
  options:['3 小时以内','3 到 6 小时','6 小时以上'],recommended:null,recommendationReason:null});
 expect(groundedCardResult({...neutral,recommended:0},none)).toBe(INVALID_CARD_RESULT);
 expect(groundedCardResult({...neutral,options:choice.options},none)).toBe(INVALID_CARD_RESULT);
 // The name before the decision, and quotes the model still sends, are read as before.
 expect(questionCardFromResult(groundedCardResult({...neutral,intent:'requested_neutral_categories',requestQuote:'随便写',
  basisQuotes:['随便写']},none))?.options).toHaveLength(3);
});
it('a comparison (with a recommendation) still needs the current request and the user\'s own alternatives, quoted',()=>{
 expect(groundedCardResult({...choice,requestQuote:null},sources)).toBe(INVALID_CARD_RESULT);
 expect(groundedCardResult({...choice,basisQuotes:[]},sources)).toBe(INVALID_CARD_RESULT);
 expect(groundedCardResult({...choice,intent:'neutral_categories'},sources)).toBe(INVALID_CARD_RESULT);
});
// Owner 2026-11-27 pay2 seq 20: the step-2 opening asked which kind of account to look for and listed four general kinds in
// prose; the host refused every card on an opening, so the question stayed prose. The coach's own words of that reply.
const PAY2_SEQ20='下面先从关键词开始。你想让我在小红书上找哪一类账号？可以直接说你的想法。比如：\n'+
 '- 杭州本地的皮具工作室，开体验课的那种；\n- 外地做皮具手作、教零基础的个人博主；\n'+
 '- 做手作体验的其他品类，比如陶艺、香薰、银饰，做法可以借鉴；\n- 都可以，由我按"皮具体验课加杭州"先找，再把相邻方向补进来。';
const seq20={intent:'neutral_categories',requestQuote:null,basisQuotes:[],question:'你想让我在小红书上找哪一类账号？',
 options:[{text:'杭州本地皮具工作室',reason:null},{text:'外地零基础皮具博主',reason:null},{text:'其他手作体验品类',reason:null}],
 recommended:null};
// Owner 2026-11-27 option C: neutral cards are the host's (fixedQuestions.ts). A neutral card the model sends anyway is refused
// on every turn, and its arguments come back as prose, so the coach's words still reach the user.
it('the tool refuses a neutral card the model sends (pay2 seq 20 style), on an opening or not; the prose stays',async()=>{
 const opening={current:'',user:[]};
 for(const turn of [{},{opening:true},{opening:true,firstOpening:true}])
  expect(await groundedCardTool(()=>opening,turn).execute(seq20,'x')).toBe(INVALID_CARD_RESULT);
 expect(await groundedCardTool(()=>sources).execute(neutral,'x')).toBe(INVALID_CARD_RESULT);
 const kept=groundedTurn(PAY2_SEQ20,INVALID_CARD_RESULT,true,groundedCardFallback(JSON.stringify(seq20)));
 expect(kept.card).toBeNull();
 expect(kept.message).toBe(PAY2_SEQ20);
 expect(groundedCardFallback(JSON.stringify(neutral))).toContain('1. 3 小时以内');
 // A comparison card is unaffected, and still refused on an opening.
 expect(questionCardFromResult(await groundedCardTool(()=>sources).execute(choice,'x'))).not.toBeNull();
 expect(groundedCardResult(choice,sources,{opening:true})).toBe(INVALID_CARD_RESULT);
});
it('a neutral card keeps the coach\'s acknowledgement before it; a comparison card with separate prose is still refused',()=>{
 const neutralTurn=groundedTurn('明白了，你想通过账号获客。',groundedCardResult(neutral,sources),true,null);
 expect(neutralTurn.card?.options).toHaveLength(3);
 expect(neutralTurn.message).toBe('明白了，你想通过账号获客。');
 expect(JSON.parse(neutralTurn.body)).toMatchObject({message:'明白了，你想通过账号获客。',card:{recommended:null}});
 // Review (P2): a reload and the next turn's history read the card's own message; both must keep the coach's words.
 expect(readAgentTurnBody(neutralTurn.body)).toMatchObject({message:'明白了，你想通过账号获客。',card:{options:['3 小时以内','3 到 6 小时','6 小时以上']}});
 expect(projectMentorHistory([{seq:2,role:'assistant',content:mentorReplyBody(neutralTurn.body,'s','r'),contentHash:'h'}])[0]!.content)
  .toBe('明白了，你想通过账号获客。');
 const alone=groundedTurn('',groundedCardResult(neutral,sources),true,null);
 expect(alone.card).not.toBeNull();expect(alone.message).toBe('下面是中性的范围或类别，请按实际情况选择。');
 const comparison=groundedTurn('另一套安排。',groundedCardResult(choice,sources),true,null);
 expect(comparison.card).toBeNull();expect(comparison.message).toBe('另一套安排。');
 expect(groundedTurn('',groundedCardResult(choice,sources),true,null).card?.recommended).toBe(0);
});
it('the tool tells the model neutral cards are the host\'s; its schema still reads a neutral call (refused, shown as prose)',()=>{
 const description=groundedCardTool(()=>sources).description!;
 expect(description).toContain('never uses this tool: the host shows its own card for its fixed questions');
 expect(description).not.toContain('explicitly requested in the current user message');
 expect(groundedCardParameters.safeParse(neutral).success).toBe(true);
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

// Staging 2026-10-19: the card quoted organizer field text, not user speech, so the host refused it. The
// contract forbids separate prose, so the paid turn used to end on the invalid-format notice.
it('a refused guarded card without prose falls back to host-rendered prose instead of the invalid notice',()=>{
 const refused={...choice,basisQuotes:['计划每周集中制作四小时']};
 expect(groundedCardResult(refused,sources)).toBe(INVALID_CARD_RESULT);
 const prose=groundedCardFallback(JSON.stringify(refused))!;
 expect(prose).toContain('先选哪种安排？');
 for(const option of choice.options){expect(prose).toContain(option.text);expect(prose).toContain('推测，待你确认：'+option.reason);}
 expect(prose).not.toContain('建议选择');
 const turn=agentTurnResult('',INVALID_CARD_RESULT,true,prose,true,false);
 expect(turn).toMatchObject({card:null,message:prose});expect(JSON.parse(turn.body)).toMatchObject({card:null,message:prose});
 expect(rejectSeparateCardProse('',turn)).toEqual(turn);
 const neutral=groundedCardFallback(JSON.stringify({...choice,intent:'requested_neutral_categories',recommended:null,
  options:[{text:'少量',reason:null},{text:'较多',reason:null}]}))!;
 expect(neutral).toContain('1. 少量');expect(neutral).not.toContain('推测');
});
it('only a quotation refusal falls back; declared no-card intents and rule-breaking cards keep the invalid notice',()=>{
 for(const intent of ['open_personal','insufficient_information','already_answered'])
  expect(groundedCardFallback(JSON.stringify({...choice,intent}))).toBeNull();
 expect(groundedCardFallback(JSON.stringify({...choice,recommended:null}))).toBeNull();
 expect(groundedCardFallback(JSON.stringify({...choice,recommended:9}))).toBeNull();
 expect(groundedCardFallback(JSON.stringify({...choice,options:[choice.options[0],choice.options[0]]}))).toBeNull();
 expect(groundedCardFallback(JSON.stringify({...choice,options:[{text:'甲',reason:'理由'},{text:'乙',reason:null}]}))).toBeNull();
 expect(groundedCardFallback(JSON.stringify({...choice,intent:'requested_neutral_categories',recommended:null}))).toBeNull();
});
it('malformed guarded card arguments keep the invalid notice',()=>{
 for(const bad of ['{"question":"q"',JSON.stringify({question:'q',options:['a','b'],recommended:0}),null])
  expect(groundedCardFallback(bad)).toBeNull();
 expect(agentTurnResult('',INVALID_CARD_RESULT,true,null,true,false).message).toBe(INVALID_REPLY_NOTICE);
});
