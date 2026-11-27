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
  expect(prompt).toContain('Never ask a case 1 question in prose only; call ask_question.');
  expect(prompt).toContain('2. Neutral ranges or categories: the host shows its card for hostTurnContext.fixedQuestion');
  expect(prompt).toContain('insufficient information for a professional judgement, ask one open question');
  expect(prompt).toContain('For open personal content (experience, strengths, stories, customers or goals), NEVER issue a card');
  expect(prompt).toContain('4. Clear answer: no card');
  expect(prompt).toContain('5. Host opening: no ask_question.');
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
  expect(prompt).toContain('the user has not spoken and ask_question is not available');
  expect(prompt).toContain('ask one useful question about a real gap');
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

describe('Owner 2026-11-27 option C: neutral cards come only from the host\'s fixed questions', () => {
  it('the mentor never sends a neutral card; with a fixed question it asks exactly that and lists no options', () => {
    expect(AGENT_TURN_STABLE_PREFIX).not.toContain('Neutral cards need no user request.');
    expect(AGENT_TURN_STABLE_PREFIX).toContain("Neutral cards come only from the host's fixed questions.");
    expect(AGENT_TURN_STABLE_PREFIX).toContain('ask any other in prose, never with ask_question');
    expect(AGENT_TURN_STABLE_PREFIX).toContain('ask exactly that question unless the user already answered it');
    expect(AGENT_TURN_STABLE_PREFIX).toContain('never list its options, examples or categories in prose');
    expect(AGENT_TURN_STABLE_PREFIX).toContain('NEVER issue a card');
    const description = groundedCardTool(() => ({current: '', user: []})).description!;
    expect(description).toContain('Show a question card only for a grounded comparison');
    expect(description).toContain('hostTurnContext.fixedQuestion');
    expect(description).not.toContain('neutral_categories: you ask the user');
  });
  it('the mentor never asks again what the user already answered', () => {
    expect(AGENT_TURN_STABLE_PREFIX).toContain('Never re-ask an answered question');
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
    expect(AGENT_TURN_STABLE_PREFIX).toContain('once per step; it stays on screen.');
    expect(AGENT_TURN_STABLE_PREFIX).not.toContain('request the card click again');
    expect(AGENT_TURN_STABLE_PREFIX).toContain('point to the card in one sentence, without advancing');
  });
});

describe('Owner 2026-11-27 pay2 run: a declined link is never offered again, and an asked confirmation is not asked again', () => {
  it('a declined thing overrides tool results that suggest it (seq 28, 30: "send a profile link" after a search)', () => {
    expect(AGENT_TURN_STABLE_PREFIX).toContain('Tool results never reopen it; never mention it again, even as a later option.');
  });
  it('the step-2 opening asks only for keywords when the user has or wants no profile links (seq 9, 21, 23)', () => {
    const opening = researchOpeningInstructions({opening: true, stepId: 'step-2'});
    expect(opening).toContain('If the user said they have or want no profile links, ask only for keywords and never for links.');
    expect(opening.indexOf('ask only for keywords')).toBeLessThan(opening.indexOf('ask for full profile URLs'));
  });
  it('confirmationAsked tells the coach the card was already requested: no summary, no card, just record (seq 12–18)', () => {
    expect(AGENT_TURN_STABLE_PREFIX).toContain('With hostTurnContext.confirmationAsked it was requested');
    expect(AGENT_TURN_STABLE_PREFIX).toContain('never summarize the step or mention the card again');
  });
});
