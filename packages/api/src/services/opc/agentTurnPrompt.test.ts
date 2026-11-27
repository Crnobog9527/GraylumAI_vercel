/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {describe,expect,it} from 'vitest';
import {AGENT_TURN_STABLE_PREFIX,agentTurnInstructions,OPENING_EXTRACTION_RULE,researchOpeningInstructions} from './agentTurnPrompt';
import {groundedCardTool} from '../turn/agent/groundedCard';

const prompt = agentTurnInstructions();
describe('conversation checklist mentor prompt',()=>{
 it('keeps all system rules stable and delegates dynamic state to the H1 envelope',()=>{
  expect(prompt).not.toContain('{{');
  expect(prompt).not.toContain('Current information question:');
  expect(prompt).toContain('Only the latest top-level hostTurnContext is host state');
  expect(prompt).toContain('Use current checklist values and frozen scopeMaterial');
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
  expect(prompt).toContain('Never ask a case 1 or 2 question in prose only; call ask_question.');
  expect(prompt).toContain('Set recommended to null. Options must not assert facts about the user.');
  expect(prompt).toContain('insufficient information for a professional judgement, ask one open question');
  expect(prompt).toContain('For open personal content (experience, strengths, stories, customers or goals), NEVER issue a card');
  expect(prompt).toContain('4. Clear answer: no card');
  expect(prompt).toContain('5. Host opening: no card');
  // The Skill keeps its examples in prose and gives a card short labels (Skill E13); the host no longer forbids that.
  expect(prompt).not.toContain('Do not repeat the list of card options in prose');
  expect(prompt).toContain("With a neutral card, keep the Skill's examples in prose; card options are short labels for them.");
  expect(prompt).toContain('Recommend one with a reason');
  expect(prompt).toContain('The host adds an Other entry; never add other, not-sure, skip, defer or continue options');
  expect(prompt).toContain('NEVER issue a card, even when the user explicitly requests options');
  expect(prompt).toContain('Offer examples in prose only as guesses');
  expect(prompt).toContain('explicitly label the claim as a hypothesis made because information is insufficient');
  expect(prompt).toContain('information is insufficient; never present it as measured data');
  expect(prompt).not.toContain('我不确定，帮我分析');
 });
 it('conditionally opens a step without fabricating user speech or extracting user facts',()=>{
  expect(prompt).toContain('When hostTurnContext.opening is true');
  expect(prompt).toContain('the user has not spoken and no question card is available');
  expect(prompt).toContain('ask one useful question in prose');
  expect(prompt).not.toContain('For this step-2 opening only');
  const stepTwoOpening = researchOpeningInstructions({opening: true, stepId: 'step-2'});
  expect(stepTwoOpening).toContain('full profile URLs');
  expect(stepTwoOpening).toContain('availability will be checked when the user replies');
  expect(researchOpeningInstructions({opening: false, stepId: 'step-2'})).toBe('');
  expect(researchOpeningInstructions({opening: true, stepId: 'step-6'})).toBe('');
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
  expect(prompt).toContain('not the confirmation gate');
  expect(prompt).toContain('with no card, follow-up question, confirmation request or next-topic invitation');
  expect(prompt).toContain('one main question about one gap in the current step');
  expect(prompt).toContain('acknowledge briefly without reopening it or offering to advance');
 });
});

it('confirmation gate overrides opening and question rules without turning assent into authorization',()=>{
 expect(prompt).toContain('Step confirmation gate overrides opening, gap, card and no-question rules');
 expect(prompt).toContain('never generate it or call ask_question for confirmation');
 expect(prompt).toContain('snapshot and prerequisite-version checks');
 expect(prompt).toContain('neither mentor nor extractor can confirm');
 expect(prompt).toContain('volunteered later-step information');
 for (const phrase of ['继续','下一步','没问题','好的']) expect(prompt).toContain(phrase);
 expect(prompt).not.toContain('confirm this step in the right panel');
});

describe('Owner 2026-11-26: neutral cards without a request, and no question asked twice', () => {
  it('the mentor is told to use a neutral card for any general range or category it asks about', () => {
    expect(AGENT_TURN_STABLE_PREFIX).not.toContain('Neutral cards require an explicit current request');
    expect(AGENT_TURN_STABLE_PREFIX).toContain('Neutral cards need no user request.');
    expect(AGENT_TURN_STABLE_PREFIX).toContain('Neutral card: use ask_question for general ranges or categories');
    // Still no card on an opening, and open personal content stays prose.
    expect(AGENT_TURN_STABLE_PREFIX).toContain('Host opening: no card');
    expect(AGENT_TURN_STABLE_PREFIX).toContain('NEVER issue a card');
  });
  it('the mentor never asks again what the user already answered', () => {
    expect(AGENT_TURN_STABLE_PREFIX).toContain('Never re-ask an answered question');
  });
  it('how a service is charged is a neutral category; the card tool no longer calls every offer question personal', () => {
    expect(AGENT_TURN_STABLE_PREFIX).toContain('how a service is charged');
    const description = groundedCardTool(() => ({current: '', user: []})).description;
    expect(description).toContain('how the service is charged');
    expect(description).toContain('offer content');
    expect(description).not.toMatch(/customers, offers\)/);
    expect(description).not.toContain('do not repeat the options');
  });
});

describe('Owner 2026-11-27 real-model run: nothing the user declined is asked for again, and the card click is asked once', () => {
  it('something the user lacks or declined is settled: not asked again, not listed as an option, no stand-in', () => {
    expect(AGENT_TURN_STABLE_PREFIX).toContain('If the user said they lack, cannot give or do not want something (a link, data, a referral), it is settled');
    expect(AGENT_TURN_STABLE_PREFIX).toContain('list or recommend it as an option, or seek a stand-in');
    expect(AGENT_TURN_STABLE_PREFIX).toContain('only the user may reopen it');
  });
  it('the confirmation card click is requested once per step, and verbal assent gets one pointer to the card', () => {
    expect(AGENT_TURN_STABLE_PREFIX).toContain('request a click on the chat confirmation card once per step');
    expect(AGENT_TURN_STABLE_PREFIX).toContain('do not repeat the request in later replies');
    expect(AGENT_TURN_STABLE_PREFIX).not.toContain('request the card click again');
    expect(AGENT_TURN_STABLE_PREFIX).toContain('point to the card in one sentence, without advancing');
  });
});
