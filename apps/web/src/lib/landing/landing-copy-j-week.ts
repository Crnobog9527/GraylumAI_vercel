/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/**
 * Sample J's first-screen window (Owner 2026-10-15, round two): one week with the AI coach for the page's example
 * person (J_PERSONA), as one conversation where the coach drives — it asks, proposes, waits for a yes, then moves on.
 * Five stages; the review shows the Owner's four parts in order (fetch each platform's data, the week's trend, each
 * platform's key measures, the conclusion and next week). No figures: trends are 上升 / 下降 / 持平 and a line with no
 * scale. NEW WORDING for the Owner to approve.
 */
export type WeekCard = 'confirm' | 'topics' | 'draft' | 'publish' | 'fetch' | 'trend' | 'platforms';
export type WeekLine = { stage: number; role: 'user' | 'coach'; text: string; card?: WeekCard };

export const J_WEEK = {
  label: '示例：AI 教练陪一位上班族走完一周（帮你挖掘定位、选题、创作、发布、复盘）',
  /** NEW (Owner 2026-10-15, round six): the five labels are buttons; this names the group for screen readers. */
  pickLabel: '点一个模块，从头看 AI 教练怎么做',
  title: '下班后 15 分钟家常菜 · 第一周',
  /** "帮你挖掘定位" is the landing page's name for the product step 你是谁 (Owner 2026-10-15). */
  stages: ['帮你挖掘定位', '选题', '创作', '发布', '复盘'],
  lines: [
    { stage: 0, role: 'user', text: '我想做个做饭账号，拍下班后的家常菜。' },
    { stage: 0, role: 'coach', text: '先问清楚为什么想做：是想记录生活，还是希望它慢慢变成一份副业收入？' },
    { stage: 0, role: 'user', text: '想有点副业收入，但每天下班只有一小时。' },
    { stage: 0, role: 'coach', text: '那这一小时要同时够做饭和拍。你做一道菜一般要多久？对出镜有没有顾虑？' },
    { stage: 0, role: 'user', text: '多数 15 分钟能做完。我不太想露脸。' },
    {
      stage: 0, role: 'coach', card: 'confirm',
      text: '"下班后 15 分钟上桌"就是你的卖点。不露脸也行，只拍手和锅。我再补两件你没提的：拍摄会让做饭时间翻倍，所以先每周两条；变现先走厨具和食材，不靠等广告。请核对：',
    },
    { stage: 1, role: 'coach', card: 'topics', text: '定位确认了。我按定位排了下周三条选题，你看行不行：' },
    { stage: 1, role: 'user', text: '第三条周日备菜，我周末不一定有空。' },
    { stage: 1, role: 'coach', text: '那换成"冰箱剩菜三种做法"，同样 15 分钟内，还能顺手带出一口好用的锅。确认就排进日程？' },
    { stage: 1, role: 'user', text: '可以，就这三条。' },
    { stage: 2, role: 'coach', card: 'draft', text: '第一条的口播稿写好了，按你说话的习惯，句子短：' },
    { stage: 2, role: 'coach', text: '开头我建议先给出锅的成品镜头，再倒回去讲步骤，刷到的人更容易停下来。这样拍可以吗？' },
    { stage: 2, role: 'user', text: '好，就这么拍。' },
    { stage: 2, role: 'coach', text: '分镜已改好：成品、备菜、下锅、装盘。你拍完上传，字幕我来配。' },
    { stage: 3, role: 'coach', card: 'publish', text: '素材收到了。三个平台的标题和标签已经分别改好，建议在下班后发。确认就一起发出：' },
    { stage: 3, role: 'user', text: '确认，发吧。' },
    { stage: 3, role: 'coach', text: '已发出，三个平台都记进资料库了。一周后我来给你做复盘。' },
    { stage: 4, role: 'coach', card: 'fetch', text: '一周到了。我先读取你这周在三个平台的账号数据：' },
    { stage: 4, role: 'coach', card: 'trend', text: '整体走势：前半周持平，"冰箱剩菜"那条发出后明显上升。' },
    { stage: 4, role: 'coach', card: 'platforms', text: '再分平台看各自最要紧的指标：' },
    {
      stage: 4, role: 'coach',
      text: '结论："省事"的题最受欢迎；YouTube 开头太长，留不住人。下周多做两条省事菜，YouTube 开头直接给成品。按这个排下周？',
    },
    { stage: 4, role: 'user', text: '按这个排。' },
  ] as readonly WeekLine[],
  confirm: { title: '帮你挖掘定位' },
  topics: {
    items: [
      { title: '一口锅，15 分钟两菜一汤', why: '最能证明"下班后也来得及"' },
      { title: '超市半成品怎么做得像现做', why: '上班族最常买，搜的人多' },
      { title: '周日备菜，工作日更快', why: '收藏型内容，适合涨关注' },
    ],
  },
  draft: {
    title: '口播稿（节选）',
    lines: ['开头：下班到家七点，这顿饭我十五分钟搞定。', '中间：一口锅，先炒菜，再借锅底的油煮汤。', '结尾：你最想学哪道快手菜？留言，下一条就拍它。'],
  },
  publish: {
    platforms: [
      { name: 'TikTok', on: true },
      { name: 'Instagram', on: true },
      { name: 'YouTube', on: true },
      { name: 'Facebook', on: false },
    ],
    action: '确认发出',
    done: '已发出',
  },
  fetch: ['读取 TikTok 数据', '读取 Instagram 数据', '读取 YouTube 数据'],
  trend: '这周的互动走势',
  platforms: {
    columns: ['平台', '看什么', '这周'],
    rows: [
      ['TikTok', '完播、互动', '上升'],
      ['Instagram', '收藏、分享', '收藏上升，分享持平'],
      ['YouTube', '完播', '下降'],
    ],
  },
} as const;
