/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/**
 * Fixed words of the report page (REPORT-VISUAL §4, §12): explanations that are the same in every report, so the
 * model no longer writes them and the page says them once, in the chapter they belong to. Shown only for a
 * report with strategy data; an older report still carries its own explanations in its text.
 */
export const REPORT_FIXED_NOTES: Record<string, { title: string; text: string }> = {
  平台选择: {
    title: "平台怎么推荐内容（大白话）",
    text: "平台会先把一条新内容推给一小部分人，看他们有没有看完、点赞、收藏、评论；反应好，就推给更多人。"
      + "所以每条内容开头的几秒、对你想吸引的人有没有用，比一天发多少条更重要。",
  },
  变现路径: {
    title: "为什么按漏斗一层层来",
    text: "大多数人第一次刷到你时不会马上花大钱。先用免费内容让人认识你，再用门槛低的产品让人试一次，"
      + "信任建立以后再推荐主力产品。每一层都在帮你筛出更合适的人，所以越往下人越少，但越愿意付费。",
  },
  合规提醒: {
    title: "平台规则会变",
    text: "各平台的社区规范、广告和商业标注规定会更新。发布前以平台当时的官方规则为准；这里的提醒是常见注意事项，不是法律意见。",
  },
  见效时间: {
    title: "不承诺见效",
    text: "AI 教练不承诺涨粉速度、见效时间或收入金额。结果取决于你的执行、内容质量、平台变化和市场情况；"
      + "报告里的阶段和时间是按条件安排的计划，不是保证。",
  },
};

export const REPORT_VIEW_TEXT = {
  quickLook: "30 秒看懂",
  summary: "一句话结论",
  firstStep: "这周先做这一件事",
  what: "做什么",
  why: "为什么",
  done: "做到什么算完成",
  mainPlatform: "主平台",
  positioning: "定位",
  funnel: "变现路径",
  thisWeek: "这周就做的事",
  showReasons: "展开理由",
  hideReasons: "收起理由",
  preparing: "图表和策略要点整理中…",
  fallback: "这一项的数据不完整，没有画成图表，下面只列出其中的文字。",
  revisionKeepsData: "评审团修订只更新了文字；图表和策略要点仍是原报告的建议，如果和文字不一致，以文字为准。",
  edited: "这一章的文字你改过，下面的图表仍是 AI 教练的原建议；如果不一致，以你改的文字为准。",
  more: "其他策略要点",
  layerDetail: "看这一层的细节",
  audienceMore: "更多",
  metricsTitle: "每周看的指标",
  day30: "第 30 天要回答的问题",
  noMetrics: "这些账号暂时没有可以对上的数据，只列出可以学什么。",
  todo: "还没有合格的对标账号",
} as const;
