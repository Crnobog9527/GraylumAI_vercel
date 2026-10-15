/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/**
 * Sample J's comparison, plan A (Owner 2026-10-15: "两个模块按 A 改"): only how the two work differently, short enough
 * to see at once. Four pairs, one per difference (asks you first / judges and gives reasons / remembers you / speaks
 * from real data); the same question to both. The general AI's side is a typical general chat reply, naming no
 * product (NEW). The AI coach's side is the coach's own words from the real sample conversations of 2026-10-15
 * (sample-reports, transcript.md), cut with "……" but not reworded; `source` names the conversation.
 */
export const J_COMPARE = {
  genericName: '通用 AI',
  coachName: 'AI 教练',
  /** NEW: under each coach reply. */
  sourceLabel: '原话出自样例对话',
  pairs: [
    {
      theme: '主动问你',
      question: '我想做自媒体，不知道从哪开始。',
      generic: ['可以先选一个领域：穿搭、美食、旅行、知识分享……', '然后保持日更，多蹭热点。'],
      coach: '我先问最重要的一件事：你做这个账号，最希望它最后给你带来什么？……有人只想每月多点零花，有人想靠它找到客户，'
        + '有人想全职，三种人的做法完全不同。',
      source: '留学生 · Instagram',
    },
    {
      theme: '帮你判断，讲清理由',
      question: '我想毕业就全职做穿搭博主，一年内靠品牌合作养活自己。',
      generic: ['这是个很棒的目标！', '保持热爱、坚持更新、多和品牌互动，你一定可以做到。'],
      coach: '我得说实话：以你现在的条件，这个方向很难赚到能覆盖伦敦生活的钱，而且有一个比流量更硬的坎。……'
        + '我不劝你放弃，而是想帮你找一条还能用上你会的东西、钱又来得更近的路。',
      source: '留学生 · Instagram',
    },
    {
      theme: '记得你的情况',
      question: '要不要我露个脸更可信？',
      generic: ['真人出镜能明显增加信任感，', '建议尝试露脸拍摄，展示真实的自己。'],
      coach: '不用露脸。你说过不想露脸，这是你的边界，方案就按这个来。……可信度靠的是"每样东西都在我家真用过"和整理前后的对比，不靠脸。',
      source: '好物副业 · TikTok',
    },
    {
      theme: '用真实数据说话',
      question: '附近的人真的会上小红书找蛋糕店吗？',
      generic: ['会的，小红书是很多人找店的地方，', '建议多发探店风格的笔记。'],
      coach: '需求是真的，而且会主动搜。……其中一篇求推荐帖有 2758 个赞、550 条评论。……我搜"成都蛋糕定制"的账号，'
        + '20 个结果里只有 1 个过万粉，大多数几十到几百粉。',
      source: '小店 · 小红书',
    },
  ],
} as const;
