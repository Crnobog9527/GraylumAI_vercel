/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { LandingFeature } from './landing-flags';
import { J_SAMPLES } from './landing-copy-j-samples';
import { SAMPLE_CHAPTERS } from './sample-reports';

/**
 * Sample L: sample K's second round (Owner 2026-10-17, after seeing K; the plan's Owner quotes are in the PR). Only what
 * changes is here. Capabilities follow the product as checked on 2026-10-17: topics and scripts with storyboards are
 * built; the weekly data review, publishing to several platforms and writing in the person's own voice are planned and
 * sit behind their landing flags (publish, voice); topic A/B tests and "extending" a post are not in the product and are
 * not claimed. NEW wording for the Owner to judge on the page, unless marked.
 */

/** 1-2: the first screen's picture: what you say, what the coach does for you, what you get. */
export const L_HERO_FLOW = {
  label: '你说一句大白话，AI 教练替你把账号的事做完',
  youSay: { title: '你说', text: '我想做个做饭账号，下班后只有一小时。' },
  coachDoes: {
    title: 'AI 教练替你做',
    items: [
      { text: '理清方向，找对标账号', needs: ['coach', 'research'] },
      { text: '每周排好选题', needs: ['content'] },
      { text: '写口播稿和分镜', needs: ['content'] },
      { text: '一次发到多个平台', needs: ['publish'] },
      { text: '看数据，告诉你下周怎么调', needs: ['publish'] },
    ] as readonly { text: string; needs: readonly LandingFeature[] }[],
  },
  youGet: { title: '你得到', text: '方向清楚、每周知道拍什么的账号，你只管拍' },
} as const;

/**
 * 2: where each note is from (Owner: mark the region; the plan's rule: simplified Chinese from a mainland source is
 * 中国大陆, traditional Chinese is 台湾, English that names no country is 英文论坛 — never guessed).
 */
export const L_NOTE_REGIONS: Readonly<Record<string, string>> = {
  p1: '中国大陆', p2: '中国大陆', p3: '台湾', p4: '中国大陆', p5: '台湾', p7: '英文论坛', p8: '英文论坛',
};

/**
 * 3: daily operations, not positioning (Owner 2026-10-17). Each step is a stage of sample J's week (J_WEEK, by its
 * stage index), shown as the coach's real conversation; it plays on by itself and every step can be clicked.
 */
export const L_OPS = {
  /** The plan's main line. */
  lede: '你只管用大白话和教练说，账号的细节全交给它。',
  /** How long each step stays before the next one (milliseconds). */
  stepMs: 7000,
  pause: '暂停',
  play: '继续播放',
  steps: [
    { stage: 1, label: '排选题', line: '按你的定位排好这周的选题，每条说清为什么值得拍；你说不行，它当场换。', needs: ['content'] },
    { stage: 2, label: '写口播稿和分镜', line: '按你说话的习惯写好口播稿，再给分镜和开头怎么拍的建议。', needs: ['content'] },
    { stage: 3, label: '一次发多个平台', line: '每个平台的标题和标签分别改好，你确认一次就一起发出。', needs: ['publish'] },
    { stage: 4, label: '看数据，定下周', line: '读取各平台的数据，告诉你哪条有效、哪里留不住人，下周怎么调。', needs: ['publish'] },
  ] as readonly { stage: number; label: string; line: string; needs: readonly LandingFeature[] }[],
} as const;

/**
 * 4: every group's sample report (Owner 2026-10-17: "尽量把我们能覆盖的人群的案例都放上去"): sample J's four, then the
 * eight generated on 2026-10-17 (the groups the Owner chose; tab names as delivered).
 */
export const L_REPORTS: readonly { slug: string; who: string; platform: string; truth: boolean }[] = [
  ...J_SAMPLES.reports,
  { slug: 'mom', who: '全职宝妈', platform: '小红书', truth: false },
  { slug: 'cross-border', who: '跨境电商卖家', platform: 'TikTok Shop（美国）', truth: true },
  { slug: 'designer', who: '自由职业设计师（台湾）', platform: 'Instagram + Threads', truth: false },
  { slug: 'creator', who: '有粉丝不会变现的博主（加拿大）', platform: 'YouTube', truth: true },
  { slug: 'trainer', who: '健身私教 · 本地获客（美国）', platform: '小红书 + Instagram', truth: false },
  { slug: 'restaurant', who: '餐饮老板 · 本地获客', platform: '抖音同城', truth: true },
  { slug: 'solo-founder', who: '一人公司创业者（新加坡）', platform: 'X', truth: true },
  { slug: 'course-creator', who: '知识付费博主', platform: '小红书 + 视频号', truth: true },
];

/** 4: the sample reports as a moving row of cards. */
export const L_SAMPLES = {
  /** NEW: sample J's title, with the number of groups shown. */
  title: (count: number) => `先看成果：${count} 种人拿到的完整报告`,
  bridge: '找一个和你情况像的，点开看',
  pause: '移到卡片上会停下',
  open: '看这份报告',
  close: '关闭',
} as const;

/**
 * 5: what you no longer worry about, and what the coach does behind it (Owner: an easy list; writing in your own voice
 * first; no fixed weekdays). An item whose capability is off is hidden.
 */
export const L_CARE = {
  title: '这些事，不用你再操心',
  items: [
    { worry: '按你的文风写，没有 AI 味', does: '先读你写过的东西，整理出你的文风，你确认后再按它写稿。', needs: ['voice'] },
    { worry: '不用自己想拍什么', does: '按你确认的定位排选题，每条附上简报和理由；你点头才采用。', needs: ['content'] },
    { worry: '不用从零写稿', does: '针对选题写好口播稿，再给分镜和剪辑建议，哪句不像你就改哪句。', needs: ['content'] },
    { worry: '不用自己找对标、扒数据', does: '按三类找对标账号，用公开数据看你和他们差在哪。', needs: ['research'] },
    { worry: '不用每个平台各发一遍', does: '同一条内容，一次发到你选的几个平台。', needs: ['publish'] },
    { worry: '不用自己盯后台数据', does: '读取已发布作品的数据，告诉你哪条有效、下周怎么调，你点头后变成新选题。', needs: ['publish'] },
    { worry: '不用每次从头解释自己', does: '你确认过的定位和上传的资料都存在资料库，之后的对话接着用。', needs: ['library'] },
  ] as readonly { worry: string; does: string; needs: readonly LandingFeature[] }[],
} as const;

/** 6: the comparison's heading (OWNER's words) and the pairs kept (sample J's J_COMPARE.pairs, by index). */
export const L_COMPARE_TITLE = 'AI 教练带你一步步做';
export const L_COMPARE_PICKS = [1, 3] as const;
/** Each kept pair ends on what the person does next: that person's real report, "这周第一步". */
export const L_COMPARE_NEXT: Readonly<Record<number, string>> = {
  1: `接下来你做：${SAMPLE_CHAPTERS.student.summary.first}`,
  3: `接下来你做：${SAMPLE_CHAPTERS.shop.summary.first}`,
};
