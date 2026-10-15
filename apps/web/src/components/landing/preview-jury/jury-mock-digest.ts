/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/**
 * Mock reading aids for the result page: what each chapter says in one sentence plus two or three points, and the
 * report's one-page summary. Where these come from for real (the report's own chapter conclusions, or written by the
 * summary in the same call) is open; the prototype only needs them to show the layout. Same fictional creator.
 */
export type ChapterDigest = { gist: string; points: string[] };

export const CHAPTER_DIGEST: Record<string, ChapterDigest> = {
  '第 1 章 你是谁': {
    gist: '你是下班后只有一小时空闲、会做二十多道家常菜的上班族。',
    points: ['每天 19 点到家', '手机竖拍做饭过程', '没有专业设备和团队'],
  },
  '第 2 章 定位一句话': {
    gist: '定位是「下班后 15 分钟上桌的家常菜」，给刚开始一个人生活的上班族。',
    points: ['一句话说清给谁、省什么', '和你自己的下班经历一致'],
  },
  '第 3 章 差异化': {
    gist: '和同类账号比，你的不同在于快，而且快在备菜。',
    points: ['周日一次切配', '工作日三天复用', '每道菜 15 分钟以内'],
  },
  '第 4 章 受众画像': {
    gist: '核心受众是 25–32 岁、刚开始独居的一二线城市上班族。',
    points: ['19–20 点到家，厨房只有单灶和小冰箱', '常因太累、买菜麻烦、一个人吃不完而放弃做饭'],
  },
  '第 5 章 同类账号': {
    gist: '同类账号多讲「好吃」「精致」，很少有人专讲下班后的速度。',
    points: ['单条制作时间长', '「下班后」这个场景没人占'],
  },
  '第 6 章 平台选择': {
    gist: '主平台是小红书，靠搜索被找到。',
    points: ['新号也有机会被搜到', '同一条视频同步发抖音，观察家庭用户反馈'],
  },
  '第 7 章 人设与语气': {
    gist: '人设是一个会做饭的同事：说话直接，不炫技。',
    points: ['每一步都说清为什么', '不用夸张的标题'],
  },
  '第 8 章 选题方向': {
    gist: '选题围绕「一个人、一小时、一顿饭」。',
    points: ['冰箱剩菜怎么用', '一周菜单怎么排', '一口锅能做什么'],
  },
  '第 9 章 内容支柱': {
    gist: '三个内容支柱撑起日常更新。',
    points: ['15 分钟晚饭', '一周不重样', '备菜和收纳'],
  },
  '第 10 章 变现路径': {
    gist: '先用免费周菜单验证有没有人愿意付钱，再决定付费版。',
    points: ['第一个月上线免费周菜单和报名表', '第三个月按报名情况决定付费版', '品牌合作放到第二步'],
  },
  '第 11 章 风险与边界': {
    gist: '不做减肥和医疗建议，不推荐没用过的产品。',
    points: ['合作内容明确标注', '不碰营养功效的说法'],
  },
  '第 12 章 30 天行动': {
    gist: '前 30 天每周更新三条，第一周上线周菜单报名表。',
    points: ['周二、周四、周日更新', '周末集中拍两条备用', '每周日整理评论区问题'],
  },
  '第 13 章 结语': {
    gist: '先把「15 分钟」这个承诺做扎实，再考虑扩展。',
    points: ['人群和形式都先不扩', '三个月后回看数据'],
  },
};

/** The report on one page: four lines, each from a chapter; the revised wording shows when that chapter changed. */
export const REPORT_SUMMARY: { label: string; section: string; original: string; revised: string }[] = [
  {
    label: '定位', section: '第 2 章 定位一句话',
    original: '下班后 15 分钟上桌的家常菜，给刚开始一个人生活的上班族', revised: '下班后 15 分钟上桌的家常菜，给刚开始一个人生活的上班族',
  },
  {
    label: '受众', section: '第 4 章 受众画像',
    original: '刚独居的上班族，以及想控制饮食的健身新手', revised: '25–32 岁、刚开始独居的一二线城市上班族',
  },
  {
    label: '主平台', section: '第 6 章 平台选择',
    original: '小红书', revised: '小红书，同一条视频同步发抖音',
  },
  {
    label: '变现', section: '第 10 章 变现路径',
    original: '先接厨具和半成品品牌合作，再推付费食谱', revised: '先做免费周菜单收集付费意愿，品牌合作放第二步',
  },
];
