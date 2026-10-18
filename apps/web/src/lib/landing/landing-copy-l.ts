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
 * 2: the coach's answer under each person's words, sample L's own (Owner 2026-10-18, confirmed wording; sample J keeps
 * J_NOTE_HEADS / J_NOTE_ANSWERS). Rows 2-1 to 2-7 are p7, p1, p2, p3, p4, p5, p8.
 */
export const L_NOTE_HEADS: Readonly<Record<string, string>> = {
  p7: '先替你做判断，再给你内容',
  p1: '有问题随时问，马上回，只针对你的账号',
  p2: '不讲大道理，直接给你能照做的下一步',
  p3: '普通上班族也有能拍的，AI 教练帮你找出来',
  p4: '不是你不适合，是没人告诉你差在哪',
  p5: '不用再一个人对着空白屏幕想下一步',
  p8: '店照常开，运营交给 AI 教练',
};

export const L_NOTE_ANSWERS: Readonly<Record<string, string>> = {
  p7: '拍什么、在哪发、能不能赚钱，AI 教练先查同类账号的真实数据再下判断；方向不对，会直接告诉你，并给出改法。',
  p1: 'AI 教练 24 小时在线，记得你的定位、你的资料和你上周的数据，回答的是"你这个号该怎么办"，不是通用攻略。',
  p2: '每次只给一件具体的事：这周拍哪条、标题怎么写、开头怎么拍、哪天发。做完再给下一件。',
  p3: '聊十几分钟你的工作、生活和能投入的时间，AI 教练从里面找出只有你能拍的方向，配上第一周的 3 条选题。',
  p4: 'AI 教练把你的每一条和同类账号放在一起比，指出差在开头、标题还是选题；下一条照着改，再看数据有没有变好。',
  p5: '每周拍什么、怎么写、发完看什么数据，AI 教练都提前替你排好。打开就知道今天该做什么，卡住了随时问。',
  p8: '选题、标题、文案、发布和复盘都由 AI 教练来做，每周给你一张拍摄清单；你只要在店里抽空拍几段。',
};

/**
 * 3: one week of operations as one conversation (Owner 2026-10-17: show the coach testing openings and turning a winner
 * into a series in the animation; "只需要你在动画里面去展示"). The page's own person (下班后 15 分钟家常菜). The A/B
 * comparison and the series are what the positioning Skill already guides in conversation (operations: change one or
 * two variables a week; scale a proven template into a series); there is no automatic testing tool, so the person
 * pastes their own numbers. Publishing to several platforms closes the week only with the `publish` flag. The figures
 * are the example's. NEW wording.
 */
export type OpsCard =
  | { kind: 'topics'; items: readonly { title: string; why: string }[] }
  | { kind: 'draft'; title: string; lines: readonly string[]; shots: string }
  | { kind: 'test'; variants: readonly { name: string; opening: string }[]; measure: string }
  | { kind: 'result'; columns: readonly string[]; rows: readonly (readonly string[])[]; winner: string }
  | { kind: 'series'; items: readonly string[]; extra: string }
  | { kind: 'publish'; platforms: readonly { name: string; on: boolean }[]; action: string }
  | { kind: 'fetch'; items: readonly string[] }
  | { kind: 'platforms'; columns: readonly string[]; rows: readonly (readonly string[])[] };
export type OpsLine = { role: 'user' | 'coach'; text: string; card?: OpsCard; needs?: readonly LandingFeature[]; without?: LandingFeature };

export const L_OPS = {
  /** The plan's main line. */
  lede: '你只管用大白话和教练说，账号的细节全交给它。',
  title: '下班后 15 分钟家常菜 · 这一周',
  /** Under the steps: what the week leaves you with. */
  close: '你只是聊了几句，下周做什么、为什么，都清楚了。',
  /** How long each step stays before the next one (milliseconds). */
  stepMs: 8000,
  pause: '暂停',
  play: '继续播放',
  steps: [
    {
      label: '排选题', line: '你问一句"这周拍什么"，它按你的定位和对标账号给出三个选题，每个都说清为什么值得拍。', needs: ['content'],
      lines: [
        { role: 'user', text: '这周拍什么？' },
        {
          role: 'coach', text: '按你的定位和对标账号里收藏最多的几类题，这周我建议这三个：',
          card: { kind: 'topics', items: [
            { title: '一口锅，15 分钟两菜一汤', why: '最能证明"下班后也来得及"，对标账号同类题收藏最高' },
            { title: '冰箱剩菜三种做法', why: '接上你说的"青菜三天吃不完"，一人住的人最有共鸣' },
            { title: '超市半成品改造', why: '最省事，适合累的那几天' },
          ] },
        },
      ],
    },
    {
      label: '写口播稿和分镜', line: '你挑一个，它写好口播稿和分镜，句子短、像你说话。', needs: ['content'],
      lines: [
        { role: 'user', text: '先拍第一个。' },
        { role: 'coach', text: '口播稿按你的文风写好了：句子短，不说"家人们"，也没有 AI 腔。', needs: ['voice'] },
        { role: 'coach', text: '口播稿按你平时说话的习惯写好了：句子短，不说"家人们"。', without: 'voice' },
        {
          role: 'coach', text: '分镜也排好了：',
          card: { kind: 'draft', title: '口播稿（节选）', lines: [
            '下班到家七点，这顿饭我十五分钟搞定。',
            '一口锅，先炒菜，再借锅底的油煮汤。',
          ], shots: '分镜：成品 → 备菜 → 下锅 → 装盘，只拍手和锅' },
        },
      ],
    },
    {
      label: '设计对比测试', line: '它让你拍两版，只改开头一处，下周就知道哪种开头更留得住人。', needs: ['content'],
      lines: [
        {
          role: 'coach', text: '这条拍两版，别的都一样，只改开头。下周比收藏和评论：',
          card: { kind: 'test', variants: [
            { name: 'A 版', opening: '先说结论："十五分钟，两菜一汤。"' },
            { name: 'B 版', opening: '先讲故事："上周加班到九点，冰箱里只剩一把青菜……"' },
          ], measure: '一次只改一个地方，才看得出是开头起的作用' },
        },
        { role: 'user', text: '好，两版都拍。' },
      ],
    },
    {
      label: '一周后看结果', line: '一周后你把数字贴给它，它告诉你哪版赢了、为什么，下次怎么写。', needs: ['content'],
      lines: [
        { role: 'user', text: 'A 版收藏 186、评论 23；B 版收藏 74、评论 31。' },
        {
          role: 'coach', text: 'A 版赢了，收藏是 B 版的两倍多：大家把它当菜谱存下来。B 版评论多一点，故事能引人说话，但没让人想收藏。',
          card: { kind: 'result', columns: ['', '收藏', '评论'], rows: [['A 版 先说结论', '186', '23'], ['B 版 先讲故事', '74', '31']],
            winner: '以后开头先给结论，故事放到结尾，两样都要' },
        },
      ],
    },
    {
      label: '做成系列', line: '赢的那条做成系列，再改一版图文，下周计划直接排好。', needs: ['content'],
      lines: [
        {
          role: 'coach', text: '把赢的那条做成"一口锅 15 分钟"系列，下周排三期：',
          card: { kind: 'series', items: ['第 1 期：番茄炒蛋 + 紫菜蛋花汤', '第 2 期：青椒肉丝 + 冬瓜汤', '第 3 期：蒜蓉青菜 + 剩饭蛋炒饭'],
            extra: '第 1 期再改一版图文：步骤拆成六张图，方便收藏' },
        },
        { role: 'coach', text: '三期都排进下周了。确认一次，就一起发到 TikTok、Instagram 和 YouTube。', needs: ['publish'] },
        { role: 'user', text: '可以，就这么排。' },
      ],
    },
  ] as readonly { label: string; line: string; needs: readonly LandingFeature[]; lines: readonly OpsLine[] }[],
} as const;

/**
 * 4: every group's sample report (Owner 2026-10-17: "尽量把我们能覆盖的人群的案例都放上去"): sample J's four, then the
 * ten generated on 2026-10-17 (the groups the Owner chose; tab names as delivered).
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
  { slug: 'realtor', who: '地产经纪（澳洲）', platform: '小红书 + YouTube', truth: false },
  { slug: 'handmade', who: '手作品牌创始人（台湾）', platform: 'Instagram', truth: true },
];

/** 4: the sample reports as a moving row of cards. */
export const L_SAMPLES = {
  /** NEW: sample J's title, with the number of groups shown; the count and its measure word never part. */
  title: (count: number) => `先看成果：${count} 种人拿到的完整报告`,
  titleParts: (count: number) => ['先看成果：', `${count} 种人`, '拿到的完整报告'] as const,
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

/**
 * Fixes of 2026-10-17 (Owner: keep L's look, fix what the comparison audit found). NEW wording unless marked.
 * The voice wall's fold button on a phone; the comparison pairs' step in the coach's head, as in the sample conversations
 * (both quotes come from the 诊断与平台对标 step); the one line under the recommended plan's button (RISK_REVERSAL's title
 * with the close's own note).
 */
export const L_VOICE_FOLD = '看完整做法';
export const L_COMPARE_STEPS: Readonly<Record<number, string>> = { 1: '诊断与平台对标', 3: '诊断与平台对标' };

/** Owner 2026-10-17, round six: the line under the price button (no free trial without the sign-up credits). */
export const L_PRICE_NOTE = { free: '无需绑卡 · 免费试用', noCard: '无需绑卡' } as const;
