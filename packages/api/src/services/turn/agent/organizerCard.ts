/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {AGENT_TURN_MESSAGE_LIMIT, MAX_OPTIONS, MIN_OPTIONS, QUESTION_MAX_CHARS, agentTurnBody, questionToolCardSchema,
  type QuestionCard} from '../../../shared/agentTurn';

/*
 * Owner 2026-11-26 (option A, 2026-09-29 item 20): a question asking the user to place themselves in general ranges or
 * categories is shown as a question card. The Skill asks for every question to carry its examples in prose, and the model
 * kept to that: in the 2026-11-27 real-model run (and in every mentor turn of the 30 days before) it never called
 * ask_question, so no neutral card ever appeared. The organizer already reads every delivered reply; when the mentor wrote
 * such a question as prose, the organizer names it and its categories, and the host shows them as a neutral card under the
 * same prose. The host checks what it can: the question must be the mentor's own (verbatim in the reply), the options short
 * category labels, no recommendation, and the turn one that may carry a card at all (not an opening, a step summary, a
 * research turn or a step waiting for its confirmation click). Whether a question is neutral is the organizer's judgement.
 */
export const ORGANIZER_CARD_KEY = 'neutralCard';
/** Short labels: the reply keeps the long examples (Skill: options are a few words; examples stay in the prose). */
export const ORGANIZER_CARD_OPTION_CHARS = 24;

export const ORGANIZER_CARD_RULE = [
  `The output object may also contain ${ORGANIZER_CARD_KEY}: {question, options} or null (default null).`,
  'Set it only when the primary assistant reply\'s one main question asks the user to place themselves in general ranges or',
  'categories that can be listed without knowing the user, and the reply names those categories (in a list or inside the',
  'question itself): for example weekly hours,',
  'platform, how the service is priced or charged (per hour, per room, per job), budget, team size, posting frequency,',
  'filming setup, or where customers usually come from.',
  'question: the reply\'s main question copied verbatim (no ** marks). options: 2 to 5 short labels of at most',
  `${ORGANIZER_CARD_OPTION_CHARS} characters, one per listed category in the reply's order; no other, not-sure or skip entry.`,
  'Return null when the question asks for the user\'s own experience, strengths, story, specific customers or audience,',
  'goals, offer content or results; when the listed items are guesses about this user (for example labelled as guesses);',
  'for a link, keyword, name or number; for a confirmation or a choice between proposals; or when there is no such question.',
].join(' ');

const plain = (text: string) => text.replace(/\*\*|__/g, '').replace(/\s+/g, '');

/** The organizer's card, checked against the reply it was read from; null when there is none or it fails a check. */
export function organizerNeutralCard(output: unknown, reply: string): QuestionCard | null {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return null;
  const value = (output as Record<string, unknown>)[ORGANIZER_CARD_KEY];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const {question, options} = value as {question?: unknown; options?: unknown};
  if (typeof question !== 'string' || !Array.isArray(options)) return null;
  const asked = question.replace(/\*\*|__/g, '').trim();
  // The mentor's own question, word for word: never a question the organizer wrote.
  if (!asked || asked.length > QUESTION_MAX_CHARS || plain(asked).length < 4 || !plain(reply).includes(plain(asked))) return null;
  const labels = options.map(option => typeof option === 'string' ? option.trim() : '');
  if (labels.length < MIN_OPTIONS || labels.length > MAX_OPTIONS || labels.some(label => !label ||
    Array.from(label).length > ORGANIZER_CARD_OPTION_CHARS) || new Set(labels).size !== labels.length) return null;
  const card = questionToolCardSchema.safeParse({question: asked, options: labels, recommended: null,
    message: reply.trim().slice(0, AGENT_TURN_MESSAGE_LIMIT), recommendationReason: null});
  return card.success ? card.data : null;
}

/** The organizer's output as turn_close reads it: the card is the host's, not a checklist write. */
export function withoutOrganizerCard(output: unknown): unknown {
  if (!output || typeof output !== 'object' || Array.isArray(output) || !(ORGANIZER_CARD_KEY in output)) return output;
  const rest = {...output as Record<string, unknown>};
  delete rest[ORGANIZER_CARD_KEY];
  return rest;
}

/** The reply with the organizer's card under the same prose (the card's own message is that prose, as groundedTurn). */
export function withOrganizerCard(turn: {body: string; message: string; card: QuestionCard | null; truncated: boolean},
  card: QuestionCard) {
  return {...turn, body: agentTurnBody(turn.message, {...card, message: turn.message}), card: {...card, message: turn.message}};
}
