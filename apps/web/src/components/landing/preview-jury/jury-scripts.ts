/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { DecisionKey, JuryEvent, Seat, Verdict } from './jury-events';

/**
 * Mock data for the prototype: one fictional creator's positioning report, reviewed three ways. Each arrival is
 * what a poll of fusionReview.events (FUSION-REVIEW.md §2.2a) newly returns at a simulated server time; the full
 * list a poll returns is every arrival so far, in order. As in the real
 * backend, a reviewer's decisions and issues all arrive together once its answer passes the host check, 10–30 s
 * after reviewer_started; nothing about its thinking arrives before that. Text is summary only (≤120 chars).
 */
type Draft = JuryEvent extends infer E ? E extends JuryEvent ? Omit<E, 'id'> : never : never;
export type MockArrival = { atMs: number; events: JuryEvent[] };
export type JuryScenarioId = 'full' | 'consensus' | 'failed';
export type JuryScenario = { id: JuryScenarioId; label: string; hint: string; arrivals: MockArrival[] };

const AUDIENCE_SOLO = '受众：刚开始独居的上班族';
const AUDIENCE_FAMILY = '受众：双职工家庭的做饭人';
const AUDIENCE_FIT = '受众：想控制饮食的健身新手';
const SELF = '用户本人';

type Steelman = { strongestCase: string; strongestAlternative: string };

const CASES: Record<Seat, Record<DecisionKey, Steelman>> = {
  A: {
    positioning: {
      strongestCase: '「下班后 15 分钟家常菜」一句话说清给谁、省什么，和你自己下班做饭的经历完全一致。',
      strongestAlternative: '改成「一个人也要好好吃饭」，情绪更强，但选题会变散，难以持续更新。',
    },
    audience: {
      strongestCase: '刚独居的上班族痛点集中：下班累、不会配菜、怕浪费，和你的内容能力正好对上。',
      strongestAlternative: '主攻双职工家庭的做饭人，愿意为省时间付钱，但你目前没有家庭场景的素材。',
    },
    platform: {
      strongestCase: '小红书的菜谱靠搜索被找到，收藏就是需求，新号也有机会。',
      strongestAlternative: '主平台改为抖音：做饭过程天然适合竖屏视频，能放大你已有的手机拍摄习惯。',
    },
    monetization: {
      strongestCase: '先接厨具和半成品品牌合作，门槛低，和内容场景贴合，不用另做产品。',
      strongestAlternative: '先卖付费周菜单，利润更高、更可控，但需要先证明有人愿意付钱。',
    },
  },
  B: {
    positioning: {
      strongestCase: '「15 分钟」是可验证的承诺，观众看完一条就知道你有没有做到。',
      strongestAlternative: '定位成「上班族一周备餐」，单条内容更长，但更适合做系列和合集。',
    },
    audience: {
      strongestCase: '独居上班族每天都要面对晚饭问题，需求天天发生，内容不愁没人看。',
      strongestAlternative: '把健身新手并进核心受众，他们更愿意收藏和照做，但会让菜谱方向两头拉扯。',
    },
    platform: {
      strongestCase: '小红书用户会主动搜「快手晚饭」，你的标题天然能接住这种搜索。',
      strongestAlternative: '同时做小红书和视频号，覆盖更多家庭用户，但一个人很难两边都顾好。',
    },
    monetization: {
      strongestCase: '品牌合作不需要你先搭产品，内容做好自然会有人来谈。',
      strongestAlternative: '先做免费周菜单收集愿意付钱的人，再推出付费版，比等品牌找上门更早拿到收入。',
    },
  },
  C: {
    positioning: {
      strongestCase: '定位把「快」和「家常」放在一起，同类账号里少见，容易被记住。',
      strongestAlternative: '强调「零失败」而不是「快」，更照顾新手，但和很多教学号撞车。',
    },
    audience: {
      strongestCase: '受众描述和你的生活状态一致，你说的话他们会信。',
      strongestAlternative: '先服务健身新手，需求更明确，但你不是健身博主，信任要从头建立。',
    },
    platform: {
      strongestCase: '新号最需要的是被搜到，小红书的搜索流量最稳定。',
      strongestAlternative: '主做 YouTube 中文频道，长视频更容易建立信任，但更新节奏会慢很多。',
    },
    monetization: {
      strongestCase: '品牌合作和你的内容场景最贴，不会让观众觉得突然在卖东西。',
      strongestAlternative: '先用免费周菜单测试付费意愿，有了真实反馈再定付费产品的价格和形式。',
    },
  },
};

const VERDICTS_SPLIT: Record<Seat, Record<DecisionKey, Verdict>> = {
  A: { positioning: 'keep', audience: 'keep', platform: 'change', monetization: 'keep' },
  B: { positioning: 'keep', audience: 'keep', platform: 'keep', monetization: 'change' },
  C: { positioning: 'keep', audience: 'keep', platform: 'keep', monetization: 'change' },
};
const VERDICTS_AGREED: Record<Seat, Record<DecisionKey, Verdict>> = {
  A: { positioning: 'keep', audience: 'keep', platform: 'keep', monetization: 'change' },
  B: { positioning: 'keep', audience: 'keep', platform: 'keep', monetization: 'change' },
  C: { positioning: 'keep', audience: 'keep', platform: 'keep', monetization: 'change' },
};

const ISSUES: Record<Seat, Omit<Extract<Draft, { type: 'issue' }>, 'type' | 'round' | 'reviewer'>[]> = {
  A: [
    { section: '第 12 章 30 天行动', perspective: SELF, severity: 'critical',
      problem: '前两周要求每天更新，和你只有晚上一小时的空闲冲突，计划很难坚持下去。',
      fix: '改为每周三更，周末集中拍两条备用，前两周先把节奏跑稳再加量。' },
    { section: '第 4 章 受众画像', perspective: AUDIENCE_SOLO, severity: 'major',
      problem: '画像只写了年龄和城市，没写他们几点到家、厨房里有什么，选题会落空。',
      fix: '补上到家时间、厨房条件和最常放弃做饭的原因，每条选题都对应其中一个场景。' },
    { section: '第 9 章 内容支柱', perspective: SELF, severity: 'minor',
      problem: '「厨房好物」这个支柱和主题关系弱，做多了容易变成带货号。',
      fix: '把这个支柱改成「备菜和收纳」，让每条内容仍然服务于「快」。' },
  ],
  B: [
    { section: '第 10 章 变现路径', perspective: SELF, severity: 'critical',
      problem: '品牌合作要等账号有一定规模才会来，前三个月没有任何收入来源，和你想尽早验证的目标不符。',
      fix: '第一个月就上线免费周菜单收集愿意付钱的人，品牌合作放到第二步。' },
    { section: '第 6 章 平台选择', perspective: AUDIENCE_FAMILY, severity: 'major',
      problem: '这类人更常在视频号和抖音找菜谱，只做小红书会漏掉他们。',
      fix: '主平台不变，把同一条视频同步到抖音，看家庭用户的反馈再决定要不要加重。' },
    { section: '第 2 章 定位一句话', perspective: AUDIENCE_FIT, severity: 'minor',
      problem: '「家常菜」容易让人以为偏油偏咸，可以补一句「少油少盐」。',
      fix: '在账号简介里写明少油少盐，定位一句话保持不变。' },
  ],
  C: [
    { section: '第 4 章 受众画像', perspective: AUDIENCE_FIT, severity: 'major',
      problem: '健身新手只在附录出现一次，正文却把他们算进核心受众，前后不一致。',
      fix: '把健身新手移出核心受众，放进「以后可以扩展的人群」。' },
    { section: '第 12 章 30 天行动', perspective: AUDIENCE_SOLO, severity: 'major',
      problem: '行动计划没有安排在评论区收集问题，错过了最省力的选题来源。',
      fix: '每周固定一次整理评论区问题，排进下周的选题。' },
    { section: '第 10 章 变现路径', perspective: SELF, severity: 'major',
      problem: '付费食谱的价格区间没有依据，应该先测试有没有人愿意付钱再定价。',
      fix: '删掉价格区间，先用免费周菜单的报名情况判断付费意愿，再定价格和形式。' },
    { section: '第 3 章 差异化', perspective: AUDIENCE_FAMILY, severity: 'minor',
      problem: '和同类账号的区别只写了「更快」，没说清快在备菜、烹饪还是收拾。',
      fix: '写明快在备菜：一次切配，三天复用。' },
  ],
};

function roundOne(seat: Seat, verdicts: Record<Seat, Record<DecisionKey, Verdict>>, issueCount?: number): Draft[] {
  const decisions: Draft[] = (['positioning', 'audience', 'platform', 'monetization'] as const).map(decision => ({
    type: 'decision', round: 1, reviewer: seat, decision, ...CASES[seat][decision], verdict: verdicts[seat][decision],
  }));
  const issues: Draft[] = ISSUES[seat].slice(0, issueCount).map(issue => ({ type: 'issue', round: 1, reviewer: seat, ...issue }));
  return [...decisions, ...issues];
}

const START: Draft[] = [{ type: 'review_started', reviewers: ['A', 'B', 'C'], sections: 13 }];
const startRound = (round: 1 | 2): Draft[] => (['A', 'B', 'C'] as const).map(reviewer => ({ type: 'reviewer_started', round, reviewer }));

const DISAGREEMENTS: Draft[] = [
  { type: 'disagreement', decision: 'platform', keep: ['B', 'C'], change: ['A'] },
  { type: 'disagreement', decision: 'monetization', keep: ['A'], change: ['B', 'C'] },
];

const RESPONSES: Record<Seat, Draft[]> = {
  A: [
    { type: 'response', round: 2, reviewer: 'A', to: 'B', decision: 'monetization', stance: 'agree',
      strongestView: 'B 认为品牌合作要等规模，前三个月没有收入；先做周菜单能更早验证有没有人愿意付钱。' },
    { type: 'response', round: 2, reviewer: 'A', to: 'C', decision: 'platform', stance: 'agree',
      strongestView: 'C 认为新号最需要的是被搜到，而不是被推荐，小红书的搜索流量最稳定。' },
  ],
  B: [
    { type: 'response', round: 2, reviewer: 'B', to: 'A', decision: 'platform', stance: 'disagree',
      strongestView: 'A 认为做饭过程天然适合竖屏视频，抖音能放大你已有的拍摄习惯。' },
  ],
  C: [
    { type: 'response', round: 2, reviewer: 'C', to: 'A', decision: 'monetization', stance: 'disagree',
      strongestView: 'A 认为品牌合作门槛最低、和内容场景最贴，不需要另外搭一个付费产品。' },
  ],
};

const RULE = (issue: string, reviewers: Seat[], adopted: boolean, reason: string): Draft =>
  ({ type: 'adjudication', issue, reviewers, single: reviewers.length === 1, adopted, reason });

const RULINGS_FULL: Draft[] = [
  RULE('变现路径：先做周菜单，还是先接品牌合作', ['B', 'C'], true,
    '保留方的最强理由是门槛低；改动方的最强理由是能更早验证付费。第 2 轮 A 也认同改动，采纳：先上线免费周菜单。'),
  RULE('平台：主平台是否改为抖音', ['A'], false,
    '改动方看重竖屏传播，保留方看重新号能被搜到。第 2 轮仍是二对一，保留小红书为主，抖音作为同步分发。'),
  RULE('第 12 章：前两周每天更新和空闲时间冲突', ['A'], true, '只有一位评审提出，但和你写下的时间限制直接冲突，改为每周三更。'),
  RULE('第 10 章：前三个月没有收入来源', ['B', 'C'], true, '两位评审都提出，并入变现路径的裁决一起修改。'),
  RULE('第 4 章：受众画像缺少生活细节', ['A'], true, '补上到家时间、厨房条件和最常放弃做饭的原因。'),
  RULE('第 4 章：健身新手前后不一致', ['C'], true, '从核心受众移出，放进「以后可以扩展的人群」。'),
  RULE('第 6 章：漏掉家庭用户常用的平台', ['B'], false, '已在平台的裁决里处理，同步分发就能覆盖，不单独改。'),
  RULE('第 12 章：没安排在评论区收集问题', ['C'], true, '每周固定一次整理评论区问题，作为下周选题。'),
  RULE('第 2 章：定位补一句「少油少盐」', ['B'], false, '会让定位变长、焦点变散，放进账号简介即可。'),
  RULE('第 9 章：「厨房好物」偏离主题', ['A'], true, '改为「备菜和收纳」，仍然服务于快。'),
  RULE('第 3 章：没说清快在哪个环节', ['C'], true, '写明快在备菜：一次切配，三天复用。'),
];

const RULINGS_CONSENSUS: Draft[] = [
  RULE('第 12 章：前两周每天更新和空闲时间冲突', ['A'], true, '只有一位评审提出，但和你写下的时间限制直接冲突，改为每周三更。'),
  RULE('第 10 章：前三个月没有收入来源', ['B'], true, '只有一位评审在问题里提到，但三位评审在变现路径上都主张先验证付费，采纳：先上线免费周菜单。'),
  RULE('第 4 章：受众画像缺少生活细节', ['A'], true, '补上到家时间、厨房条件和最常放弃做饭的原因。'),
  RULE('第 6 章：漏掉家庭用户常用的平台', ['B'], false, '核心受众是独居上班族，家庭用户不是这一版的重点。'),
  RULE('第 4 章：健身新手前后不一致', ['C'], true, '从核心受众移出，放进「以后可以扩展的人群」。'),
  RULE('第 12 章：没安排在评论区收集问题', ['C'], true, '每周固定一次整理评论区问题，作为下周选题。'),
];

/** Gives each event a fixed id, as the backend does; ids carry no meaning and are never shown. */
function build(scenario: string, steps: [number, Draft[]][]): MockArrival[] {
  let count = 0;
  return steps.map(([atMs, drafts]) => ({ atMs, events: drafts.map(draft => ({ ...draft, id: `${scenario}-${++count}` }) as JuryEvent) }));
}

const ROUND_ONE_SPLIT: [number, Draft[]][] = [
  [0, START],
  [900, startRound(1)],
  [21_000, roundOne('A', VERDICTS_SPLIT)],
  [27_500, roundOne('C', VERDICTS_SPLIT)],
  [30_500, [...roundOne('B', VERDICTS_SPLIT), ...DISAGREEMENTS]],
];

export const JURY_SCENARIOS: readonly JuryScenario[] = [
  {
    id: 'full', label: '有分歧，辩论两轮', hint: '两个决定上意见不一，开第 2 轮，汇总裁决后写出修订稿',
    arrivals: build('full', [
      ...ROUND_ONE_SPLIT,
      [35_000, startRound(2)],
      [52_000, RESPONSES.A],
      [57_500, RESPONSES.B],
      [61_000, [...RESPONSES.C, { type: 'summary_started', round: 2 }]],
      [96_000, [...RULINGS_FULL, { type: 'revision_ready', changedSections: 5, changedFields: 3, revisionId: 'mock-revision',
        changedSectionTitles: ['第 3 章 差异化', '第 4 章 受众画像', '第 9 章 内容支柱', '第 10 章 变现路径', '第 12 章 30 天行动'] },
        { type: 'review_ended', state: 'completed', outcome: 'revised' }]],
    ]),
  },
  {
    id: 'consensus', label: '没有分歧，提前结束', hint: '四个决定三人意见一致，不开第 2 轮，直接汇总',
    arrivals: build('consensus', [
      [0, START],
      [900, startRound(1)],
      [19_000, roundOne('A', VERDICTS_AGREED, 2)],
      [24_000, roundOne('B', VERDICTS_AGREED, 2)],
      [30_500, [...roundOne('C', VERDICTS_AGREED, 2), { type: 'summary_started', round: 1 }]],
      [62_000, [...RULINGS_CONSENSUS, { type: 'revision_ready', changedSections: 3, changedFields: 2, revisionId: 'mock-revision',
        changedSectionTitles: ['第 4 章 受众画像', '第 10 章 变现路径', '第 12 章 30 天行动'] },
        { type: 'review_ended', state: 'completed', outcome: 'revised' }]],
    ]),
  },
  {
    id: 'failed', label: '修订稿没有生成成功', hint: '辩论完成，但汇总写出的修订稿没有通过检查，意见仍可参考',
    arrivals: build('failed', [
      ...ROUND_ONE_SPLIT,
      [35_000, startRound(2)],
      [52_000, RESPONSES.A],
      [58_000, [{ type: 'reviewer_failed', round: 2, reviewer: 'B', reason: 'format' }]],
      [61_000, [...RESPONSES.C, { type: 'summary_started', round: 2 }]],
      [92_000, [{ type: 'revision_failed', reason: 'REVISION_NOTES' },
        { type: 'review_ended', state: 'revision_failed', outcome: 'opinions_only' }]],
    ]),
  },
];

export function findScenario(id: string): JuryScenario {
  return JURY_SCENARIOS.find(scenario => scenario.id === id) ?? JURY_SCENARIOS[0];
}
