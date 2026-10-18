/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { QuestionCard } from '@repo/api/src/shared/agentTurn';
import { J_PERSONA_DIRECTION } from './landing-copy-j-persona';
import { J_TAKEOVER_MOMENTS, type TakeoverLine } from './landing-copy-j-takeover';

/**
 * Sample L's step one conversation, round six (Owner 2026-10-17: "第一个信息应该是我们的 Agent 在定位分析 skill 里面做的，
 * 它会先发一段信息给用户，询问用户想做什么……用户突然就发了一个他想拍周末的精致大餐啊，这个就感觉很跳"). One person
 * throughout (下班后 15 分钟家常菜):
 * - It opens with the coach (主动引导), in the positioning Skill's own words: the opening sentence of
 *   social-media-commercial-strategist 2.6.0, references/01-discovery.md 「开场」, verbatim, then its question 1
 *   (最终想得到什么) in the file's structure, the examples fitted to this person, as the Skill allows. The account
 *   name the person filled in is known context, so the coach does not ask for it again.
 * - Every fact a step summary lists is something the person said before it.
 * - The weekend-dinner idea is no longer the person's sudden turn: the coach raises it as one of the directions, from
 *   what the person said in step one (an hour after work, weekends uncertain), and recommends against it as the main line.
 * Lines kept from sample J are taken from its script by position; the rest are NEW.
 */
// Sample J's 了解你: [0] the person's opening, [1] the goal question, [2] "副业收入", [3] the goal reply, [4] the audience,
// [5] the camera question, [6] the resources, [7] the summary. Round ten (W1): taken one place off before, which put J's
// "副业收入" right after this person's own answer (two messages from the person in a row) and dropped the coach's reply.
const [, , , J_GOAL_REPLY, J_AUDIENCE, J_CAMERA] = J_TAKEOVER_MOMENTS[0].lines;
const [, , , J_FEASIBILITY, J_FETCH, J_TABLE, J_DIAGNOSE_SUMMARY] = J_TAKEOVER_MOMENTS[1].lines;

/**
 * Round thirteen (Owner 2026-10-18: "AI 教练的说法太别扭，要改成大白话"): sample L's own wording of the lines it borrows
 * from sample J, inside words swapped for everyday ones, the meaning and the figures unchanged (sample J keeps its own).
 * Each pair is [J's words, L's words]; the tests check every one is found and replaced.
 */
export const L_PLAIN_SWAPS: readonly (readonly [string, string])[] = [
  ['受众决定变现能力', '看的人是谁，决定了以后能怎么赚钱'],
  ['也是你和泛做饭号不一样的地方', '也是你和一般做饭号不一样的地方'],
  ['做饭是高频刚需，锅具、调料、食材都有现成的联盟带货和品牌合作', '做饭是天天都要做的事，锅具、调料、食材都有现成的带货分佣和品牌合作'],
  ['做饭赛道很挤', '做饭的账号很多'],
  ['带货要信任和一定的数据基础', '带货要先让人信你，也要有一定的播放量'],
  ['- 降难度：', '- 怎么降低难度：'],
  ['第一个月只测内容，不急着变现', '第一个月先试哪类内容受欢迎，不急着赚钱'],
  ['5 个合格，2 个只作参考', '5 个和你最像、可以照着学，2 个只作参考'],
  ['这是推断，样本有限，但值得你去占', '这是我的判断，看过的账号有限，但值得你去占'],
  ['数据来自网络公开信息，观察日期 2026-10-15，真实性待考证，仅供参考', '数据来自平台上的公开信息，查于 2026-10-15，仅供参考'],
  ['难在赛道挤、带货要信任', '难在做饭的账号很多、带货要先让人信你'],
  ['对标：5 个合格（A–E），2 个参考', '对标：5 个可以照着学（A–E），2 个只作参考'],
  ['③中式家常 × 一人份 × 下班，样本里没人同时占住', '③中式家常、一人份、下班后做，这三点在我看过的账号里没人同时做到'],
  ['第一个月是测试期：测哪类题有人收藏、有人问，流量不是第一指标，数据平淡很正常', '第一个月先试：看哪类题有人收藏、有人问，播放多少不是最要紧的，数据平淡很正常'],
];
const plain = <T extends { text: string }>(line: T): T =>
  ({ ...line, text: L_PLAIN_SWAPS.reduce((text, [from, to]) => text.split(from).join(to), line.text) });

/** The Skill's opening sentence (01-discovery.md 「开场」), verbatim. */
export const L_SKILL_OPENING = '我先花十几分钟了解你的情况，一次只问一个问题，你想到什么说什么。你说得越具体，最后给你的方案就越准。';

/** The goal card; its reason now points at the account name the person filled in (the person has not spoken yet). */
export const L_GOAL_CARD = {
  question: '你最想从账号得到什么？',
  options: ['记录生活', '副业收入', '做成主业', '还没想好'],
  recommended: 1,
  recommendationReason: '你填的账号是"下班后家常菜"，本身就是每天要做的事，最容易长期坚持的是"顺手赚点钱"这条路。',
} as unknown as QuestionCard;

const OPENING = `${L_SKILL_OPENING}\n\n`
  + '看到你填的账号是"下班后家常菜"，那就从做饭说起。先问第一件：**你做这个账号，最希望它最后给你带来什么？**\n\n'
  + '我先问这个，是因为同样是做饭账号，想记录生活和想赚钱，拍法、选平台、找对标完全不一样。大概有这么几种情况，你看看更接近哪种：\n'
  + '- 记录：给自己留个做饭日记，有人看更好；\n- 零花钱：每个月多几百美元，至少把买菜钱赚回来；\n'
  + '- 慢慢做成主业：收入稳定了，考虑不上班；\n- 还没想好，先试试自己能不能坚持。\n\n'
  + '如果好几个都想要，先挑一个你眼下最想要的。都不是也没关系，说说你真实的想法就行。';

/** NEW: the person's answer about time and camera now also says what the step summary lists (platforms, dishes, benchmarks). */
const RESOURCES = '只拍手和锅吧，不太想露脸，声音可以。下班后只有一小时，大多数菜 15 分钟能做完。周末不一定有空，有时候要加班或者跟朋友出去。'
  + '设备就一部手机，加一个夹在橱柜上的支架。平时刷 TikTok 和 Instagram 最多，要另外剪的长视频我就不做了。会做的家常菜二十多道，朋友来家里吃饭常问我怎么做。对标账号我不知道该找谁。';

const STEP_ONE_SUMMARY = '请核对，确认后进入第二步：\n'
  + '- 目标：做副业，不辞职；一年后希望每月多几百美元，起步先走厨具和食材带货（AI 教练建议，可改）。\n'
  + '- 内容：中式家常菜，二十多道，多数 15 分钟上桌。\n'
  + '- 想吸引：刚开始一个人住的上班族——下班晚、累、外卖贵、一人份食材吃不完。\n'
  + '- 资源：工作日每晚约 1 小时，周末不固定；不露脸，可出声；手机 + 支架。\n'
  + '- 平台：常刷 TikTok、Instagram；不做需要另剪的长视频。\n- 对标：还没有，由我找。\n- 条件：做得快；朋友常问做法。\n'
  + '- 我补的一条：拍摄会让做饭时间翻倍，先按每周两条排。';

/** NEW: the direction raised by the coach from what the person said, the weekend dinners one of the options. */
const DIRECTION = '前面你说了两件事：下班后只有一小时，周末不一定有空。所以方向我先给判断，再请你选。\n\n**方向怎么定？**\n\n'
  + '做饭账号常见两条主线：\n'
  + '- **下班后 15 分钟家常菜**：一条一小时内拍得完，工作日就能稳定更新；你本人就是这群人，最有说服力。\n'
  + '- **周末精致大餐**：拍出来好看，但一条要大半天，做的人里不少是专业团队，打光、摆盘都比一个人用手机精；你周末不固定，很难稳定更新。\n\n'
  + '**风险提示**：新账号断更，平台和观众都会忘了你。按你现在的时间，精致大餐当主线很容易断更。\n\n'
  + '我推荐第一种。也可以两样各做一半，或者说说你的想法。';

type Moment = { id: 'know' | 'diagnose' | 'plan'; step: 0 | 1 | 2; lines: readonly (TakeoverLine & { opening?: boolean; pick?: number })[] };

/**
 * Round eleven (X1, Owner 2026-10-18: "如果你要展示教练提问的弹窗……那么用户就直接去选择这个提问卡，不要再自己去回复"):
 * a question card is shown only where the person answers by picking one of its options, as the product does (the
 * option's own words are sent as the message). The goal and camera questions are answered in the person's own words,
 * so they are asked in the conversation without a card; only the direction question brings one.
 */
const DIRECTION_PICK = 0;

export const L_POSITIONING_MOMENTS: readonly Moment[] = [
  {
    id: 'know', step: 0,
    lines: [
      { role: 'coach', text: OPENING, opening: true },
      { role: 'user', text: '副业收入吧，不想辞职。一年后每个月能多几百美元就行。' },
      plain(J_GOAL_REPLY),
      plain(J_AUDIENCE),
      plain({ ...J_CAMERA, card: undefined }),
      { role: 'user', fills: ['resources'], text: RESOURCES },
      { role: 'summary', card: 'confirm', fills: ['track', 'platforms', 'benchmarks', 'assets'], text: STEP_ONE_SUMMARY },
    ],
  },
  {
    id: 'diagnose', step: 1,
    lines: [
      { role: 'coach', card: 'direction', text: DIRECTION },
      { role: 'user', pick: DIRECTION_PICK, text: J_PERSONA_DIRECTION.options[DIRECTION_PICK] },
      plain(J_FEASIBILITY),
      plain(J_FETCH),
      // Round twelve (D4): every figure filled, so the line no longer speaks of missing ones (sample J keeps its own).
      plain({ ...J_TABLE, text: J_TABLE.text.replace('数据已经填进表格，查不到的写"未取到"。', '数据已经填进表格。') }),
      plain(J_DIAGNOSE_SUMMARY),
    ],
  },
  { id: 'plan', step: 2, lines: J_TAKEOVER_MOMENTS[2].lines.map(plain) },
];

/** The direction card is sample J's; its options are the coach's two main lines and "两样各做一半". */
export const L_DIRECTION_CARD = J_PERSONA_DIRECTION;
