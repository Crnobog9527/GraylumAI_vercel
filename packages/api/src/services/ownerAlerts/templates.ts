/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { OwnerAlertFacts, OwnerAlertKind } from './kinds';

/*
 * ALERT-FEISHU: the Owner's Chinese alert copy, all in one place (Owner 2026-11-07: plain words, not code). One or two
 * sentences under a 【tag】, then the admin link on its own line; a test site is marked 「（测试站）」. Same message shape
 * as Shotviva T72 (core/alerts/templates.ts). No prompt, user content, email, phone, key or provider payload goes in:
 * the facts carry none, and sanitize() is a last net.
 */
export type RenderContext = { origin: string; testSite: boolean };
type Rendered = { line: string; path: string };
type Renderers = { [K in OwnerAlertKind]: (facts: OwnerAlertFacts[K]) => Rendered };

const PROVIDERS: Record<string, string> = { stripe: 'Stripe', waffo: 'Waffo', openrouter: 'OpenRouter' };
const ORDER_KINDS: Record<string, string> = { pack: '积分包', subscription_first: '会员', subscription_renewal: '会员续费',
  wallet_membership: '会员' };
const provider = (name: string) => PROVIDERS[name] ?? '供应商';
const shortId = (id: string) => id.replace(/[^A-Za-z0-9]/g, '').slice(0, 8);

export function money(minor: number | null, currency: string | null): string | null {
  if (minor === null || !Number.isFinite(minor) || !currency) return null;
  const value = (minor / 100).toFixed(2);
  return currency.toLowerCase() === 'usd' ? `$${value}` : `${value} ${currency.toUpperCase()}`;
}

function refundLine(f: OwnerAlertFacts['refund']): string {
  const what = `${ORDER_KINDS[f.orderKind] ?? ''}订单 ${shortId(f.orderId)} `;
  const refunded = money(f.refundedMinor, f.currency);
  const charged = money(f.chargedMinor, f.currency);
  const amount = refunded ? `退了 ${refunded}${charged && charged !== refunded ? `（这笔共付 ${charged}）` : ''}` : '被退款';
  switch (f.state) {
    case 'refunded': {
      // null: not known here (a replay); never reported as zero.
      const taken = f.creditsTakenBack === null ? '积分扣回情况请到后台看'
        : f.creditsTakenBack ? `已自动扣回 ${f.creditsTakenBack} 积分` : '没有要扣回的积分';
      const short = f.creditsShortfall ? `，还差 ${f.creditsShortfall} 积分没扣回（已经被用掉）` : '';
      return `【退款】${what}在 Stripe 那边${amount}（不是从后台发起的），${taken}${short}。`;
    }
    case 'renewing':
      return `【退款·要处理】${what}${amount}，但这个订阅还在自动续费，请确认要不要停掉续费。`;
    case 'partial_review':
      return `【退款·要处理】${what}只退了一部分（${refunded ?? '金额见后台'}），会员和积分都没动，请人工核对。`;
    case 'pack_review':
      return `【退款·要处理】${what}被全额退款，请按积分包的积分和用户现在的余额，决定收回多少积分。`;
    case 'unmatched':
      return '【退款·要处理】Stripe 有一笔退款找不到对应的订单，请人工核对这笔钱属于哪个订单，再处理会员和积分。';
    case 'during_monthly_refund':
      return `【退款·要处理】${what}的月付退款正在进行，又收到一笔外部退款，已记成冲突，请人工核对。`;
  }
}

const DISPUTES: Record<string, string> = {
  PAY_DISPUTE_OPENED: '有用户向银行发起了拒付，钱先被银行扣住了，请在截止前到 Stripe 后台提交证据。',
  PAY_DISPUTE_PAYMENT_FROZEN: '一笔被拒付的付款对应的积分已冻结，用户暂时用不了这部分积分。',
  PAY_DISPUTE_SOURCE_REVIEW: '一笔拒付对应的积分来源分不清，系统没有自动处理，请人工核对。',
  PAY_DISPUTE_REFUNDED_PAYMENT: '有用户对一笔已经退过款的付款又发起了拒付，请到 Stripe 后台核对，别让钱被扣两次。',
  PAY_DISPUTE_UNMATCHED: '收到一笔拒付，但找不到对应的订单，请人工核对。',
  PAY_DISPUTE_UNMATCHED_24H: '有一笔拒付超过 24 小时还没找到对应的订单，请尽快人工处理。',
  PAY_DISPUTE_PAYMENT_INTENT_MISSING: '收到一笔拒付，但缺少付款编号，系统没法对上订单，请人工核对。',
  PAY_DISPUTE_STOP_MANUAL: '一笔被拒付的订阅没能自动停掉续费，请到 Stripe 后台手动取消续费。',
  PAY_DISPUTE_RENEWAL_REFUND_MANUAL: '一笔被拒付的续费需要人工退款，请到后台处理。',
  PAY_DISPUTE_CLOSED: '一笔拒付已经有结果了（输赢见后台），请看一下积分要不要还回。',
};

function disputeLine(f: OwnerAlertFacts['dispute']): string {
  const due = f.dueBy && /^\d{4}-\d{2}-\d{2}/.test(f.dueBy) ? `提交证据截止 ${f.dueBy.slice(0, 10)}。` : '';
  return `【拒付】${DISPUTES[f.code] ?? '有一笔拒付有新情况，需要你到后台看一下。'}${f.code === 'PAY_DISPUTE_OPENED' ? due : ''}`;
}

const REVIEWS: Record<string, Rendered> = {
  PAY_STRIPE_MP_RECONCILIATION_REVIEW_REQUIRED: { line: '每日 Stripe 对账发现了对不上的地方，请到后台看一下。', path: '/admin/finance' },
  PAY_COMMON_ANNUAL_RELEASE_REVIEW_REQUIRED: { line: '年付会员每月发积分时有几笔没发成，请到后台核对。', path: '/admin/finance' },
  PAY_NOTIFY_REVIEW_REQUIRED: { line: '有几封给用户的付款通知邮件没发出去，请到后台看一下。', path: '/admin/payment-notices' },
  PAY_COMMON_PAYMENT_EVIDENCE_CONFLICT: { line: 'Stripe 发来的付款信息和我们记的对不上，钱先留着待核对，请到后台看一下。', path: '/admin/orders' },
};

function billingReview(f: OwnerAlertFacts['billing_review']): Rendered {
  const known = REVIEWS[f.code] ?? { line: '一项付款检查需要人工处理，请到后台看一下。', path: '/admin/finance' };
  const line = f.count ? known.line.replace(/。$/, `（共 ${f.count} 条）。`) : known.line;
  return { line: `【付款要核对】${line}`, path: known.path };
}

const BACKLOGS: Record<string, Rendered> = {
  ERASURE_BACKLOG: { line: '有用户申请注销账号超过 12 小时还没删完（我们承诺 24 小时内删完），请尽快看一下。',
    path: '/admin/diagnostics' },
  LIBRARY_CLEANUP_BACKLOG: { line: '用户删掉的资料库文件清理跟不上了，可能超过 24 小时的删除承诺，请看一下。',
    path: '/admin/diagnostics' },
  PUBLISH_MONITOR_QUOTA_NEAR: { line: 'Post for Me 本月的发布次数快用完了（到 80%），用完后一键发布会暂停。',
    path: '/admin/publish-monitor' },
  PUBLISH_MONITOR_QUOTA_FULL: { line: 'Post for Me 本月的发布次数用完了，新的一键发布已暂停。', path: '/admin/publish-monitor' },
  PUBLISH_MONITOR_CLEANUP_STUCK: { line: 'Post for Me 有账号连接清理试了很多次都没成功，需要人工处理。',
    path: '/admin/publish-monitor/cleanup' },
  RUNTIME_RECOVERY_RUN_STALE: { line: '每分钟跑一次的"对话收尾"任务超过 10 分钟没有运行了。它停着的时候，中断的对话不会自动结清，'
    + '该退给用户的冻结积分退不回去，请尽快看一下。', path: '/admin/finance' },
  RUNTIME_RECOVERY_RUN_FAILING: { line: '每分钟跑一次的"对话收尾"任务连续 3 次没有成功。中断的对话可能没有结清，'
    + '该退给用户的冻结积分可能还没退，请尽快看一下。', path: '/admin/finance' },
};

const RENDERERS: Renderers = {
  payment_webhook_failed: f => ({
    line: `【付款回调出错】${provider(f.provider)} 发来的一条付款通知没能处理，${provider(f.provider)} 会自动重发；`
      + '如果一直失败，用户付的钱可能没到账，请到后台订单页看看。',
    path: '/admin/orders',
  }),
  payment_webhook_unclaimed: f => ({
    line: `【订阅通知没人处理】${provider(f.provider)} 发来一条会员订阅的变化通知（例如到期取消），系统找不到对应的订阅，`
      + `已经确认收到但什么都没改，${provider(f.provider)} 不会再发。请到后台订单页核对这个用户的会员状态；每日对账也会再按 `
      + `${provider(f.provider)} 的状态核对一次。`,
    path: '/admin/orders',
  }),
  payment_webhook_unavailable: f => ({
    line: f.reason === 'signature'
      ? `【付款回调出错】${provider(f.provider)} 发来的通知签名对不上，付款都不会自动到账。请检查 Vercel 里的回调密钥是不是这个环境的。`
      : `【付款回调出错】${provider(f.provider)} 发来的通知存不进数据库，付款暂时不会自动到账；${provider(f.provider)} 会自动重发。`,
    path: '/admin/orders',
  }),
  refund: f => ({ line: refundLine(f), path: '/admin/refunds' }),
  dispute: f => ({ line: disputeLine(f), path: '/admin/refunds' }),
  billing_review: billingReview,
  stop_loss: f => ({ line: `【成本止损】${f.line.replace(/[。.]?$/, '。')}`, path: '/admin/settings' }),
  stop_loss_reached: f => ({
    line: `【成本止损】今天（${f.utcDate} UTC）全站花费到了每日上限，新的付费对话会被拒绝，直到明天 UTC 零点。`
      + '要调整上限请到「系统设置 → 成本止损」。',
    path: '/admin/settings',
  }),
  provider_402: f => ({
    line: `【AI 供应商】${provider(f.provider)} 说账户余额不够付钱，用户的 AI 调用正在失败（不扣用户积分）。请尽快去 ${provider(f.provider)} 充值。`,
    path: '/admin/costs',
  }),
  platform_absorb: f => ({
    line: `【平台垫付】${f.utcDate} 模型 ${f.model} 由平台承担的成本约 $${trimUsd(f.usd)}，超过了提醒线 $${trimUsd(f.thresholdUsd)}。`,
    path: '/admin/finance',
  }),
  ops_backlog: f => {
    const known = BACKLOGS[f.code] ?? { line: '一项后台任务积压了，请看一下。', path: '/admin/diagnostics' };
    return { line: `【${f.level === 'fatal' ? '紧急' : '后台积压'}】${known.line}`, path: known.path };
  },
  error_spike: f => ({
    line: `【网站报错】过去 ${f.minutes} 分钟服务器报错 ${f.count} 次，比平时多，可能有功能坏了。详细错误在 Sentry 里。`,
    path: '/admin/performance',
  }),
  test: f => ({ line: `【测试】飞书告警已接通。${f.note}`, path: '/admin' }),
};

/** "12.300000000000" → "12.30": two decimals, never rounded down. */
function trimUsd(value: string): string {
  const n = Number(value);
  return Number.isFinite(n) ? (Math.ceil(n * 100) / 100).toFixed(2) : value;
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const SECRETS = /\b(?:sk|rk|pk|whsec|sntrys|sbp)_[A-Za-z0-9_]{8,}\b|\beyJ[A-Za-z0-9_-]{20,}\b|https?:\/\/\S*hook\S*/g;
const PHONE = /\+\d{1,3}[\s-]?\d[\d\s-]{6,}\d|\b1[3-9]\d{9}\b|\(?\b\d{3}\)?[\s-]\d{3}[\s-]\d{4}\b/g;

/** The last net: no full email, phone number, token or hook address ever leaves, whatever a caller passed. */
export function sanitize(text: string): string {
  return text.replace(EMAIL, '[邮箱]').replace(SECRETS, '[已隐藏]').replace(PHONE, '[号码]');
}

export function renderAlert<K extends OwnerAlertKind>(kind: K, facts: OwnerAlertFacts[K], ctx: RenderContext): string {
  const { line, path } = (RENDERERS[kind] as (f: OwnerAlertFacts[K]) => Rendered)(facts);
  return `${sanitize(`${ctx.testSite ? '（测试站）' : ''}${line}`)}\n去后台看：${ctx.origin}${path}`;
}
