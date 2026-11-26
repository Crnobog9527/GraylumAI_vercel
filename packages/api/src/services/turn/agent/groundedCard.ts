/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {z} from 'zod';
import {AGENT_TURN_MESSAGE_LIMIT, ASK_QUESTION_TOOL, agentTurnBody, questionToolCardSchema, OPTION_MAX_CHARS, type QuestionCard} from '../../../shared/agentTurn';
import type {RuntimeTool} from './runner';
import {INVALID_CARD_RESULT, questionCardFromResult} from './agentTools';
import {agentTurnResult} from './agentTurnResult';

export const GROUNDED_CARD_CONTRACT = 'grounded-card-v1';
const text = z.string().min(1).max(2000);
export const groundedCardParameters = z.object({
  // requested_neutral_categories: the name before the Owner's 2026-11-26 decision, still read from frozen turns.
  intent: z.enum(['grounded_comparison', 'neutral_categories', 'requested_neutral_categories', 'open_personal',
    'insufficient_information', 'already_answered']),
  requestQuote: text.nullable(),
  basisQuotes: z.array(text).max(8),
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

export const isNeutralIntent = (intent: string) => intent === 'neutral_categories' || intent === 'requested_neutral_categories';
/** Semantic classification is the model's job; the host enforces its declared decision and
 * exact user-source evidence. This is not a general natural-language entailment checker.
 * Owner 2026-11-26 (option A, restoring 2026-09-29 item 20): a neutral range or category card needs no request from the
 * user and no quotation, carries no recommendation and no reasons; a comparison (with a recommendation) still needs the
 * current request and the user's own alternatives, quoted verbatim. No card on a host opening (the user has not spoken). */
export function groundedCardResult(value: unknown, sources: CardSources, turn: {opening?: boolean} = {}): string {
  const parsed = groundedCardParameters.safeParse(value);
  if (!parsed.success || turn.opening) return INVALID_CARD_RESULT;
  const v = parsed.data;
  const neutral = isNeutralIntent(v.intent);
  if (neutral ? v.recommended !== null || v.options.some(option => option.reason !== null)
    : v.intent !== 'grounded_comparison' || v.requestQuote === null || !contains([sources.current], v.requestQuote) ||
      !v.basisQuotes.length || !v.basisQuotes.every(quote => contains([sources.current, ...sources.user], quote)) ||
      v.recommended === null || !v.options.every(option => option.reason?.trim())) return INVALID_CARD_RESULT;
  // No independently generated public message is accepted. Options, recommendation and
  // their prose rendering have exactly one source. All professional reasoning is tentative.
  const options = v.options.map(option => option.text);
  const chosen = v.recommended === null ? undefined : v.options[v.recommended];
  const reason = chosen?.reason ? '推测，待你确认：' + chosen.reason : null;
  const message = neutral ? '下面是中性的范围或类别，请按实际情况选择。'
    : v.options.map((option, index) => `${index + 1}. ${option.text}\n推测，待你确认：${option.reason}`).join('\n\n') +
      (chosen ? `\n\n建议选择「${chosen.text}」。${reason}` : '');
  const card = questionToolCardSchema.safeParse({question: v.question, options, recommended: v.recommended,
    message, recommendationReason: reason});
  return card.success ? JSON.stringify({card: 'question', ...card.data}) : INVALID_CARD_RESULT;
}
/** A guarded card refused ONLY for its quotations is never shown as a card, and its tool contract
 * forbids separate prose. Rather than ending a paid turn on the invalid-format notice, the host renders
 * the same arguments as plain prose (every reason labelled as a hypothesis, no recommendation) for the
 * user to answer freely. Every other refusal (a declared no-card intent, a bad card shape, reasons that
 * break the comparison/neutral rules) keeps the notice: the check below is groundedCardResult with the
 * evidence requirement alone satisfied by the card's own quotations. */
export function groundedCardFallback(arguments_: unknown): string | null {
  let value: unknown;
  try { value = typeof arguments_ === 'string' ? JSON.parse(arguments_) : null; } catch { return null; }
  const parsed = groundedCardParameters.safeParse(value);
  if (!parsed.success) return null;
  const v = parsed.data;
  if (groundedCardResult(v, {current: v.requestQuote ?? '', user: v.basisQuotes}) === INVALID_CARD_RESULT) return null;
  const options = v.options.map((option, index) => `${index + 1}. ${option.text}` +
    (option.reason?.trim() ? `\n推测，待你确认：${option.reason.trim()}` : '')).join('\n\n');
  return `${v.question.trim()}\n\n${options}\n\n可以直接回复你的选择，或用自己的话补充。`;
}
export function groundedCardTool(sources: () => CardSources, turn: {opening?: boolean} = {}): RuntimeTool {
  return {name: ASK_QUESTION_TOOL, parameters: groundedCardParameters,
    description: 'Show a question card for exactly two kinds of question. '+
      '(1) neutral_categories: you ask the user to place themselves in general ranges or categories that can be listed '+
      'without knowing the user (for example weekly hours, platform types, how customers usually buy, budget or team size). '+
      'Use it whenever you ask such a question, including as your own next question; the user need not ask for options. '+
      'Set recommended=null, every reason=null, requestQuote=null and basisQuotes=[]. Options are general categories, '+
      'never guesses about the user\'s own experience, strengths, story, customers, offer or results. '+
      'You may write a short acknowledgement before the call; do not repeat the options in it. '+
      '(2) grounded_comparison: the user chooses between concrete alternatives the user supplied, or plans computed from the '+
      'user\'s explicit constraints. Copy requestQuote verbatim from the current user message and basisQuotes from actual '+
      'user speech; never quote assistant guesses, Skill text, metadata or field names. Give a reason per option and '+
      'recommend one. Each reason analyses ONLY its own option and preserves every user constraint; do not invent a '+
      'different schedule or broaden a user fact. The host labels reasons as hypotheses and renders the explanation and '+
      'recommendation from these options; send no separate prose with a comparison card (it would be refused). '+
      'Never use a card on a host opening, for open personal questions (experience, strengths, stories, customers, offers), '+
      'for confirmation or workflow choices, or for anything already answered: ask in prose. Put each complete option in '+
      'text exactly once. The host adds an Other entry. Ends your turn.',
    invalidResult: INVALID_CARD_RESULT, execute: async args => groundedCardResult(args, sources(), turn)};
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

/**
 * The turn a mentor reply makes (Owner 2026-11-26): a neutral card (no recommendation) keeps the coach's short prose before it,
 * so an acknowledgement of the user's answer is not lost; a comparison card accompanied by separate prose is refused as before.
 */
export function groundedTurn(text: string, output: string, toolCalled: boolean, cardMessage: string | null | undefined) {
  const card = toolCalled ? questionCardFromResult(output) : null;
  if (card && card.recommended === null && text.trim()) {
    // The coach's own words in the reply's language; the card carries the question and the options.
    const raw = text.trim(), message = raw.slice(0, AGENT_TURN_MESSAGE_LIMIT);
    return {body: agentTurnBody(message, card), message, card, truncated: raw.length > AGENT_TURN_MESSAGE_LIMIT};
  }
  return rejectSeparateCardProse(text, agentTurnResult(text, output, toolCalled, text.trim() ? undefined : cardMessage));
}
