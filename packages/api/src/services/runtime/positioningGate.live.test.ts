/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// POSITIONING-GATE real-model probe, skipped unless a test key is given (platform-paid, approved OpenRouter test
// budget only; 16 small calls):
//   POSITIONING_GATE_OPENROUTER_KEY=... pnpm --filter @repo/api exec vitest run src/services/runtime/positioningGate.live.test.ts
// Prints each verdict, the agreement with the expected label and the total provider-reported cost. No user data.
import { expect, it } from 'vitest';
import { decide } from './positioningGate';

const cases: Array<[text: string, expected: 'block' | 'allow']> = [
  ['帮我想一下下周小红书发什么', 'block'],
  ['给我的抖音账号写一条带货脚本', 'block'],
  ['我的账号怎么快速涨粉到一万', 'block'],
  ['根据我的定位写三个选题', 'block'],
  ['帮我复盘一下我上个月发的视频数据', 'block'],
  ['我的 YouTube 频道怎么变现', 'block'],
  ['Write five Instagram captions for my bakery account', 'block'],
  ['帮我给我的视频号起一个账号名字和简介', 'block'],
  ['小红书的推荐算法大概是怎么运作的？', 'allow'],
  ['抖音和快手的用户画像有什么区别？', 'allow'],
  ['帮我写一封邮件，向客户道歉发货延迟', 'allow'],
  ['把这句话翻译成英文：明天下午三点开会', 'allow'],
  ['Python 里怎么读取一个 CSV 文件？', 'allow'],
  ['推荐一下东京三日游的路线', 'allow'],
  ['什么是 KOL 和 KOC？', 'allow'],
  ['你好，你能做什么？', 'allow'],
];

const key = process.env.POSITIONING_GATE_OPENROUTER_KEY?.trim();
it.skipIf(!key)('Decisions separates own-account social media operations from everything else', async () => {
  let cost = 0, agree = 0, unavailable = 0;
  const transport: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    try { cost += Number((await response.clone().json()).usage?.cost ?? 0); } catch { /* reported as unavailable */ }
    return response;
  };
  for (const [text, expected] of cases) {
    const verdict = await decide(key!, text, transport);
    if (verdict === expected) agree++;
    if (verdict === 'unavailable') unavailable++;
    process.stdout.write(`${verdict === expected ? 'OK  ' : 'DIFF'} expected=${expected} got=${verdict} ${text}\n`);
  }
  process.stdout.write(JSON.stringify({ cases: cases.length, agree, unavailable, costUsd: Number(cost.toFixed(6)) }) + '\n');
  expect(unavailable).toBe(0);
}, 120_000);
