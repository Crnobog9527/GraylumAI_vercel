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
    // Round nine (V2, Owner 2026-10-18): the creation Skill's order — topic, then title and cover, then the material and
    // the person's voice, then the script and storyboard.
    lede: '定位定下来以后，每周在同一个对话里：\n先选题，再定标题和封面，然后找资料、按你的写作风格写稿、出分镜。',
    stages: [
      { id: 'topics', label: '选题', needs: ['content'], source: 'real',
        note: '按你的定位、上周的数据和对标账号的近况，挑出这周最值得拍的几条，每条写清理由。' },
      { id: 'cover', label: '标题和封面', needs: ['content'], source: 'real',
        note: '围绕选好的题，出 10 个从不同角度吸引人的标题和 10 种封面做法，教练标出推荐和理由；选定的写到右边。' },
      // Round ten (W2, Owner 2026-10-18: "你就写【资料库和写作风格】").
      { id: 'material', label: '资料库和写作风格', needs: ['content', 'library', 'voice'], source: 'planned',
        note: '先在资料库里找这个选题的资料，再加载你的写作风格，稿子按你平时说话的样子写。' },
      { id: 'script', label: '口播稿和分镜', needs: ['content'], source: 'real',
        note: '稿子出现在对话里的"建议稿"，右边是正文稿件和分镜；你改哪句，它就接着改哪句。' },
    ] as readonly LaterStage[],
  },
  three: {
    title: '第三步：帮你建立数据飞轮',
    lede: '拍完以后，发出去、盯数据、每周复盘；复盘的结论，就是下一轮的选题。',
    stages: [
      { id: 'publish', label: '一键发到多个平台', needs: ['publish'], source: 'planned',
        note: '连接你的账号后，一条视频一键分发到 TikTok、YouTube、Instagram 等 9 个主流平台。（暂不支持中国大陆的社交媒体平台）' },
      { id: 'monitor', label: '替你盯数据', needs: ['publish'], source: 'planned',
        note: '一键获取你各个平台账号的数据，告别人工手动收集数据变化。' },
      { id: 'review', label: '每周复盘', needs: ['publish'], source: 'planned',
        note: '每周把这周的作品和你平时的水平比，说清哪条有效、为什么；给出下周三个能直接变成选题的建议。' },
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
  /** Round nine (V2): titles with their hooks and cover ideas for the chosen topic (the plan's lists, copied as given). */
  cover: {
    user: '就拍第 1 条，标题和封面怎么弄？',
    read: ['《我的定位报告》'],
    call: { query: '我的账号 · 上周 3 条的数据', found: '成品先出镜那条收藏最高' },
    titles: [
      ['15 分钟两菜一汤，只洗 1 口锅', '数字 + 意外好处'],
      ['下班累到连外卖都懒得点？试试这个', '戳痛点'],
      ['一口锅做两菜一汤，比等外卖还快', '反常识'],
      ['外卖 30 刀 vs 自己做 6 刀，差在哪', '价格对比'],
      ['一个人住第 3 个月，终于不点外卖了', '身份代入'],
      ['锅底这层油别倒，第三道菜全靠它', '悬念'],
      ['掐表实测：一口锅能不能 15 分钟出三样', '挑战'],
      ['一个人吃饭，这样做一周少花一百多刀', '省钱'],
      ['下班快手菜公式：1 口锅 + 3 样菜 + 15 分钟', '清单 / 收藏'],
      ['你下班第一件事，是点外卖还是做饭？', '提问互动'],
    ] as const,
    covers: [
      ['成品俯拍，大字"15 分钟"', '搜索、收藏'],
      ['计时器停在 14:52，成品在背景里虚化', '证明"真的 15 分钟"'],
      ['左右对比：外卖盒 $30 / 一口锅成品 $6', '价格敏感的人'],
      ['一口锅里三样菜分区摆好', '制造"怎么做到的"好奇'],
      ['冰箱打开前后对比：几样菜变一桌饭', '剩菜、清冰箱人群'],
      ['九宫格步骤缩略图', '想收藏照做的人'],
      ['水槽里只有一口锅，大字"只洗 1 口锅"', '怕洗碗的人'],
      ['第一视角：进门挂钥匙，手表显示 19:00', '上班族代入'],
      ['成品 + 字幕"累死了，但还是想吃口热的"', '情绪共鸣'],
      ['系列固定模板：底部色条"下班 15 分钟 · 第 N 道"', '长期做系列、主页统一'],
    ] as const,
    pick: '**我推荐**：标题用 **#1**，备选 **#6**；封面用 **#2**，长期加上 **#10** 的系列模板。上周开头先给成品的那条收藏最高，'
      + '#1 和 #2 都是"先给结果"；#6 留着测完播率。\n\n**接下来你做**：确认标题和封面后，开始写稿。',
    /** The right column once chosen. */
    chosenLabel: '标题和封面',
    chosenTitle: '15 分钟两菜一汤，只洗 1 口锅',
    chosenBody: '标题：#1 15 分钟两菜一汤，只洗 1 口锅（备选 #6）\n封面：#2 计时器停在 14:52，成品在背景里虚化；长期用 #10 的系列模板',
    chosenLine: '已选 · 标题 #1 · 封面 #2',
  },
  /** Round nine (V2): the library searched and read, the voice profile loaded, in half the room the two stages took. */
  material: {
    user: '标题就用 #1，封面用 #2。',
    search: '一口锅 / 两菜一汤',
    document: '一口锅两菜一汤 · 拍摄笔记.md',
    voice: '《我的说话习惯》（文风画像）',
    reply: '找到你的拍摄笔记，读完了：青菜先炒先盛、锅底的油直接煮汤、米饭用早上剩的，稿子就按这个顺序走。你的文风画像也加载了，下面是要点。',
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
    ] as const,
    compareTitle: '写出来的，和你原来写的放在一起看',
    /**
     * Round ten (W2, Owner 2026-10-18: "应该放另外的内容，比如他日常生活或其他选题的文案"): an older post on another subject, so
     * the side-by-side shows the way of speaking was learned, not an old script on the same dish reused (the plan's text).
     */
    original: { label: '你上个月发的一条（别的话题）', text: '哎周末去了趟超市，本来就想买盒鸡蛋，结果推了一车出来，结账一看九十多刀，咋整。'
      + '回家一样样往冰箱里塞，塞到最后门都关不上了，嘿，这周又得天天对着它们想吃啥了。' },
    draft: { label: '按你的文风写的', text: '哎下班到家都七点了，冰箱里就俩青菜，咋整？一口锅，十五分钟搞定呗。先炒青菜，盛出来；锅底的油别倒啊，加水直接煮汤。嘿，一个人也能吃得挺香。' },
  },
  script: {
    user: '写吧，再给我一个分镜。',
    /**
     * Round ten (W3, Owner 2026-10-18: "不要用'想看的评论区扣 1'这种方式……用什么样的角度去做互动更高情商"): the ending asks
     * what everyone has something to say about, so a reply helps others and may be picked for the next video.
     */
    reply: '按你的文风写好了，约 300 字，念下来七十秒左右。结尾问大家冰箱里最常剩啥、怎么救回来：人人都有话说，说出来能帮到别人，'
      + '还可能被挑中上下一期，比"扣 1"更让人想留言。分镜如下，正文和分镜也同步到右边了：',
    /** Round six (Owner: "尽量给一个 300 字左右完整的口播稿，而且要在我们的聊天框里面展示一个完整的分镜脚本表格"). */
    proposal: '哎，下班到家都七点了，累得不想动，外卖一看又是三十多刀。冰箱里就俩青菜、两个番茄、一盒鸡蛋，咋整？今天就一口锅，十五分钟，两菜一汤，搞定给你看。\n\n'
      + '先把米饭热上，早上剩的就行。锅烧热，倒点油，青菜下锅，大火翻一分钟，加点盐，盛出来。青菜别一次全炒啊，一个人一把刚好，剩下的明天还能煮面。锅别刷，留着底油。\n\n'
      + '番茄挑软一点的，出汁快。切块下锅，炒出汁，鸡蛋打散倒进去，划两下，番茄炒蛋就好了，盛一半出来当菜。\n\n'
      + '剩下那一半直接加水，煮开，撒点葱花，番茄蛋汤就有了。你看，一口锅，一个油底，两菜一汤，前后十五分钟，洗的锅都只有一个。\n\n'
      + '一个人吃，也得好好吃饭。对了，你家冰箱里最常剩的是啥？你都是咋把它救回来的？评论区说说你的独门做法，我挑几个最绝的，下期照着做给大家看。',
    /** 11 shots, 73 seconds in all (round ten: the last one 9); each line is exactly what is said in that shot, so together they are the script. */
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
      ['11', '近景', '一个人开吃，转向镜头', '一个人吃，也得好好吃饭。对了，你家冰箱里最常剩的是啥？你都是咋把它救回来的？评论区说说你的独门做法，我挑几个最绝的，下期照着做给大家看。', '9 秒'],
    ] as const,
    shotHead: ['镜号', '景别', '画面', '口播台词', '时长'] as const,
    total: '合计约 73 秒',
    /** Round nine (V2): the title picked in 标题和封面 (#1). */
    draftTitle: '15 分钟两菜一汤，只洗 1 口锅',
    versionLine: '账号已保存 v1 · 草稿',
    editing: '开头先放成品；字幕只写步骤，不写形容词；第 10 镜的计时器要拍清楚',
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
  /**
   * Round twelve (D3, Owner 2026-10-18): one card per platform, each with only the fields that platform's connection
   * really gives (TikTok business or creator account, Instagram professional account, YouTube), all filled. Rates are
   * the count over the views (TikTok likes 186 / 2,140 = 8.7%, saves 97 / 2,140 = 4.5%; Instagram likes 64 / 860 =
   * 7.4%, saves 41 / 860 = 4.8%; YouTube likes 72 / 1,310 = 5.5%, 1,310 × 26 s ≈ 9.5 hours). Figures NEW, 示意.
   */
  monitor: {
    title: '这条视频的数据',
    updated: '最后更新于 今天 09:00 · 发布后第 3 天',
    connect: '连接 TikTok 企业号或创作者账号、Instagram 专业账号、YouTube 后，这些数据每天自动更新。',
    cards: [
      { platform: 'TikTok', account: '企业号', fields: [['播放', '2,140'], ['平均观看', '29 秒'], ['完播率', '39%'], ['点赞率', '8.7%'],
        ['评论率', '0.8%'], ['收藏率', '4.5%'], ['分享率', '1.1%'], ['新增关注', '+23'], ['主页访问', '54']] },
      { platform: 'Instagram Reels', account: '专业账号', fields: [['播放', '860'], ['覆盖人数', '790'], ['点赞率', '7.4%'], ['评论率', '0.9%'],
        ['收藏率', '4.8%'], ['分享率', '1.3%'], ['新增关注', '+6'], ['主页访问', '21']] },
      { platform: 'YouTube Shorts', account: '', fields: [['播放', '1,310'], ['平均观看', '26 秒'], ['观看总时长', '9.5 小时'], ['点赞率', '5.5%'],
        ['评论率', '0.6%'], ['分享率', '0.8%'], ['新增订阅', '+5']] },
    ],
    insightTitle: 'AI 教练看出来的',
    insights: [
      'TikTok 平均观看 29 秒、完播 39%，开头留住了人。',
      'Instagram 收藏率 4.8%，点赞率比 TikTok 低一点但收藏更高，图文版值得多发。',
      'YouTube 观看总时长 9.5 小时，适合把几条拼成长合集。',
    ],
  },
  review: {
    title: '本周复盘',
    notice: '本周复盘已生成',
    compare: '这周 3 条，和你平时发布第 3 天的数据比：',
    rows: [
      ['一口锅，15 分钟两菜一汤', '收藏是你平时的 2 倍', '有效'],
      ['一个人的菜怎么买不浪费', '和你平时差不多', '一般'],
      ['超市半成品改造', '发布才 1 天', '太新，下周再看'],
    ] as const,
    why: '先给成品的开头留住了人；评论里又有人问"一个人的量怎么买"。',
    nextTitle: '下周三个建议，确认后变成选题：',
    next: ['一口锅系列第 2 期：15 分钟一荤一素', '一个人一周买菜清单（回答评论）', '开头一律先给成品'],
    action: '设为下周选题',
    loop: '复盘的结论，回到第二步，变成下一轮选题。',
  },
} as const;
