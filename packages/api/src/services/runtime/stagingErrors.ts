/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { randomUUID } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { logger } from '../../lib/logger';
import { DatabaseReadError } from '../../lib/databaseReadError';

const failures = {
  RUNTIME_FROZEN_PAYLOAD_TOO_LARGE: ['BAD_REQUEST', 'RUNTIME_FROZEN_PAYLOAD_TOO_LARGE：本轮内容超过可保存的容量，请缩短本轮输入后重试；未发起模型调用或扣费。'],
  RUNTIME_FROZEN_PAYLOAD_INVALID: ['BAD_REQUEST', 'RUNTIME_FROZEN_PAYLOAD_INVALID：本轮内容包含无法保存的字符，请检查输入；未发起模型调用或扣费。'],
  RUNTIME_BUDGET_CONFIG_UNAVAILABLE: ['SERVICE_UNAVAILABLE', '暂时无法读取用途预算，请稍后重试。'],
  RUNTIME_BUDGET_CONFIG_INVALID: ['PRECONDITION_FAILED', '用途预算配置无效，请管理员检查设置。'],
  RUNTIME_REASONING_NOT_CONFIGURED: ['PRECONDITION_FAILED', '请在后台为这个模型设置“交互对话”的思考方式。'],
  RUNTIME_REASONING_ROUTE_MISMATCH: ['PRECONDITION_FAILED', '后台思考设置的供应商线路与测试窗口报价不一致，请管理员核对完整线路。'],
  RUNTIME_REASONING_CONFIG_INVALID: ['PRECONDITION_FAILED', '模型思考设置不可用，请管理员核对目录、用途、线路能力与输出上限。'],
  RUNTIME_STAGING_INTERNAL_ERROR: ['INTERNAL_SERVER_ERROR', '工作空间读取或操作失败，请稍后重试。'],
  RUNTIME_STAGING_NOT_CONFIGURED: ['PRECONDITION_FAILED', '当前工作空间尚未配置开放条件，请联系管理员。'],
  RUNTIME_STAGING_DISABLED: ['PRECONDITION_FAILED', '当前测试窗口尚未开放或已关闭。'],
  RUNTIME_STAGING_TARGET_DENIED: ['FORBIDDEN', '当前环境不允许访问此工作空间。'],
  RUNTIME_STAGING_AUTH_REFRESH_REQUIRED: ['PRECONDITION_FAILED', '登录会话剩余时间不足，请重新登录后继续原请求。'],
  RUNTIME_STAGING_ACTOR_DENIED: ['FORBIDDEN', '当前登录账号未获准访问此测试工作空间。'],
  RUNTIME_STAGING_POLICY_DENIED: ['PRECONDITION_FAILED', '当前账号没有可用的测试窗口：窗口未开放、已关闭、已过期或账号未获准。'],
  RUNTIME_STAGING_WINDOW_EXPIRED: ['PRECONDITION_FAILED', '当前测试窗口已过期。'],
  RUNTIME_STAGING_RECOVERY_DENIED: ['FORBIDDEN', '当前账号无法恢复此工作。'],
  RUNTIME_STAGING_SERVICE_UNAVAILABLE: ['SERVICE_UNAVAILABLE', '工作空间服务暂不可用，请稍后重试。'],
  RUNTIME_STAGING_SCHEMA_UNAVAILABLE: ['SERVICE_UNAVAILABLE', '工作空间服务尚未就绪，请联系管理员。'],
  RUNTIME_STAGING_MODEL_NOT_APPROVED: ['PRECONDITION_FAILED', '本次操作所需模型尚未获准用于当前测试窗口，请联系管理员。'],
  RUNTIME_STAGING_MODEL_DENIED: ['SERVICE_UNAVAILABLE', '当前测试模型配置暂不可用，请联系管理员。'],
  RUNTIME_STAGING_QUOTE_CONFLICT: ['SERVICE_UNAVAILABLE', '当前测试模型配置暂不可用，请联系管理员。'],
  RUNTIME_STAGING_POLICY_INVALID: ['SERVICE_UNAVAILABLE', '当前测试窗口配置暂不可用，请联系管理员。'],
  RUNTIME_BILLING_UNIT_UNAVAILABLE: ['SERVICE_UNAVAILABLE', '计费配置暂不可用，新的收费已暂停，请稍后重试。'],
  RUNTIME_BILLING_UNIT_MISMATCH: ['PRECONDITION_FAILED', '测试窗口的每美元积分数或模型加价倍数与后台配置不一致，请管理员核对。'],
  RUNTIME_BILLING_UNIT_WINDOW_OUTDATED: ['PRECONDITION_FAILED', '当前测试窗口还没有按模型的加价倍数，需要管理员按新计费重新建立窗口。'],
  RUNTIME_PRICE_SNAPSHOT_MISSING: ['PRECONDITION_FAILED', '这个模型还没有可用的 OpenRouter 价格，或线路与价格不一致，请管理员在后台重新读取价格并核对线路。'],
  RUNTIME_PRICE_SNAPSHOT_STALE: ['PRECONDITION_FAILED', '模型价格太久没更新，暂时无法核对，请稍后重试或请管理员在后台重新读取。'],
  RUNTIME_PRICE_INCREASED: ['PRECONDITION_FAILED', '供应商价格已上涨，超过已批准的报价，这个模型需要重新批准报价后才能继续使用。'],
  RUNTIME_PRICE_UNKNOWN_FIELD: ['PRECONDITION_FAILED', '供应商价格里出现了系统还不认识的收费项，这个模型暂停使用，等待系统更新。'],
} as const;
export type StagingFailure = keyof typeof failures;
export class StagingAccessError extends Error {
  constructor(readonly reason: StagingFailure, readonly databaseCode?: string) { super(reason); }
}

/** Only recognize the exact database-owned denial; permission/schema/transport
 * failures are operational failures, never proof that the actor was refused. */
function databaseFailure(error: {code?: string}): StagingAccessError {
  const code = new DatabaseReadError('', error.code).databaseCode;
  if (['PGRST202', 'PGRST205', '42883', '42P01', '42703'].includes(code ?? ''))
    return new StagingAccessError('RUNTIME_STAGING_SCHEMA_UNAVAILABLE', code);
  const unavailable = !code || ['42501', '28000', '28P01', '57014', '57P01', '57P02', '57P03', 'PGRST301', 'PGRST302', 'PGRST303'].includes(code) || /^(08|53|PGRST0)/.test(code);
  return new StagingAccessError(unavailable ? 'RUNTIME_STAGING_SERVICE_UNAVAILABLE' : 'RUNTIME_STAGING_INTERNAL_ERROR', code);
}
export function stagingRpcFailure(error: { code?: string; message?: string }, denial?: string, reason?: StagingFailure): never {
  if (reason && denial && error.code === '42501' && error.message === denial) throw new StagingAccessError(reason);
  throw databaseFailure(error);
}

/** No raw exception, credential, actor ID, SQL or business body reaches logs. */
export function stagingProcedureError(cause: unknown, path: string): TRPCError {
  const original = cause instanceof TRPCError ? cause.cause : cause;
  const failure = original instanceof StagingAccessError ? original
    : original instanceof DatabaseReadError ? databaseFailure({code: original.databaseCode}) : null;
  if (!failure && cause instanceof TRPCError && cause.code !== 'INTERNAL_SERVER_ERROR') return cause;
  const diagnosticId = randomUUID();
  const reason = failure?.reason ?? 'UNEXPECTED_SERVER_ERROR';
  const mapped = failure ? failures[failure.reason] : null;
  const details = { path, diagnosticId, reason, ...(failure?.databaseCode ? { databaseCode: failure.databaseCode } : {}) };
  if (mapped && (mapped[0] === 'PRECONDITION_FAILED' || mapped[0] === 'FORBIDDEN')) logger.info('api', 'staging_access_refused', details);
  else logger.error('api', 'staging_service_failed', details);
  return new TRPCError({
    code: mapped?.[0] ?? 'INTERNAL_SERVER_ERROR',
    message: mapped && (mapped[0] === 'PRECONDITION_FAILED' || mapped[0] === 'FORBIDDEN') ? mapped[1]
      : `${mapped?.[1] ?? '工作空间读取或操作失败，请稍后重试。'}（诊断编号：${diagnosticId}）`,
  });
}
