/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import { readAgentTurnBody } from '../../shared/agentTurn';
import { isOpeningInput, readChecklistUpdatedInput } from '../../shared/opcQuestions';
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
