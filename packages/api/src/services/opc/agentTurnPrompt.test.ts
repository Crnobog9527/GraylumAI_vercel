/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {describe,expect,it} from 'vitest';
import {agentTurnInstructions,OPENING_EXTRACTION_RULE} from './agentTurnPrompt';

const prompt = agentTurnInstructions();
describe('conversation checklist mentor prompt',()=>{
 it('keeps all system rules stable and delegates dynamic state to the H1 envelope',()=>{
  expect(prompt).not.toContain('{{');
  expect(prompt).not.toContain('Current information question:');
  expect(prompt).toContain('Only the latest top-level hostTurnContext is host state');
  expect(prompt).toContain('Values come from the current frozen scopeMaterial');
 });
 it('requires substantive answers and analysis before an unsure user is asked to choose',()=>{

  expect(prompt).toContain('Output only public natural-language text');
  expect(prompt).toContain('make exactly one ask_question call');
  expect(prompt).toContain('A vague reply is not a field value or confirmation');
  expect(prompt).toContain('When the user is not sure, first analyse the available information');
  expect(prompt).toContain('An acknowledgement, help request or uncertainty is neither an answer nor permission to advance');
  expect(prompt).toContain('Draft is not confirmed');
 });
 // Owner 2026-09-29: the card is an aid for sorting out known material, never a guess.
 it('states when a card is used and when prose is used instead',()=>{

  expect(prompt).toContain("it never guesses the user's situation");
  expect(prompt).not.toContain('most turns need no card');
  expect(prompt).toContain('you MUST call ask_question');
  expect(prompt).toContain('including when they explicitly ask for options');
  expect(prompt).toContain('Never write a multiple-choice question only as assistant prose');
  expect(prompt).toContain('examples in prose do not replace the card');
  expect(prompt).toContain('Set recommended to null. Options must not assert facts about the user.');
  expect(prompt).toContain('insufficient information for a professional judgement, ask one open question');
  expect(prompt).toContain("Do not turn guesses about the user's customers, audience, strengths, story or offer into options");
  expect(prompt).toContain('4. Clear answer: no card');
  expect(prompt).toContain('5. Host opening: no card');
  expect(prompt).toContain('Do not repeat the list of card options in prose');
  expect(prompt).toContain('Recommend one with a reason');
  expect(prompt).toContain('The host adds an Other entry; never add other, not-sure, skip, defer or continue options');
  expect(prompt).toContain('For user_fact, use a neutral card only for general ranges or categories and Socratic prose for open personal content');
  expect(prompt).toContain('never offer guesses as options');
  expect(prompt).toContain('explicitly label the claim as a hypothesis made because information is insufficient');
  expect(prompt).toContain('information is insufficient; never present it as measured data');
  expect(prompt).not.toContain('我不确定，帮我分析');
 });
 it('conditionally opens a step without fabricating user speech or extracting user facts',()=>{
  expect(prompt).toContain('When hostTurnContext.opening is true');
  expect(prompt).toContain('the user has not spoken and no question card is available');
  expect(prompt).toContain('ask one useful question in prose');
  expect(OPENING_EXTRACTION_RULE).toContain('any user_fact field as an answer');
  expect(OPENING_EXTRACTION_RULE).toContain('patches: []');
 });
 it.each([false,true])('keeps generic evidence, constraint and no-question boundaries for opening=%s',opening=>{
  expect(typeof opening).toBe('boolean');
  expect(prompt).toContain('A status supplies no value');
  expect(prompt).toContain('Preserve corrections without strengthening them');
  expect(prompt).toContain('Never invent the user\'s experience, strengths, customers, prices, results, numbers or research findings');
  expect(prompt).toContain('total time across combined activities');
  expect(prompt).toContain('an occasional maximum is not a sustainable commitment');
  expect(prompt).toContain('this overrides every case');
  expect(prompt).toContain('with no card, follow-up question, confirmation request or next-topic invitation');
  expect(prompt).toContain('one main question about one gap in the current step');
  expect(prompt).toContain('acknowledge briefly without reopening it or offering to advance');
 });
});
