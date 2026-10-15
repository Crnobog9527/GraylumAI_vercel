/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { OFFICE_WORKER_REPORT } from './sample-reports/office-worker';
import { plainText } from './sample-reports/report-markdown';

/**
 * "AI 教练怎么接手你的运营", round five (Owner 2026-10-15: "先真的去看一下代码或者看一下界面"): the real positioning
 * workbench for the page's example person (J_PERSONA). The product's own steps (了解你 → 诊断与平台对标 → 定位与执行方案)
 * appear once, in the workbench's step strip; each message fills the checklist fields it names (`fills`); a step ends
 * on the product's "本步小结". Then the report is generated from the workbench footer, and the jury is opened from the
 * report. What the current moment shows is said outside the window (`caption`, `note`). NEW WORDING for the Owner to
 * approve, except where marked.
 */
/**
 * Round seven (Owner 2026-10-15; the approved script ~/.graylum/landing/sample-reports/office-worker-cooking/
 * takeover-script.md, part two): every line comes from the real conversation (transcript.md) run with the positioning
 * Skill for this person, cut with "……" but not reworded; one speaker's turns may be joined across a skipped answer.
 * 了解你 8 lines, 诊断与平台对标 7, 定位与执行方案 6; the chat scrolls when they do not fit. Three question cards (goal,
 * on camera, direction); an option clicked is sent as the user's message, as the product does (question-card.tsx).
 * A risk is written inside the coach's message, led by a bold "风险提示" (the product has no separate risk box).
 */
export type TakeoverCard = 'goal' | 'camera' | 'direction' | 'confirm' | 'fetch' | 'table' | 'plan';
export type TakeoverLine = {
  role: 'user' | 'coach' | 'summary'; text: string; card?: TakeoverCard; fills?: readonly string[];
};
export type TakeoverMoment = {
  id: 'know' | 'diagnose' | 'plan' | 'report' | 'jury';
  /** Which product step the strip shows as current; 3 means all three are done (report and jury). */
  step: 0 | 1 | 2 | 3;
  caption: string;
  note: string;
  lines: readonly TakeoverLine[];
};

export const J_TAKEOVER_MOMENTS: readonly TakeoverMoment[] = [
  {
    id: 'know', step: 0, caption: '帮你挖掘定位',
    note: '一次只问一个问题，问题下面带例子；是选择题时给推荐选项和理由。你答完，就从你的话接着往下问，再把你没想到的补上。清单跟着对话自动记。',
    lines: [
      { role: 'user', text: '我想做个做饭账号，拍下班后的家常菜。' },
      {
        role: 'coach', card: 'goal',
        text: '好，做饭是个好起点。先不急着定拍什么，我先把你的情况弄清楚，一次只问一个问题。先问第一件：\n\n'
          + '**你做这个账号，最希望它最后给你带来什么？**\n\n'
          + '同样是做饭账号，想记录生活和想赚钱，拍法、选平台、找对标完全不一样。大概有这几种：\n'
          + '- 记录：给自己留个做饭日记，有人看更好；\n- 零花钱：每个月多几百美元，至少把买菜钱赚回来；\n'
          + '- 慢慢做成主业：收入稳定了，考虑不上班；\n- 还没想好，先试试自己能不能坚持。\n\n'
          + '好几个都想要的话，先挑一个你眼下最想要的。都不是也没关系，说说你的真实想法。',
      },
      // The goal card's option, clicked: the product sends the option itself as the user's message.
      { role: 'user', text: '副业收入' },
      {
        role: 'coach', fills: ['goal'],
        text: '明白，目标很实在。收入从哪来，决定了你该吸引什么人。做饭账号常见三条路：带货（推荐你用的锅、调料，别人买了你拿佣金）、'
          + '接广告、卖自己的东西（菜谱、一周菜单）。你现在没有粉丝，接广告要等很久；带货门槛最低、和做饭场景最贴。'
          + '我建议先走厨具和食材带货，先记到右侧「最终想得到什么」，你随时能改。\n\n'
          + '……下一个问题：**你希望谁来看你的内容？能不能想一个你真认识的人？**\n\n'
          + '受众决定变现能力：同样看做饭视频，学生更爱看便宜的，上班族更在意快，带娃的人更在意营养。帮你把人说具体：\n'
          + '- 多大、在哪个城市、做什么工作；\n- 他最头疼的一件事，比如"下班太累不想做""买了菜吃不完坏掉"；\n'
          + '- 他什么时候刷手机：通勤路上、午休、睡前。',
      },
      {
        role: 'user', fills: ['audience'],
        text: '想吸引的就是跟我一样，刚开始一个人住的上班族。比如我自己，今年 6 月刚搬出来一个人住，每天坐火车通勤，7 点到家，'
          + '累得不想做饭，点外卖又贵。还有个问题，买一把青菜一个人三天都吃不完，常常坏掉。',
      },
      {
        role: 'coach', card: 'camera',
        text: '这几句特别有用。"一把青菜三天吃不完"这种细节，就是以后的选题来源，也是你和泛做饭号不一样的地方，我会写进受众分析。\n\n'
          + '这群人最缺的是时间。那你自己：**下班后能留多少时间做饭和拍摄？对出镜有没有顾虑？**\n\n'
          + '我要按你真实能做到的量来排计划，排多了第一周就会放弃。常见几种情况：\n'
          + '- 时间：工作日每晚一小时 / 只有周末半天 / 每天能抽两三小时；\n- 设备：只有手机 / 能花几十美元买支架和补光灯；\n'
          + '- 出镜：完全露脸 / 只露手和声音 / 连声音都不想出。',
      },
      {
        role: 'user', fills: ['resources'],
        text: '只拍手和锅吧，不太想露脸，声音可以。下班后只有一小时，大多数菜 15 分钟能做完。周末不一定有空，有时候要加班或者跟朋友出去。'
          + '设备就一部手机，加一个夹在橱柜上的支架。',
      },
      {
        role: 'summary', card: 'confirm', fills: ['track', 'platforms', 'benchmarks', 'assets'],
        text: '请核对，确认后进入第二步：\n'
          + '- 目标：做副业，不辞职；一年后希望每月多几百美元，起步先走厨具和食材带货（导师建议，可改）。\n'
          + '- 内容：中式家常菜，二十多道，多数 15 分钟上桌。\n'
          + '- 想吸引：刚开始一个人住的上班族——下班晚、累、外卖贵、一人份食材吃不完。\n'
          + '- 资源：工作日每晚约 1 小时，周末不固定；不露脸，可出声；手机 + 支架。\n'
          + '- 平台：常刷 TikTok、Instagram；不做需要另剪的长视频。\n- 对标：没有，由我找。\n- 条件：快；朋友常问做法。\n'
          + '- 我补的一条：拍摄会让做饭时间翻倍，先按每周两条排。',
      },
    ],
  },
  {
    id: 'diagnose', step: 1, caption: '诊断与平台对标',
    note: '先直说这条路能不能赚钱、难在哪；你想换方向时直接说"不建议"，把理由一条条讲清，并提示风险，方向由你决定。再按三类找对标，用真实公开数据看差距。',
    lines: [
      { role: 'user', text: '对了，我其实更想拍周末的精致大餐，看起来更高级。工作日那种家常菜感觉太普通了。' },
      {
        role: 'coach', card: 'direction',
        text: '我理解，精致大餐拍出来确实好看。但我不建议把精致大餐当主线，理由有三：\n'
          + '1. 做的人多，不少是专业团队，打光、摆盘、餐具都比你精，你一个人用手机很难拍赢；\n'
          + '2. 一条要大半天，下班后的一小时做不完，只能靠周末，可你刚才说周末不一定有空；\n'
          + '3. 观众爱收藏，但很少真的照着做——看的人多，不等于会买你推荐的锅和调料。\n\n'
          + '**风险提示**：如果坚持做精致大餐，单条耗时长，下班后很难稳定更新，容易断更。新账号断更，平台和观众都会忘了你。\n\n'
          + '反过来，"太普通"恰恰是你的机会：刚一个人住的上班族要的就是普通、快、照着能做。',
      },
      // The direction card's option, clicked.
      { role: 'user', text: '主线做下班后 15 分钟家常菜' },
      {
        role: 'coach', fills: ['feasibility', 'platform_choice'],
        text: '好。接下来我直接说判断：**这条路可行，但难在两处。**\n'
          + '- 可行：做饭是高频刚需，锅具、调料、食材都有现成的联盟带货和品牌合作。\n'
          + '- 难点一：做饭赛道很挤，"快手菜""easy dinner"满屏都是，只说"快"不够，要说清"给谁快、快在哪"。\n'
          + '- 难点二：带货要信任和一定的数据基础，新号前几个月不会有收入，这段时间只能靠你坚持。\n'
          + '- 降难度：把人群收窄到"刚开始一个人住的上班族"，卖点落到"一人份、15 分钟、不剩菜"，第一个月只测内容，不急着变现。\n\n'
          + '……平台我的建议：\n'
          + '- **TikTok 当主平台**：新号的视频会先推给一小批人试看，看完的人多、收藏多，才推给更多人。你的视频短、结果直观，适合这种推法。\n'
          + '- **Instagram Reels 同步发**：同一条视频直接发，不另做。\n'
          + '- **YouTube 只放 Shorts，再把几条短视频拼成一条"一周晚饭合集"**：不单独拍，剪映里拼接就行。YouTube 是很多人搜菜谱的地方，合集能被搜到很久。',
      },
      {
        role: 'coach', card: 'fetch',
        // The last sentence is the OWNER's (2026-10-14), verbatim.
        text: '最后是对标。对标分三类找，每类学的东西不一样：\n'
          + '- **同路人**：同样下班后做饭的上班族账号——看怎么把"省时间"讲得有说服力；\n'
          + '- **同观众**：一人食、一人份做饭类账号——看这群人关心什么、在评论里问什么；\n'
          + '- **同品类**：快手菜、中式家常菜账号——看怎么把步骤拍清楚、讲简单。\n\n'
          + 'AI 教练通过数据接口，直接抓取对标账号在社交媒体平台上的真实公开数据。',
      },
      {
        role: 'coach', card: 'table', fills: ['benchmark_findings'],
        text: '数据已经填进表格，查不到的写"未取到"。我只算粉丝在 1 万到 20 万之间、最近半年还在更新的账号：5 个合格，2 个只作参考。\n\n'
          + '……同路人类最值得学的是"先给成品再讲步骤"的开头，以及把系列名固定下来；同品类里，标题里写时间的视频表现最突出；'
          + '同观众里，对标账号 B 专讲"一人份、不剩菜"，正好接上你说的"青菜三天吃不完"。\n\n'
          + '还有一个空位：这次看到的账号里，没有人同时占住"中式家常菜 + 一人份 + 下班 15 分钟"三点。这是推断，样本有限，但值得你去占。\n\n'
          + '数据来自网络公开信息，观察日期 2026-10-15，真实性待考证，仅供参考。',
      },
      {
        role: 'summary', card: 'confirm',
        text: '请核对：\n- 可行性：可行但难；难在赛道挤、带货要信任；用"一人份 + 15 分钟 + 中式家常"收窄。\n'
          + '- 方向：主线做下班后 15 分钟家常菜。\n- 平台：TikTok 主，Instagram Reels 同步；YouTube 只放 Shorts 和合集，不另拍。\n'
          + '- 对标：5 个合格（A–E），2 个参考。',
      },
    ],
  },
  {
    id: 'plan', step: 2, caption: '定位与执行方案',
    note: '把前两步的结论收成一句话定位，再落到第一个月具体怎么做：每周发几条、发什么、什么时候复盘。',
    lines: [
      {
        role: 'coach', fills: ['positioning'],
        text: '把前两步收成一句话定位：**下班后 15 分钟上桌的家常菜，给刚开始一个人生活的上班族。**\n\n'
          + '展开一点：给刚一个人住、下班晚又累的上班族，用一口锅、一人份、15 分钟的中式家常菜，让他们不靠外卖也能好好吃饭；先靠厨具和食材带货变现。\n\n'
          + '为什么是你：①你本人就是目标人群（6 月刚开始一个人住）；②"15 分钟"每条都能被验证；③中式家常 × 一人份 × 下班，样本里没人同时占住。',
      },
      { role: 'user', text: '可以，就这个。' },
      {
        role: 'coach', card: 'plan', fills: ['profile_kit', 'first_month'],
        text: '账号三件套我先给推荐版：\n'
          + '- 名字：**下班后 15 分钟家常菜**（名字就是卖点，搜"快手菜""下班做饭"的人一眼看懂）；\n'
          + '- 简介：一个人也好好吃饭｜下班后 15 分钟上桌；\n- 头像：一口锅的特写（不露脸也认得出，和内容一致）。\n\n'
          + '……下面是第一个月的执行方案。第一个月是测试期：测哪类题有人收藏、有人问，流量不是第一指标，数据平淡很正常。',
      },
      { role: 'user', text: '每周两条我做得到。不过周日复盘要多久？周末我不一定在家。' },
      {
        role: 'coach', fills: ['offer'],
        text: '二十分钟，手机上看就行，不一定在家；哪天有空就哪天看，固定在周日只是提醒。\n\n'
          + '……最后是变现路径：\n'
          + '- 先：用免费内容攒信任，视频里顺带推荐你真在用的锅和调料；开通带货前查清平台规则。\n'
          + '- 再：整理"一周菜单"——一次买菜、三顿用完，正好解决"青菜吃不完"。\n'
          + '- 之后：把常做的菜整理成一人食菜谱合集。\n\n'
          + '**风险提示**：只推荐自己用过的，不然会伤信任；各平台开通带货有门槛，开通前先查规则。这是根据你的定位做的判断和建议，不代表收入承诺。',
      },
      { role: 'summary', card: 'confirm', text: '三步都齐了。确认后就可以生成完整报告，里面会把每一部分展开写。' },
    ],
  },
  {
    id: 'report', step: 3, caption: '生成完整运营策略报告',
    note: '三步都确认后，在工作台底部生成完整报告：十三章加一句话结论，全文约九千五百字，根据你确认过的全部信息来写，边写边显示。',
    lines: [],
  },
  {
    id: 'jury', step: 3, caption: '报告生成 → 开启评审团（Gold）',
    note: '报告写好后，Gold 会员可以在报告里开启评审团：几位评审各自审一遍，有分歧的地方辩论，再裁决、写出修订稿，逐章告诉你改了什么。',
    lines: [],
  },
];

/** The benchmark table: which columns the program fills. Cells show only whether a value was fetched (no numbers). */
export const J_BENCHMARK_TABLE = {
  title: '对标账号（示例）',
  columns: ['账号', '播放中位数', '互动率', '更新频率'],
  /** The real comparison table's accounts (A–E qualify; G is reference only and could not be fetched in full). */
  rows: [
    ['同路人 · 账号 A', '已取到', '已取到', '已取到'],
    ['同观众 · 账号 B', '已取到', '已取到', '已取到'],
    ['同观众 · 账号 C', '已取到', '已取到', '已取到'],
    ['同品类 · 账号 D', '已取到', '已取到', '已取到'],
    ['同品类 · 账号 E', '已取到', '已取到', '已取到'],
    ['参考 · 账号 G（不计入）', '已取到', '未取到', '已取到'],
  ],
} as const;

/** The first month's plan in the 定位与执行方案 step. */
export const J_PLAN_ROWS: readonly (readonly [string, string])[] = [
  ['每周发几条', '两条，放在周二和周四下班后'],
  ['发什么', '一口锅系列、冰箱剩菜、超市半成品改造，轮着来'],
  ['怎么拍', '只拍手和锅；开头先给成品，再倒回去讲步骤'],
  ['什么时候复盘', '每周日看一次数据，按复盘调下周选题'],
];

/**
 * The report as the product shows it: title, intro and button are report-gen.ts's words, verbatim; the chapter list
 * is the real report's (13 numbered chapters plus 一句话结论, about 11,000 characters; paywall v25 and REPORT_GEN_PLAN).
 * The text under each chapter is this person's made-up example.
 */
export const J_REPORT = {
  title: '完整运营策略报告',
  intro: '所有步骤都已确认。AI 教练会根据你确认的全部信息写一份完整报告，边写边显示。',
  generate: '生成完整报告',
  export: '导出已确认资料',
  /** The real original: about 9,500 characters without spaces (sample-reports meta). */
  size: '13 章 + 一句话结论 · 全文约 9,500 字',
  /** The real original report of this person (sample-reports/office-worker.ts), chapter by chapter, as Markdown. */
  chapters: OFFICE_WORKER_REPORT.original.map(chapter => ({ title: chapter.title, body: chapter.markdown })),
  juryEntry: '开启评审团',
  juryTag: 'Gold',
} as const;

/**
 * What the jury's revision changed (the real review of 2026-10-15: review.md and report-revised.md). Six chapters
 * changed in substance: 三 受众, 四 平台选择, 六 账号定位, 八 内容规划, 十 变现路径, 十二 见效时间; the original and the
 * revised text are the reports' own, as plain prose for the result page.
 */
/** NEW: the result page's name for screen readers. */
export const J_JURY_RESULT_LABEL = '评审完成后的结果页';

const SUBSTANTIVE = ['3 受众', '4 平台选择', '6 账号定位', '8 内容规划', '10 变现路径', '12 见效时间'] as const;
const markdownOf = (list: readonly { title: string; markdown: string }[], title: string) =>
  list.find(chapter => chapter.title === title)?.markdown ?? '';

export const J_REVISION = {
  changes: SUBSTANTIVE.map(chapter => ({
    chapter,
    original: plainText(markdownOf(OFFICE_WORKER_REPORT.original, chapter)),
    revised: plainText(markdownOf(OFFICE_WORKER_REPORT.revised, chapter)),
  })),
};
