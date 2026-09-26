/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { randomUUID } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { logger } from '../../lib/logger';
import { DatabaseReadError } from '../../lib/databaseReadError';

const failures = {
  RUNTIME_STAGING_INTERNAL_ERROR: ['INTERNAL_SERVER_ERROR', '工作空间读取或操作失败，请稍后重试。'],
  RUNTIME_STAGING_NOT_CONFIGURED: ['PRECONDITION_FAILED', '当前工作空间尚未配置开放条件，请联系管理员。'],
  RUNTIME_STAGING_DISABLED: ['PRECONDITION_FAILED', '当前测试窗口尚未开放或已关闭。'],
  RUNTIME_STAGING_TARGET_DENIED: ['FORBIDDEN', '当前环境不允许访问此工作空间。'],
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
