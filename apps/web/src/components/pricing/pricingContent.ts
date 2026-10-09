/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { faqItems } from '@/lib/landing-content';

/**
 * Copy of the public pricing page (PAYWALL design v25 scene 5, MASTER_PLAN §2.1 items 50–51).
 * Rules: prices only from the server catalog; no predicted credit cost, no model names, no 7-day
 * refund on cards (only in the FAQ), no founder/first-month offers until PAY-WAFFO serves them,
 * no features the backend does not have (studio team features, Fusion, profile limits).
 */
export const PRICING_COPY = {
  title: '选一个适合你的方案',
  lede: '注册就能免费开始做定位；需要完整的运营策略报告、更多积分时，再开通会员。',
  freeName: '免费',
  freeFit: '先试试，看 Graylum 能不能帮到你',
  freePoints: ['注册赠送积分，可以开始做定位', '已确认的信息免费保留、可以导出', '生成完整运营策略报告需要开通会员'],
  freeCta: '免费注册',
  memberCta: '开通会员',
  contactCta: '联系我们',
  memberCtaNote: '登录后在个人中心的会员页开通',
  packsTitle: '积分包',
  packsLede: '积分包只对付费会员开放，会员购买有折扣。积分永不过期。',
  packsMemberDiscount: '会员折扣',
  packsUnavailable: '积分包暂时读不到，请稍后再看。',
  studioTitle: '工作室版',
  studioLede: '给需要同时运营多个品牌的团队。按团队规模报价，留下联系方式，我们会通过邮件联系你。',
  faqTitle: '常见问题',
  catalogUnavailable: '会员方案暂时读不到，请稍后刷新。',
} as const;

const REFUND_QUESTION = '可以退款吗？';

/** The one shared refund answer (also on /faq and the landing page); never a second copy. */
export const refundFaqItem = faqItems.find(item => item.question === REFUND_QUESTION);

/** Pricing FAQ: decided rules only (MASTER_PLAN §2.1 items 50–51), plus the shared refund answer. */
export const pricingFaqItems = [
  {
    question: '积分会过期吗？',
    answer: '不会。积分永不过期，只有会员等级会到期。',
  },
  {
    question: '可以随时取消订阅吗？',
    answer: '可以，在个人中心随时取消自动续费。取消后会员权益用到当期结束。',
  },
  {
    question: '年付的积分怎么发？',
    answer: '年付的积分分 12 个月，每个月发放一次。',
  },
  ...(refundFaqItem ? [refundFaqItem] : []),
];
