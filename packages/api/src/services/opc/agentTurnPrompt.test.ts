/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {describe,expect,it} from 'vitest';
import {agentTurnInstructions,OPENING_EXTRACTION_RULE} from './agentTurnPrompt';

const schema=[
 {id:'field-z',title:'任意建议',required:true,elicitation:'agent_proposal' as const},
 {id:'position',title:'历史事实',required:true},
 {id:'field-optional',required:false,elicitation:'user_fact' as const},
];
const input={step:{id:'custom-step',title:'固定修订步骤',schema,values:{'field-z':{status:'provisional'}}},
 question:schema[0]!,questionLabel:'7.2',workflowContext:[{id:'custom-step',fields:['field-z','position']}],opening:false};
function lineJson(prompt:string,label:string){
 const line=prompt.split('\n').find(item=>item.startsWith(label));
 expect(line).toBeDefined();return JSON.parse(line!.slice(label.length));
}
describe('pinned generic Agent turn prompt',()=>{
 it('carries required fields, declared roles and current states without inferring from field names',()=>{
  const prompt=agentTurnInstructions(input);
  expect(lineJson(prompt,'Current step material: ')).toEqual({id:'custom-step',title:'固定修订步骤',fields:[
   {id:'field-z',title:'任意建议',required:true,elicit:'agent_proposal',status:'provisional'},
   {id:'position',title:'历史事实',required:true,elicit:'user_fact',status:'missing'},
   {id:'field-optional',title:'field-optional',required:false,elicit:'user_fact',status:'missing'},
  ]});
  expect(lineJson(prompt,'Current information question: ')).toEqual({id:'field-z',title:'任意建议',label:'7.2'});
  expect(lineJson(prompt,'Field roles for the current question: ')).toEqual([
   {id:'field-z',title:'任意建议',required:true,elicit:'agent_proposal'},
  ]);
  expect(lineJson(prompt,'Steps and allowed fields: ')).toEqual(input.workflowContext);
  expect(prompt).not.toContain('{{');
 });
 it('requires substantive answers and analysis before an unsure user is asked to choose',()=>{
  const prompt=agentTurnInstructions(input);
  expect(prompt).toContain('Output only public natural-language text');
  expect(prompt).toContain('make exactly one ask_question call');
  expect(prompt).toContain('A vague reply is not a field value or confirmation');
  expect(prompt).toContain('When the user is not sure, first analyse the available information');
  expect(prompt).toContain('An acknowledgement, help request or uncertainty is neither an answer nor permission to advance');
  expect(prompt).toContain('every required user_fact');expect(prompt).toContain('every required agent_proposal');
  expect(prompt).toContain('Missing, unclear or provisional values do not prove confirmation.');
 });
 // Owner 2026-09-29: the card is an aid for sorting out known material, never a guess.
 it('states when a card is used and when prose is used instead',()=>{
  const prompt=agentTurnInstructions(input);
  expect(prompt).toContain("it never guesses the user's situation");
  expect(prompt).not.toContain('most turns need no card');
  expect(prompt).toContain('you MUST call ask_question');
  expect(prompt).toContain('including when they explicitly ask for options');
  expect(prompt).toContain('Never write a multiple-choice question only as assistant prose');
  expect(prompt).toContain('examples in prose do not replace the card');
  expect(prompt).toContain('Set recommended to null. Options must not assert facts about the user.');
  expect(prompt).toContain('insufficient information for a professional judgement, ask one open question');
  expect(prompt).toContain("Do not turn guesses about the user's audience, strengths or offer into options");
  expect(prompt).toContain('4. Clear answer: no card');
  expect(prompt).toContain('5. Host opening: no card');
  expect(prompt).toContain('Do not repeat the list of card options in prose');
  expect(prompt).toContain('Recommend one with a reason');
  expect(prompt).toContain('The host adds an Other entry; never add other, not-sure, skip, defer or continue options');
  expect(prompt).toContain('For user_fact, use a neutral card only for general ranges or categories and Socratic prose for open personal content');
  expect(prompt).toContain('never offer guesses as options');
  expect(prompt).toContain('explicitly label the claim as a hypothesis made because');
  expect(prompt).toContain('information is insufficient; never present it as measured data');
  expect(prompt).not.toContain('我不确定，帮我分析');
 });
 it('adds host-opening instructions only for openings and never fabricates user speech',()=>{
  expect(agentTurnInstructions(input)).not.toContain('This turn is opened by the host');
  const prompt=agentTurnInstructions({...input,opening:true});
  expect(prompt).toContain('the user has not spoken and no question card is available');
  expect(prompt).toContain('ask one useful question in prose');
  expect(prompt).toContain('first give one grounded, tentative draft recommendation');
  expect(OPENING_EXTRACTION_RULE).toContain('only if that field has elicit agent_proposal');
  expect(OPENING_EXTRACTION_RULE).toContain('Set status to provisional, basis to agent_proposal and nature to decision');
  expect(OPENING_EXTRACTION_RULE).toContain('any user_fact field as an answer');
  expect(OPENING_EXTRACTION_RULE).toContain('Never confirm or defer a field');
 });
 it.each([false,true])('keeps generic evidence, constraint and no-question boundaries for opening=%s',opening=>{
  const prompt=agentTurnInstructions({...input,opening});
  expect(prompt).toContain('A status supplies no value');
  expect(prompt).toContain('Preserve corrections without strengthening them');
  expect(prompt).toContain('Never invent the user\'s experience, strengths, customers, prices, results, numbers or research findings');
  expect(prompt).toContain('total time across combined activities');
  expect(prompt).toContain('an occasional maximum is not a sustainable commitment');
  expect(prompt).toContain('this overrides every case');
  expect(prompt).toContain('with no card, follow-up question, confirmation request or next-topic invitation');
  expect(prompt).toContain('one main question about the current');
  expect(prompt).toContain('acknowledge briefly without reopening it or offering to advance');
 });
 it('handles a revision without a current question',()=>{
  const prompt=agentTurnInstructions({...input,question:null,questionLabel:null});
  expect(lineJson(prompt,'Current information question: ')).toBeNull();
  expect(lineJson(prompt,'Field roles for the current question: ')).toEqual([]);
 });
});
