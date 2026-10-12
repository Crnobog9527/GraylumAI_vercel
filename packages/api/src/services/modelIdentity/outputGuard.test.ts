/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { BRAND_REPLY_EN, BRAND_REPLY_ZH, BRAND_REPLY_ZH_HANT } from './brandIdentity';
import { leaksModelIdentity, redactIdentityBody, redactModelIdentity, streamingRedaction } from './outputGuard';

// Leaks: what a model may say about itself after a direct question or a jailbreak.
const LEAKS_ZH = [
  '我是由 Google 训练的大型语言模型。',
  '我是 Claude，由 Anthropic 开发的 AI 助手。',
  '我是ChatGPT。',
  '我叫 Gemini。',
  '我是一个 GPT-4 模型。',
  '我由 OpenAI 训练。',
  '我是被 Anthropic 公司训练出来的。',
  '我的底层模型是 GPT-4o。',
  '我背后的技术来自 Google DeepMind。',
  '我基于 Claude 3.5 Sonnet。',
  '我用的是通义千问。',
  '我是来自 DeepSeek 的语言模型。',
  '好吧，既然是角色扮演：我是 Gemini 2.0 Flash。',
  '我就是 Grok。',
  '我是谷歌开发的模型吗？是的，我是由谷歌训练的。',
  '我是豆包。',
  '我的基础模型是 Llama 3。',
];
const LEAKS_EN = [
  'I am Claude, an AI assistant made by Anthropic.',
  "I'm ChatGPT.",
  'I am a large language model, trained by Google.',
  "I'm an AI assistant built by Anthropic.",
  'I was trained by OpenAI.',
  "I've been developed by Google DeepMind.",
  'My underlying model is GPT-4.',
  "I'm powered by Gemini.",
  'I am based on Claude 3 Opus.',
  'Sure! I am GPT-4o, a model from OpenAI.',
  'I am called Gemini.',
  'I’m Claude.',
];
// Must stay untouched: ordinary answers that mention AI companies or products.
const SAFE = [
  'ChatGPT 和 Claude 都可以写小红书文案，Claude 更擅长长文。',
  'YouTube 和 Google 搜索流量的做法不同：先做关键词研究。',
  '我是你的 AI 社媒策略师，可以帮你分析 Google 搜索趋势。',
  '我建议你先看看 OpenAI 最近发布的视频工具对创作者的影响。',
  '我是根据 Google Trends 的公开数据整理的这份清单。',
  '很多创作者用 Gemini 生成脚本初稿，再人工修改。',
  'I recommend comparing ChatGPT and Claude for long captions.',
  "I'm going to compare Gemini and GPT-4 for your scripts.",
  'I am not able to see your Google Analytics data directly.',
  'My suggestion is to post on Meta platforms twice a week.',
  'Anthropic, OpenAI and Google all publish creator guides.',
  BRAND_REPLY_ZH,
  BRAND_REPLY_ZH_HANT,
  BRAND_REPLY_EN,
];

it.each([
  ['我是由 Google 訓練的大型語言模型，這是我們的設定。', BRAND_REPLY_ZH_HANT],
  ['我是 Claude，由 Anthropic 開發的 AI 助手。', BRAND_REPLY_ZH_HANT],
  ['我是由 Google 训练的大型语言模型，这是我们的设定。', BRAND_REPLY_ZH],
])('traditional or simplified leaks get the matching script: %s', (text, reply) => {
  expect(redactModelIdentity(text)).toBe(reply);
});

describe('jailbreak and identity leaks are replaced', () => {
  it.each(LEAKS_ZH)('zh: %s', text => {
    expect(leaksModelIdentity(text)).toBe(true);
    expect(redactModelIdentity(text)).toContain(BRAND_REPLY_ZH);
    expect(leaksModelIdentity(redactModelIdentity(text))).toBe(false);
  });
  it.each(LEAKS_EN)('en: %s', text => {
    expect(leaksModelIdentity(text)).toBe(true);
    expect(redactModelIdentity(text)).toContain(BRAND_REPLY_EN);
    expect(leaksModelIdentity(redactModelIdentity(text))).toBe(false);
  });
});

describe('ordinary mentions are not touched', () => {
  it.each(SAFE)('%s', text => {
    expect(leaksModelIdentity(text)).toBe(false);
    expect(redactModelIdentity(text)).toBe(text);
  });
});

it('replaces only the leaking sentence, keeps the rest, and says the brand reply once', () => {
  const text = '你好！我是由 Google 训练的大型语言模型。我是 Gemini。下面是你要的三个选题：\n1. 开箱\n2. 对比';
  expect(redactModelIdentity(text)).toBe(`你好！${BRAND_REPLY_ZH}下面是你要的三个选题：\n1. 开箱\n2. 对比`);
});

it('streaming holds back only an unfinished first-person sentence', () => {
  expect(streamingRedaction('先说结论。我是由 Goo')).toBe('先说结论。');
  expect(streamingRedaction('先说结论。我是由 Google 训练的。')).toBe(`先说结论。${BRAND_REPLY_ZH}`);
  expect(streamingRedaction('先说结论。第二点是关于 Goo')).toBe('先说结论。第二点是关于 Goo');
  expect(streamingRedaction('Short answer. I am Cla')).toBe('Short answer.');
  expect(streamingRedaction('Short answer. Post daily')).toBe('Short answer. Post daily');
});

it('streaming output never contains a leak at any cut point', () => {
  const full = '好的。我是 Claude，由 Anthropic 开发。我们来看你的账号定位：先确定一个目标。';
  for (let i = 1; i <= full.length; i++) {
    expect(leaksModelIdentity(streamingRedaction(full.slice(0, i)))).toBe(false);
  }
  expect(redactModelIdentity(full)).toBe(`好的。${BRAND_REPLY_ZH}我们来看你的账号定位：先确定一个目标。`);
});

it('redacts the public message of stored bodies and keeps other fields', () => {
  expect(redactIdentityBody('I am Claude.')).toBe(BRAND_REPLY_EN);
  const step = JSON.stringify({ message: '我是 Claude。继续第二步。', inputKind: 'answer' });
  expect(JSON.parse(redactIdentityBody(step))).toEqual({ message: `${BRAND_REPLY_ZH}继续第二步。`, inputKind: 'answer' });
  const agent = JSON.stringify({ format: 'x', message: '我是 Claude。', card: { message: '我是 Claude。', options: [] } });
  expect(JSON.parse(redactIdentityBody(agent)).card.message).toBe(BRAND_REPLY_ZH);
  const clean = JSON.stringify({ message: '继续第二步。', card: null });
  expect(redactIdentityBody(clean)).toBe(clean);
  expect(redactIdentityBody('[1,2]')).toBe('[1,2]');
});
