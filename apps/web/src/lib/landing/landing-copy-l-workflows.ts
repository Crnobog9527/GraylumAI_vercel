/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/**
 * Sample L, round five, region 6 (Owner 2026-10-17: "你不要只是一句话一个回复……一定要把我们的工作流状态给体现出来……这个逻辑
 * 一定要闭环，前后要完整"): the coach's side of each scenario as a whole work conversation of the page's own person
 * ("下班后 15 分钟家常菜"). Each answer first shows its work in the product's own forms (the library read, the data
 * fetched: own account and benchmark accounts, in ResearchCall shapes), then decides with reasons, then says what to do
 * next; a second turn follows up. All lines are NEW. Reading one's own published data is the publishing and monitoring
 * feature (not built yet, Owner: "在预览里直接按这样去演示"); the voice profile is VOICE (not built yet).
 */
export type WorkflowCall = { query: string; dataKind: 'keyword_posts' | 'account_posts' | 'post_detail'; toolName: string };
export type WorkflowTurn = {
  user: string;
  /** What the coach read from the library before answering (the status line under its name). */
  read?: readonly string[];
  /** What it fetched, in order. */
  calls?: readonly WorkflowCall[];
  reply: string;
  /** A draft in the product's 建议稿 block (the script). */
  proposal?: string;
};

const OWN = 'social_account';
const BENCH = 'benchmark_fetch';
const DISCOVER = 'benchmark_discover';

/** By the task's index in L_TASKS: 定位, 这周拍什么, 写稿, 这条为什么没火. */
export const L_WORKFLOWS: readonly (readonly WorkflowTurn[])[] = [
  [
    {
      user: '我想做美食号，该怎么定位？',
      read: ['你上传的《下班做饭记录》'],
      calls: [{ query: '下班做饭、一人食', dataKind: 'keyword_posts', toolName: DISCOVER }],
      reply: '我先看了你上传的做饭记录：大多是工作日晚上、一个人的量、20 分钟以内。同类账号里，"下班快手菜"和"一人食"各有一批做得好的，'
        + '但同时占住两个的很少。\n\n定方向之前先问一件事：**你做这个账号，最希望它最后给你带来什么**？记录生活、每月多点零花钱、慢慢做成主业，'
        + '还是先试试？这决定了拍法、平台和找谁当对标。',
    },
    {
      user: '副业收入，每月多几百美元就行。',
      reply: '那方向就清楚了：**下班后 15 分钟的一人份家常菜**。你本人就是这群人，每条"15 分钟"都能被验证；起步先走厨具和食材带货，门槛最低、'
        + '和做饭最贴。\n\n**接下来你做**：回答下一个问题——你希望谁来看？想一个你真认识的人。',
    },
  ],
  [
    {
      user: '这周拍什么？',
      read: ['《我的定位报告》', '《上周拍摄清单》'],
      calls: [
        { query: '我的账号 · 上周发布的 3 条', dataKind: 'account_posts', toolName: OWN },
        { query: '对标账号 A–E · 近 7 天作品', dataKind: 'account_posts', toolName: BENCH },
      ],
      reply: '上周 3 条里，"冰箱剩菜三种做法"收藏最多，评论里好几个人问"一个人的菜怎么买才不浪费"。对标账号 A 和 C 这周都在发"一周备菜"。\n\n'
        + '这周拍这三条：\n1. **一口锅，15 分钟两菜一汤**——最能证明"下班后也来得及"，接住你的定位；\n'
        + '2. **一个人的菜怎么买不浪费**——直接回答上周评论里的问题；\n3. **超市半成品改造**——最省事，留给最累的那天。\n\n'
        + '**接下来你做**：先拍第 1 条，下班后 15 分钟就够；拍完传上来，字幕我来配。',
    },
    {
      user: '第 1 条开头怎么拍？',
      reply: '开头直接给成品：前 3 秒让人看到桌上的两菜一汤，和计时器上的 15:00，再倒回去讲怎么做。你上周收藏最多的那条也是先给成品。\n\n'
        + '**接下来你做**：照这个开头拍，拍完上传。',
    },
  ],
  [
    {
      user: '帮我写一条口播稿，就拍一口锅两菜一汤。',
      read: ['《我的说话习惯》（文风画像）', '《一口锅两菜一汤 · 拍摄笔记》'],
      reply: '按你平时说话的习惯写的：句子短，不说"家人们"，先给结论。',
      proposal: '下班到家七点。这顿饭，我十五分钟搞定。\n\n一口锅：先炒青菜，盛出来；锅底的油别倒，加水煮番茄蛋汤；最后热一下早上的米饭。\n\n'
        + '一个人吃，也好好吃。\n\n分镜：成品 → 备菜 → 下锅 → 装盘，只拍手和锅。',
    },
    {
      user: '第二段有点长。',
      reply: '改成两句："一口锅，先炒青菜。锅底的油别倒，直接煮汤。"米饭那句挪到画面字幕里。\n\n**接下来你做**：照着分镜拍，拍完上传，字幕我来配。',
    },
  ],
  [
    {
      user: '上周三那条番茄炒蛋，为什么没火？',
      read: ['《我的定位报告》'],
      calls: [
        { query: '我的账号 · 番茄炒蛋那条', dataKind: 'post_detail', toolName: OWN },
        { query: '我的账号 · 近 30 天作品', dataKind: 'account_posts', toolName: OWN },
        { query: '对标账号 A、C · 同题作品', dataKind: 'account_posts', toolName: BENCH },
      ],
      reply: '这条的人大多在前几秒就划走了：开头先讲了二十秒备菜。对标账号 A 和 C 的同一道菜，都是先给成品。另外标题没写"15 分钟"，'
        + '和你主页说的对不上。\n\n**接下来你做**：下周重拍这道菜，开头直接给成品，标题写"15 分钟番茄炒蛋，一个人的量"。',
    },
    {
      user: '要不要干脆换个方向？',
      reply: '不用换。你近 30 天的作品里，开头先给成品的那几条，收藏都明显更多。问题在开头，不在方向。\n\n**接下来你做**：先把这一条重拍，下周我们一起看数据。',
    },
  ],
];
