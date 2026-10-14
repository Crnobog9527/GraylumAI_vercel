/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/**
 * Sample J's four sample reports as a walkthrough (Owner 2026-10-15, round five: "给这个地方的样例报告做一个解读……至少能让
 * 他有个框架，知道这份分析报告拿到的到底是一个什么样的结果，以及值不值得付费"). Each report opens on its cover, then its
 * chapters light up one by one in the real report's order (13 numbered chapters plus 一句话结论, about 11,000
 * characters: paywall v25 595-601, REPORT_GEN_PLAN), each with what the chapter gives you and one key conclusion.
 * The groups and platforms are the Owner's; the reports' own conclusions come from the research window after RT-7 and
 * are not written here — until then each shows "样例报告生成中". Shown only in a local development preview or when the
 * landing flag `sampleReports` is on (off on staging and production).
 */
export const J_SAMPLES = {
  /** NEW */
  title: '先看成果：四种人拿到的完整报告',
  lede: '每份都是和 AI 教练聊完以后拿到的一整套方案。下面逐章看一份报告里有什么。',
  pending: '样例报告生成中',
  more: '看完整报告',
  truthTag: '教练说真话',
  coverLabel: '完整运营策略报告',
  size: '13 章 + 一句话结论 · 全文约 11,000 字',
  giveLabel: '这一章给你什么',
  keyLabel: '关键结论',
  reports: [
    { slug: 'accountant', who: '会计', platform: 'YouTube', truth: false },
    { slug: 'shop', who: '小店', platform: '小红书', truth: false },
    { slug: 'side-hustle', who: '好物副业', platform: 'TikTok', truth: false },
    { slug: 'student', who: '留学生', platform: 'Instagram', truth: true },
  ],
  /** The real report's chapters, in order; what each gives you is NEW wording (not the report's content). */
  chapters: [
    { title: '一句话结论', give: '用一句话告诉你：做什么、给谁看、靠什么赚钱。' },
    { title: '1 现状盘点', give: '盘清你手里有什么：经历、时间、资源和短板。' },
    { title: '2 目标和可行性', give: '你的目标现不现实、多久能到、要付出什么。' },
    { title: '3 受众', give: '你的观众是谁、在意什么、会为什么花钱。' },
    { title: '4 平台选择', give: '先做哪个平台、为什么，其他平台怎么配合。' },
    { title: '5 对标账号分析', give: '三类对标各学什么、哪些不要学，数据来自公开接口。' },
    { title: '6 账号定位', give: '你在观众心里是谁，和同类账号差在哪。' },
    { title: '7 账号三件套', give: '名字、简介、头像，每项给出写法和理由。' },
    { title: '8 内容规划', give: '几条内容线、选题池和发布节奏。' },
    { title: '9 运营手册', give: '开头怎么拍、标题怎么起、标签和评论怎么做。' },
    { title: '10 变现路径', give: '先做什么、再做什么，每一阶段的门槛和风险。报告里写得最长的一章。' },
    { title: '11 合规提醒', give: '这个方向要注意的平台规则和说法边界。' },
    { title: '12 见效时间', give: '多久能看到什么变化，什么时候该调方向。' },
    { title: '13 待验证的假设', give: '哪些判断要靠真实数据验证，怎么验证。' },
  ],
} as const;

export const samplePath = (slug: string) => `/landing/samples/${slug}`;
