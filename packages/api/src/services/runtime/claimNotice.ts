/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { BillingClaimRejection } from '../bill2/claimFailure';

const configuration = '计费配置待处理，暂时无法继续，请稍后重试或联系管理员。';
const conflict = '当前任务状态已变化，暂时无法继续，请刷新后查看原任务。';
const denied = '当前任务暂时无法继续，请检查账号状态或联系管理员。';
const notices: Readonly<Record<string, string>> = {
  BILL2_START_THRESHOLD_UNCONFIGURED: configuration,
  BILL2_PAYG_QUOTE_INVALID: configuration,
  BILL2_PAYG_BOUND_MISMATCH: configuration,
  BILL2_NOMINAL_BOUND_MISMATCH: configuration,
  BILL2_NOMINAL_PRICING_INVALID: configuration,
  BILL2_PAYG_METERING_BLOCKED: '费用核对中，暂时无法继续，请稍后查看原任务。',
  BILL2_CALL_BUDGET_OR_CONTRACT: '本次任务的可用额度或执行条件不满足，暂时无法继续。',
  BILL2_CALL_CONFLICT: conflict,
  BILL2_CALL_PENDING: '上一项调用仍在处理中，请稍后查看原任务。',
  BILL2_CALL_TOO_LARGE: '本次请求超出可用额度，请缩小请求后重试。',
  BILL2_DISPATCH_CLOSED: '当前任务已停止，无法继续执行，请查看原任务。',
  BILL2_RUN_DENIED: denied,
  BILL2_ACTOR_DENIED: denied,
  BILL2_POLICY_DENIED: denied,
  BILL2_PREDEDUCT_CONFLICT: '积分核对中，暂时无法继续，请稍后查看原任务。',
  RUNTIME_RESUME_CONFLICT: conflict,
  RUNTIME_CHECKPOINT_CONFLICT: conflict,
  RUNTIME_STOP_REQUESTED: '当前任务已停止，请查看已保留的结果。',
  RUNTIME_TEST_BUDGET_EXHAUSTED: '当前测试额度已用完，暂时无法继续，请联系管理员。',
  PRE_DEDUCT_GRANT_ACCOUNTING_REVIEW_REQUIRED: '积分核对中，暂时无法继续，请稍后查看原任务。',
  REPORT_MEMBERSHIP_REQUIRED: '当前会员权益不支持生成报告，请查看会员状态。',
  REPORT_ENTITLEMENTS_UNAVAILABLE: '暂时无法核对报告权益，请稍后重试。',
  REPORT_SOURCE_CONFLICT: '报告来源已变化，请刷新后重新选择。',
};

/** Latch only the billing service's verified denial, before the SDK wraps it. */
export function billingClaimNotice(error: unknown): string | undefined {
  return error instanceof BillingClaimRejection && Object.hasOwn(notices, error.reason)
    ? notices[error.reason] : undefined;
}

/** A credit wait is an explicit SQL outcome, never inferred from an exception. */
export function withClaimNotice<T extends { state: string; unavailable?: unknown; notice?: string }>(result: T): T & { notice?: string } {
  if (result.notice || result.unavailable || result.state !== 'waiting_credits') return result;
  return { ...result, notice: '余额不足，任务已暂停，请补充积分后继续。' };
}
