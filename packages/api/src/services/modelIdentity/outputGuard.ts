/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { BRAND_REPLY_EN, BRAND_REPLY_ZH } from './brandIdentity';

/**
 * MODEL-IDENTITY-GUARD layer 3: replace a model's first-person self-identification
 * ("我是 Claude", "我是由 Google 训练的…", "I am GPT-4", "I was trained by OpenAI") with the
 * Owner-approved brand reply. It inspects model output only, never user intent, and ordinary
 * mentions of AI products ("ChatGPT 和 Claude 哪个适合写文案") are left alone.
 */
const BRAND = String.raw`(?:claude|anthropic|chat\s?gpt|gpt(?:[-\s]?\d[\w.]*)?|openai|gemini|google|deepmind|bard|qwen|通义千问?|阿里(?:巴巴|云)|`
  + String.raw`deepseek|深度求索|llama|meta\s?ai|mistral|grok|x\.?ai|文心一言|百度|kimi|月之暗面|豆包|字节跳动|智谱|chatglm|glm|混元|腾讯|`
  + String.raw`谷歌|微软|microsoft|copilot)`;
const ZH_GAP = '[^。！？!?.\\n，,；;]';
const PATTERNS = [
  // 我是 Claude / 我叫 ChatGPT / 我是一个 Gemini 模型
  `我(?:是|叫|就是)\\s*(?:一个|一款|名叫)?\\s*${BRAND}`,
  // 我是由 Google 训练的大型语言模型 / 我是来自 OpenAI 的语言模型
  `我(?:是|叫)${ZH_GAP}{0,10}?(?:由|来自)\\s*${BRAND}\\s*(?:公司)?${ZH_GAP}{0,10}?(?:训练|开发|打造|研发|创建|推出|设计|的${ZH_GAP}{0,6}?(?:模型|助手|AI))`,
  // 我由 Anthropic 开发 / 我是被 OpenAI 训练出来的
  `我(?:是)?(?:由|被)\\s*${BRAND}\\s*(?:公司)?${ZH_GAP}{0,6}(?:训练|开发|打造|研发|创建|推出|设计)`,
  // 我的底层模型是 GPT-4 / 我背后的技术来自 Google
  `我(?:的|背后的)(?:底层|基础|背后)?(?:模型|大模型|架构|技术)${ZH_GAP}{0,8}?(?:是|基于|来自|用的是)\\s*${BRAND}`,
  // 我基于 Claude / 我用的是 GPT
  `我(?:基于|背后是|使用的是|用的是|底层是)\\s*${BRAND}`,
  // I am Claude / I'm ChatGPT / I am called Gemini
  String.raw`\bI(?:'m|’m|\s+am)\s+(?:called\s+|actually\s+)?${BRAND}\b`,
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

function brandReplyFor(sentence: string) {
  return /[㐀-鿿]/u.test(sentence) ? BRAND_REPLY_ZH : BRAND_REPLY_EN;
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
const FIRST_PERSON = /我|\bI\b|\bI['’]|\bmy\b/iu;

/**
 * Streaming view of cumulative text: complete sentences are redacted; an unfinished last
 * sentence is held back only while it is first-person (it could still become a leak).
 */
export function streamingRedaction(text: string) {
  const spans = sentences(text);
  const last = spans.at(-1);
  const unfinished = last && !/(?:[。！？!?\n]|\.\s*)$/u.test(text.slice(last[0], last[1]));
  if (!unfinished || !FIRST_PERSON.test(text.slice(last[0], last[1]))) return redactModelIdentity(text);
  return redactModelIdentity(text.slice(0, last[0]));
}

/** Redact the public message of a stored runtime body (plain text, step envelope or agent turn). */
export function redactIdentityBody(body: string) {
  let value: unknown;
  try { value = JSON.parse(body); } catch { return redactModelIdentity(body); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return body;
  const record = value as Record<string, unknown>;
  if (typeof record.message !== 'string') return body;
  const message = redactModelIdentity(record.message);
  if (message === record.message) return body;
  const card = record.card as Record<string, unknown> | null | undefined;
  const sameCard = card && typeof card === 'object' && card.message === record.message;
  return JSON.stringify({ ...record, message, ...(sameCard ? { card: { ...card, message } } : {}) });
}
