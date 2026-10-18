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
  /** Where it searched (TikTok unless said). */
  platform?: 'tiktok' | 'xiaohongshu';
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
  /** What the coach adds after the draft (round eight, U10: why it is written so, then what to do next). */
  after?: string;
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

/** By the task's index in L_TASKS: 加做小红书, 这周拍什么, 写稿, 这条为什么没火. */
export const L_WORKFLOWS: readonly (readonly WorkflowTurn[])[] = [
  [
    {
      // Round eight (U7): the page's person adds 小红书 to TikTok; the positioning stays, the content and how people find it change.
      user: '我在 TikTok 做了两个月，想把小红书也做起来，该怎么弄？',
      read: ['《我的定位报告》', '《TikTok 近 30 天数据》'],
      calls: [
        { query: '小红书同类笔记：一人食、下班快手菜、北美做饭', dataKind: 'keyword_posts', toolName: DISCOVER, platform: 'xiaohongshu',
          found: '找到 9 个账号，计入 5 个' },
        { query: '你 TikTok 收藏最高的 3 条 × 小红书同题热门笔记', dataKind: 'post_detail', toolName: BENCH, platform: 'xiaohongshu',
          found: '已对比：小红书收藏多的是能照做的清单和一周菜单图文' },
      ],
      reply: '先说结论：**定位不用变**，还是"下班后 15 分钟的一人份家常菜"；要变的是内容的样子，和别人找到你的方式（数据为示意）：\n\n'
        + '| | TikTok（你现在） | 小红书（要适配的） |\n|---|---|---|\n'
        + '| 别人怎么找到你 | 推荐流刷到 | 一半靠搜索（"一人食""下班吃什么"），一半靠推荐 |\n'
        + '| 先看什么 | 开头的画面 | 封面大字 + 标题里的关键词 |\n'
        + '| 什么内容收藏多 | 成品先出镜的过程视频 | 能直接照做的清单、一周菜单图文 |\n'
        + '| 谁在看 | 北美上班族，中英都有 | 北美华人为主，留学生、新移民多 |\n'
        + '| 怎么留住人 | 关注、看下一条 | 收藏、评论区问"在哪买" |\n\n'
        + '**怎么适配**\n'
        + '1. 每条 TikTok 视频在小红书发两份：原视频（加中文封面大字）＋ 一篇图文笔记（成品图 + 步骤 + 购物清单）；\n'
        + '2. 标题写搜索词："下班 15 分钟一人食｜一口锅两菜一汤"；\n'
        + '3. 简介加一句"每周日发一周菜单"，把"免费一周菜单"放到小红书置顶笔记；\n'
        + '4. 前 4 周每周 3 篇，先测图文和视频哪种收藏多。\n\n'
        + '第一篇笔记我写好了，在下面的建议稿里。',
      // Round eight (U10, Owner 2026-10-18): the plan's note, copied as given (steps 4 + 3 + 4 + 4 = 15 minutes).
      proposal: '**标题（推荐）**：7点到家15分钟两菜一汤，只洗1口锅\n\n'
        + '**备选标题**\n- 北美独居第3个月，我终于不点外卖了\n- 外卖30刀 vs 自己做6刀，15分钟搞定\n\n'
        + '**封面大字**：15分钟 两菜一汤（下方小字：只洗 1 口锅）\n\n'
        + '**正文**\n\n'
        + '在北美一个人住，最怕的不是做饭，是做完还要洗一池子锅😮‍💨\n'
        + '外卖一单三十多刀，自己做又嫌麻烦——这顿我掐着表做，15 分钟，两菜一汤，最后只洗了 1 口锅。\n\n'
        + '🛒 材料（一人份，约 $6）：青菜一把｜番茄 2 个｜鸡蛋 2 个｜早上剩的米饭\n\n'
        + '⏱ 顺序别乱，省时间全靠它：\n'
        + '1️⃣ 0–4 分钟：先热饭，同时洗菜、切番茄\n'
        + '2️⃣ 4–7 分钟：大火炒青菜，盛出，锅不刷\n'
        + '3️⃣ 7–11 分钟：用底油炒番茄鸡蛋，盛一半当菜\n'
        + '4️⃣ 11–15 分钟：锅里剩下的加水煮开，就是番茄蛋汤\n\n'
        + '💡 诀窍：一口锅按"先素后荤、先炒后汤"走，上一道的底油就是下一道的味道。\n\n'
        + '想要我这周的一人份采购清单 + 5 顿菜单，评论区扣「菜单」，我挨个发你📩\n\n'
        + '**标签**：#一人食 #下班吃什么 #北美生活 #快手菜 #留学生做饭',
      after: '**为什么这么写**\n'
        + '1. 标题：时间对比（7点到家→15分钟）加一个意外的好处（只洗 1 口锅），比"一人食教程"更想点。\n'
        + '2. 开头：先戳痛点"做完还要洗一池子锅"，再给结果，3 行内让人决定看下去。\n'
        + '3. 中间：材料带价格、步骤带时间，看完就能照做，这是让人收藏的理由。\n'
        + '4. 结尾：评论区扣「菜单」领一周菜单，把看的人变成能联系上的人，接上报告里"免费一周菜单"那一层。\n\n'
        + '**接下来你做**：这周日把"一口锅两菜一汤"那条改成图文发出去，下周一我们一起看收藏和搜索进来的比例。',
    },
  ],
  [
    {
      user: '这周拍什么？',
      read: ['《定位报告》', '《我的说话习惯》'],
      calls: [
        { query: '我的 TikTok 企业号 · 上周 3 条', dataKind: 'account_posts', toolName: OWN, found: '已读取你的 TikTok 企业号数据：上周 3 条' },
        { query: '对标账号 A–E · 近 7 天热门', dataKind: 'account_posts', toolName: BENCH, found: '取到 8 条，开头都先给成品' },
      ],
      // Round twelve (D1, Owner 2026-10-18: "一定要先从'率'这种指标出发"): only what the TikTok business account gives;
      // every rate is that count over the views. The figures are the page's one set (示意).
      reply: '先看你上周的 3 条（TikTok 企业号数据，示意）：\n\n'
        + '| 标题 | 平均观看占时长 | 完播率 | 评论率 | 收藏率 | 关注率 |\n|---|---|---|---|---|---|\n'
        + '| 一口锅两菜一汤 | 50% | 41% | 0.9% | 5.7% | 1.1% |\n'
        + '| 番茄炒蛋一人份 | 42% | 33% | 0.6% | 3.4% | 0.6% |\n'
        + '| 冰箱剩菜三种做法 | 26% | 28% | 1.4% | 3.4% | 0.5% |\n'
        + '| 你近 30 天平均 | 43% | 37% | 0.8% | 5.1% | 0.9% |\n\n'
        + '**从这几个率看出来的**\n'
        + '1. 一口锅平均观看 31 秒、占时长一半，完播 41%，三条里最高：开头先给成品、节奏紧，人留下来看完了。→ 以后每条开头先给成品。\n'
        + '2. 一口锅收藏率 5.7%，约是另外两条（3.4%）的 1.7 倍：步骤能照着做，观众存下来下次用。→ 继续做"能照着做的一顿饭"，不做单个菜。\n'
        + '3. 一口锅关注率 1.1%、主页访问率 2.6% 也最高：看完的人想看更多。→ 这类是涨粉内容，做成系列。\n'
        + '4. 冰箱剩菜评论率最高（1.4%），但平均只看了 17 秒（不到时长的三成），完播 28%：大家对剩菜有话说，选题是对的；人在前面就走了，开头是打开冰箱、没给结果。→ 周六重拍，开头先放三道成品。\n'
        + '5. 番茄炒蛋各项都在平均附近：单个菜吸引力不够。→ 不再单独拍。\n\n'
        + '这周拍这三条：\n\n'
        + '| 选题 | 为什么拍 | 开头怎么拍 | 哪天发 |\n|---|---|---|---|\n'
        + '| 一口锅鸡腿饭配青菜 | 一口锅收藏率 5.7%、关注率 1.1%，能照着做的一顿饭最受欢迎 | 第 1 秒给成品和停在 15:00 的计时器 | 周二 |\n'
        + '| 一个人买菜不浪费：一周清单 | 冰箱剩菜评论率 1.4%，大家对"不浪费"最有话说 | 先甩出清单和小票上的总价 | 周四 |\n'
        + '| 冰箱剩菜三道菜（重拍） | 评论率最高，选题没问题；平均只看了 26%，问题在开头 | 先上三道成品，再倒回去开冰箱 | 周六 |\n\n'
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
        { query: '我的 TikTok 企业号 · 冰箱剩菜那条', dataKind: 'post_detail', toolName: OWN, found: '已读取你的 TikTok 企业号数据：这一条、近 30 天平均' },
        { query: '对标账号 A、C · 同题材热门', dataKind: 'account_posts', toolName: BENCH, found: '取到 6 条，开头都先给成品' },
      ],
      // Round twelve (D2): the rates the TikTok business account gives, each with what it says.
      reply: '和你自己近 30 天的平均比（TikTok 企业号数据，示意）：\n\n'
        + '| 指标 | 这一条 | 你近 30 天平均 | 说明 |\n|---|---|---|---|\n'
        + '| 平均观看时长 | 17 秒（视频 66 秒） | 25 秒（平均 58 秒） | 大部分人在前面就划走了 |\n'
        + '| 平均观看占时长 | 26% | 43% | 只看了不到三成 |\n'
        + '| 完播率 | 28% | 37% | 看完的人少 |\n'
        + '| 点赞率 | 4.2% | 5.6% | 偏低 |\n'
        + '| 评论率 | 1.4% | 0.8% | 高于平均：大家对这个话题有话说 |\n'
        + '| 收藏率 | 3.4% | 5.1% | 步骤没讲成清单，不值得存 |\n'
        + '| 分享率 | 0.3% | 0.9% | 不值得转给别人 |\n'
        + '| 关注率 | 0.5% | 0.9% | 没把人留下来 |\n\n'
        + '**问题出在开头**：平均只看了 17 秒，不到时长的三成，完播 28%，都低于你的平均。第一个镜头是打开冰箱，没先给成品，人在前面就划走了；标题写的"剩菜"，听起来也没胃口。\n\n'
        + '**选题没问题**：评论率 1.4%，比你的平均高，大家对剩菜这件事有话说。\n\n'
        + '**收藏和分享偏低**：收藏率 3.4%、分享率 0.3%，步骤没做成能照着做的清单，不值得存，也不值得转给别人。对标账号同题材的热门，都是成品先出镜、标题写结果。\n\n'
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
