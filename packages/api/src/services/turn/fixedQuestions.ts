/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { questionToolCardSchema, readAgentTurnBody, type QuestionCard } from '../../shared/agentTurn';
import type { ReplyLocale } from '../../shared/replyLocales';
import type { HostTurnContext } from './agent/hostTurn';
import type { HistoryItem } from './db';

/*
 * Owner 2026-11-27 option C (MASTER_PLAN §2.1, "固定问题由系统出卡"): a fixed list of neutral questions, each with its short options.
 * The host, not the model, decides when one is asked and shows its card, so a list question always gets its card:
 *  - only a field that has a fixed question gets one; personal fields (experience, strengths, stories, customers, what the user
 *    already has) stay prose, as everything outside the list does;
 *  - only when the next empty field of the step is that field, so the coach's own order of questions is kept, or when the coach
 *    asks a later list field's question word for word (laterFixedQuestions);
 *  - never on the conversation's first opening, a step summary, or once the step is ready or confirmed;
 *  - only in the interview (mode mentor): importing an existing positioning (mode manual) asks for the user's material instead;
 *  - not when the user asks in this turn for no questions or options (that request overrides the question rules, agentTurnPrompt.ts;
 *    review of #2060);
 *  - never twice in a round, and not when the user answered the field in the same turn (the organizer wrote it).
 * Cards carry no recommendation; the page adds the "Other" entry. The questions and options are copy (the decision allows edits).
 */
type Localized = Record<ReplyLocale, string>;
export type FixedQuestion = { id: string; fieldId: string; question: Localized; options: Record<ReplyLocale, readonly string[]>;
  /** Asked only while the step's benchmark search has not started (no keyword or candidate card, no qualified account). */
  beforeResearch?: true };

export const FIXED_QUESTIONS: readonly FixedQuestion[] = [
  { id: 'goal', fieldId: 'goal',
    question: { 'zh-Hans': '你做这个账号，最希望它最后带来什么？', 'zh-Hant': '你做這個帳號，最希望它最後帶來什麼？',
      en: 'What do you most want this account to bring you in the end?' },
    options: { 'zh-Hans': ['每月多份零花钱', '给生意带客户', '慢慢做成主业', '卖课程或产品', '先试试适不适合'],
      'zh-Hant': ['每月多份零用錢', '幫生意帶客人', '慢慢做成主業', '賣課程或產品', '先試試適不適合'],
      en: ['Some side income', 'Customers for my business', 'A full-time living', 'Selling courses or products', 'Just trying it out'] } },
  { id: 'platform', fieldId: 'platforms',
    question: { 'zh-Hans': '你打算先在哪个平台做？', 'zh-Hant': '你打算先在哪個平台做？', en: 'Which platform do you want to start on?' },
    options: { 'zh-Hans': ['小红书', '抖音', '视频号', 'B站'], 'zh-Hant': ['小紅書', '抖音', 'YouTube', 'Instagram'],
      en: ['TikTok', 'YouTube', 'Instagram', 'Xiaohongshu'] } },
  { id: 'weekly_time', fieldId: 'resources',
    question: { 'zh-Hans': '你每周大概能拿出多少时间做账号？', 'zh-Hant': '你每週大概能拿出多少時間做帳號？',
      en: 'How much time can you give the account each week?' },
    options: { 'zh-Hans': ['3 小时以内', '3 到 6 小时', '6 到 10 小时', '10 小时以上'],
      'zh-Hant': ['3 小時以內', '3 到 6 小時', '6 到 10 小時', '10 小時以上'],
      en: ['Under 3 hours', '3 to 6 hours', '6 to 10 hours', 'Over 10 hours'] } },
  { id: 'filming', fieldId: 'resources',
    question: { 'zh-Hans': '拍内容时，你能接受哪种方式？', 'zh-Hant': '拍內容時，你能接受哪種方式？', en: 'How are you willing to make content?' },
    options: { 'zh-Hans': ['真人出镜', '不露脸只拍画面', '图文为主', '配音讲解'], 'zh-Hant': ['真人出鏡', '不露臉只拍畫面', '圖文為主', '配音講解'],
      en: ['On camera', 'Hands and scenes only', 'Mostly images and text', 'Voice-over'] } },
  { id: 'budget', fieldId: 'resources',
    question: { 'zh-Hans': '起步阶段，你打算花多少钱？', 'zh-Hant': '起步階段，你打算花多少錢？', en: 'How much do you plan to spend at the start?' },
    options: { 'zh-Hans': ['基本不花钱', '几百元以内', '一两千元', '更多'], 'zh-Hant': ['基本不花錢', '幾百元以內', '一兩千元', '更多'],
      en: ['Almost nothing', 'Under $100', '$100 to $500', 'More'] } },
  { id: 'benchmark_kind', fieldId: 'benchmark_findings', beforeResearch: true,
    question: { 'zh-Hans': '你想先参考哪一类账号？', 'zh-Hant': '你想先參考哪一類帳號？', en: 'Which kind of account do you want to learn from first?' },
    options: { 'zh-Hans': ['本地同行', '外地同类博主', '相邻品类'], 'zh-Hant': ['本地同行', '外地同類創作者', '相鄰品類'],
      en: ['Local peers', 'Similar creators elsewhere', 'Neighbouring niches'] } },
];

/** Fixed host text that comes with the question (per-turn data in the current message, never in the cached instructions). */
export const FIXED_QUESTION_NOTE = 'Host question of this turn. Unless the user\'s message already answers it, end your reply with exactly '
  + 'this question as your one main question. The host shows its options on a card under your reply: never list options, examples '
  + 'or categories for it in prose, and do not call ask_question. A short acknowledgement and why you ask are fine.';

/** The user asks for no questions or options in this turn ("先不要提问或给选项，只回答我的问题"). */
const NO_QUESTIONS = new RegExp(['(不要|别|不用|先别|暂时不要|先不要)(再)?(问我|问|提问|追问|给我?选项|出选项|列选项)',
  '只(回答|说)(我的)?(这个)?问题', '直接(回答|说结论)',
  '\\bno (more )?(questions|options)\\b', "\\bdon'?t ask\\b", '\\bwithout (any )?(questions|options)\\b', '\\bjust answer\\b'].join('|'), 'i');

export type ChosenQuestion = { fixed: FixedQuestion; question: string; options: readonly string[] };

/** The question texts of the cards saved in this round (any step), from the saved replies (mentorReplyBody). */
function askedInRound(history: readonly HistoryItem[], roundId: string): Set<string> {
  const asked = new Set<string>();
  for (const item of history) {
    if (item.role !== 'assistant') continue;
    let saved: { roundId?: unknown };
    try { saved = JSON.parse(item.content) as typeof saved; } catch { continue; }
    const card = saved?.roundId === roundId ? readAgentTurnBody(item.content).card : null;
    if (card) asked.add(card.question.trim());
  }
  return asked;
}

type Pick = { host: HostTurnContext; history: readonly HistoryItem[]; roundId: string; locale: ReplyLocale;
  firstOpening: boolean; summary: boolean; mode: unknown; words: string };

/** The step's empty list fields in order, the next field the user is asked about, and the question of each list field. */
function plan(input: Pick): { next: string | null; questions: Map<string, ChosenQuestion> } | null {
  const { host } = input;
  if (input.mode !== 'mentor' || input.summary || input.firstOpening || NO_QUESTIONS.test(input.words)
    || host.confirmation?.stepReady || host.confirmation?.stepConfirmed) return null;
  const fields = host.checklist.find(step => step.id === host.stepId)?.fields ?? [];
  const missing = fields.filter(field => field.required && field.status === 'missing');
  // The next field the user is asked about: the first empty one the user supplies; in a step of the coach's drafts only (step 2),
  // the first empty one with a fixed question.
  const next = missing.find(field => field.role === 'user_fact')
    ?? missing.find(field => FIXED_QUESTIONS.some(fixed => fixed.fieldId === field.id));
  const research = host.research;
  const researchStarted = Boolean(research && (research.cards.length > 0 || research.benchmarks.qualified > 0));
  const asked = askedInRound(input.history, input.roundId);
  const questions = new Map<string, ChosenQuestion>();
  for (const field of missing) {
    const fixed = FIXED_QUESTIONS.find(q => q.fieldId === field.id && !(q.beforeResearch && researchStarted)
      && !Object.values(q.question).some(text => asked.has(text)));
    if (fixed) questions.set(field.id, { fixed, question: fixed.question[input.locale], options: fixed.options[input.locale] });
  }
  return { next: next?.id ?? null, questions };
}

/** The fixed question this turn asks, or null (see the rules above). */
export function fixedQuestionFor(input: Pick): ChosenQuestion | null {
  const found = plan(input);
  return found?.next ? found.questions.get(found.next) ?? null : null;
}

/*
 * The list questions of the step's later empty fields (pay2 2026-11-27, seq 10). The host picks before the organizer writes this
 * turn's answer: when the user answers the field the host expected next (or answers it in passing), the coach goes on to the
 * field after it, which the host did not know. The coach therefore gets each later list field's question to ask word for word
 * when its question is about that field, and the host shows that card when the reply contains the question exactly.
 */
export function laterFixedQuestions(input: Pick): ChosenQuestion[] {
  const found = plan(input);
  return found ? [...found.questions].filter(([fieldId]) => fieldId !== found.next).map(([, chosen]) => chosen) : [];
}

/** Fixed host text that comes with the later questions (per-turn data in the current message). */
export const LATER_QUESTIONS_NOTE = 'Questions of later fields of this step. When your one main question is about one of these fields '
  + '(for example because the user\'s message answers the field you asked about), ask exactly its question as written here and end '
  + 'your reply with it. The host shows its options on a card: never list options, examples or categories for it in prose, and do '
  + 'not call ask_question.';

// Exact containment after removing Markdown emphasis and spaces only ("**你打算先在哪个平台做？**"): no fuzzy matching.
const plain = (text: string) => text.replace(/[*_\s]/g, '');

/**
 * The card the host shows under the reply, or null: of the host's question and the later ones, the one whose exact question the
 * reply ends with last; without one, the host's question of this turn. Never a question whose field the organizer wrote this
 * turn (the user answered it).
 */
export function fixedCardChoice(input: { chosen: ChosenQuestion | null; later: readonly ChosenQuestion[]; reply: string;
  written: (fieldId: string) => boolean }): ChosenQuestion | null {
  const reply = plain(input.reply);
  const open = [...(input.chosen ? [input.chosen] : []), ...input.later].filter(q => !input.written(q.fixed.fieldId));
  const quoted = open.map(q => ({ q, at: reply.lastIndexOf(plain(q.question)) })).filter(x => x.at >= 0).sort((a, b) => b.at - a.at);
  if (quoted[0]) return quoted[0].q;
  return input.chosen && !input.written(input.chosen.fixed.fieldId) ? input.chosen : null;
}

/** Whether the organizer wrote the question's field this turn (the user answered it in passing: no card). */
export function organizerWrote(output: unknown, stepId: string, fieldId: string): boolean {
  const patches = output && typeof output === 'object' ? (output as { patches?: unknown }).patches : undefined;
  return Array.isArray(patches) && patches.some(patch => Boolean(patch) && typeof patch === 'object'
    && (patch as { stepId?: unknown }).stepId === stepId && (patch as { fieldId?: unknown }).fieldId === fieldId);
}

/** The card the host shows under the coach's words: no recommendation; the coach's words are its message. */
export function fixedQuestionCard(chosen: ChosenQuestion, message: string): QuestionCard {
  return questionToolCardSchema.parse({ question: chosen.question, options: [...chosen.options], recommended: null, message,
    recommendationReason: null });
}
