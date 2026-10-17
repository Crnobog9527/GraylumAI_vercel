/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/**
 * Sample L, region 6: the coach's side of each scenario as a whole work conversation of the page's own person
 * ("下班后 15 分钟家常菜": TikTok first, Instagram Reels and YouTube Shorts alongside). Round seven (T11, Owner 2026-10-17:
 * "这四个模块现在展现出的信息感觉非常'草台班子'……口播稿也太短了吧"), to the plan's content spec: every scenario works
 * first (the read and each fetch, from "正在…" to done, saying what was read and what came back), gives numbers (a table
 * at least), hands over something ready to use, and ends with "接下来你做" on a named day. Every figure is an example
 * (the window carries 示意). The numbers agree across scenarios (the 冰箱剩菜 video: 1,870 plays, 28% watched to the
 * end, 64 saves = 3.4%). All lines are NEW. Reading one's own published data is the publishing and monitoring
 * feature (not built yet, Owner: "在预览里直接按这样去演示"); the voice profile is VOICE (not built yet).
 */
export type WorkflowCall = {
  query: string; dataKind: 'keyword_posts' | 'account_posts' | 'post_detail'; toolName: string;
  /** What came back, said once the call is done (round seven, T11: "每条都写清读了什么、取到什么"). */
  found?: string;
};
export type WorkflowTurn = {
  user: string;
  /** What the coach read before answering (the status line under its name). */
  read?: readonly string[];
  /** The status line's words while reading and once read; the library's by default. */
  readLabel?: readonly [string, string];
  /** What it fetched, in order. */
  calls?: readonly WorkflowCall[];
  reply: string;
  /** A draft in the product's 建议稿 block (the script). */
  proposal?: string;
};

const OWN = 'social_account';
const BENCH = 'benchmark_fetch';
const DISCOVER = 'benchmark_discover';

/**
 * The script of the 写稿 scenario (the plan's text, about 300 characters, in the person's own spoken voice), and its
 * storyboard: every shot's line, joined, is the whole script.
 */
export const SCRIPT = '哎，周四了，冰箱里就剩半颗白菜、三个鸡蛋、一碗早上没吃完的米饭，外卖一看又三十多刀，算了，自己整。今天一口锅，十五分钟，剩菜变三道菜，看好了啊。\n\n'
  + '第一道，白菜别切，直接手撕，锅烧热，蒜末爆香，白菜下锅大火翻，淋一圈生抽，一分钟出锅，脆的。\n\n'
  + '第二道，剩饭。锅不用刷，打两个鸡蛋，蛋液先倒一半，饭倒进去压散，再把剩下的蛋液浇上，翻匀，撒点葱花，黄金蛋炒饭就有了。\n\n'
  + '第三道，白菜根别扔，加一碗水煮开，打一个蛋花，一点盐一点胡椒，汤就有了。\n\n'
  + '你看，半颗白菜、三个蛋、一碗饭，三道菜，前后十四分钟，就洗一个锅。\n\n'
  + '冰箱里还剩啥，评论区告诉我，下周我挑一个帮你整。';

/** Shot, framing, picture, line, seconds. */
export const SHOTS: readonly (readonly [number, string, string, string, number])[] = [
  [1, '近景', '三道成品摆一排，计时器停在 14:00', '哎，周四了，冰箱里就剩半颗白菜、三个鸡蛋、一碗早上没吃完的米饭，', 7],
  [2, '特写', '手机外卖页面，价格 $32', '外卖一看又三十多刀，算了，自己整。', 4],
  [3, '中景', '打开冰箱，拿出白菜、鸡蛋、剩饭', '今天一口锅，十五分钟，剩菜变三道菜，看好了啊。', 5],
  [4, '特写', '手撕白菜，蒜末下锅', '第一道，白菜别切，直接手撕，锅烧热，蒜末爆香，', 6],
  [5, '近景', '大火翻炒，淋生抽，出锅', '白菜下锅大火翻，淋一圈生抽，一分钟出锅，脆的。', 6],
  [6, '特写', '不刷锅，打两个蛋，蛋液先倒一半', '第二道，剩饭。锅不用刷，打两个鸡蛋，蛋液先倒一半，', 6],
  [7, '近景', '米饭压散，浇上剩下的蛋液，撒葱花', '饭倒进去压散，再把剩下的蛋液浇上，翻匀，撒点葱花，黄金蛋炒饭就有了。', 8],
  [8, '特写', '白菜根下锅加水，打蛋花', '第三道，白菜根别扔，加一碗水煮开，打一个蛋花，一点盐一点胡椒，汤就有了。', 8],
  [9, '俯拍', '三道菜摆好，旁边只有一口锅', '你看，半颗白菜、三个蛋、一碗饭，三道菜，前后十四分钟，就洗一个锅。', 8],
  [10, '近景', '端起蛋炒饭吃第一口，字幕"冰箱里还剩啥？"', '冰箱里还剩啥，评论区告诉我，下周我挑一个帮你整。', 6],
];

/** By the task's index in L_TASKS: 定位, 这周拍什么, 写稿, 这条为什么没火. */
export const L_WORKFLOWS: readonly (readonly WorkflowTurn[])[] = [
  [
    {
      user: '我想做美食号，该怎么定位？',
      read: ['你的账号信息', '你填写的情况'],
      readLabel: ['正在读取', '已读取'],
      calls: [{ query: 'TikTok 同类账号：下班做饭、一人食、家常快手菜', dataKind: 'keyword_posts', toolName: DISCOVER, found: '找到 7 个，计入 5 个' }],
      reply: '看了你的情况，也找了 TikTok 上的同类账号（数据为示意）。做饭号常见三个方向：\n\n'
        + '| 方向 | 谁在看 | 竞争多不多 | 怎么赚钱 | 适合你吗 |\n|---|---|---|---|---|\n'
        + '| 中式家常快手菜 | 想学做饭的大多数人 | 多，大号占着 | 带货、接广告 | 能做，但很难冒头 |\n'
        + '| 一人食 | 一个人住的年轻人 | 不少，偏精致摆拍 | 餐具、小家电带货 | 拍法和你的条件不太合 |\n'
        + '| 下班后 15 分钟的一人份家常菜 | 下班晚、一个人吃饭的上班族 | 少，这个交叉位置还空着 | 厨具、调料、食材带货，之后卖菜单 | 最适合 |\n\n'
        + '**我推荐第三个**：你本人就是这群人，每条的"15 分钟"都能被验证；前两个方向各有大号占着，两者交叉的位置还空着。\n\n'
        + '定下来之前先问你一件事：**你做这个账号，最想得到什么**？记录生活、每月多点零花钱，还是慢慢做成主业？',
    },
    {
      user: '副业收入，每月多几百美元就行。',
      reply: '好，那就这样定：\n\n**一句话定位**：下班后 15 分钟上桌的家常菜，给刚开始一个人生活的上班族。\n\n'
        + '**账号三件套（草稿，三个平台通用）**\n'
        + '- 名字：下班后 15 分钟家常菜\n'
        + '- 简介：一个人住的上班族｜下班 15 分钟，一口锅吃好一顿｜每周二、四、六更新\n'
        + '- 头像：一口锅的特写，不用露脸，和你的视频画面一致\n\n'
        + '起步先走厨具和调料带货，门槛最低、和做饭最贴。\n\n'
        + '**接下来你做**：今晚把 TikTok、Instagram、YouTube 三个平台的名字和简介改好，明天拍第一条。',
    },
  ],
  [
    {
      user: '这周拍什么？',
      read: ['《定位报告》', '《我的说话习惯》'],
      calls: [
        { query: '我的账号 · 上周发布的 3 条', dataKind: 'account_posts', toolName: OWN, found: '取到播放、完播率、收藏、新增关注' },
        { query: '对标账号 A–E · 近 7 天热门', dataKind: 'account_posts', toolName: BENCH, found: '取到 8 条，开头都先给成品' },
      ],
      reply: '先看你上周的 3 条（数据为示意）：\n\n'
        + '| 标题 | 播放 | 完播率 | 收藏 | 新增关注 |\n|---|---|---|---|---|\n'
        + '| 一口锅两菜一汤 | 3,240 | 41% | 186 | +37 |\n'
        + '| 番茄炒蛋一人份 | 2,110 | 33% | 71 | +12 |\n'
        + '| 冰箱剩菜三种做法 | 1,870 | 28% | 64 | +9 |\n\n'
        + '开头先给成品的那条（一口锅两菜一汤），收藏是另外两条的 2.6–2.9 倍；对标账号近 7 天的热门，也都是成品先出镜。\n\n'
        + '这周拍这三条：\n\n'
        + '| 选题 | 为什么拍 | 开头怎么拍 | 哪天发 |\n|---|---|---|---|\n'
        + '| 一口锅鸡腿饭配青菜 | 接着上周收藏最多的"一口锅" | 第 1 秒给成品和停在 15:00 的计时器 | 周二 |\n'
        + '| 一个人买菜不浪费：一周清单 | 上周评论里问得最多 | 先甩出清单和小票上的总价 | 周四 |\n'
        + '| 冰箱剩菜三道菜（重拍） | 题目没问题，问题在开头没给成品 | 先上三道成品，再倒回去开冰箱 | 周六 |\n\n'
        + '**接下来你做**：周二拍选题 1，周四拍选题 2，周六重拍"冰箱剩菜"，改成开头先给成品。',
    },
  ],
  [
    {
      user: '帮我写一条口播稿，就是周六要重拍的冰箱剩菜。',
      read: ['《我的说话习惯》（文风画像）', '《冰箱剩菜 · 拍摄笔记》'],
      reply: '按你平时说话的习惯写的：大白话，句子短，先给成品。\n\n'
        + '**标题**：冰箱剩半颗白菜，15 分钟变三道菜\n**封面字**：剩菜 → 三道菜\n\n'
        + '口播稿在下面的建议稿里，分镜是这样拍：\n\n'
        + '| 镜号 | 景别 | 画面 | 口播台词 | 时长 |\n|---|---|---|---|---|\n'
        + SHOTS.map(([n, size, frame, line, seconds]) => `| ${n} | ${size} | ${frame} | ${line} | ${seconds} 秒 |`).join('\n')
        + `\n\n总长约 ${SHOTS.reduce((sum, shot) => sum + shot[4], 0)} 秒，台词连起来就是全文。\n\n`
        + '**接下来你做**：周六拍，拍完把素材传上来，字幕和封面我来配。',
      proposal: SCRIPT,
    },
  ],
  [
    {
      user: '冰箱剩菜那条为什么没火？',
      calls: [
        { query: '我的账号 · 冰箱剩菜那条', dataKind: 'post_detail', toolName: OWN, found: '取到前 3 秒流失、完播、收藏、分享' },
        { query: '我的账号 · 近 30 天平均', dataKind: 'account_posts', toolName: OWN, found: '取到 11 条的平均值' },
        { query: '对标账号 A、C · 同题材热门', dataKind: 'account_posts', toolName: BENCH, found: '取到 6 条，开头都先给成品' },
      ],
      reply: '和你自己近 30 天的平均比（数据为示意）：\n\n'
        + '| 指标 | 这一条 | 你近 30 天平均 |\n|---|---|---|\n'
        + '| 前 3 秒流失 | 58% | 41% |\n| 完播率 | 28% | 37% |\n| 收藏率 | 3.4% | 5.1% |\n| 分享 | 6 | 19 |\n\n'
        + '**问题出在开头**：第一个镜头是打开冰箱，前 3 秒没让人看到成品；标题写的"剩菜"，听起来没胃口。对标账号同题材的热门，都是成品先出镜、标题写结果。\n\n'
        + '**改法**\n'
        + '1. 第一个镜头换成三道成品摆一排，计时器停在 14:00；\n'
        + '2. 标题改成结果："冰箱剩半颗白菜，15 分钟变三道菜"；\n'
        + '3. 打开冰箱挪到第 3 个镜头，当"倒回去"讲。\n\n'
        + '**重拍时开头 3 个镜头**\n\n'
        + '| 镜号 | 画面 | 时长 |\n|---|---|---|\n'
        + '| 1 | 三道成品摆一排，计时器停在 14:00 | 3 秒 |\n'
        + '| 2 | 手机外卖页面，价格 $32 | 2 秒 |\n'
        + '| 3 | 打开冰箱，拿出半颗白菜、鸡蛋、剩饭 | 3 秒 |',
    },
    {
      user: '要不要干脆换个方向？',
      reply: '不用换。你近 30 天的作品里，开头先给成品的那几条，收藏都明显更多。问题在开头，不在方向。\n\n'
        + '**接下来你做**：周六按新开头重拍，下周一我们一起看数据。',
    },
  ],
];
