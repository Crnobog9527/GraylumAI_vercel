/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
import { z } from 'zod';
import { noticeLayout, type PaymentNoticeTemplate, type PaymentNoticeTemplates } from './templates';

// Fixed, first-party links: never render arbitrary URLs from persisted parameters.
const PRICING = 'https://www.graylum.com/pricing';
const ACCOUNT = 'https://www.graylum.com/app/profile?tab=subscription';
const time = z.iso.datetime({ offset: true });
const date = (value: string) => new Date(value).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
const expiry = z.object({ endDate: time });
const wallet = expiry.extend({ deadline: time.nullable(), plan: z.enum(['pro', 'gold']),
  stage: z.enum(['-7d', '0d', '+5d']) });
const card = expiry.extend({ amount: z.string().regex(/^\d+(?:\.\d{1,2})?$/),
  managed: z.boolean(), plan: z.enum(['pro', 'gold']) });
const template = (render: PaymentNoticeTemplate['render']): PaymentNoticeTemplate => ({ version: 'pay-n2-v1', render });

export const PAYMENT_NOTICE_TEMPLATES: PaymentNoticeTemplates = {
  card_renewal_upcoming: template(raw => {
    const p = card.parse(raw);
    return noticeLayout('年付扣款前提醒 / Annual renewal reminder', [
      `你的 ${p.plan === 'gold' ? 'Gold' : 'Pro'} 年付订阅预计于 ${date(p.endDate)} 自动扣款，税前标价 USD ${p.amount}。`
        + (p.managed ? '另加适用税款；你也可能收到 Link 的年度提醒。' : ''),
      `如不想续订，请在扣款前到账号页面管理订阅并取消续费：${ACCOUNT}`,
      `Your annual subscription is due to renew on ${date(p.endDate)} at USD ${p.amount} before tax.`
        + (p.managed ? ' Applicable taxes are added. Link may also send an annual reminder.' : ''),
      `To stop renewal, manage and cancel your subscription before the charge date: ${ACCOUNT}`,
    ]);
  }),
  wallet_founder_expiry: template(raw => {
    const p = wallet.extend({ deadline: time }).parse(raw);
    const status = p.stage === '-7d' ? '即将到期' : p.stage === '0d' ? '已经到期' : '续买宽限期即将结束';
    return noticeLayout('创始会员到期提醒 / Founder membership expiry', [
      `你的创始会员${status}，本期到期时间：${date(p.endDate)}。钱包付款不会自动续费。`,
      `你可以在 ${date(p.deadline)} 前按 USD 496 续买一年：${PRICING}。逾期将失去创始身份。`,
      `Your founder term ends on ${date(p.endDate)}. Wallet payments do not renew automatically.`,
      `Renew for one year at USD 496 by ${date(p.deadline)}: ${PRICING}. Your founder status ends after this deadline.`,
    ]);
  }),
  wallet_plan_expiry: template(raw => {
    const p = wallet.parse(raw);
    return noticeLayout('年付会员到期提醒 / Annual membership expiry', [
      `你的 ${p.plan === 'gold' ? 'Gold' : 'Pro'} 会员将于 ${date(p.endDate)} 到期，不会自动扣款。续买入口：${PRICING}`,
      `Your ${p.plan === 'gold' ? 'Gold' : 'Pro'} membership expires on ${date(p.endDate)}. It does not renew automatically. Renew: ${PRICING}`,
    ]);
  }),
  restore_pro_expiry: template(raw => {
    const p = expiry.parse(raw);
    return noticeLayout('恢复的 Pro 即将到期 / Restored Pro expiry', [
      `升级退款后恢复的 Pro 将于 ${date(p.endDate)} 到期，原 Pro 不会自动扣费。如需继续使用，请自行重新订阅：${PRICING}`,
      `The Pro term restored after your upgrade refund expires on ${date(p.endDate)}. It will not renew automatically.`
        + ` To continue, please subscribe again: ${PRICING}`,
    ]);
  }),
  dispute_won_resubscribe: template(() => noticeLayout('争议处理结果 / Dispute resolved', [
    '付款争议已处理完成，相关冻结已解除。原订阅已停止，不会自动扣款。如有需要，请自行重新订阅：' + PRICING,
    'The payment dispute has been resolved and the related freeze has been lifted.'
      + ' The original subscription is stopped and will not charge automatically. Subscribe again if needed: ' + PRICING,
  ])),
  founder_ended: template(raw => {
    const p = expiry.parse(raw);
    return noticeLayout('创始身份已结束 / Founder status ended', [
      `你的创始身份已于 ${date(p.endDate)} 结束。创始专属权益、展示墙和社群资格随之结束。若需普通会员，可查看：${PRICING}`,
      `Your founder status ended on ${date(p.endDate)}. Founder benefits, wall listing and community eligibility have ended.`
        + ` Standard memberships are available here: ${PRICING}`,
    ]);
  }),
};
