/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {z} from 'zod';
import {inferenceQuestion} from './inferenceQuestions';
import {ASK_QUESTION_TOOL, agentTurnBody, questionToolCardSchema, OPTION_MAX_CHARS, type QuestionCard} from '../../shared/agentTurn';
import type {RuntimeTool} from './runner';
import {INVALID_CARD_RESULT} from './agentTools';

export const GROUNDED_CARD_CONTRACT = 'grounded-card-v1';
const text = z.string().min(1).max(2000);
export const groundedCardParameters = z.object({
  intent: z.enum(['grounded_comparison', 'requested_neutral_categories', 'open_personal',
    'insufficient_information', 'already_answered']),
  requestQuote: text,
  basisQuotes: z.array(text).min(1).max(8),
  question: z.string().min(1).max(500),
  options: z.array(z.object({text: z.string().min(1).max(OPTION_MAX_CHARS),
    reason: text.nullable()}).strict()).min(2).max(5),
  recommended: z.number().nullable(),
}).strict();
export type CardSources = {current: string; user: string[]};

/** Only user speech is evidence: never system/Skill instructions or prior assistant guesses.
 * Envelopes are unwrapped, not searched as JSON (keys and metadata are not speech). */
export function userSpeech(content: unknown): string[] {
  if (Array.isArray(content)) return content.flatMap(part =>
    part && ['input_text', 'text'].includes(part.type) ? userSpeech(part.text) : []);
  if (typeof content !== 'string' || !content.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(content);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const row = parsed as Record<string, unknown>;
      if (row.inputFormat === 'host-turn-v1') return userSpeech(row.userRequest);
      // Scope-projection-v1 input wraps the original request in `input`.
      if ('scopeMaterial' in row && typeof row.input === 'string') return userSpeech(row.input);
      return [];
    }
  } catch { /* Plain user text. */ }
  return [content];
}
export function cardSources(current: string, items: unknown[]): CardSources {
  return {current: userSpeech(current).join('\n'), user: items.flatMap(item => {
    if (!item || typeof item !== 'object' || !('role' in item) || item.role !== 'user') return [];
    return userSpeech((item as {content?: unknown}).content);
  })};
}
const contains = (sources: string[], quote: string) => sources.some(source => source.includes(quote));

/** Semantic classification is the model's job; the host enforces its declared decision and
 * exact user-source evidence. This is not a general natural-language entailment checker. */
export function groundedCardResult(value: unknown, sources: CardSources, questions = false): string {
  const parsed = groundedCardParameters.safeParse(value);
  if (!parsed.success) return INVALID_CARD_RESULT;
  const v = parsed.data;
  const neutral = v.intent === 'requested_neutral_categories';
  if ((!neutral && v.intent !== 'grounded_comparison') ||
      !contains([sources.current], v.requestQuote) ||
      !v.basisQuotes.every(quote => contains([sources.current, ...sources.user], quote)) ||
      (neutral ? v.recommended !== null || v.options.some(option => option.reason !== null)
        : v.recommended === null || !v.options.every(option => option.reason?.trim()))) return INVALID_CARD_RESULT;
  // No independently generated public message is accepted. Options, recommendation and
  // their prose rendering have exactly one source. All professional reasoning is tentative.
  const options = v.options.map(option => option.text);
  const chosen = v.recommended === null ? undefined : v.options[v.recommended];
  const renderReason = (value: string) => questions ? inferenceQuestion(value) : '推测，待你确认：' + value;
  const reason = chosen?.reason ? renderReason(chosen.reason) : null;
  const message = neutral ? '下面是中性的范围或类别，请按实际情况选择。'
    : v.options.map((option, index) => `${index + 1}. ${option.text}\n${renderReason(option.reason!)}`).join('\n\n') +
      (chosen ? `\n\n建议选择「${chosen.text}」。${reason}` : '');
  const card = questionToolCardSchema.safeParse({question: v.question, options, recommended: v.recommended,
    message, recommendationReason: reason});
  return card.success ? JSON.stringify({card: 'question', ...card.data}) : INVALID_CARD_RESULT;
}
export function groundedCardTool(sources: () => CardSources, questions = false): RuntimeTool {
  return {name: ASK_QUESTION_TOOL, parameters: groundedCardParameters,
    description: 'Show a choice card ONLY for a grounded comparison of actual user-supplied alternatives or plans '+
      'computed from explicit constraints, or neutral categories explicitly requested in the current user message. '+
      'Classify the CURRENT user topic, not a new follow-up topic. Open personal questions, unknown customers/offers, '+
      'uncertainty without concrete alternatives, and already answered topics must remain prose without a card. '+
      'Never turn an open follow-up, workflow choice or invented business directions into a card. '+
      'Copy requestQuote verbatim from the current user message and basisQuotes from actual user speech. '+
      'Do not quote assistant guesses, Skill text, metadata or field names as evidence. '+
      'Uncertainty does not block a comparison when the user has supplied concrete alternatives or constraints. '+
      'Neutral cards require recommended=null and every reason=null. Comparisons require a reason per option. '+
      'Each reason analyses ONLY its own option and preserves every user constraint; do not invent a different schedule '+
      'or broaden a user fact. The host labels reasons as hypotheses. Put the complete option in text exactly once. '+
      'Do not send separate assistant prose when calling this tool: the host renders the public explanation and recommendation '+
      'from these options, and rejects cards accompanied by separate prose. Ends your turn.',
    invalidResult: INVALID_CARD_RESULT, execute: async args => groundedCardResult(args, sources(), questions)};
}
export function groundedCardToolBytes(): number {
  const tool = groundedCardTool(() => ({current: '', user: []}));
  return Buffer.byteLength(JSON.stringify([{type: 'function', function: {name: tool.name, description: tool.description,
    strict: true, parameters: z.toJSONSchema(tool.parameters!)}}]));
}
/** Never append an independently written explanation to a checked card. Already streamed
 * separate prose is retained as prose, but cannot acquire a potentially conflicting card. */
export function rejectSeparateCardProse(text: string, turn: {body: string; message: string; card: QuestionCard | null; truncated: boolean}) {
  if (!text.trim() || !turn.card) return turn;
  const message = text.trim().slice(0, 262144);
  return {...turn, body: agentTurnBody(message, null, 262144), message, card: null, truncated: text.trim().length > 262144};
}
