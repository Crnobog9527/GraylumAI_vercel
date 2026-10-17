/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { REPORT_DATA_FENCE, type ReportData } from './reportData';
import { REPORT_DATA_FIELD_NAMES, REPORT_DATA_VERSION } from './reportDataSpec';

/**
 * Made-up strategy data for tests and the landing page's sample report: a home baker on Xiaohongshu (the same
 * example as the chat-display report fixture). No real user and no real account; benchmark names are fictional.
 * Every field passes the checks, so it doubles as the reference for what a complete data block looks like.
 */
export const SAMPLE_REPORT_DATA: ReportData = {
  summary: '主做小红书的"烘焙师定制蛋糕日常"，每周 3 条，先用作品集带来同城私信，首月只验证有没有人来问。',
  thisWeek: [
    { action: '注册小红书账号，设好名字、头像和简介', why: '先把名字占住，后面每条内容都指向它', done: '主页三件套都填好' },
    { action: '拍 3 个已做过的蛋糕成品，各写一段设计思路', why: '作品集是同城客户下单前最先看的', done: '发出 3 条图文' },
    { action: '在简介里写清楚接单范围和预约方式', why: '让看到的人知道怎么找你', done: '有人私信时能直接回复报价' },
  ],
  situation: {
    strengths: [{ point: '有烘焙手艺和老客户', basis: 'user' }, { point: '会讲设计思路', basis: 'inferred' }],
    resources: '每周 3–10 小时，一个人，几乎没有推广预算',
    limits: [{ point: '工作日白天要接单，拍摄只能放在晚上', basis: 'user' }],
    missing: [{ point: '同城定制蛋糕的真实询价量', basis: 'unverified' }],
  },
  goal: {
    primary: '三个月内每周稳定接到 3–5 个定制单',
    outcome: '不靠熟人介绍也有稳定订单',
    feasibility: 'conditional',
    pros: ['同城定制需求稳定', '客单价能覆盖做内容的时间'],
    cons: ['前两个月要坚持更新'],
    unknowns: ['同城用户愿不愿意为设计溢价'],
  },
  audience: {
    groups: [
      { name: '筹备生日和纪念日的年轻妈妈', job: '给孩子办一场好看的生日会', pain: '担心外观好看但不安全', trigger: '生日前两周',
        wallet: '愿意为好看多付一点', whyBuy: '能定制图案和口味', whyNot: '怕不好吃、怕送晚', contentFit: 'high', moneyFit: 'high',
        basis: 'inferred', quote: '想要一个独一无二的蛋糕，但一定要用好的材料。' },
      { name: '公司行政', job: '给同事过生日、办活动', pain: '怕送晚和不能开票', trigger: '每月固定的生日会',
        wallet: '有预算，看重省心', whyBuy: '准时交付、可以开票', whyNot: '比连锁店贵', contentFit: 'medium', moneyFit: 'high',
        basis: 'unverified' },
    ],
    core: '都在为一个重要场合准备，看重好看和放心，愿意为定制多付一点',
  },
  platforms: [
    { platform: '小红书', role: 'main', reasons: ['同城搜索多', '图文门槛低', '用户习惯先搜再买'] },
    { platform: '抖音', role: 'support', reasons: ['先只同步视频，不单独投入'] },
  ],
  benchmarks: {
    accounts: [
      { platform: '小红书', account: '示例甜点工作室', category: '同城定制', takeaway: '每条都先放成品特写，再讲设计' },
      { platform: '小红书', account: '示例家庭烘焙', category: '家庭烘焙', takeaway: '制作过程用 6 张图讲完' },
    ],
    todo: { searchTerms: ['同城定制蛋糕', '生日蛋糕设计'], next: '按这两个词再找 2 个粉丝 1 万以内的同城账号' },
  },
  positioning: {
    statement: '一个会讲做法的烘焙师：每条内容只讲一个蛋糕从设计到交付',
    value: '让同城客户放心地把重要场合的蛋糕交给你',
    differentiators: [{ point: '每个蛋糕都讲设计思路', evidence: '你说老客户最常夸的是设计' }],
    notClaims: ['不能说"全城最好吃"'],
    verdict: '可以先这样定，做满一个月再看私信来自哪类人',
  },
  accountKit: {
    hook: '每个蛋糕背后的故事', boundary: '只做定制蛋糕和相关小课，不做零售面包', naming: '名字 + 品类 + 日记感',
    name: '小麦的定制蛋糕日记', handle: '小红书号用拼音，和名字保持一致',
    rejected: [{ name: '甜蜜工坊', reason: '太常见，搜不到你' }],
    avatar: '工作台实拍，能看清你的手和蛋糕', bio: '同城定制 · 每一个蛋糕的故事 · 私信预约',
  },
  content: {
    formats: { main: '图文', support: '30 秒短视频' },
    mix: [{ kind: 'traffic', share: 40 }, { kind: 'trust', share: 40 }, { kind: 'conversion', share: 20 }],
    pillars: ['成品展示', '制作过程', '客户故事'],
    style: '真实、温和、讲细节',
    cadence: '每周 3 条',
  },
  topics: [
    { title: '这个恐龙蛋糕我改了三次设计', forWhom: '年轻妈妈', pain: '想要独一无二', howToShoot: '设计稿 + 成品对比',
      tests: '设计故事能不能带来收藏', watch: '收藏数' },
    { title: '给 30 人公司做生日会蛋糕的一天', forWhom: '公司行政', pain: '怕送晚', howToShoot: '时间线图文',
      tests: '准时交付能不能带来私信', watch: '私信数' },
  ],
  roadmap: [
    { stage: '起步', when: '前 2 周', purpose: '把作品集立起来', do: '每周 3 条成品图文', watch: '收藏数', exitWhen: '发满 6 条' },
    { stage: '找方向', when: '第 3–4 周', purpose: '找到最受欢迎的内容类型', do: '三类内容各测 2 条', watch: '私信来自哪类内容',
      exitWhen: '有一类内容的私信明显多' },
  ],
  plan30: {
    weeks: [
      { week: 1, purpose: '立起作品集', posts: '3 条', topics: '已做过的成品', watch: '收藏数', passIf: '发满 3 条',
        reviewQuestion: '哪一条收藏最多？' },
      { week: 2, purpose: '测试开头', posts: '3 条', topics: '成品 + 设计故事', watch: '前 3 秒停留', passIf: '至少一条收藏超过 20',
        reviewQuestion: '哪种开头让人停下来？' },
      { week: 3, purpose: '固定栏目', posts: '3 条', topics: '制作过程', watch: '私信数', passIf: '有 1 条私信问价',
        reviewQuestion: '私信的人在问什么？' },
      { week: 4, purpose: '复盘调整', posts: '3 条', topics: '客户故事', watch: '私信转成订单', passIf: '接到第一个线上来的订单',
        reviewQuestion: '下个月保留哪类内容？' },
    ],
    day30Questions: ['线上来的私信有几条？', '哪类内容带来的私信最多？'],
  },
  routine: [
    { when: '周日晚上', task: '定下周 3 个选题', minutes: 30 },
    { when: '每条发布后 1 小时', task: '回复评论和私信', minutes: 15 },
  ],
  adjustments: [
    { signal: '收藏多、私信少', meaning: '内容好看但不知道怎么找你', action: '在结尾写清楚预约方式' },
  ],
  funnel: [
    { layer: '免费内容', role: '让同城的人看到你', forWhom: '所有刷到的人', buyPoint: '好看、想收藏', offer: '作品图文', price: '免费',
      filter: '不在同城的人', whyFilter: '标注同城和自提', howToSell: '结尾引导私信', watch: '收藏数', basis: 'inferred' },
    { layer: '入门款', role: '第一次下单', forWhom: '想试试的人', buyPoint: '价格低、风险小', offer: '小尺寸定制', price: '约 198 元',
      filter: '只想要最便宜的人', whyFilter: '定制本身有门槛', howToSell: '私信报价', watch: '私信转订单', basis: 'inferred' },
    { layer: '主力款', role: '主要收入', forWhom: '重要场合的客户', buyPoint: '独一无二的设计', offer: '全定制蛋糕', price: '约 398–898 元',
      filter: '不重视设计的人', whyFilter: '先看作品集再下单', howToSell: '设计沟通 + 定金', watch: '复购', basis: 'unverified' },
  ],
  upgrades: [{ from: '入门款', to: '主力款', how: '交付时附下次纪念日的设计建议', when: '第一次下单后' }],
  income: {
    active: ['定制蛋糕订单'], passive: ['以后可以做烘焙小课'],
    order: '先把入门款和主力款做稳，再考虑小课', formulas: ['月收入 = 订单数 × 平均客单价'],
  },
  redLines: ['不承诺功效和健康效果', '不晒客户隐私信息'],
  compliance: [
    { topic: '肖像', risk: '客户和孩子的照片', advice: '发之前征得同意，孩子的脸打码' },
    { topic: '商业标注', risk: '合作推广不标注', advice: '有合作就用平台的合作标注功能' },
  ],
  assumptions: [
    { assumption: '同城用户愿意为设计溢价', why: '老客户愿意多付', howToTest: '入门款和主力款各发 3 条', signal: '主力款的私信数',
      passIf: '主力款私信不少于入门款的一半', when: '第 3–4 周', ifNot: '把主力款拆成两档价格' },
    { assumption: '制作过程类内容的收藏率更高', why: '同类账号多是这样', howToTest: '成品和过程各发 2 条', signal: '收藏率',
      passIf: '过程类收藏率更高', when: '第 2 周', ifNot: '以成品展示为主' },
  ],
};

/** The sample as the model writes it: one field per line, in the field order. */
export function sampleReportDataBlock(data: ReportData = SAMPLE_REPORT_DATA) {
  const rows = REPORT_DATA_FIELD_NAMES.filter(field => data[field] !== undefined)
    .map(field => JSON.stringify({ v: REPORT_DATA_VERSION, field, value: data[field] }));
  return [REPORT_DATA_FENCE, ...rows, '```'].join('\n');
}
