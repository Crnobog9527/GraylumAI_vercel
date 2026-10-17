/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

// The public refund summary page (/refund). The rules below are MASTER_PLAN section 2.1 item 51 ("退款规则", records Y, AA,
// AB, AC and the 2026-10-07 execution note), one line each and nothing added. The full refund terms are the Owner's own text
// (generated with a third-party tool, outside this repository's writing scope); this page says the summary yields to them.
export const REFUND_PATH = '/refund';

export const REFUND_PAGE = {
  path: REFUND_PATH,
  metaTitle: '退款说明：哪些情况可以申请退款',
  metaDescription: '首次购买会员或购买积分包后 7 天内、且账户没有用过任何积分，可以通过客服工单申请退款，人工审核后按原支付渠道退回。本页用大白话汇总退款规则，完整条款以正式条款为准。',
  h1: '退款说明',
  lead: '首次购买会员、积分包或从 Pro 升级 Gold，7 天内并且账户没有用过任何积分，可以申请退款。续费不退。',
  updated: '2026-10-17',
  crumbs: [{ name: '首页', path: '/' }, { name: '退款说明', path: REFUND_PATH }],
  sections: [
    {
      h2: '哪些情况可以申请退款？',
      items: [
        '首次购买会员（月付、年付、创始会员、微信或支付宝一次性会员）、购买积分包、从 Pro 升级到 Gold：付款后 7 天内可以申请。',
        '必须没有用过积分：从这次付款开始，你的账户没有任何积分消耗（包括之前的积分和赠送的积分）。',
        '年付会员在 7 天内只发放第一个月的积分，退款时扣回这一个月的积分。',
        '创始会员退款后，创始身份立即结束，已售出的名额不会放回。',
        'Pro 升级 Gold 的退款，退的是这笔 Gold 付款：扣回这次发放的积分，恢复到 Pro，恢复到原 Pro 已付期限的原到期日为止，不延长也不缩短；如果退款时原到期日已经过了，就没有可恢复的 Pro 期限。'
          + '原 Pro 订阅保持停止续费，到期前请自己重新订阅；年付 Pro 没发完的按月积分继续发到原到期日。',
      ],
    },
    {
      h2: '哪些情况不退款？',
      items: [
        '自动续费的各期不退款。',
        '付款超过 7 天不退款。',
        '这次付款之后账户用过积分，不退款。',
        '取消订阅后可以用到当期结束，不按剩余时间折算退款。',
      ],
    },
    {
      h2: '怎么申请？退多少？',
      items: [
        '通过产品内的客服工单申请，不在账单或订单旁提供自助退款入口。',
        '人工审核通过后，按原支付渠道退回。',
        '法律允许时，退款会扣除 6% 手续费；法律不允许扣除的，不扣。',
        '手续费按不含税的价格计算，付款时收的税全额退还。',
      ],
    },
    {
      h2: '还有哪些情况会退款？',
      items: [
        '平台大幅缩减付费功能：按剩余时间退款，已经发放的积分不收回。',
        '没有正当理由终止你的账号：按剩余时间退款，并退还没用完的已购积分。',
        '按剩余时间退款后，这份会员到此结束，以后的积分不再发放；创始会员同时结束创始身份。',
        '因违规被终止账号（包括恶意拒付）：不退款，积分作废。',
      ],
    },
    {
      h2: '积分会过期吗？',
      items: ['积分永不过期，只有会员等级会过期。'],
    },
  ],
  footnote: '本页是退款规则的汇总说明，完整条款以《服务条款》和正式的退款政策为准；两者不一致时，以正式条款为准。',
} as const;
