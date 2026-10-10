import { TRPCError, type TRPCDefaultErrorShape } from '@trpc/server';
import { runtimeGateMessages, type RuntimeGateMessage } from '../shared/runtimeGateMessages';

/** Safe public rejection shared by the service and its transport adapters. */
export class RateLimitError extends TRPCError {
  readonly retryAfter: number;
  readonly businessCode?: 'RUNTIME_NEW_CALLS_STOPPED';
  constructor(reason: 'unavailable' | 'rate_limited', retryAfter = 60, message?: RuntimeGateMessage) {
    const seconds = Number.isSafeInteger(retryAfter) && retryAfter > 0 ? retryAfter : 60;
    super({
      code: reason === 'unavailable' ? 'SERVICE_UNAVAILABLE' : 'TOO_MANY_REQUESTS',
      message: message ? runtimeGateMessages[message] : reason === 'unavailable' ? '服务暂时繁忙，请稍后再试'
        : `请求过于频繁，请在 ${seconds} 秒后重试`,
      cause: { retryAfter: seconds },
    });
    this.retryAfter = seconds;
    this.businessCode = message === 'paused' ? 'RUNTIME_NEW_CALLS_STOPPED' : undefined;
  }
}

/** Only serialize the safe retry hint, never arbitrary internal cause details. */
export function rateLimitErrorFormatter({ shape, error }: {
  shape: TRPCDefaultErrorShape;
  error: TRPCError;
}) {
  const limit = error instanceof RateLimitError ? error : error.cause instanceof RateLimitError ? error.cause : undefined;
  return {
    ...shape,
    data: { ...shape.data, ...(limit ? { retryAfter: limit.retryAfter,
      ...(limit.businessCode ? { businessCode: limit.businessCode } : {}) } : {}) },
  };
}
