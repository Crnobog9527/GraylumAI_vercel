/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { LandingFeature } from './landing-flags';

/**
 * Sample L, round three, region 6 (Owner 2026-10-17: "展示通用 AI 和我们的 AI 教练面对同一个任务时，工作成果分别是什么
 * 样的"): four everyday tasks, the same question to both. The general AI's side is a typical answer of a general chat
 * assistant, fair and correct, naming no product (NEW). The coach's side is the page's own person's conversation
 * (sample J's takeover script and week, sample L's week), cut with "……", ending on what to do next. The verdicts are NEW.
 * Round four (Owner 2026-10-17): a marketing comparison, not a product window, so no product step head on the coach's side.
 */
export const L_TASKS_TITLE = '同一个任务，通用 AI 和 AI 教练交出来的东西不一样';
const SOURCE = '下班后 15 分钟家常菜';

export const L_TASKS: readonly {
  question: string; generic: readonly string[]; coach: string; genericNote: string; coachNote: string; source: string;
  verdict: string; needs?: readonly LandingFeature[];
}[] = [
  {
    question: '我想做美食号，该怎么定位？',
    generic: ['可以先想清楚三件事：拍什么类型的美食、给谁看、和别人有什么不同。',
      '常见方向有家常菜、探店、烘焙、减脂餐。选一个你喜欢的，保持更新，慢慢找到自己的风格。'],
    coach: '好，做饭是个好起点。先不急着定拍什么，我先把你的情况弄清楚，一次只问一个问题。先问第一件：'
      + '你做这个账号，最希望它最后给你带来什么？……同样是做饭账号，想记录生活和想赚钱，拍法、选平台、找对标完全不一样。'
      + '\n\n接下来你做：回答这一个问题就行，记录、零花钱、慢慢做成主业，还是先试试。',
    genericNote: '给你一套框架，自己去套', coachNote: '先问清你，再下判断', source: SOURCE,
    verdict: '一个给你方法，一个先把你弄清楚', needs: ['coach'],
  },
  {
    question: '这周拍什么？',
    generic: ['可以试试这几类常见选题：', '10 分钟快手晚餐、一周备餐、冰箱清空挑战、网红菜复刻、平价食材改造。'],
    coach: '按你的定位和对标账号里收藏最多的几类题，这周拍这三个：一口锅，15 分钟两菜一汤（最能证明"下班后也来得及"）；'
      + '冰箱剩菜三种做法（接上你说的"青菜三天吃不完"）；超市半成品改造（最省事，适合累的那几天）。'
      + '\n\n接下来你做：先拍第一个，下班后十五分钟就够。',
    genericNote: '一份谁都能拍的清单', coachNote: '按你的定位和数据挑', source: SOURCE,
    verdict: '一个给你清单，一个替你挑好这周拍什么', needs: ['content'],
  },
  {
    question: '帮我写一条口播稿',
    generic: ['好的，这是一条美食口播稿：', '"大家好，今天给大家分享一道超级简单又好吃的家常菜，学会了再也不用点外卖！……喜欢的话记得点赞关注哦！"'],
    coach: '按你平时说话的习惯写好了，句子短：下班到家七点，这顿饭我十五分钟搞定。一口锅，先炒菜，再借锅底的油煮汤。'
      + '分镜：成品 → 备菜 → 下锅 → 装盘，只拍手和锅。\n\n接下来你做：照着分镜拍，拍完上传，字幕我来配。',
    genericNote: '一套通用模板', coachNote: '按你的定位和说话习惯写', source: SOURCE,
    verdict: '一个给你模板，一个写的是你自己的稿子', needs: ['content'],
  },
  {
    question: '这条为什么没火？',
    generic: ['可能的原因有很多：发布时间、封面不够吸引人、前 3 秒没抓住观众、话题不够热。', '建议多分析数据，持续优化，保持更新。'],
    coach: '我读了你这周三个平台的数据：前半周持平，"冰箱剩菜"那条发出后明显上升。"省事"的题最受欢迎；YouTube 开头太长，留不住人。'
      + '\n\n接下来你做：下周多做两条省事菜，YouTube 开头直接给成品。',
    genericNote: '列出所有可能', coachNote: '看你自己的数据下结论', source: SOURCE,
    verdict: '一个列出所有可能，一个告诉你问题在哪、下周怎么改', needs: ['publish'],
  },
];
