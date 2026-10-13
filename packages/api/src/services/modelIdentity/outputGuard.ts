/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { BRAND_REPLY_EN, BRAND_REPLY_ZH, BRAND_REPLY_ZH_HANT } from './brandIdentity';
import { questionCardSchema, questionToolCardSchema } from '../../shared/agentTurn';

/**
 * MODEL-IDENTITY-GUARD layer 3: replace a model's first-person self-identification
 * ("我是 Claude", "我是由 Google 训练的…", "I am GPT-4", "I was trained by OpenAI") with the
 * Owner-approved brand reply. It inspects model output only, never user intent, and ordinary
 * mentions of AI products ("ChatGPT 和 Claude 哪个适合写文案") are left alone.
 */
const BRAND = String.raw`(?:claude|anthropic|chat\s?gpt|gpt(?:[-\s]?\d[\w.]*)?|openai|gemini|google|deepmind|bard|qwen|通[义義]千[问問]?|阿里(?:巴巴|云)|`
  + String.raw`deepseek|深度求索|llama|meta\s?ai|mistral|grok|x\.?ai|文心一言|百度|kimi|月之暗面|豆包|字[节節]跳[动動]|位元組跳動|智[谱譜]|chatglm|glm|混元|[腾騰][讯訊]|`
  + String.raw`谷歌|微软|microsoft|copilot)`;
const ZH_GAP = '[^。！？!?.\\n，,；;]';
// After a bare brand, an identity claim ends the clause or continues with model wording; "I am Google
// certified", "I am Claude's biggest fan", "我是 Claude 的重度用户" are ordinary copy (review P2).
const VERSION = String.raw`(?:[-\s]?\d[\w.]*|\s+(?:opus|sonnet|haiku|flash|pro|ultra|turbo|mini|nano|lite|max))*`;
const EN_END = String.raw`(?=\s*(?:[,.!?;:]|$)|\s+(?:an?\s+|the\s+)?(?:[\w-]+\s+){0,2}?(?:model|AI|assistant|chatbot|LLM)\b`
  + String.raw`|\s+(?:by|from|developed|trained|made|created|built)\b)`;
// Simplified and Traditional forms of the same words (review: 我由 Anthropic 開發 / 我的底層模型是 / 我基於).
const MADE = '(?:[训訓][练練]|[开開][发發]|打造|[研][发發]|[创創]建|推出|[设設][计計])';
const FROM = '(?:由|[来來]自)';
const ZH_END = `(?=\\s*(?:[，,。.！!？?；;：:、]|$)|\\s*(?:大?模型|助手|AI|[语語]言模型|${FROM}|${MADE}))`;
const PATTERNS = [
  // 我是 Claude / 我叫 ChatGPT / 我是一个 Gemini 模型
  `我(?:是|叫|就是)\\s*(?:一[个個]|一款|名叫)?\\s*${BRAND}${VERSION}${ZH_END}`,
  // 我是由 Google 训练的大型语言模型 / 我是来自 OpenAI 的语言模型
  // 由/来自 must follow 我是 directly (optionally 一个/一款): "我是想看看来自 Google 的开发工具" is ordinary copy (review P2).
  `我(?:是|叫)\\s*(?:一[个個]|一款)?\\s*${FROM}\\s*${BRAND}\\s*(?:公司)?${ZH_GAP}{0,10}?(?:${MADE}|的${ZH_GAP}{0,6}?(?:模型|助手|AI))`,
  // 我由 Anthropic 开发 / 我是被 OpenAI 训练出来的
  `我(?:是)?(?:由|被)\\s*${BRAND}\\s*(?:公司)?${ZH_GAP}{0,6}${MADE}`,
  // 我的底层模型是 GPT-4 / 我背后的技术来自 Google
  `我(?:的|背[后後]的)(?:底[层層]|基[础礎]|背[后後])?(?:模型|大模型|架[构構]|技[术術])${ZH_GAP}{0,8}?(?:是|基[于於]|${FROM}|用的是)\\s*${BRAND}`,
  // 我基于 Claude / 我用的是 GPT — but not a user's product ("我基于 Claude 开发了一个写作工具", review P1)
  `我(?:基[于於]|背[后後]是|使用的是|用的是|底[层層]是)\\s*${BRAND}(?!${ZH_GAP}{0,8}?(?:[开開][发發]了|做了|搭建|[构構]建了|打造了|写了|[写寫]了))`,
  // 作为 ChatGPT，我… / 作为一个由 OpenAI 开发的 AI 助手… (review P1: role-prefaced)
  `作[为為]\\s*(?:一[个個]|一款)?\\s*${BRAND}\\s*[，,]\\s*我`,
  `作[为為]\\s*(?:一[个個]|一款)?\\s*${FROM}\\s*${BRAND}\\s*(?:公司)?${ZH_GAP}{0,10}?(?:${MADE}|的${ZH_GAP}{0,6}?(?:模型|助手|AI))`,
  // As ChatGPT, I can help / As an AI assistant developed by OpenAI / As a GPT-4 based model (review P1)
  String.raw`\bAs\s+${BRAND}\b[^.!?\n]{0,6}?,\s*(?:I|my)\b`,
  String.raw`\bAs\s+(?:an?|the)\s+(?:[\w-]+\s+){0,4}(?:model|AI|assistant|chatbot|LLM)\b[^.!?\n]{0,40}?\b(?:by|from)\s+${BRAND}`,
  String.raw`\bAs\s+(?:an?|the)\s+${BRAND}[\w.-]*(?:\s+[\w-]+){0,2}?\s+(?:model|AI|assistant|chatbot|LLM)\b`,
  // I am Claude / I'm ChatGPT / I am called Gemini
  String.raw`\bI(?:'m|’m|\s+am)\s+(?:called\s+|actually\s+)?${BRAND}${VERSION}${EN_END}`,
  // I am a GPT-4 model / I'm an OpenAI language model / I am a Claude-based assistant. An article form needs a
  // model noun, so copy such as "I am a Google Ads specialist" stays untouched (review P2).
  String.raw`\bI(?:'m|’m|\s+am)\s+(?:an?|the)\s+${BRAND}[\w.-]*(?:\s+[\w-]+){0,2}?\s+(?:model|AI|assistant|chatbot|LLM)\b`,
  // I am a large language model trained by Google / I'm an AI assistant made by Anthropic
  String.raw`\bI(?:'m|’m|\s+am)\s+(?:an?\s+|the\s+)?(?:[\w-]+\s+){0,4}(?:model|AI|assistant|chatbot|LLM)\b[^.!?\n]{0,40}?\b(?:by|from)\s+${BRAND}`,
  // I was trained by OpenAI / I've been developed by Anthropic
  String.raw`\bI(?:\s+was|\s+have\s+been|'ve\s+been|’ve\s+been)\s+(?:created|trained|developed|built|made|designed)\s+by\s+${BRAND}`,
  // My underlying model is GPT-4
  String.raw`\bmy\s+(?:underlying\s+|base\s+)?(?:model|architecture|LLM)\s+(?:is|comes\s+from)\s+(?:an?\s+)?${BRAND}`,
  // I'm powered by Gemini / I am based on Claude
  String.raw`\bI(?:'m|’m|\s+am)\s+(?:powered\s+by|based\s+on|built\s+on|running\s+on)\s+${BRAND}`,
].map(source => new RegExp(source, 'iu'));

const TERMINATOR = /[。！？!?\n]|\.(?=\s|$)/gu;

/** Sentence spans [start, end) of text, each ending after its terminator (or at the end). */
function sentences(text: string) {
  const spans: Array<[number, number]> = [];
  let start = 0;
  for (const match of text.matchAll(TERMINATOR)) {
    const end = match.index! + match[0].length;
    spans.push([start, end]);
    start = end;
  }
  if (start < text.length) spans.push([start, text.length]);
  return spans;
}

export function leaksModelIdentity(text: string) {
  return PATTERNS.some(pattern => pattern.test(text));
}

// Common characters that differ between the scripts; the side with more hits decides.
const HANT = /[們這個為說會對時來後體學們國語開關係發將與還從進過員書車問題東話樣處點傳訊練經營帳號範圖應實現電網誰嗎麼]/gu;
const HANS = /[们这个为说会对时来后体学国语开关系发将与还从进过员书车问题东话样处点传讯练经营帐号范图应实现电网谁吗么]/gu;
function brandReplyFor(sentence: string) {
  if (!/[\u3400-\u9fff]/u.test(sentence)) return BRAND_REPLY_EN;
  return (sentence.match(HANT)?.length ?? 0) > (sentence.match(HANS)?.length ?? 0) ? BRAND_REPLY_ZH_HANT : BRAND_REPLY_ZH;
}

/** Replace every self-identifying sentence; the brand reply appears at most once. */
export function redactModelIdentity(text: string) {
  if (!leaksModelIdentity(text)) return text;
  let out = '', replied = false;
  for (const [start, end] of sentences(text)) {
    const sentence = text.slice(start, end);
    if (!leaksModelIdentity(sentence)) { out += sentence; continue; }
    if (!replied) {
      const lead = sentence.match(/^\s*/u)![0], trail = /\n$/u.test(sentence) ? '\n' : '';
      out += lead + brandReplyFor(sentence) + trail;
      replied = true;
    } else if (/\n$/u.test(sentence)) out += '\n';
  }
  return out;
}

/** First-person openings a trailing, unfinished sentence may still turn into a leak with. */
const FIRST_PERSON = /我|作[为為]|\bI\b|\bI['’]|\bmy\b|\bas\b/iu;

/**
 * Streaming view of cumulative text: complete sentences are redacted; an unfinished last
 * sentence is held back from its first first-person word on (it could still become a leak).
 */
export function streamingRedaction(text: string) {
  const spans = sentences(text);
  const last = spans.at(-1);
  if (!last) return text;
  const unfinished = !/(?:[。！？!?\n]|\.\s*)$/u.test(text.slice(last[0], last[1]));
  const tail = text.slice(last[0], last[1]);
  const person = unfinished ? tail.search(FIRST_PERSON) : -1;
  if (person < 0) return redactModelIdentity(text);
  // Keep what is already safe before the first-person word visible; hold back only from there (review P2).
  return redactModelIdentity(text.slice(0, last[0])) + tail.slice(0, person);
}

/** Redact the public message of a stored runtime body (plain text, step envelope or agent turn). */
export function redactIdentityBody(body: string) {
  let value: unknown;
  try { value = JSON.parse(body); } catch { return redactModelIdentity(body); }
  // A bare JSON string is shown as plain reply text after reload (review P1).
  if (typeof value === 'string') { const text = redactModelIdentity(value); return text === value ? body : JSON.stringify(text); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return body;
  const record = value as Record<string, unknown>;
  const message = typeof record.message === 'string' ? redactModelIdentity(record.message) : record.message;
  // Card messages are redacted on their own: an appended card's text differs from the combined message,
  // and readers prefer card.message after reload (review P1).
  // Every displayed card string (message, question, options, recommendationReason) is redacted on its own:
  // an appended card's text differs from the combined message and readers prefer it after reload (review P1).
  const card = record.card && typeof record.card === 'object' ? redactIdentityCard(record.card) : record.card;
  if (message === record.message && JSON.stringify(card) === JSON.stringify(record.card)) return body;
  return JSON.stringify({ ...record, message, ...(record.card !== undefined ? { card } : {}) });
}

/**
 * Every displayed card string is redacted. A card that redaction makes invalid (options collapsing into
 * the same brand reply, or longer than a field allows) is dropped: the message already carries the brand
 * reply, and an invalid card would fail the whole paid turn (review P2).
 */
export function redactIdentityCard<T>(card: T): T | null {
  const redacted = redactIdentityStrings(card);
  if (JSON.stringify(redacted) === JSON.stringify(card)) return card;
  const schema = card && typeof card === 'object' && 'message' in card ? questionToolCardSchema : questionCardSchema;
  return schema.safeParse(redacted).success ? redacted : null;
}

/** Every string inside a JSON value; other values and keys unchanged. */
export function redactIdentityStrings<T>(value: T): T {
  const walk = (v: unknown): unknown => typeof v === 'string' ? redactModelIdentity(v)
    : Array.isArray(v) ? v.map(walk)
      : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : v;
  return walk(value) as T;
}

/**
 * Organizer summaries: plain-text summaries are public prose and are redacted. A structured summary is
 * extracted account data (user facts may name AI products, review P1): only its top-level public
 * prose fields are redacted, never extraction values.
 */
export function redactIdentitySummary(summary: string) {
  let value: unknown;
  try { value = JSON.parse(summary); } catch { return redactModelIdentity(summary); }
  if (typeof value === 'string') { const text = redactModelIdentity(value); return text === value ? summary : JSON.stringify(text); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return summary;
  const record = value as Record<string, unknown>;
  const redacted = Object.fromEntries(Object.entries(record).map(([key, item]) =>
    [key, (key === 'message' || key === 'summary') && typeof item === 'string' ? redactModelIdentity(item) : item]));
  return JSON.stringify(redacted) === JSON.stringify(record) ? summary : JSON.stringify(redacted);
}
