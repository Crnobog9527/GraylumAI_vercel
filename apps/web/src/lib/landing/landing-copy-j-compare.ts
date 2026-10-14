/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/**
 * Sample J's comparison as four side-by-side conversations (Owner 2026-10-15): the same question asked of a general
 * AI (left) and of the AI coach (right), one per row of the Owner's four-row table (H_COMPARE.rows, same order).
 * NEW WORDING for the Owner to approve. The general answers are written as a typical general chat reply, naming no
 * product; the coach's side follows the page's example person (J_PERSONA: an office worker, 15-minute home dishes).
 * No figures beyond that person's own situation.
 */
export const J_COMPARE = {
  genericName: '通用 AI',
  coachName: 'AI 教练',
  pairs: [
    {
      question: '我想做自媒体，该做什么内容？',
      generic: [
        '可以考虑以下几个方向：',
        '1. 生活日常 Vlog　2. 知识分享　3. 美食探店　4. 好物推荐　5. 旅行记录',
        '选择你感兴趣的领域，保持稳定更新，多和粉丝互动，就能慢慢做起来。',
      ],
      coach: '先不急着定做什么。你手里有什么，决定了你能做什么。我先问你一个问题：',
    },
    {
      question: '这周发什么？',
      generic: [
        '这里有一些热门选题供你参考：',
        '1. 一天的工作日常　2. 新手常犯的错误　3. 行业冷知识　4. 好物分享　5. 问答合集……',
        '你可以根据自己的兴趣挑选。',
      ],
      coach: '这周先做一条，题目替你定好了：',
      plan: {
        title: '本周选题',
        rows: [
          ['做什么', '一口锅，15 分钟两菜一汤'],
          ['为什么', '最能证明"下班后也来得及"，正是你的定位；想省时间的上班族会收藏'],
          ['怎么做', '开头先给出锅的成品；中间只拍手和锅，步骤配字幕；结尾问观众最想学哪道'],
        ],
      },
    },
    {
      question: '接着上次的写。',
      generic: [
        '抱歉，我看不到我们之前的对话。',
        '能不能再介绍一下你的账号定位、目标观众，以及之前写到哪里了？',
      ],
      coach: '好，接着上次。这是我记得的：',
      memory: [
        ['定位档案', '下班后 15 分钟上桌的家常菜，给刚开始一个人生活的上班族'],
        ['你的情况', '每天下班后一小时；只拍手和锅，不露脸'],
        ['创作进度', '第一周：一口锅两菜一汤已发，下一条是冰箱剩菜三种做法'],
      ],
    },
    {
      question: '这条发了没人看，问题在哪？',
      generic: [
        '内容表现不好可能有很多原因：',
        '发布时间、封面、标题、话题热度、平台推荐机制……',
        '建议多尝试不同的形式，持续优化。',
      ],
      coach: '我看了你这条的平台数据，问题出在开头，不在内容：',
      review: {
        title: '这条怎么改',
        rows: [
          ['问题在哪', '大部分人在开头的备菜镜头就划走了；看完的人收藏不少，说明菜本身有用'],
          ['下一条怎么改', '开头先给出锅的成品和"15 分钟"，再倒回去讲步骤'],
        ],
      },
    },
  ],
} as const;
