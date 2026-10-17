/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { J_TAKEOVER_MOMENTS } from './landing-copy-j-takeover';
import { J_WEEK } from './landing-copy-j-week';
import type { LandingFeature } from './landing-flags';
import { L_CARE, L_OPS, type OpsLine } from './landing-copy-l';

/**
 * Sample L, round three (Owner 2026-10-17): region 3 in two acts. Act one is sample J's whole positioning flow on the
 * real workspace (了解你 → 诊断与平台对标 → 定位与执行方案 → the written report), each step with its note from sample J's
 * takeover script; act two is the week after it in the real work chat, six steps from topics to the review that sets
 * the next round, each with what you no longer worry about and what the coach does behind it (region 5's list, merged
 * in). Publishing and data monitoring show only with the `publish` flag. Lines reused from samples J and L are marked
 * by where they come from; the rest is NEW wording for the Owner to judge on the page.
 */
const care = (worry: string) => L_CARE.items.find(item => item.worry === worry);

export type ActOneStep = { label: string; moment: number; note: string; needs?: readonly LandingFeature[] };
export type ActTwoStep = {
  label: string; worry: string; does: string; needs: readonly LandingFeature[]; lines: readonly OpsLine[];
  /** The same step without one capability: its own worry and answer (writing without the voice profile). */
  without?: { flag: LandingFeature; worry: string; does: string };
};

export const L_ACTS = {
  acts: ['第一幕：先把你的定位挖清楚', '第二幕：然后每周带你做'] as const,
  /** NEW: the note's lead-in in act one (the plan's words). */
  why: '为什么不是正确的废话',
  /** NEW: act two's lead-ins. */
  worryLabel: '这件事你不用操心',
  doesLabel: '教练替你做了什么',
  /** NEW: under act two, the loop in plain words (no "数据飞轮"). */
  loop: '复盘的结果，决定下一轮拍什么。',
  /** NEW (plan: the jury leaves the home page; one line links to it, Gold, with the fusion flag). */
  jury: { text: '多模型评审团把关，Gold 会员可用', link: '了解评审团', href: '/landing/preview/jury', needs: ['fusion'] as readonly LandingFeature[] },
  /** How long each step stays (milliseconds); act one's steps play their conversation through this time. */
  oneMs: 11000,
  twoMs: 8000,
  one: [
    { label: '了解你', moment: 0, note: J_TAKEOVER_MOMENTS[0].note },
    { label: '诊断与平台对标', moment: 1, note: J_TAKEOVER_MOMENTS[1].note, needs: ['research'] },
    { label: '定位与执行方案', moment: 2, note: J_TAKEOVER_MOMENTS[2].note },
    { label: '生成完整运营策略报告', moment: 3, note: J_TAKEOVER_MOMENTS[3].note, needs: ['report'] },
  ] as readonly ActOneStep[],
  two: [
    {
      label: '选题和封面', needs: ['content'],
      worry: care('不用自己想拍什么')?.worry ?? '', does: care('不用自己想拍什么')?.does ?? '',
      lines: [
        ...L_OPS.steps[0].lines,
        { role: 'coach', text: '封面也配好了：成品俯拍，大字写"15 分钟两菜一汤"，刷到的人一眼知道这条讲什么。' },
      ],
    },
    {
      label: '口播稿和分镜脚本', needs: ['content'],
      worry: care('按你的文风写，没有 AI 味')?.worry ?? '', does: care('按你的文风写，没有 AI 味')?.does ?? '',
      without: { flag: 'voice', worry: care('不用从零写稿')?.worry ?? '', does: care('不用从零写稿')?.does ?? '' },
      lines: L_OPS.steps[1].lines,
    },
    {
      label: 'AB 测试', needs: ['content'],
      worry: '不用自己猜哪种开头好', does: '它让你拍两版，只改开头一处，下周用收藏和评论说话。',
      lines: L_OPS.steps[2].lines,
    },
    {
      label: '自动发布', needs: ['publish'],
      worry: care('不用每个平台各发一遍')?.worry ?? '', does: care('不用每个平台各发一遍')?.does ?? '',
      lines: [
        { role: 'coach', text: J_WEEK.lines[14].text, card: { kind: 'publish', platforms: J_WEEK.publish.platforms, action: J_WEEK.publish.action } },
        { role: 'user', text: J_WEEK.lines[15].text },
        { role: 'coach', text: J_WEEK.lines[16].text },
      ],
    },
    {
      label: '数据监控', needs: ['publish'],
      worry: care('不用自己盯后台数据')?.worry ?? '', does: care('不用自己盯后台数据')?.does ?? '',
      lines: [
        { role: 'coach', text: J_WEEK.lines[17].text, card: { kind: 'fetch', items: J_WEEK.fetch } },
        { role: 'coach', text: J_WEEK.lines[19].text, card: { kind: 'platforms', columns: J_WEEK.platforms.columns, rows: J_WEEK.platforms.rows } },
      ],
    },
    {
      label: '复盘', needs: ['content'],
      worry: '不用自己琢磨下周怎么调', does: '它看两版谁赢、为什么，把赢的做成系列，下一轮选题就从这里来。',
      lines: [
        { role: 'coach', text: '两版的数据都在这儿了：', needs: ['publish'], card: L_OPS.steps[3].lines[1].card },
        { role: 'user', text: L_OPS.steps[3].lines[0].text, without: 'publish' },
        { role: 'coach', text: L_OPS.steps[3].lines[1].text, without: 'publish', card: L_OPS.steps[3].lines[1].card },
        { role: 'coach', text: 'A 版赢了，收藏是 B 版的两倍多：大家把它当菜谱存下来。以后开头先给结论。', needs: ['publish'] },
        ...L_OPS.steps[4].lines.filter(line => !line.needs?.includes('publish')),
      ],
    },
  ] as readonly ActTwoStep[],
} as const;
