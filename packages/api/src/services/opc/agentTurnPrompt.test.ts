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
  expect(prompt).toContain('Output only public natural-language text.');
  expect(prompt).toContain('call ask_question once');
  expect(prompt).toContain('A vague, non-committal response is not a substantive field value or confirmation.');
  expect(prompt).toContain('我不确定，帮我分析');
  expect(prompt).toContain('analyse the available information and explain a useful recommendation before asking');
  expect(prompt).toContain('every required user_fact');expect(prompt).toContain('every required agent_proposal');
  expect(prompt).toContain('Missing, unclear or merely provisional values do not prove confirmation.');
 });
 it('adds host-opening instructions only for openings and never fabricates user speech',()=>{
  expect(agentTurnInstructions(input)).not.toContain('This turn is opened by the host');
  const prompt=agentTurnInstructions({...input,opening:true});
  expect(prompt).toContain('the user has not spoken yet');
  expect(prompt).toContain('first present one concrete draft recommendation');
  expect(OPENING_EXTRACTION_RULE).toContain('only if that field has elicit agent_proposal');
  expect(OPENING_EXTRACTION_RULE).toContain('Set status to provisional, basis to agent_proposal and nature to decision');
  expect(OPENING_EXTRACTION_RULE).toContain('any user_fact field as an answer');
  expect(OPENING_EXTRACTION_RULE).toContain('Never confirm or defer a field');
 });
 it('handles a revision without a current question',()=>{
  const prompt=agentTurnInstructions({...input,question:null,questionLabel:null});
  expect(lineJson(prompt,'Current information question: ')).toBeNull();
  expect(lineJson(prompt,'Field roles for the current question: ')).toEqual([]);
 });
});
