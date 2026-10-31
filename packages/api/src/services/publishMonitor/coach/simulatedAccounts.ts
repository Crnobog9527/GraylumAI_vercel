/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/**
 * REVIEW-COACH RC-0: the four simulated accounts behind the long-timespan test dataset. Plain data only, so the
 * designed effects are readable in one place; `simulatedDataset.ts` turns them into posts and daily snapshots.
 * Every number is invented. Days are counted back from the dataset's `asOf` day (0 = asOf).
 */
export type SimSource = 'postforme' | 'tikhub' | 'manual';
export type SimStage = '0_1' | '1_10' | '10_100';
export type SimVerdict = 'worked' | 'failed' | 'inconclusive' | 'not_run';

export type PlatformSpec = {
  platform: string; source: SimSource;
  /** Day the account was connected to Graylum; earlier posts only get one cumulative snapshot on this day. */
  connectedDaysAgo: number;
  /** Median day-7 views of an average post at the start of the timeline. */
  baseViews: number;
  /** (likes + comments + shares) / views of an average post. */
  engagement: number;
  /** Metric keys this platform reports. */
  metrics: string[];
  /** Fields the provider names but leaves empty on every post (listed in missing_fields, never written as zero). */
  missing?: string[];
  /** Account follower count (TikHub profiles only); absent = the platform does not provide it. */
  followers?: { start: number; end: number };
  /** Manual table imports: one snapshot per post every N days instead of a daily refresh. */
  importEveryDays?: number;
};

export type ExperimentSpec = {
  id: string; kind: 'tactic' | 'pillar_mix';
  hypothesis: string; action: string; metric: 'views' | 'engagement_rate'; targetMult: number;
  match: { pillarKey: string; platform?: string; formatTags?: string[] };
  /** The review that proposed it and the observation window, in days before asOf. */
  proposedDaysAgo: number; periodDays: number;
  /** The effect the generator applies to matching posts inside (and, if `persists`, after) the window. */
  effect: number; persists: boolean;
  /** Matching posts the generator writes per week inside the window (overrides the normal pillar draw). */
  postsPerWeek: number;
  expected: { verdict: SimVerdict; reason?: string };
};

export type AccountSpec = {
  key: 'A' | 'B' | 'C' | 'D'; label: string; startDaysAgo: number;
  /** Reach of an average post at asOf relative to the start (audience growth). */
  growth: number;
  platforms: PlatformSpec[];
  pillars: Array<{ key: string; name: string; definition: string; share: number;
    /** Day-7 views multiplier per platform (1 = account average). */
    effect: Record<string, number> }>;
  /** Posts per week per platform, as [daysAgo, rate] steps; the last step with daysAgo >= day applies. */
  cadence: Array<[number, number]>;
  /** Tags carried by ordinary posts of a pillar from a day on (after an experiment the user kept doing). */
  formats: Array<{ tag: string; pillarKey: string; fromDaysAgo: number; share: number }>;
  experiments: ExperimentSpec[];
  /** Days with no snapshots at all for a platform (connection broken, then repaired). */
  outages: Array<{ platform: string; fromDaysAgo: number; toDaysAgo: number }>;
  /** A platform-wide reach change (algorithm shift) affecting every pillar from that day on. */
  shifts: Array<{ platform: string; fromDaysAgo: number; effect: number }>;
  stage: { initial: SimStage; transitions: Array<{ daysAgo: number; to: SimStage; reason: string }> };
};

const TIKHUB = ['views', 'likes', 'comments', 'shares'];

export const SIMULATED_ACCOUNTS: AccountSpec[] = [
  {
    key: 'A', label: '新手小红书+抖音：从 0 到 1，第 5 个月过千粉', startDaysAgo: 210, growth: 2.5,
    platforms: [
      { platform: 'xiaohongshu', source: 'tikhub', connectedDaysAgo: 210, baseViews: 900, engagement: 0.06, metrics: TIKHUB,
        followers: { start: 120, end: 1650 } },
      { platform: 'douyin', source: 'tikhub', connectedDaysAgo: 210, baseViews: 1500, engagement: 0.04, metrics: TIKHUB,
        followers: { start: 60, end: 1400 } },
    ],
    pillars: [
      { key: 'p1', name: '干货教程', definition: '一条讲清一个具体做法', share: 0.4, effect: { xiaohongshu: 2.2, douyin: 2.2 } },
      { key: 'p2', name: '日常记录', definition: '工作和生活片段', share: 0.4, effect: { xiaohongshu: 1, douyin: 1 } },
      { key: 'p3', name: '粉丝答疑', definition: '回答评论区的问题', share: 0.2, effect: { xiaohongshu: 1.3, douyin: 1.2 } },
    ],
    cadence: [[210, 2], [150, 3], [90, 5]],
    formats: [{ tag: '结论先行', pillarKey: 'p1', fromDaysAgo: 70, share: 0.5 }],
    experiments: [
      { id: 'A-E1', kind: 'tactic', hypothesis: '干货教程开头先给结论，前 3 秒留住人', action: '接下来两周的干货教程全部结论先行',
        metric: 'views', targetMult: 1.5, match: { pillarKey: 'p1', formatTags: ['结论先行'] },
        proposedDaysAgo: 84, periodDays: 14, effect: 1.6, persists: true, postsPerWeek: 2, expected: { verdict: 'worked' } },
      { id: 'A-E2', kind: 'tactic', hypothesis: '日常记录蹭热点话题能带来更多曝光', action: '两周内日常记录都挂当周热点话题',
        metric: 'views', targetMult: 1.3, match: { pillarKey: 'p2', formatTags: ['蹭热点'] },
        proposedDaysAgo: 56, periodDays: 14, effect: 0.55, persists: false, postsPerWeek: 2, expected: { verdict: 'failed' } },
    ],
    outages: [], shifts: [],
    stage: { initial: '0_1', transitions: [{ daysAgo: 40, to: '1_10', reason: '小红书粉丝过 1000，近 8 周稳定周更 4 条以上' }] },
  },
  {
    key: 'B', label: '带 6 个月历史接入的 YouTube+Instagram（冷启动）', startDaysAgo: 240, growth: 1.3,
    platforms: [
      { platform: 'youtube', source: 'postforme', connectedDaysAgo: 60, baseViews: 1800, engagement: 0.035,
        metrics: ['views', 'likes', 'comments', 'followers_gained'], missing: ['shares'] },
      { platform: 'instagram', source: 'postforme', connectedDaysAgo: 60, baseViews: 2400, engagement: 0.05,
        metrics: ['views', 'likes', 'comments', 'shares', 'saves'] },
    ],
    pillars: [
      { key: 'p1', name: '器材测评', definition: '单件器材上手', share: 0.35, effect: { youtube: 1, instagram: 0.9 } },
      { key: 'p2', name: '拍摄技巧', definition: '一个技巧讲透', share: 0.35, effect: { youtube: 1.1, instagram: 1 } },
      { key: 'p3', name: '作品拆解', definition: '拆一张或一段成片', share: 0.3, effect: { youtube: 2, instagram: 1.9 } },
    ],
    cadence: [[240, 2]],
    formats: [],
    experiments: [
      { id: 'B-E1', kind: 'tactic', hypothesis: 'Instagram 拍摄技巧改成轮播图，收藏和播放都会更高',
        action: '两周内 Instagram 拍摄技巧全部做成轮播图', metric: 'views', targetMult: 1.3,
        match: { pillarKey: 'p2', platform: 'instagram', formatTags: ['轮播图'] },
        proposedDaysAgo: 28, periodDays: 14, effect: 1.5, persists: false, postsPerWeek: 2, expected: { verdict: 'worked' } },
    ],
    outages: [{ platform: 'youtube', fromDaysAgo: 25, toDaysAgo: 14 }],
    shifts: [],
    stage: { initial: '1_10', transitions: [] },
  },
  {
    key: 'C', label: '三平台博主：同一支柱跨平台相反，TikTok 第 4 个月整体限流', startDaysAgo: 183, growth: 1.2,
    platforms: [
      { platform: 'xiaohongshu', source: 'tikhub', connectedDaysAgo: 183, baseViews: 1200, engagement: 0.055, metrics: TIKHUB,
        followers: { start: 3000, end: 5200 } },
      { platform: 'tiktok', source: 'postforme', connectedDaysAgo: 183, baseViews: 2600, engagement: 0.045, metrics: TIKHUB },
      { platform: 'x', source: 'postforme', connectedDaysAgo: 183, baseViews: 700, engagement: 0.02,
        metrics: ['views', 'likes', 'comments', 'shares'] },
    ],
    pillars: [
      { key: 'p1', name: '读书笔记', definition: '一本书一个观点', share: 0.35, effect: { xiaohongshu: 1, tiktok: 1, x: 1.2 } },
      { key: 'p2', name: '穿搭灵感', definition: '一套通勤穿搭', share: 0.35, effect: { xiaohongshu: 1.8, tiktok: 0.6, x: 0.8 } },
      { key: 'p3', name: '城市探店', definition: '一家店的真实体验', share: 0.3, effect: { xiaohongshu: 1, tiktok: 1.4, x: 0.9 } },
    ],
    cadence: [[183, 3]],
    formats: [],
    experiments: [
      { id: 'C-E1', kind: 'tactic', hypothesis: 'TikTok 城市探店加字幕能提高完播和播放', action: '两周内 TikTok 探店全部加字幕',
        metric: 'views', targetMult: 1.3, match: { pillarKey: 'p3', platform: 'tiktok', formatTags: ['加字幕'] },
        proposedDaysAgo: 70, periodDays: 14, effect: 1.3, persists: false, postsPerWeek: 2,
        expected: { verdict: 'inconclusive', reason: 'platform_shift' } },
    ],
    outages: [],
    shifts: [{ platform: 'tiktok', fromDaysAgo: 70, effect: 0.4 }],
    stage: { initial: '1_10', transitions: [] },
  },
  {
    key: 'D', label: '低频 Instagram：每周 1 条、每周手动导入一次表格，样本永远不够', startDaysAgo: 186, growth: 1.1,
    platforms: [
      { platform: 'instagram', source: 'manual', connectedDaysAgo: 186, baseViews: 600, engagement: 0.07,
        metrics: ['views', 'likes', 'comments', 'shares', 'saves'], importEveryDays: 7 },
    ],
    pillars: [
      { key: 'p1', name: '手作过程', definition: '从材料到成品', share: 0.6, effect: { instagram: 1.4 } },
      { key: 'p2', name: '工作室日常', definition: '工作室的一天', share: 0.4, effect: { instagram: 0.8 } },
    ],
    cadence: [[186, 1]],
    formats: [],
    experiments: [
      { id: 'D-E1', kind: 'tactic', hypothesis: '手作过程先放成品，开头更抓人', action: '两周内手作过程先放成品再倒叙',
        metric: 'views', targetMult: 1.3, match: { pillarKey: 'p1', formatTags: ['成品先出'] },
        proposedDaysAgo: 35, periodDays: 14, effect: 1.4, persists: false, postsPerWeek: 1,
        expected: { verdict: 'inconclusive', reason: 'low_volume' } },
    ],
    outages: [], shifts: [],
    stage: { initial: '0_1', transitions: [] },
  },
];
