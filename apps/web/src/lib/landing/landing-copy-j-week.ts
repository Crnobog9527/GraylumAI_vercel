/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/**
 * Sample J's first-screen window (Owner 2026-10-15, option A): one week with the AI coach, in five steps, for the
 * demo's made-up case (a dental assistant in Canada). Topics, draft lines and the review wording follow the demo
 * scenes (preview-g/scenes.ts); the topic reasons are new. No numbers: the review shows a trend without a scale.
 */
export const J_WEEK = {
  label: '示例：AI 教练陪一位加拿大牙科助理走完一周（定位、选题、创作、发布、复盘）',
  title: '加拿大牙科助理 · 第一周',
  stages: ['定位', '选题', '创作', '发布', '复盘'],
  position: {
    user: '我在加拿大做牙科助理，下班后和周末有点时间，想做个账号。',
    coach: '你的经历、时间和想帮的人都问清楚了，定位清单已经记好，你核对一下。',
  },
  topics: {
    coach: '按你的定位，这周排 3 个选题：',
    items: [
      { title: '入行前要准备哪些证书', why: '想入行的人最先搜的问题' },
      { title: '课程怎么选：我当时踩过的坑', why: '你自己走过的路，别人替代不了' },
      { title: '第一份工作的面试会问什么', why: '离"找到工作"最近的一步' },
    ],
    why: '三条都从你的入行经历出发，由浅到深，接得上你的定位。',
  },
  draft: {
    user: '用第二个题目写一条口播稿。',
    coach: '按你的文风写好了：先讲经历，再讲方法，句子短。',
    title: '口播稿（节选）',
    lines: [
      '开头：我当年选课花了冤枉钱，今天把踩过的坑一次讲清楚。',
      '第一段：先看课程有没有带实习，这一条最容易被忽略。',
      '结尾：你现在卡在哪一步，留言告诉我，下一条就讲它。',
    ],
  },
  publish: {
    coach: '选好平台，确认后一次发出：',
    title: '发布到',
    platforms: [
      { name: 'TikTok', on: true },
      { name: 'Instagram', on: true },
      { name: 'YouTube', on: true },
      { name: 'Facebook', on: false },
    ],
    action: '确认发出',
    done: '已发出',
  },
  review: {
    coach: '一周到了，这是本周复盘：',
    title: '本周复盘',
    trend: '这周的互动走势',
    rows: [
      ['哪条有效', '讲证书清单的那条，收藏和提问最多'],
      ['下周怎么调', '多做"清单 + 你的亲身经历"，每周至少一条'],
    ],
  },
} as const;
