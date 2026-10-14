/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { JuryEvent } from '@/components/landing/preview-jury/jury-events';

/**
 * Sample J's jury case (controller 2026-10-15): the review panel on the demo's made-up positioning report (a dental
 * assistant in Canada), for the canvas player of #1002 — `caseFromEvents(J_JURY_REPORT, J_JURY_EVENTS)` once it is
 * merged. The report shape is #1002's JuryCaseReport; the events follow jury-scripts.ts's 'full' scenario (two
 * disagreements, a second round, rulings, a revision). Every text is at most 120 characters, names no model and
 * carries no figures. NEW WORDING for the Owner to approve.
 */
export const J_JURY_REPORT = {
  title: '定位报告：加拿大牙科助理的转行笔记',
  excerpt: '一句话定位：帮刚到加拿大的新移民，用下班时间一步步转行做牙科助理。主平台放在 TikTok 和 Instagram 短视频；变现先做一对一入行咨询。',
  chapters: 10,
  revisedExcerpt: '变现路线：先把评论区最常见的问题整理成免费入行清单，确认需求后再开一对一咨询；咨询只分享个人经历和求职准备，执照和移民问题转介官方渠道。'
    + '平台：短视频起量不变，同步把入行步骤做成 YouTube 长视频，留住搜索流量。',
} as const;

/** The chapters the revision changes, in report order. */
export const J_JURY_CHANGED = ['第 3 章 目标受众', '第 5 章 平台选择', '第 8 章 变现路线'] as const;

type Draft = JuryEvent extends infer E ? E extends JuryEvent ? Omit<E, 'id'> : never : never;
const seats = ['A', 'B', 'C'] as const;

const decisions = (round: 1 | 2, reviewer: 'A' | 'B' | 'C', platform: 'keep' | 'change', money: 'keep' | 'change'): Draft[] => [
  ...(round === 1 ? [
    { type: 'decision', round, reviewer, decision: 'positioning', verdict: 'keep',
      strongestCase: '主线是亲历的入行路径，牙医和诊所账号替代不了；痛点具体：没有本地经验，找不到第一份工作。',
      strongestAlternative: '改做牙齿护理科普，受众更大，但做的人太多，助理身份没有优势。' },
    { type: 'decision', round, reviewer, decision: 'audience', verdict: 'keep',
      strongestCase: '刚到加拿大、想转行的新移民，愿意为具体的入行帮助花时间和钱。',
      strongestAlternative: '扩到所有想进医疗行业的人，范围大了，内容会变得笼统。' },
  ] as Draft[] : []),
  { type: 'decision', round, reviewer, decision: 'platform', verdict: platform,
    strongestCase: platform === 'keep'
      ? '短视频起量快，适合把一个入行步骤讲清楚，下班后也做得完。'
      : '入行步骤信息量大，观众会主动搜索；YouTube 长视频能持续带来搜索流量。',
    strongestAlternative: platform === 'keep' ? '改以长视频为主，单条制作时间长，下班后难以稳定更新。' : '只做短视频，流量来得快也走得快，留不住搜索的人。' },
  { type: 'decision', round, reviewer, decision: 'monetization', verdict: money,
    strongestCase: money === 'keep'
      ? '一对一入行咨询门槛低，马上能开始，也能直接听到观众的真实问题。'
      : '先用免费清单验证需求，再开咨询；咨询要写清边界，避免被当成就业或移民建议。',
    strongestAlternative: money === 'keep' ? '先做付费资料包，但还不知道观众最卡在哪一步。' : '直接开咨询，需求没验证，边界也没说清。' },
];

const ROUND_ONE: Draft[] = [
  ...decisions(1, 'A', 'change', 'keep'),
  { type: 'issue', round: 1, reviewer: 'A', section: '第 3 章 目标受众', perspective: '受众', severity: 'major',
    problem: '只写了「新移民」，没分清还在观望和已经在读课程的人，两类人要的内容不同。',
    fix: '拆成两类：观望的人讲值不值得转行，在读的人讲实习和第一份工作。' },
  ...decisions(1, 'C', 'keep', 'change'),
  { type: 'issue', round: 1, reviewer: 'C', section: '第 7 章 第一个 30 天计划', perspective: '执行', severity: 'major',
    problem: '按周排了主题，但没写每周更新几条、每条多长，下班后的时间够不够没有验证。',
    fix: '按每周能投入的时间倒推更新量，先跑两周，再按数据调整。' },
  ...decisions(1, 'B', 'keep', 'change'),
  { type: 'issue', round: 1, reviewer: 'B', section: '第 8 章 变现路线', perspective: '合规', severity: 'critical',
    problem: '一对一入行咨询没写边界，容易被当成就业或移民建议，引发纠纷。',
    fix: '写明咨询只分享个人经历和求职准备；涉及执照和移民的问题，转介官方渠道。' },
  { type: 'disagreement', decision: 'platform', keep: ['B', 'C'], change: ['A'] },
  { type: 'disagreement', decision: 'monetization', keep: ['A'], change: ['B', 'C'] },
];

const ROUND_TWO: Draft[] = [
  ...seats.map(reviewer => ({ type: 'reviewer_started', round: 2, reviewer }) as Draft),
  { type: 'response', round: 2, reviewer: 'A', to: 'B', decision: 'monetization', stance: 'agree',
    strongestView: '咨询没写边界会出问题；先用免费清单验证需求，再开咨询更稳。' },
  ...decisions(2, 'A', 'change', 'change'),
  { type: 'response', round: 2, reviewer: 'B', to: 'A', decision: 'platform', stance: 'disagree',
    strongestView: '长视频有搜索价值，但下班后做不过来；主平台仍是短视频，长视频只做补充。' },
  ...decisions(2, 'B', 'keep', 'change'),
  { type: 'response', round: 2, reviewer: 'C', to: 'A', decision: 'platform', stance: 'agree',
    strongestView: '入行步骤确实适合被搜到；可以把已发的短视频合成长视频，不多占时间。' },
  ...decisions(2, 'C', 'keep', 'change'),
  { type: 'summary_started', round: 2 },
];

const RULINGS: Draft[] = [
  { type: 'adjudication', section: '第 8 章 变现路线', issue: '一对一咨询没写边界，需求也没验证。', reviewers: ['A', 'B', 'C'],
    single: false, disputed: true, adopted: true,
    opinion: '保留咨询，但改成先验证、后开通，并写清边界。',
    reason: '第二轮三位都认同：没边界有纠纷风险，没验证可能白做。',
    fix: '先把评论区高频问题整理成免费清单，确认需求后再开咨询；执照和移民问题转介官方渠道。' },
  { type: 'adjudication', section: '第 5 章 平台选择', issue: '要不要改成以 YouTube 长视频为主。', reviewers: ['A', 'B', 'C'],
    single: false, disputed: true, adopted: true,
    opinion: '主平台仍是短视频，加 YouTube 长视频做搜索沉淀。',
    reason: '长视频的搜索价值成立，但下班后的时间只够短视频；合成长视频不多占时间。',
    fix: '把同一主题的几条短视频合成一条 YouTube 长视频，每月一次。' },
  { type: 'adjudication', section: '第 3 章 目标受众', issue: '受众只写了新移民，太宽。', reviewers: ['A'],
    single: true, disputed: false, adopted: true,
    opinion: '采纳：受众拆成观望和在读两类。', reason: '两类人的问题不同，混在一起，内容会两头都不准。',
    fix: '观望的人讲值不值得转行，在读的人讲实习和第一份工作。' },
  { type: 'adjudication', section: '第 7 章 第一个 30 天计划', issue: '更新量没有按可用时间核算。', reviewers: ['C'],
    single: true, disputed: false, adopted: false,
    opinion: '记为提醒，不改报告：更新量交给每周复盘按数据调整。', reason: '这一条要靠真实发布的数据才能定，现在改只是猜。',
    fix: '在每周复盘里跟踪实际能完成的条数。' },
  { type: 'revision_ready_for_choice', changedSections: J_JURY_CHANGED.length, changedSectionTitles: [...J_JURY_CHANGED], changedFields: 0 },
  { type: 'review_ended', state: 'completed', outcome: 'revised' },
];

const DRAFTS: Draft[] = [
  { type: 'review_started', reviewers: [...seats], sections: J_JURY_REPORT.chapters },
  ...seats.map(reviewer => ({ type: 'reviewer_started', round: 1, reviewer }) as Draft),
  ...ROUND_ONE,
  ...ROUND_TWO,
  ...RULINGS,
];

/** The review's events in order, with fixed ids as the backend gives them (ids carry no meaning). */
export const J_JURY_EVENTS: readonly JuryEvent[] = DRAFTS.map((draft, index) => ({ ...draft, id: `j-jury-${index + 1}` }) as JuryEvent);
