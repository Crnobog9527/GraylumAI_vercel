/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import { readAgentTurnBody } from '../../shared/agentTurn';
import { CHECKLIST_UPDATED_INPUT, isOpeningInput, readChecklistUpdatedInput } from '../../shared/opcQuestions';
import { isStepSummaryInput } from '../../shared/opcStepSummary';
import type { AnsweredCard } from '../opc/answerCard';
import type { HistoryItem } from './db';

/*
 * CORE-PATH-V2 V2-5b: what kind of mentor turn a request is, from the host markers of the old path (opening, step summary,
 * checklist updated) and the answered card. The rules are the old path's (service.ts prepareStep, stepSummary.ts,
 * opcQuestions.ts): a summary is never organized and answers no card; a checklist event answers no card; an opening answers
 * nothing. An answered card is the card of the conversation's latest mentor reply, which must belong to this step (its saved
 * body carries the step, mentorReplyBody); a chosen option becomes the user's words, as the old path replaced the input.
 * sourceSeq is the message the user answered (its seq, as GET /api/turn shows it): an answer from a stale tab whose card was
 * since replaced is refused rather than mapped onto the newer card's options.
 */
export const mentorAnswer = z.object({ sourceSeq: z.number().int().positive(),
  optionIndex: z.number().int().min(0).max(4).optional() }).strict();
export type MentorAnswer = z.infer<typeof mentorAnswer>;

export type MentorTurnInput = { opening: boolean; summary: boolean; updatedFieldIds?: string[]; organize: boolean };

export class MentorInputError extends Error {
  constructor() { super('TURN_REQUEST_INVALID'); }
}

export function mentorTurnInput(input: { text: string; organizeAfter: boolean; answer?: MentorAnswer }): MentorTurnInput {
  let summary: boolean, updatedFieldIds: string[] | undefined;
  try { summary = isStepSummaryInput(input.text); updatedFieldIds = readChecklistUpdatedInput(input.text); }
  catch { throw new MentorInputError(); }
  const opening = isOpeningInput(input.text);
  if ((summary && (input.organizeAfter || input.answer)) || (updatedFieldIds && input.answer) || (opening && input.answer))
    throw new MentorInputError();
  // An opening is always organized (it may carry a mentor proposal for an agent_proposal field); a summary never.
  return { opening, summary, ...(updatedFieldIds ? { updatedFieldIds } : {}), organize: opening || (input.organizeAfter && !summary) };
}

/**
 * The card the user answers, from the latest mentor reply of this step; refused when there is none, when the user answered
 * another message, or when the option is out of range.
 */
export function mentorAnsweredCard(history: readonly HistoryItem[], stepId: string, answer: MentorAnswer,
  turnId: number): AnsweredCard {
  const last = [...history].reverse().find(m => m.role === 'assistant');
  const card = last ? readAgentTurnBody(last.content).card : null;
  let step: unknown;
  try { step = last ? (JSON.parse(last.content) as { stepId?: unknown }).stepId : undefined; } catch { step = undefined; }
  if (!card || step !== stepId || last!.seq !== answer.sourceSeq || (answer.optionIndex !== undefined && answer.optionIndex >= card.options.length))
    throw new Error('TURN_ANSWER_SOURCE_DENIED');
  return { executionId: String(turnId), card, ...(answer.optionIndex === undefined ? {} : { optionIndex: answer.optionIndex }) };
}

/** The user's words of an answered turn: the chosen option's text, or what they typed for a free answer. */
export function answeredText(text: string, answered: AnsweredCard | undefined): string {
  return answered?.optionIndex === undefined ? text : answered.card.options[answered.optionIndex]!;
}

/** A saved mentor reply: the agent-turn body plus the step and round it belongs to (readers of the body ignore the extra keys). */
export function mentorReplyBody(body: string, stepId: string, roundId: string): string {
  return JSON.stringify({ ...(JSON.parse(body) as Record<string, unknown>), stepId, roundId });
}

const CONFIRMATION_REQUEST = /确认卡|確認卡|confirmation card/i;
/**
 * Owner 2026-11-27 (pay2): with the step ready, four replies running asked the user again to click the confirmation card. The
 * card stays on screen, so the host marks the turn once a saved reply of this step and round has asked for it, and the coach
 * then records what the user adds without asking again (agentTurnPrompt.ts). Only replies of the same step and round count.
 */
export function confirmationAsked(history: readonly HistoryItem[], stepId: string, roundId: string): boolean {
  return askedInStep(history, stepId, roundId, message => CONFIRMATION_REQUEST.test(message));
}

/** Whether a saved reply of this step and round says `asks` (its message as shown). */
export function askedInStep(history: readonly HistoryItem[], stepId: string, roundId: string, asks: (message: string) => boolean): boolean {
  return history.some(item => {
    if (item.role !== 'assistant') return false;
    let saved: { stepId?: unknown; roundId?: unknown };
    try { saved = JSON.parse(item.content) as typeof saved; } catch { return false; }
    return saved?.stepId === stepId && saved.roundId === roundId && asks(readAgentTurnBody(item.content).message);
  });
}

/**
 * Whether the user has said anything in this conversation: a saved user message that is not a host marker (an opening, a
 * step summary or a checklist event). Before it, an opening is the conversation's first and shows no card (MASTER_PLAN §3).
 */
export function userHasSpoken(history: readonly HistoryItem[]): boolean {
  return history.some(item => {
    return item.role === 'user' && !isOpeningInput(item.content) && !isStepSummaryInput(item.content)
      && !item.content.startsWith(CHECKLIST_UPDATED_INPUT);
  });
}

const LINKS_DECLINED = [
  /(没有|没|不想|不愿|不用|不会|不打算|不再|不能|不方便|不发|不给|不提供|拿不出|给不了|提供不了)[^。！？\n]{0,10}链接/,
  /链接[^。！？\n]{0,4}(没有|不想|不给|不发|不提供|找不到)/,
  /\b(no|don'?t have|do not have|won'?t|not (going to )?(send|share|provide|give))\b[^.!?\n]{0,30}\blinks?\b/i,
];
/**
 * Owner 2026-11-27 (pay2 seq 5, 24, 28, 29): whether the user said they have no profile links or will not send any. The
 * user's own words, oldest first; a later message carrying a profile link reopens it (only the user may). The benchmark
 * search then never offers "send a link" as a way on (discovery.ts candidateShortage).
 */
export function profileLinksDeclined(userTexts: readonly string[], carriesLink: (text: string) => boolean): boolean {
  let declined = false;
  for (const text of userTexts) {
    if (carriesLink(text)) declined = false;
    else if (LINKS_DECLINED.some(pattern => pattern.test(text))) declined = true;
  }
  return declined;
}
