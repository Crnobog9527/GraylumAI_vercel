/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type {
  DecisionKey, DetailDecision, DetailIssue, DetailResponse, DetailRound, RulingFields, Seat, Severity, Stance, Verdict,
} from '@/components/landing/preview-jury/jury-events';

/** "3 受众" → "第 3 章 受众", the jury's way of naming a chapter. */
export const asCanvasPlace = (title: string) => title.replace(/^(\d+) /, '第 $1 章 ');

/**
 * The real review of this page's report (the review Skill, 2026-10-15: review.md), in the shapes the jury canvas and
 * the result page read: each reviewer's four decisions and its issues in round 1, the answers in round 2. The texts
 * are the review's own, shortened; chapters are named as this report names them ("第 4 章 平台选择").
 */
const decision = (key: DecisionKey, verdict: Verdict, strongestCase: string, strongestAlternative: string, basis: string): DetailDecision =>
  ({ decision: key, verdict, strongestCase, strongestAlternative, basis });
const issue = (location: string, severity: Severity, perspective: string, problem: string, suggestion: string): DetailIssue =>
  ({ location, severity, perspective, problem, suggestion });
const answer = (reviewer: Seat, key: DecisionKey, stance: Stance, strongestView: string, reason: string): DetailResponse =>
  ({ reviewer, decision: key, stance, strongestView, reason });

const SELF = '用户本人';
const SOLO = '受众：刚开始一个人住的上班族';

const CASE = {
  positioning: '"下班后 15 分钟"是用户每天就在做的事，每条都能被观众验证。',
  audience: '用户本人就是这类人，说的话这群人会信。',
  platform: 'TikTok 推荐对新号友好，一条视频三处发，工作量最小。',
  monetization: '带货不用囤货、和做饭场景最贴，用户已经接受。',
};

const ROUND_ONE: Record<Seat, DetailRound> = {
  A: { round: 1, status: 'usable', decisions: [
    decision('positioning', 'keep', CASE.positioning, '"一个人也要好好吃饭"：情绪更强、更好转发。', '保留方向，但要补一个能验证的"快"的机制。'),
    decision('audience', 'keep', CASE.audience, '主攻留学生：更集中、更爱分享。', '保留。'),
    decision('platform', 'change', CASE.platform, '前两个月三平台同发、按数据定主平台。', '用只在 TikTok 上搜到的对标证明 TikTok 最适合，是循环论证。'),
    decision('monetization', 'change', CASE.monetization, '先放免费一周菜单和报名表，带货放第二步。', '新号未必开得了带货，先知道有没有人肯付钱更要紧。'),
  ], issues: [
    issue('第 4 章 平台选择', 'critical', SELF, '用只在 TikTok 上搜到的对标来证明"TikTok 最适合"，Instagram 的数据会被忽略。',
      '前两个月三个平台发同一条视频，按各自数据再决定在哪里加重。'),
    issue('第 10 章 变现路径', 'major', SELF, '入门层放带货，但开通条件新号未必满足；一周菜单的层级混乱。',
      '第一个月末放出免费一周菜单和报名表；第三个月再决定付费版；带货放第二步。'),
    issue('第 6 章 账号定位', 'major', SELF, '"快"没有落到机制上，对手同样可以说"15 分钟"。', '写明快在哪，每条全程计时。'),
    issue('第 11 章 合规提醒', 'minor', SELF, '改成报名表收集联系方式，原文没有提醒。', '加一条：写清用途、能退订、不卖给别人。'),
    issue('第 9 章 运营手册', 'minor', SELF, '"周末不占"和"周日看数据"写在同一句里，自相矛盾。', '写成每周找一晚，默认周日，手机上看即可。'),
  ] },
  B: { round: 1, status: 'usable', decisions: [
    decision('positioning', 'keep', '七点到家，最想看到"真的来得及"。', '定位成"一周备餐"：周末做好，工作日热一下。', '保留，但要说清 15 分钟从哪开始算。'),
    decision('audience', 'change', CASE.audience, '—', '放弃做饭的原因没写全；健身新手应写成以后的扩展方向。'),
    decision('platform', 'change', '我确实在 TikTok 刷到做饭视频。', '我在 Instagram 上收藏菜谱更多。', '别替我决定我在哪。'),
    decision('monetization', 'change', '锅具带货贴场景。', '我刚搬家，锅已经买了；更愿意领一份"这周吃什么 + 购物清单"。', '一份免费菜单我会马上领；推锅我大概率划走。'),
  ], issues: [
    issue('第 3 章 受众', 'major', SOLO, '只写了"累"，没写清为什么放弃自己做，选题只会围绕"快"。', '补上太累、买菜麻烦、一个人吃不完；厨房小标"假设"。'),
    issue('第 8 章 内容规划', 'major', SOLO, '"超市半成品改造"不是我想学的，也和"你会做二十多道菜"不搭。', '换成"一份食材三顿用完"。'),
    issue('第 6 章 账号定位', 'major', SOLO, '不说清 15 分钟从哪算，我会觉得被骗。', '画面上全程计时，从打开冰箱算起。'),
    issue('第 8 章 内容规划', 'minor', SOLO, '英文字幕只写"适量""少许"，非华人看不懂。', '用量写成勺、杯这类美国厨房常用单位。'),
  ] },
  C: { round: 1, status: 'usable', decisions: [
    decision('positioning', 'change', '场景清楚、可验证。', '"快在备菜：周日一次切配，工作日三天复用"。', '把"快"落到备菜上，能做系列，也能接菜单。'),
    decision('audience', 'keep', '核心人群聚焦合理。', '—', '保留。'),
    decision('platform', 'keep', 'TikTok 为主、IG 同步，工作量最小。', '三平台同发。', '原方案本来就是一条视频同步发，没有冲突。'),
    decision('monetization', 'keep', '带货门槛最低，第一个月本来就是测试期。', '先做免费菜单。', '每晚只有一小时，第一个月再做菜单会挤占拍摄。'),
  ], issues: [
    issue('第 6 章 账号定位', 'major', SELF, '"快"没有具体做法。', '加"快在备菜：周日一次切配，工作日三天复用"。'),
    issue('第 12 章 见效时间', 'major', SELF, '只讲道理，没把可控的流程落到动作上。', '每周三更、周末集中拍两条备用；每周日二十分钟把评论排进下周选题。'),
    issue('第 8 章 内容规划', 'minor', SELF, '"超市半成品搜的人多"没有来源。', '写成经验判断、待验证，或换掉。'),
  ] },
};

const ROUND_TWO: Record<Seat, DetailRound> = {
  A: { round: 2, status: 'usable', decisions: [], issues: [], responses: [
    answer('C', 'platform', 'disagree', '工作量本来就是一条视频发三处，改不改主平台都一样。',
      '正因为工作量一样，没有数据时就不该先宣布 TikTok 是主平台。坚持改判断顺序。'),
    answer('C', 'monetization', 'disagree', '第一个月做菜单会分心。', '接受这个担心：菜单放到第一个月最后一周，用已有的菜整理。坚持改顺序。'),
    answer('C', 'positioning', 'disagree', '"快"要有机制，周日一次切配。', '用户说过"周末不一定有空"，周日切配建在做不到的时间上；同意"一次买菜、分几顿用"。'),
  ] },
  B: { round: 2, status: 'usable', decisions: [], issues: [], responses: [
    answer('C', 'monetization', 'disagree', '只看过两三条视频，我未必信你、不会填表。', '放到第四周、我已经跟着做过几道菜之后，我会领。同意 A 的时间点。'),
    answer('C', 'positioning', 'disagree', '周日一次切配。', '我周末也不想切菜，我需要的是"买一次菜，这几天怎么用完"。'),
  ] },
  C: { round: 2, status: 'usable', decisions: [], issues: [], responses: [
    answer('A', 'platform', 'agree', '用 TikTok 上的对标证明 TikTok，这站不住。', '被说服：保留同一条视频同步发，改为按数据定加重。'),
    answer('A', 'monetization', 'agree', '免费菜单放在第四周、用已有的菜整理。', '被说服；观众说"锅已经买了"，锅具带货的买点不成立。'),
    answer('B', 'positioning', 'agree', '用户周末不一定有空。', '撤回"周日"，改为买菜当天把三顿的料分好装盒；"每周三更"也撤回。'),
  ] },
};

export const J_REVIEW_SEATS = (['A', 'B', 'C'] as const).map(seat => ({ seat, rounds: [ROUND_ONE[seat], ROUND_TWO[seat]] }));

/** The decisions the panel split on in round 1 (review.md, 第 2 轮). */
export const J_REVIEW_SPLITS: { decision: DecisionKey; keep: Seat[]; change: Seat[] }[] = [
  { decision: 'platform', keep: ['C'], change: ['A', 'B'] },
  { decision: 'monetization', keep: ['C'], change: ['A', 'B'] },
  { decision: 'positioning', keep: ['A', 'B'], change: ['C'] },
];

const rule = (chapter: string, issue: string, reviewers: Seat[], disputed: boolean, adopted: boolean,
  texts: { opinion: string; reason: string; fix: string }): RulingFields =>
  ({ section: asCanvasPlace(chapter), issue, reviewers, single: reviewers.length === 1, disputed, adopted, ...texts });

/** The chief writer's rulings, chapter by chapter (review.md, 逐条裁决), including the two it turned down. */
export const J_RULINGS: RulingFields[] = [
  rule('3 受众', '人群①放弃做饭的原因不全；扩展人群没写清', ['B'], false, true, {
    opinion: '人群①补上放弃做饭的原因：太累、买菜麻烦、一个人吃不完；"厨房小、灶少"标为假设；写明以后可以扩展到想控制饮食的健身新手。',
    reason: '只有一位评审提出，回到原文核实：用户说过"累得不想做饭""点外卖又贵""买一把青菜一个人三天都吃不完"；"厨房小、灶少"没有用户原话，只能标假设。',
    fix: '补全放弃原因，扩展人群写清楚，核心人群不变。',
  }),
  rule('4 平台选择', '用只在 TikTok 搜到的对标证明 TikTok 最适合', ['A', 'B'], true, true, {
    opinion: '前两个月 TikTok、Instagram Reels、YouTube Shorts 发同一条视频，按各自数据再决定在哪里加重；写明对标只查了 TikTok。',
    reason: '核实：原文第四章确有"对标账号都在 TikTok 上做起来"作为依据，而对标只在 TikTok 上查过。原方案最强的理由（工作量最小）保留：还是同一条视频三处发，改的只是判断顺序。',
    fix: '三处同发两个月、按数据定加重；Instagram、YouTube 的同类账号待核实。',
  }),
  rule('6 账号定位', '"快"没有机制、没有计时', ['A', 'B', 'C'], true, true, {
    opinion: '写明快在备菜：买菜当天多花十分钟把三顿的料分好装盒，工作日复用；每条全程计时，从打开冰箱算起。',
    reason: '三位评审都要求把"快"落到看得见的做法上，否则观众会问"15 分钟含不含洗切"。具体做法按用户能做到的时间来写。',
    fix: '加上备菜做法和全程计时。',
  }),
  rule('6 账号定位', '周日一次切配，工作日三天复用', ['C'], true, false, {
    opinion: '不采纳"周日一次切配"。',
    reason: '和用户原话"周末不一定有空，有时候要加班或者跟朋友出去"冲突，会把计划建在做不到的时间上；提出的评审在第 2 轮已撤回。',
    fix: '改为买菜当天把三顿的料分好。',
  }),
  rule('8 内容规划', '"超市半成品改造"偏离定位，"搜的人多"没有来源', ['B', 'C'], false, true, {
    opinion: '第三条内容线换成"一份食材三顿用完（买菜和保存）"。',
    reason: '这条和"你会做二十多道中式家常菜"的优势关系弱，"搜的人多"也没有来源；新内容线直接对上用户自己说的"一把青菜三天吃不完"。',
    fix: '换掉第三条内容线和对应选题。',
  }),
  rule('8 内容规划', '英文字幕的用量单位', ['B'], false, true, {
    opinion: '英文字幕里的用量写成勺、杯这类美国厨房常用单位。',
    reason: '和"中英字幕"的既定决定一致，不增加用户的工作。',
    fix: '风格里加一句字幕单位。',
  }),
  rule('10 变现路径', '带货开通条件新号未必满足；"锅已经买了"让锅具带货的买点不成立', ['A', 'B'], true, true, {
    opinion: '第一个月第四周放出免费一周菜单和报名表；第三个月按报名情况决定要不要出付费的一周菜单和备菜指南；带货放到第二步，先推调料和保鲜盒，锅具放后面。',
    reason: '核实：第十章自己写了联盟带货有开通条件；用户的目标是"小而稳的副业收入"，没说必须先带货。菜单用已有的菜整理，排在周一晚上，不占拍摄。',
    fix: '漏斗改为免费菜单 → 带货 → 付费菜单和备菜指南 → 菜谱合集。',
  }),
  rule('12 见效时间', '没把可控的流程落到动作上', ['C'], true, true, {
    opinion: '加上"每周日花二十分钟把评论区的问题排进下周选题"。',
    reason: '在用户的时间之内，把"能控制的流程"落到了具体动作上。',
    fix: '加一条每周复盘动作。',
  }),
  rule('12 见效时间', '每周三更、周末集中拍两条备用', ['C'], true, false, {
    opinion: '不采纳"每周三更、周末集中拍两条备用"。',
    reason: '违反用户确认过的"每周两条"和"周末不固定"；提出的评审在第 2 轮已撤回。',
    fix: '保持每周两条。',
  }),
];
