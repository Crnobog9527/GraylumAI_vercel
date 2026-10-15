/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { J_PERSONA } from './landing-copy-j-persona';

/**
 * "AI 教练怎么接手你的运营", round five (Owner 2026-10-15: "先真的去看一下代码或者看一下界面"): the real positioning
 * workbench for the page's example person (J_PERSONA). The product's own steps (了解你 → 诊断与平台对标 → 定位与执行方案)
 * appear once, in the workbench's step strip; each message fills the checklist fields it names (`fills`); a step ends
 * on the product's "本步小结". Then the report is generated from the workbench footer, and the jury is opened from the
 * report. What the current moment shows is said outside the window (`caption`, `note`). NEW WORDING for the Owner to
 * approve, except where marked.
 */
/** The bold lead of a risk the coach writes as its own message (the product has no separate risk box). */
export const J_RISK_LABEL = '风险提示';

export type TakeoverCard = 'question' | 'pending' | 'confirm' | 'direction' | 'kinds' | 'fetch' | 'table' | 'plan';
export type TakeoverLine = {
  role: 'user' | 'coach' | 'summary' | 'risk'; text: string; card?: TakeoverCard; fills?: readonly string[];
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
    note: '一次只问一个问题，带推荐选项和理由；你答得笼统，就追问到具体的时间、顾虑和细节，再把你没想到的补上。清单跟着对话自动记。',
    lines: [
      { role: 'user', text: '我想做个做饭账号，拍下班后的家常菜。' },
      {
        role: 'coach', card: 'question',
        text: '先不急着定拍什么。我想先弄清三件事：你最终想从账号得到什么、想吸引谁、能投入多少。先问第一件：',
      },
      { role: 'user', text: '想慢慢有份副业收入。' },
      {
        role: 'coach', fills: ['goal'],
        text: '收入从哪来，决定了你该吸引什么人。做饭账号常见三条路：带货、接广告、卖菜谱。现在没有粉丝，接广告要等很久，我建议先走厨具和食材带货。先记到右侧「最终目标与变现方式」，你随时能改。',
      },
      { role: 'user', text: '想吸引的就是跟我一样，刚开始一个人住的上班族。', fills: ['audience'] },
      { role: 'coach', card: 'pending', text: '这群人最缺的是时间。那你自己：下班后能留多少时间做饭和拍摄？对出镜有没有顾虑？' },
      { role: 'user', text: '下班后只有一小时，大多数菜 15 分钟能做完。不太想露脸。', fills: ['resource'] },
      {
        role: 'summary', card: 'confirm',
        text: '"下班后 15 分钟上桌"就是你的卖点，不露脸只拍手和锅也够。补一件你没提的：拍摄会让做饭时间翻倍，所以先按每周两条来排。',
      },
    ],
  },
  {
    id: 'diagnose', step: 1, caption: '诊断与平台对标',
    note: '直接说"不建议"，把理由一条条讲清，单独提示风险；再按三类找对标，用真实公开数据看差距。最后由你决定。',
    lines: [
      { role: 'user', text: '我其实更想拍周末的精致大餐，看起来更高级。' },
      {
        role: 'coach',
        text: '我不建议把精致大餐当主线，理由有三：\n1. 做的人多，不少是专业团队，拍得比你精；\n2. 一条要大半天，下班后的一小时做不完；\n3. 观众爱收藏，但很少真的照着做。',
      },
      { role: 'risk', text: '如果坚持做精致大餐：单条耗时长，下班后很难稳定更新，容易断更。' },
      { role: 'coach', card: 'direction', text: '主线做下班后 15 分钟家常菜，精致大餐留到节日偶尔做。平台先用短视频起量。你来定：' },
      { role: 'user', text: '那就主线做 15 分钟家常菜。', fills: ['platform'] },
      { role: 'coach', card: 'kinds', text: '对标分三类找，每类学的东西不一样：' },
      // OWNER (2026-10-14), verbatim.
      { role: 'coach', card: 'fetch', text: 'AI 教练通过数据接口，直接抓取对标账号在社交媒体平台上的真实公开数据。' },
      { role: 'summary', card: 'table', fills: ['rival'], text: '数据已经填进表格，查不到的写"未取到"。同路人类最值得学的是"先给成品再讲步骤"的开头。' },
    ],
  },
  {
    id: 'plan', step: 2, caption: '定位与执行方案',
    note: '把前两步的结论收成一句话定位，再落到第一个月具体怎么做：每周发几条、发什么、什么时候复盘。',
    lines: [
      { role: 'coach', text: `一句话定位：${J_PERSONA.values.direction}。下面是第一个月的执行方案：`, card: 'plan', fills: ['plan'] },
      { role: 'user', text: '每周两条我做得到。' },
      { role: 'summary', card: 'confirm', text: '三步都齐了。确认后就可以生成完整报告，里面会把每一部分展开写。' },
    ],
  },
  {
    id: 'report', step: 3, caption: '生成完整运营策略报告',
    note: '三步都确认后，在工作台底部生成完整报告：十三章加一句话结论，约一万一千字，根据你确认过的全部信息来写，边写边显示。',
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
  rows: [
    ['同路人 · 账号 A', '已取到', '已取到', '已取到'],
    ['同路人 · 账号 B', '已取到', '已取到', '已取到'],
    ['同观众 · 账号 C', '已取到', '未取到', '已取到'],
    ['同品类 · 账号 D', '已取到', '已取到', '已取到'],
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
  size: '13 章 + 一句话结论 · 全文约 11,000 字',
  chapters: [
    { title: '一句话结论', body: `${J_PERSONA.values.direction}。先用短视频起量，变现先走厨具和食材带货。` },
    { title: '1 现状盘点', body: '会做二十多道家常菜，多数 15 分钟上桌；每天下班后一小时；不露脸。优势是快，短板是还没有发过内容。' },
    { title: '2 目标和可行性', body: '目标是先做成能长期更新的副业账号。每周两条在一小时内做得到，前两个月以稳定更新为主。' },
    { title: '3 受众', body: '刚开始一个人生活的上班族：下班晚、怕麻烦、不想天天点外卖，最在意"快"和"省事"。' },
    { title: '4 平台选择', body: 'TikTok 和 Instagram 短视频起量；YouTube 放把几条短视频合起来的长视频，留住搜索流量。' },
    { title: '5 对标账号分析', body: '同路人、同观众、同品类三类各看什么、学什么、哪些不要学；数据来自公开接口。' },
    { title: '6 账号定位', body: '下班后 15 分钟上桌的家常菜；人设是"会做饭的同事"，说话直接，不炫技。' },
    { title: '7 账号三件套', body: `名字：${J_PERSONA.account}；简介：一个人也好好吃饭，下班后 15 分钟上桌；头像：一口锅的特写。` },
    { title: '8 内容规划', body: '三条内容线：一口锅系列、冰箱剩菜、超市半成品改造；每条线的选题池和发布节奏。' },
    { title: '9 运营手册', body: '开头怎么拍、标题怎么起、标签怎么选、评论怎么回；每一项都写了做法和理由。' },
    { title: '10 变现路径', body: '先做厨具和食材带货清单，再出一周菜单和备菜指南，之后整理成一人食菜谱合集；每一阶段的门槛和风险。' },
    { title: '11 合规提醒', body: '只推荐自己用过的产品；合作内容明确标注；不做减肥和医疗建议。' },
    { title: '12 见效时间', body: '前两个月重在稳定更新和找准开头；第三个月起再看哪类内容值得加码。' },
    { title: '13 待验证的假设', body: '"省事"比"好吃"更能留住人；不露脸也能建立信任。每周复盘时逐条验证。' },
  ],
  juryEntry: '开启评审团',
  juryTag: 'Gold',
} as const;

/** The report chapter with this numbered title ("3 受众"), as the table of contents shows it. */
const chapter = (title: string) => J_REPORT.chapters.find(item => item.title === title)?.body ?? '';

/**
 * NEW: after the jury, the revised report chapter by chapter. The six chapters are the ones the panel raised (their
 * places mapped onto this report's 13 chapters, see jury-case-j.ts); "改前" is this report's own text.
 */
export const J_REVISION = {
  title: '修订后的定位报告：改了这 6 章',
  before: '改前',
  after: '改后',
  changes: [
    { chapter: '3 受众', original: chapter('3 受众'),
      revised: '刚开始一个人生活的上班族：多在晚上七八点到家，厨房只有单灶和小冰箱，最常因为太累、买菜麻烦、一个人吃不完而放弃做饭。'
        + '以后可以扩展的人群：想控制饮食的健身新手。' },
    { chapter: '4 平台选择', original: chapter('4 平台选择'),
      revised: 'TikTok 和 Instagram 短视频起量；YouTube 放把几条短视频合起来的长视频，留住搜索流量。'
        + '前两个月三个平台发同一条视频，按各自的数据再决定在哪里加重。' },
    { chapter: '6 账号定位', original: chapter('6 账号定位'),
      revised: '下班后 15 分钟上桌的家常菜，快在备菜：周日一次切配，工作日三天复用。人设是"会做饭的同事"，说话直接，不炫技。' },
    { chapter: '8 内容规划', original: chapter('8 内容规划'),
      revised: '三条内容线：一口锅系列、冰箱剩菜、备菜和收纳（换掉超市半成品改造）；每条线的选题池和发布节奏。' },
    { chapter: '10 变现路径', original: chapter('10 变现路径'),
      revised: '第一个月先上线免费的一周菜单，用报名表找到愿意付钱的人；第三个月按报名情况决定要不要出付费的备菜指南。'
        + '带货清单放到第二步。' },
    { chapter: '12 见效时间', original: chapter('12 见效时间'),
      revised: '前两个月每周三更、周末集中拍两条备用，重在稳定更新和找准开头；每周日花二十分钟把评论区的问题排进下周选题。'
        + '第三个月起再看哪类内容值得加码。' },
  ],
};
