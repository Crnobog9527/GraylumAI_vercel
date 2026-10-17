/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { LandingFeature } from './landing-flags';

/**
 * Sample L, round five, R5 (Owner 2026-10-17: "还没开发完的功能，现在也全部都要在落地页上展示出来"): steps two and three of
 * region 3, the page's own person's week after step one. Each stage says whether the page shows the product's real
 * components ("real") or the planned design ("planned": MASTER_PLAN §5 for the voice profile, PUBLISH-MONITOR.md §1
 * and §5 for publishing, monitoring and the weekly review); `needs` names what each promises (Owner 2026-10-17: the
 * page is the full launched version, no switch hides a stage). Lines are NEW unless noted.
 */
export type LaterStage = {
  id: string; label: string; note: string; needs: readonly LandingFeature[]; source: 'real' | 'planned';
};

export const L_LATER = {
  /** NEW: the stages' tab list label, and the pause control. */
  label: '这一步的几个环节',
  two: {
    title: '第二步：每周带你做内容',
    lede: '定位定下来以后，每周在同一个对话里：先选题，再按你的资料和说话习惯写稿、出分镜。',
    stages: [
      { id: 'topics', label: '选题', needs: ['content'], source: 'real',
        note: '按你的定位、上周的数据和对标账号的近况，挑出这周最值得拍的几条，每条写清理由。' },
      { id: 'library', label: '引用你的资料', needs: ['content', 'library'], source: 'real',
        note: '在输入框里 @ 一份你上传过的资料，教练读完再写，不用每次从头介绍自己。' },
      { id: 'voice', label: '按你的文风写', needs: ['content', 'voice'], source: 'planned',
        note: '从你写过的东西里学出文风画像：语气、句子长短、开头方式、常用表达。你确认后才用；写出来的稿子和你原文放在一起看。' },
      { id: 'script', label: '口播稿和分镜', needs: ['content'], source: 'real',
        note: '稿子出现在对话里的"建议稿"，右边是正文稿件和分镜；你改哪句，它就接着改哪句。' },
    ] as readonly LaterStage[],
  },
  three: {
    title: '第三步：帮你建立数据飞轮',
    lede: '拍完以后，发出去、盯数据、每周复盘；复盘的结论，就是下一轮的选题。',
    stages: [
      { id: 'publish', label: '一键发到多个平台', needs: ['publish'], source: 'planned',
        note: '连接你的账号后，一条视频一次发到几个平台；每个平台单独显示结果，没发成的写清原因。' },
      { id: 'monitor', label: '替你盯数据', needs: ['publish'], source: 'planned',
        note: '发出后自动取数：前 7 天每天一次，之后每周一次。平台不给的数，写"平台不提供"，不填 0。' },
      { id: 'review', label: '每周复盘', needs: ['publish'], source: 'planned',
        note: '每周把这周的作品和你自己的中位数比，说清哪条有效、为什么；给出下周三个能直接变成选题的建议。' },
    ] as readonly LaterStage[],
  },
} as const;

/** The person's work conversation in step two (NEW). */
export const L_LATER_CHAT = {
  title: '工作对话',
  platform: 'TikTok',
  account: '下班后 15 分钟家常菜',
  topics: {
    user: '这周拍什么？',
    /** Its work first, as region 6 shows it: the library read, then the data fetched. */
    read: ['《我的定位报告》', '《上周拍摄清单》'],
    calls: [
      { query: '我的账号 · 上周发布的 3 条', dataKind: 'account_posts', toolName: 'social_account' },
      { query: '对标账号 A–E · 近 7 天作品', dataKind: 'account_posts', toolName: 'benchmark_fetch' },
    ],
    reply: '按你的定位和上周的数据，这周拍这三条：\n1. **一口锅，15 分钟两菜一汤**——最能证明"下班后也来得及"；\n'
      + '2. **一个人的菜怎么买不浪费**——上周评论里问得最多；\n3. **超市半成品改造**——最省事，留给最累的那天。\n\n先做第 1 条？',
  },
  library: {
    document: '一口锅两菜一汤 · 拍摄笔记.md',
    user: '按这份笔记写第 1 条的口播稿。',
    reply: '读完了。你笔记里写了三处要点：青菜先炒先盛、锅底的油直接煮汤、米饭用早上剩的。稿子就按这个顺序走。',
  },
  voice: {
    profileTitle: '我的文风画像',
    status: '已确认 · 第 2 版',
    fields: [
      ['语气', '像跟朋友说话，不喊口号'],
      ['句子长短', '短句为主，一句一个动作'],
      ['开头方式', '先说结果，再说怎么做'],
      ['常用表达', '"就够了""别倒""一个人也"'],
      ['不喜欢的表达', '"家人们""绝绝子""赶紧码住"'],
    ] as const,
    toggle: '使用我的文风',
    compareTitle: '写出来的，和你原来写的放在一起看',
    original: { label: '你以前写的', text: '今天又是七点到家。冰箱里只剩两根青菜，那就一口锅解决：先炒菜，锅底的油别倒，加水煮个汤。' },
    draft: { label: '按你的文风写的', text: '下班到家七点。这顿饭，我十五分钟搞定。一口锅，先炒青菜。锅底的油别倒，直接煮汤。' },
  },
  script: {
    user: '写吧。',
    reply: '按你的文风写好了，分镜在右边。',
    proposal: '下班到家七点。这顿饭，我十五分钟搞定。\n\n一口锅，先炒青菜。锅底的油别倒，直接煮汤。\n\n一个人吃，也好好吃。',
    draftTitle: '一口锅，15 分钟两菜一汤',
    versionLine: '账号已保存 v1 · 草稿',
    storyboard: '镜头 1：桌上成品 + 计时器 15:00（3 秒）\n镜头 2：洗切青菜，只拍手\n镜头 3：下锅翻炒，盛出\n镜头 4：锅底加水，番茄蛋汤\n镜头 5：装盘，上桌',
    editing: '前 3 秒放成品；字幕只写步骤，不写形容词',
  },
} as const;

/** Step three's pictures, from PUBLISH-MONITOR.md §1 and §5 (status words as the plan writes them); figures NEW. */
export const L_LATER_FLYWHEEL = {
  publish: {
    title: '发布这条视频',
    video: '一口锅，15 分钟两菜一汤',
    platforms: [['TikTok', '已发布'], ['Instagram Reels', '已发布'], ['YouTube Shorts', '已发布']] as const,
    note: '视频会先交给发布服务，再发到各平台；每个平台单独显示结果。',
    action: '一键发布',
  },
  monitor: {
    title: '这条视频的数据',
    updated: '最后更新于 今天 09:00 · 发布后第 3 天',
    columns: ['平台', '播放', '点赞', '收藏', '粉丝变化'] as const,
    rows: [
      ['TikTok', '2,140', '186', '97', '+23'],
      ['Instagram Reels', '860', '64', '41', '平台不提供'],
      ['YouTube Shorts', '1,310', '72', '未取到', '+5'],
    ] as const,
    footnote: '平台不给的数写"平台不提供"，没取到的写"未取到"，不填 0。',
  },
  review: {
    title: '本周复盘',
    notice: '本周复盘已生成',
    compare: '这周 3 条，和你自己同样发布第 3 天的中位数比：',
    rows: [
      ['一口锅，15 分钟两菜一汤', '收藏是中位数的 2 倍', '有效'],
      ['一个人的菜怎么买不浪费', '和中位数差不多', '一般'],
      ['超市半成品改造', '发布才 1 天', '太新，下周再看'],
    ] as const,
    why: '先给成品的开头留住了人；评论里又有人问"一个人的量怎么买"。',
    nextTitle: '下周三个建议，确认后变成选题：',
    next: ['一口锅系列第 2 期：15 分钟一荤一素', '一个人一周买菜清单（回答评论）', '开头一律先给成品，3 秒内'],
    action: '设为下周选题',
    loop: '复盘的结论，回到第二步，变成下一轮选题。',
  },
} as const;
