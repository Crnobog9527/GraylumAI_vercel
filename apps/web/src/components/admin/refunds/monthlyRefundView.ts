/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

// Mirrors the input checks of admin.quoteMonthlyRefund so obvious typos fail before a
// server round trip; the server stays the authority for every rule.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FEE_EVIDENCE_PATTERN = /^[A-Za-z0-9:._/-]{1,160}$/;

export type FeePermitted = 'confirmed' | 'not_permitted';
export type MonthlyRefundForm = { orderId: string; ticketId: string; feePermitted: FeePermitted | ''; feeEvidence: string };
export type MonthlyRefundRequest = { orderId: string; ticketId: string; feePermitted: FeePermitted; feeEvidence: string };
export type RejectReason = 'ineligible' | 'evidence_missing' | 'customer_withdrew';

export const EMPTY_MONTHLY_REFUND_FORM: MonthlyRefundForm = { orderId: '', ticketId: '', feePermitted: '', feeEvidence: '' };

export type RefundFormScope = 'quote' | 'status' | 'reject';
type FormErrors = Partial<Record<keyof MonthlyRefundForm, string>>;
const SCOPE_FIELDS: Record<RefundFormScope, Array<keyof MonthlyRefundForm>> = {
  quote: ['orderId', 'ticketId', 'feePermitted', 'feeEvidence'],
  status: ['orderId'],
  reject: ['orderId', 'ticketId'],
};

function fieldError(field: keyof MonthlyRefundForm, form: MonthlyRefundForm): string | null {
  if (field === 'orderId' && !UUID_PATTERN.test(form.orderId.trim())) return '请填写完整的订单编号（支付订单页里的"订单"一行）';
  if (field === 'ticketId' && !UUID_PATTERN.test(form.ticketId.trim())) return '请填写完整的工单编号（这位用户提交的账单类工单）';
  if (field === 'feePermitted' && form.feePermitted !== 'confirmed' && form.feePermitted !== 'not_permitted') {
    return '请先确认当地法律是否允许扣手续费';
  }
  if (field === 'feeEvidence' && !FEE_EVIDENCE_PATTERN.test(form.feeEvidence.trim())) {
    return '请填写核对依据的编号，只能用英文字母、数字和 : . _ / -，最多 160 个字符';
  }
  return null;
}

/** Checks only the fields the chosen action sends; the server's own input checks stay authoritative. */
export function validateRefundFields(form: MonthlyRefundForm, scope: RefundFormScope): FormErrors {
  const errors: FormErrors = {};
  for (const field of SCOPE_FIELDS[scope]) {
    const error = fieldError(field, form);
    if (error) errors[field] = error;
  }
  return errors;
}

export function validateMonthlyRefundForm(form: MonthlyRefundForm):
  | { ok: true; request: MonthlyRefundRequest }
  | { ok: false; errors: FormErrors } {
  const errors = validateRefundFields(form, 'quote');
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, request: { orderId: form.orderId.trim(), ticketId: form.ticketId.trim(),
    feePermitted: form.feePermitted as FeePermitted, feeEvidence: form.feeEvidence.trim() } };
}

/** The rules the server checked before it returned a quote; a quote only exists when all pass. */
export const MONTHLY_REFUND_RULES = [
  '这是该账号第一次购买 Pro 或 Gold 月付会员，不是续费',
  '付款后 7 天内提交了退款工单',
  '从这次付款起，整个账户没有用过任何积分',
  '只在测试模式（Stripe 沙盒）下处理',
] as const;

export const FEE_PERMITTED_LABELS: Record<FeePermitted, string> = {
  confirmed: '法律允许，扣 6% 手续费',
  not_permitted: '法律不允许，不扣手续费',
};

export const REJECT_REASON_LABELS: Record<RejectReason, string> = {
  ineligible: '不符合退款条件',
  evidence_missing: '证据不足，无法核实',
  customer_withdrew: '用户撤回了申请',
};

const STATUS_LABELS: Record<string, string> = {
  approved: '已批准，等待执行',
  review_required: '执行中或需要人工核对',
  succeeded: '退款成功',
  failed: '退款失败，权益已恢复',
  rejected: '已拒绝',
};

const HOLD_LABELS: Record<string, string> = {
  none: '未冻结',
  held: '会员权益和积分已暂停',
  released: '已恢复',
  terminated: '订阅已结束',
};

const STAGE_LABELS: Record<string, string> = {
  stop_renewal: '停止自动续费',
  refund: '向支付商发起退款',
  cancel: '取消订阅',
  restore_renewal: '恢复自动续费',
};

const EXECUTE_REASON_LABELS: Record<string, string> = {
  recorded_cash_conflict: '支付商的退款记录和本地记录对不上，已停止自动处理，需要人工核对',
  bounded_reconciliation: '这一轮没有处理完，可以稍后再点一次"继续执行"',
  monthly_refund_requires_reconciliation: '执行中遇到不确定的结果，已停止自动处理；请先查看进度，再决定是否继续执行',
};

export const PLAN_LABELS: Record<string, string> = { pro: 'Pro', gold: 'Gold' };

export function monthlyRefundStatusLabel(status: unknown) {
  return typeof status === 'string' && STATUS_LABELS[status] ? STATUS_LABELS[status] : '未知状态';
}

export function monthlyRefundHoldLabel(hold: unknown) {
  return typeof hold === 'string' && HOLD_LABELS[hold] ? HOLD_LABELS[hold] : '—';
}

export function rejectReasonLabel(reason: unknown) {
  return typeof reason === 'string' && reason in REJECT_REASON_LABELS ? REJECT_REASON_LABELS[reason as RejectReason] : '—';
}

export function executeReasonLabel(reason: unknown) {
  if (typeof reason === 'string' && EXECUTE_REASON_LABELS[reason]) return EXECUTE_REASON_LABELS[reason];
  return '需要人工核对，请先查看进度';
}

/** Ordered stage list for the status card; a stage without a timestamp has not started. */
export function monthlyRefundStages(started: unknown) {
  const record = started && typeof started === 'object' ? started as Record<string, unknown> : {};
  return Object.keys(STAGE_LABELS).map(key => ({
    key, label: STAGE_LABELS[key], startedAt: typeof record[key] === 'string' ? record[key] as string : null,
  }));
}

/** Only an approved intent that has not been finished or rejected can be executed. */
export function canExecuteMonthlyRefund(intent: { status?: unknown; id?: unknown } | null | undefined) {
  return !!intent && typeof intent.id === 'string'
    && (intent.status === 'approved' || intent.status === 'review_required');
}

/** Rejection is refused by the server once execution has claimed the order. */
export function canRejectMonthlyRefund(intent: { status?: unknown; claimedAt?: unknown } | null | undefined) {
  if (!intent) return true;
  return !intent.claimedAt && intent.status !== 'rejected' && intent.status !== 'succeeded' && intent.status !== 'failed';
}

export function formatRefundTime(value: unknown) {
  if (typeof value !== 'string' || !value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(date);
}
