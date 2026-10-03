/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Homepage presentation copy approved by the Owner on 2026-10-04.
// It is marketing copy only and intentionally independent of the published mentor Skill.

export type HomeStep = {
  title: string;
  purpose: string;
  outcome: string;
  why: string;
};

export const HOME_STEPS: readonly HomeStep[] = [
  {
    title: '目标与资源盘点',
    purpose: '问清你的变现目标、赛道和现有条件，把你能投入的时间、精力和预算一起纳入考量。',
    outcome: '一份你自己确认过的起点档案，后面每一步都以它为依据。',
    why: '很多账号失败不是因为不努力，而是方向和自身条件不匹配。先把起点讲清楚，后面的方案才是你真正做得到的。',
  },
  {
    title: '目标人群与购买决策分析',
    purpose: '按“谁在看、谁会买、谁做决定”拆解你的受众，至少梳理出 5 类人群，分析他们各自的痛点、需求和付费动机。',
    outcome: '一张人群画像，标出哪类人是你的流量来源、哪类人是你的收入来源。',
    why: '吸引来看的人和真正付钱的人往往不是同一群。分不清这一点，粉丝涨了也赚不到钱。',
  },
  {
    title: '平台选择与对标账号拆解',
    purpose: '根据你的赛道和人群比较各平台特点，拆解对标账号的内容结构、选题方式、更新节奏和变现手段。',
    outcome: '平台建议，以及“对标账号做对了什么、哪些你可以借鉴、哪些不适合你”的结论。',
    why: '站在已经跑通的路上做改进，比从零摸索快得多；选错平台，再好的内容也事倍功半。',
  },
  {
    title: '变现可行性诊断',
    purpose: '综合前三步，判断你的方向能不能赚钱、主要靠什么赚钱、大概需要多久，并指出主要风险。',
    outcome: '一份明确的可行性判断，说清楚“能做”还是“需要调整”，以及调整方向。',
    why: '在投入几个月时间之前，先确认这条路走得通。',
  },
  {
    title: '差异化定位与账号包装',
    purpose: '提炼你的一句话定位和与众不同之处，设计账号名称、头像方向和简介。',
    outcome: '一套可以直接使用的账号三件套和定位表述。',
    why: '用户刷到你只有几秒钟，要让陌生人马上明白“你是谁、为什么值得关注”。',
  },
  {
    title: '30 天行动计划与变现路径',
    purpose: '把前面的结论落成第一个月每周的具体任务，并设计从内容到收入的完整路径。',
    outcome: '一份下周就能开始执行的行动清单和清晰的变现路线。',
    why: '好的策略只有落到行动上才有价值。',
  },
];

export const HOME_STEP_LABELS = [
  ['purpose', '目的'],
  ['outcome', '你会得到'],
  ['why', '为什么重要'],
] as const satisfies readonly (readonly [keyof Omit<HomeStep, 'title'>, string])[];
