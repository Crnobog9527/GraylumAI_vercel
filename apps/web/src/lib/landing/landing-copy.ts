/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { LandingFeature } from './landing-flags';

/**
 * Landing page wording, copied verbatim from the Owner's final offer (2026-10-13,
 * docs/launch/design/landing/offer-one-page-final-2026-10-13.md and section 13 of the brief).
 * Do not reword here; changes go back to the Owner. `needs` hides a block while its capability
 * is switched off (landing-flags.ts).
 */
type Gated = { needs?: readonly LandingFeature[] };
export type GatedText = Gated & { text: string };

export const OFFER_NAME = 'Graylum AI 自媒体陪跑教练';

export const HERO = {
  title: '你的 AI 自媒体陪跑教练',
  promise: '运营从此交给它，你只管专心输出你擅长的内容。',
  primaryCta: '免费和教练聊聊',
  secondaryCta: '看它怎么工作',
  // One sentence in the final copy, split so the 500-credit promise can wait for the grant change.
  note: [
    { text: '免费注册，不用绑卡。' },
    { text: '注册送 500 积分。', needs: ['signupGrant'] },
    { text: '聊出来的内容随时能看、能导出，不会收回。' },
  ] as readonly GatedText[],
} as const;

/**
 * Style sample H's first screen, the Owner's final wording of 2026-10-14 (verbatim). H1 and promise stay HERO's.
 * Only sample H uses this for now; /landing keeps HERO until H replaces it.
 */
export const HERO_H = {
  audience: '手里有专业，想做知识付费？开了店，想引流获客？想把自媒体做成副业，或者转型全职博主？',
  audienceSummary: '想做自媒体，却没人教过你怎么运营，连第一步都不知道迈向哪？从这里开始。',
  difference: '通用 AI 给你正确的废话，你需要的是一个带你做的教练。',
  differenceBody:
    'Graylum AI 先了解你的情况，帮你判断方向；再告诉你每一步做什么、为什么。'
    + '内容发出去后，它根据真实数据每周和你复盘：哪里做得好、哪里要改、下一步做什么。',
  result: '你只管输出内容，运营交给它。',
  /** Under every "免费和教练聊聊" button on sample H (first screen and the close). */
  ctaNote: '无需绑卡，免费试用',
} as const;

/**
 * Sample H's "自己用通用 AI ／ 用教练" table beside the difference line (diagnosis #979 item 8 B). NEW WORDING for
 * the Owner to approve: each cell is shortened from a step note already on the page (landing-flow.ts), no new claim.
 */
export const H_COMPARE = {
  caption: '自己用通用 AI 和用教练，差在哪',
  generic: '自己用通用 AI',
  coach: '用教练',
  rows: [
    { generic: '等你提问，你问得笼统它就答得笼统', coach: '按一套固定的运营方法主动问你，答案从你的情况里推出来' },
    { generic: '会编一个"示例账号"', coach: '对标数据实时查出来、程序算出来，查不到就写"未取到"' },
    { generic: '每开一个新窗口，你就得从头介绍自己', coach: '带着你确认过的定位、资料和文风来回答' },
    { generic: '看不到你的数据', coach: '看你真实发出去的内容和数据，建议从数据里来' },
  ],
} as const;

/**
 * The first screen's small exchange beside the difference line (sample H). NEW WORDING for the Owner to approve:
 * the general AI's answer is a made-up sample of "正确的废话"; the coach's side is the demo's real question card
 * (QUESTION_ONE in components/landing/demo/demo-script.ts, checked by a test) and its recommended option.
 */
export const H_HERO_EXCHANGE = {
  label: '示例',
  genericWho: '通用 AI',
  generic: '做自媒体要找准定位、持续输出优质内容、多和粉丝互动。',
  coachWho: '教练',
  coach: '你在工作里，最常被身边的人问到的是哪类问题？',
  coachPick: '推荐：怎么在加拿大入行做牙科助理',
} as const;

export type VoiceNote = Gated & {
  id: string;
  quote: string;
  source: string;
  translated?: boolean;
  answer: string;
};

/** Seven sticky notes, one per pain point; P6 ("wants to pay but does not trust") is left out on purpose. */
export const VOICE_WALL = {
  title: '他们抱怨的 vs 教练怎么做',
  lede: '左边是公开论坛和媒体报道里的原话，右边是教练怎么解决。',
  translatedLabel: '译自英文',
  notes: [
    {
      id: 'p1', needs: ['coach', 'library'],
      quote: '可实际上根本没有一对一服务，我有问题想咨询，往往很久都没人回复。',
      source: '北京日报报道中的受访者，2024-11',
      answer: '教练 24 小时在。它记得你确认过的定位、读过你上传的资料，回答的是你的情况，不是群发的攻略。',
    },
    {
      id: 'p2', needs: ['coach'],
      quote: '老师讲的还算可以……听着还挺有道理，但就是不告诉你具体该怎么做',
      source: '知乎，约 2021',
      answer: '每一步它只给你三样东西：你现在该做什么、为什么、做完下一步是什么。你确认了才往下走。',
    },
    {
      id: 'p3', needs: ['coach', 'content'],
      quote: '一個平凡的上班族，沒有賣東西，那…..可以拍什麼？',
      source: 'YouTube 留言，2026-09',
      answer: '先聊，从你的经历和专业里挖方向。方向定了，每周发什么它替你排好，每条写清拍给谁、为什么是这条。',
    },
    {
      id: 'p4', needs: ['research', 'publish'],
      quote: '每次看到别人的笔记轻松破百赞，而我的连两位数都达不到，就会怀疑自己是不是不适合做这个。',
      source: '腾讯新闻报道中的受访者，2025-05',
      answer: '对标账号的数据是真实查出来、程序算的，你知道差在哪。发了内容以后，它每周告诉你哪条有效、下周怎么调。',
    },
    {
      id: 'p5', needs: ['coach'],
      quote: '自媒體這條路，最難的從來都不是上課的那幾個小時，而是下課後自己面對空白螢幕的孤獨與迷惘。',
      source: '方格子，约 2026',
      answer: '下课才是开始，教练也是。做完一步它告诉你下一步，中途可以停，下次接着聊。',
    },
    {
      id: 'p7', needs: ['coach', 'research'], translated: true,
      quote: 'AI 通常只是给你更多内容，而不是更好的判断。',
      source: 'Reddit r/socialmedia，2026-04',
      answer: '它不是多给你几条内容。它先把你的方向定清楚，再看真实数据替你判断；方向难赚钱会直说，并给出调整方案。',
    },
    {
      id: 'p8', needs: ['content'], translated: true,
      quote: '一边经营店铺，一边还要想到底发什么，根本没有框架，很难有创意。',
      source: 'Reddit r/smallbusinessowner，2026-04',
      answer: '不用自己想。每周按它给的清单做，店里再忙也发得出去；拍摄你来，其余交给它。',
    },
  ] as readonly VoiceNote[],
} as const;

/** Module 3 frame. The nine-step walk-through and the sample reports are added inside it. */
export const HOW_IT_WORKS = {
  title: 'AI 教练怎么接手你的运营',
  // One paragraph in the final copy; split only so a switched-off promise can be left out.
  promise: [
    { text: '你不用再分心研究运营技术，' },
    { text: '不用自己想选题，', needs: ['content'] },
    { text: '也不用再为怎么变现发愁。' },
    { text: '发了内容以后，也不用自己看数据：它每周告诉你哪条有效、下周怎么调。', needs: ['publish'] },
    { text: '你也不用研究哪个模型更强、提示词怎么写。这些都已经打包进你的 AI 教练。' },
    { text: '拍摄、出镜、录音这些要你本人来，其余交给它。' },
  ] as readonly GatedText[],
  timelineTitle: '什么时候拿到什么',
  timeline: [
    { text: '第一次聊完就有你确认过的定位', needs: ['coach'] },
    { text: '开通会员当天拿到报告和第一个 30 天计划', needs: ['report'] },
    { text: '发了内容以后，每周有复盘', needs: ['publish'] },
  ] as readonly GatedText[],
} as const;

export type CompareRow = Gated & { label: string; price: string; sourceId: string };

/** "If you hired someone or bought tools" anchors; the Pro price at the bottom comes from the server. */
export const PRICE_COMPARE = {
  title: '价格',
  lede: '如果请人或买工具做同样的事：',
  rows: [
    { label: '请一位社媒顾问', price: '$2,000–10,000/月（2024 年调查平均 $2,107）', sourceId: 'consultant', needs: ['coach'] },
    { label: '做一次开号和内容策略', price: '平均 $1,510（2024 年调查）', sourceId: 'project', needs: ['report'] },
    { label: '排程工具发 9 个平台', price: '约 $45/月', sourceId: 'scheduler', needs: ['publish'] },
    { label: '对标分析工具', price: '$82/月起', sourceId: 'benchmark', needs: ['publish'] },
  ] as readonly CompareRow[],
  ownPrice: (proMonthly: string) => `${OFFER_NAME}：${proMonthly}/月起。`,
  sourcesTitle: '出处（价格于 2026-10-12 核对，上线前再核对一次）',
  sources: {
    consultant: 'HawkSEM（2026-07-27）、MarketerHire（2025-03-17）的顾问月费区间；平均数来自 HeyOrca 2024 年社媒经理调查（2024-05-28 发布，2024 年数据）',
    project: 'HeyOrca 2024 年社媒经理调查（2024-05-28 发布）',
    scheduler: 'Buffer 官方价目页（每个频道 $5/月，9 个频道）',
    benchmark: 'Socialinsider 官方价目页',
  } as Record<string, string>,
} as const;

/** Guarantee block next to the price cards ("先聊后买"). The 7-day refund lives only in the FAQ. */
export const RISK_REVERSAL = {
  title: '先聊后买',
  points: [
    { text: '先免费和教练聊一次：注册送 500 积分，足够把你的情况聊透、把定位整理出来。觉得有用，再开通。', needs: ['coach', 'signupGrant'] },
    { text: '聊出来的内容随时能看、能导出，不会收回。', needs: ['coach'] },
    { text: '积分永不过期；会员到期后，已生成的报告仍然可以看、可以导出。', needs: ['report'] },
    { text: '随时取消，用到当期结束。' },
  ] as readonly GatedText[],
} as const;

export const FINAL_ACTION = {
  title: '现在有两条路',
  paths: [
    '一条，是继续自己摸索：看教程、买课、对着空白页猜下一步，几个月后还在原地。',
    '另一条，是先免费和教练聊一次。聊完你就有一份自己确认过的定位。觉得有用再开通；觉得没用，聊出来的东西也是你的。',
  ],
  stackLabel: '你会得到的：',
  stack: {
    text: '一个 24 小时在线、记得你是谁的 AI 自媒体陪跑教练；从定位、对标、报告，到写内容、发布、每周复盘，一直陪你做下去。',
    needs: ['coach', 'library', 'research', 'report', 'voice', 'content', 'publish'],
  } satisfies GatedText,
  founderLine: '前 50 位创始会员，招满为止。',
  cta: '免费和教练聊聊',
  note: [
    { text: '不用绑卡' },
    { text: '注册送 500 积分', needs: ['signupGrant'] },
    { text: '聊出来的内容不会收回' },
  ] as readonly GatedText[],
} as const;
