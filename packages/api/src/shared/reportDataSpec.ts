/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/**
 * REPORT-VISUAL (docs/launch/tasks/REPORT-VISUAL.md §3.1): the fields of the report's strategy data, version 1.
 * One declarative definition is shared by the validator, the report page's tables and charts, the export and
 * the host's instructions to the model, so a column name or a limit is written down exactly once.
 * Every text is plain text counted in Unicode characters; links, images and HTML are never interpreted.
 */

export const REPORT_DATA_VERSION = 1;

/** A text field: at most `max` characters (default `TEXT_MAX`). */
export type TextSpec = { kind: 'text'; label: string; max?: number; optional?: true };
/** One of a few fixed codes; the page shows `labels[code]`. */
export type EnumSpec = { kind: 'enum'; label: string; values: Record<string, string>; optional?: true };
export type IntSpec = { kind: 'int'; label: string; min: number; max: number; optional?: true };
export type ObjectSpec = { kind: 'object'; label: string; fields: Record<string, Spec>; optional?: true };
export type ListSpec = { kind: 'list'; label: string; of: Spec; min: number; max: number; optional?: true };
export type Spec = TextSpec | EnumSpec | IntSpec | ObjectSpec | ListSpec;

export const TEXT_MAX = 120;

const text = (label: string, extra: Partial<TextSpec> = {}): TextSpec => ({ kind: 'text', label, ...extra });
const optionalText = (label: string) => ({ ...text(label), optional: true as const });
const list = <O extends Spec>(label: string, of: O, min: number, max: number) => ({ kind: 'list' as const, label, of, min, max });
const object = <F extends Record<string, Spec>>(label: string, fields: F) => ({ kind: 'object' as const, label, fields });
const texts = (label: string, min: number, max: number) => list(label, text(label), min, max);

/** Where a statement comes from: what the user said, what the AI coach inferred, or still to be checked. */
export const BASIS: EnumSpec = { kind: 'enum', label: '信息来源', values: { user: '你说的', inferred: 'AI 推断', unverified: '待验证' } };
const FIT: Record<string, string> = { high: '高', medium: '中', low: '低' };
const sourced = (label: string) => object(label, { point: text(label), basis: BASIS });

export const REPORT_DATA_FIELDS = {
  summary: text('一句话结论', { max: 200 }),
  thisWeek: list('这周就做的事', object('一件事', {
    action: text('做什么'), why: text('为什么'), done: text('做到什么算完成'),
  }), 1, 8),
  situation: object('现状', {
    strengths: list('能用的优势', sourced('优势'), 0, 8),
    resources: text('时间、人手和预算'),
    limits: list('限制', sourced('限制'), 0, 8),
    missing: list('还缺的信息', sourced('缺的信息'), 0, 8),
  }),
  goal: object('目标', {
    primary: text('主要目标'),
    outcome: text('变现背后的结果'),
    feasibility: { kind: 'enum', label: '可行性', values: { feasible: '可行', conditional: '有条件', not_advised: '暂不建议' } },
    pros: texts('有利的地方', 0, 6),
    cons: texts('不利的地方', 0, 6),
    unknowns: texts('最大的未知数', 0, 6),
  }),
  audience: object('受众', {
    groups: list('人群', object('人群', {
      name: text('是谁'), job: text('要完成的事'), pain: text('痛点或顾虑'), trigger: text('什么时候会买'),
      wallet: text('钱包和价格敏感'), whyBuy: text('为什么会买'), whyNot: text('为什么不买'),
      contentFit: { kind: 'enum', label: '内容匹配', values: FIT },
      moneyFit: { kind: 'enum', label: '变现匹配', values: FIT },
      basis: BASIS,
      quote: optionalText('代表人物的一句话'),
    }), 1, 6),
    core: text('核心人群的共同点'),
  }),
  platforms: list('平台', object('平台', {
    platform: text('平台', { max: 30 }),
    role: { kind: 'enum', label: '主 / 辅', values: { main: '主平台', support: '辅助平台' } },
    reasons: texts('理由', 1, 5),
  }), 1, 4),
  benchmarks: object('对标账号', {
    accounts: list('对标账号', object('账号', {
      platform: text('平台', { max: 30 }), account: text('账号', { max: 60 }),
      category: text('类别'), takeaway: text('可以学什么'),
    }), 0, 8),
    todo: { ...object('还没有合格对标时', { searchTerms: texts('去搜这些词', 0, 8), next: text('下一步') }), optional: true as const },
  }),
  positioning: object('定位', {
    statement: text('定位一句话'),
    value: text('核心商业价值'),
    differentiators: list('差异点', object('差异点', { point: text('差异点'), evidence: text('依据') }), 0, 5),
    notClaims: texts('不能当优势写的', 0, 5),
    verdict: text('结论'),
  }),
  accountKit: object('账号三件套', {
    hook: text('记忆点'), boundary: text('扩展边界'), naming: text('命名思路'),
    name: text('名称', { max: 40 }), handle: text('账号 ID 提醒', { max: 60 }),
    rejected: list('淘汰的名称', object('淘汰的名称', { name: text('名称', { max: 40 }), reason: text('淘汰理由') }), 0, 6),
    avatar: text('头像'), bio: text('简介', { max: 200 }),
  }),
  content: object('内容规划', {
    formats: object('内容形式', { main: text('主形式'), support: optionalText('辅助形式') }),
    mix: list('内容占比', object('内容类型', {
      kind: { kind: 'enum', label: '类型', values: { traffic: '流量', trust: '信任', conversion: '转化' } },
      share: { kind: 'int', label: '占比（%）', min: 0, max: 100 },
    }), 0, 3),
    pillars: texts('内容支柱', 0, 6),
    style: text('风格'),
    cadence: text('更新频率'),
  }),
  topics: list('选题清单', object('选题', {
    title: text('选题'), forWhom: text('给谁看'), pain: text('戳中什么'), howToShoot: text('怎么拍'),
    tests: text('测什么'), watch: text('看什么数据'),
  }), 1, 12),
  roadmap: list('起号路线图', object('阶段', {
    stage: text('阶段', { max: 40 }), when: text('什么时候进入'), purpose: text('目的'), do: text('做什么'),
    watch: text('看什么'), exitWhen: text('什么时候进入下一阶段'),
  }), 1, 6),
  plan30: object('30 天计划', {
    weeks: list('每一周', object('一周', {
      week: { kind: 'int', label: '第几周', min: 1, max: 5 },
      purpose: text('这周重点'), posts: text('发几条', { max: 40 }), topics: text('发什么'),
      watch: text('看哪个指标'), passIf: text('怎样算过关'), reviewQuestion: text('周末复盘问什么'),
    }), 1, 5),
    day30Questions: texts('第 30 天要回答的问题', 0, 5),
  }),
  routine: list('每周固定流程', object('一项', {
    when: text('什么时候', { max: 40 }), task: text('做什么'),
    minutes: { kind: 'int', label: '大约几分钟', min: 1, max: 600 },
  }), 1, 10),
  adjustments: list('数据怎么看、怎么调', object('一条', {
    signal: text('看到什么'), meaning: text('说明什么'), action: text('怎么调'),
  }), 1, 10),
  funnel: list('变现漏斗', object('一层', {
    layer: text('层', { max: 40 }), role: text('这一层的目的'), forWhom: text('给谁'), buyPoint: text('买点'),
    offer: text('卖什么'), price: text('建议价格', { max: 40 }), filter: text('过滤掉谁'), whyFilter: text('为什么能过滤'),
    howToSell: text('怎么卖'), watch: text('看什么'), basis: BASIS,
  }), 1, 6),
  upgrades: list('升级路径', object('一步', {
    from: text('从', { max: 40 }), to: text('到', { max: 40 }), how: text('怎么引导'), when: text('什么时候'),
  }), 1, 6),
  income: object('收入结构', {
    active: texts('主动收入', 0, 6), passive: texts('被动收入', 0, 6),
    order: text('先做哪一层'), formulas: texts('收益公式（不写金额）', 0, 4),
  }),
  redLines: texts('红线', 1, 10),
  compliance: list('合规提醒', object('一条', {
    topic: text('方面', { max: 30 }), risk: text('要注意什么'), advice: text('具体该怎么做'),
  }), 1, 10),
  assumptions: list('待验证的假设', object('一条', {
    assumption: text('假设'), why: text('为什么这么假设'), howToTest: text('怎么验证'), signal: text('看什么信号'),
    passIf: text('怎样算成立'), when: text('什么时候验证', { max: 40 }), ifNot: text('不成立怎么办'),
  }), 1, 10),
} satisfies Record<string, Spec>;

export type ReportDataField = keyof typeof REPORT_DATA_FIELDS;
export const REPORT_DATA_FIELD_NAMES = Object.keys(REPORT_DATA_FIELDS) as ReportDataField[];

/** The two groups (§3.1): content sessions read only the content group; free chat may read both. */
export const REPORT_DATA_GROUPS = {
  content: ['summary', 'thisWeek', 'situation', 'positioning', 'audience', 'platforms', 'accountKit', 'content',
    'topics', 'plan30', 'routine', 'adjustments', 'redLines', 'compliance'],
  business: ['goal', 'benchmarks', 'funnel', 'upgrades', 'income', 'roadmap', 'assumptions'],
} as const satisfies Record<string, readonly ReportDataField[]>;

export type ReportDataGroup = keyof typeof REPORT_DATA_GROUPS;

/** Hard limits (§3.1, Owner's choice B): every one of them holds at the same time. */
export const REPORT_DATA_LIMITS = { contentBytes: 12000, businessBytes: 14000, characters: 9000 } as const;

/**
 * Which chapter each field belongs to (§3.1 "对应章节"), by the chapter titles of the report Skill. The page
 * draws a field in its chapter; a field whose chapter the report does not have is shown after the last one.
 */
export const REPORT_DATA_CHAPTER: Record<ReportDataField, string> = {
  summary: '一句话结论', thisWeek: '一句话结论', situation: '现状盘点', goal: '目标和可行性', audience: '受众',
  platforms: '平台选择', benchmarks: '对标账号分析', positioning: '账号定位', accountKit: '账号三件套',
  content: '内容规划', topics: '内容规划', roadmap: '运营手册', plan30: '运营手册', routine: '运营手册',
  adjustments: '运营手册', redLines: '运营手册', funnel: '变现路径', upgrades: '变现路径', income: '变现路径',
  compliance: '合规提醒', assumptions: '待验证的假设',
};
