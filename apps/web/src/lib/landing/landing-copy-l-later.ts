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
    /** Round six (Owner: "必须要显示加载资料库的过程"): the notice while the library is read. */
    reading: '正在读取资料库',
    read: '已读取资料库',
    reply: '读完了。你笔记里写了三处要点：青菜先炒先盛、锅底的油直接煮汤、米饭用早上剩的。稿子就按这个顺序走。',
  },
  voice: {
    profileTitle: '我的文风画像',
    status: '已确认 · 第 2 版',
    /** Round six (Owner: "用户真实写东西的文风应该是稍微口水化一点，真实的大白话，语气词也会多一点"): drawn from the text below. */
    fields: [
      ['语气', '像跟朋友唠嗑，口语多，爱带语气词（"呗""啊""嘿"）'],
      ['句子长短', '长短不一，想到哪说到哪，常拿短句收尾'],
      ['开头方式', '先吐槽一句下班的累，再说今天吃啥'],
      ['常用表达', '"咋整""搞定""一口锅""还挺香"'],
      ['不喜欢的表达', '"家人们""绝绝子""赶紧码住"'],
    ] as const,
    toggle: '使用我的文风',
    compareTitle: '写出来的，和你原来写的放在一起看',
    original: { label: '你以前写的', text: '哎今天又七点才到家，冰箱里就剩两根青菜了，那咋整，一口锅搞定呗。先炒菜，炒完别急着刷锅啊，锅底那点油直接加水煮个汤，嘿还挺香。' },
    draft: { label: '按你的文风写的', text: '哎下班到家都七点了，冰箱里就俩青菜，咋整？一口锅，十五分钟搞定呗。先炒青菜，盛出来；锅底的油别倒啊，加水直接煮汤。嘿，一个人也能吃得挺香。' },
  },
  script: {
    user: '写吧，再给我一个分镜。',
    reply: '按你的文风写好了，约 300 字，念下来七十秒左右。分镜如下，正文和分镜也同步到右边了：',
    /** Round six (Owner: "尽量给一个 300 字左右完整的口播稿，而且要在我们的聊天框里面展示一个完整的分镜脚本表格"). */
    proposal: '哎，下班到家都七点了，累得不想动，外卖一看又是三十多刀。冰箱里就俩青菜、两个番茄、一盒鸡蛋，咋整？今天就一口锅，十五分钟，两菜一汤，搞定给你看。\n\n'
      + '先把米饭热上，早上剩的就行。锅烧热，倒点油，青菜下锅，大火翻一分钟，加点盐，盛出来。青菜别一次全炒啊，一个人一把刚好，剩下的明天还能煮面。锅别刷，留着底油。\n\n'
      + '番茄挑软一点的，出汁快。切块下锅，炒出汁，鸡蛋打散倒进去，划两下，番茄炒蛋就好了，盛一半出来当菜。\n\n'
      + '剩下那一半直接加水，煮开，撒点葱花，番茄蛋汤就有了。你看，一口锅，一个油底，两菜一汤，前后十五分钟，洗的锅都只有一个。\n\n'
      + '一个人吃，也得好好吃饭。明天拍冰箱剩菜咋整，想看的评论区扣个1呗。',
    /** 11 shots, 70 seconds in all, matching the script. */
    /** 11 shots, 70 seconds in all; each line is exactly what is said in that shot, so together they are the script. */
    shots: [
      ['1', '近景', '成品和计时器', '哎，下班到家都七点了，累得不想动，', '5 秒'],
      ['2', '特写', '外卖页面价格', '外卖一看又是三十多刀。', '4 秒'],
      ['3', '近景', '打开冰箱', '冰箱里就俩青菜、两个番茄、一盒鸡蛋，咋整？', '6 秒'],
      ['4', '中景', '按下计时器', '今天就一口锅，十五分钟，两菜一汤，搞定给你看。', '5 秒'],
      ['5', '特写', '热剩米饭', '先把米饭热上，早上剩的就行。', '4 秒'],
      ['6', '俯拍', '炒青菜', '锅烧热，倒点油，青菜下锅，大火翻一分钟，加点盐，盛出来。青菜别一次全炒啊，一个人一把刚好，剩下的明天还能煮面。', '9 秒'],
      ['7', '特写', '锅底留油', '锅别刷，留着底油。', '4 秒'],
      ['8', '俯拍', '番茄炒蛋', '番茄挑软一点的，出汁快。切块下锅，炒出汁，鸡蛋打散倒进去，划两下，番茄炒蛋就好了，盛一半出来当菜。', '11 秒'],
      ['9', '俯拍', '加水煮汤', '剩下那一半直接加水，煮开，撒点葱花，番茄蛋汤就有了。', '9 秒'],
      ['10', '近景', '上桌，14:52', '你看，一口锅，一个油底，两菜一汤，前后十五分钟，洗的锅都只有一个。', '7 秒'],
      ['11', '近景', '一个人开吃', '一个人吃，也得好好吃饭。明天拍冰箱剩菜咋整，想看的评论区扣个1呗。', '6 秒'],
    ] as const,
    shotHead: ['镜号', '景别', '画面', '口播台词', '时长'] as const,
    total: '合计约 70 秒',
    draftTitle: '一口锅，15 分钟两菜一汤',
    versionLine: '账号已保存 v1 · 草稿',
    editing: '前 3 秒放成品；字幕只写步骤，不写形容词；第 10 镜的计时器要拍清楚',
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
