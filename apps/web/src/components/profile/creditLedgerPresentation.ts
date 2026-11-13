/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

export type CreditLedgerType = 'grant' | 'spend' | 'refund_clawback' | 'adjustment' | 'expiration';

export interface CreditLedgerPresentationInput {
  amount?: number | string | null;
  type?: string | null;
  ledger_type?: string | null;
  counts_as_spend?: boolean | null;
  source_type?: string | null;
  description?: string | null;
  idempotency_key?: string | null;
}

const CREDIT_LEDGER_TYPES = new Set<CreditLedgerType>([
  'grant',
  'spend',
  'refund_clawback',
  'adjustment',
  'expiration',
]);

function toNumber(value: CreditLedgerPresentationInput['amount']): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function includesAny(value: string, needles: string[]): boolean {
  const normalizedValue = value.toLowerCase();
  return needles.some((needle) => normalizedValue.includes(needle.toLowerCase()));
}

function isAdminAdjustmentLedgerEntry(row: CreditLedgerPresentationInput): boolean {
  const description = row.description ?? '';
  const idempotencyKey = row.idempotency_key ?? '';
  return (
    row.source_type === 'admin' ||
    idempotencyKey.startsWith('admin_adjustment:') ||
    idempotencyKey.startsWith('admin_credit_deduction:') ||
    includesAny(description, ['管理员', 'admin', '调整', 'adjustment'])
  );
}

function isLegacyAiSpendLedgerEntry(row: CreditLedgerPresentationInput): boolean {
  const description = row.description ?? '';
  const idempotencyKey = row.idempotency_key ?? '';
  return (
    row.source_type === 'ai_task' ||
    idempotencyKey.startsWith('ai_spend:') ||
    includesAny(description, [
      'AI 对话消费',
      'AI 对话结算',
      'AI 对话中断结算',
      'ai task',
      'ai spend',
    ])
  );
}

export function normalizeCreditLedgerType(row: CreditLedgerPresentationInput): CreditLedgerType {
  if (row.ledger_type && CREDIT_LEDGER_TYPES.has(row.ledger_type as CreditLedgerType)) {
    return row.ledger_type as CreditLedgerType;
  }

  const amount = toNumber(row.amount);
  const type = row.type ?? '';
  const description = row.description ?? '';
  const idempotencyKey = row.idempotency_key ?? '';

  if (
    amount < 0 &&
    (
      row.source_type === 'stripe_refund' ||
      idempotencyKey.startsWith('stripe_refund:') ||
      includesAny(description, [
        'refund credit clawback',
        'stripe refund',
        '退款扣回',
        '订单退款扣除积分',
      ])
    )
  ) {
    return 'refund_clawback';
  }

  if (type === 'expiration') {
    return 'expiration';
  }

  if (isAdminAdjustmentLedgerEntry(row)) {
    return 'adjustment';
  }

  if (amount < 0 && (type === 'deduction' || type === 'consumption' || type === 'usage')) {
    if (isLegacyAiSpendLedgerEntry(row)) {
      return 'spend';
    }
    return 'adjustment';
  }

  if (
    amount > 0 &&
    (type === 'addition' || type === 'purchase' || type === 'bonus' || type === 'checkin' || type === 'membership')
  ) {
    return 'grant';
  }

  return 'adjustment';
}

export function countsAsCreditSpend(row: CreditLedgerPresentationInput): boolean {
  const ledgerType = normalizeCreditLedgerType(row);
  if (ledgerType === 'refund_clawback') {
    return false;
  }
  if (typeof row.counts_as_spend === 'boolean') {
    return row.counts_as_spend && ledgerType === 'spend';
  }
  return ledgerType === 'spend';
}

export function getCreditLedgerLabel(row: CreditLedgerPresentationInput): string {
  const ledgerType = normalizeCreditLedgerType(row);
  switch (ledgerType) {
    case 'grant':
      return '积分到账';
    case 'spend':
      return 'AI 使用消耗';
    case 'refund_clawback':
      return '退款扣回';
    case 'expiration':
      return '积分过期';
    case 'adjustment':
    default:
      return '系统调整';
  }
}

/**
 * The database writes its record descriptions in internal English (the turn, billing, research, payment, refund and dispute
 * functions under packages/db, and the older migrations whose rows are still in users' records). What the user reads
 * instead (walkthrough 2026-11-11, item 6; the validation of #1892 found the older ones). '' means no second line: the
 * record's own label ("AI 使用消耗") already says it. A refund or dispute note names what happened and no more; the amount
 * and the label beside it carry the rest. Any description not listed here is shown as written.
 */
const INTERNAL_RECORD_NOTES: Record<string, string> = {
  // An ordinary AI spend, under its several historical names.
  'AI turn': '',
  'AI turn freeze': '',
  'AI turn freeze top-up': '',
  'AI call consumption': '',
  'AI run consumption': '',
  // A spend that can be named.
  'Skill model call': '技能调用',
  'Workbench AI generation': '内容生成',
  'Workbench generation': '内容生成',
  'Workbench web search': '联网搜索',
  'Web search / social data lookup': '联网搜索和社媒数据查询',
  'Positioning report': '运营策略报告',
  'Expert review': '多模型专家评审团',
  // Held before a call and given back after it (the records page leaves most of these out).
  'Call reservation': '调用前预留',
  'Call reservation release': '预留退回',
  'Run reservation': '调用前预留',
  'Run reservation release': '预留退回',
  'Report hold': '运营策略报告预留',
  'Report hold release': '运营策略报告预留退回',
  'Expert review hold': '评审团预留',
  'Expert review hold release': '评审团预留退回',
  'Skill call not dispatched': '调用没有发出',
  'Workbench generation not dispatched': '调用没有发出',
  'Research cancelled before dispatch': '搜索在发出前已取消',
  'Research provider returned a terminal error': '搜索服务出错',
  // Given back, or not.
  'Confirmed failure compensation': '调用失败，积分已退回',
  'AI turn freeze not returned (subscription refunded or ended)': '冻结的积分没有退回（订阅已退款或已结束）',
  // Credits arriving.
  'Opening grant for new user profile bootstrap': '新用户赠送',
  'Opening grant already claimed by this identity': '新用户赠送已经领过',
  // BOT-GUARD (0526): the grant was refused for good; these rows carry 0 credits.
  'Opening grant refused: paused': '新用户赠送暂停中，这个账号没有赠送',
  'Opening grant refused: same IP': '这个网络 24 小时内已注册多个账号，这个账号没有赠送',
  'Opening grant refused: daily cap': '当天的新用户赠送已经送完，这个账号没有赠送',
  'Paid credit package': '购买积分包',
  'Membership paid period': '会员积分',
  // Refunds and payment disputes.
  'Approved package refund': '积分包退款',
  // The database writes this for every externally recorded refund, WeChat Pay and Alipay ones too: it names no payment method.
  'External card refund': '订单退款',
  'Refunded credit pack settled': '积分包退款',
  'Refunded credit pack settled (returned reservation)': '积分包退款',
  'Refunded dispute reservation return': '争议订单退款',
  'Failed cash refund credit restoration': '退款没有成功，积分已恢复',
  'Payment dispute hold': '付款争议处理中，积分暂时冻结',
  // pay_dispute_withdraw: an administrator lifts the hold and the credits come back; the dispute itself may still be open.
  'Payment dispute hold withdrawn': '付款争议的冻结已撤销，积分已恢复',
  'Payment dispute in-flight adjustment': '付款争议期间的调整',
};
/** Descriptions that end in internal ids ("… [order:… refund:…]"): matched by how they begin; the longer beginning first. */
const INTERNAL_RECORD_NOTE_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ['Stripe subscription refund credit clawback', '会员退款'],
  ['Stripe refund credit clawback', '订单退款'],
];

export function creditRecordNote(description: string | null | undefined): string {
  const text = (description ?? '').trim();
  if (Object.hasOwn(INTERNAL_RECORD_NOTES, text)) return INTERNAL_RECORD_NOTES[text]!;
  return INTERNAL_RECORD_NOTE_PREFIXES.find(([start]) => text.startsWith(start))?.[1] ?? text;
}
