import { TRPCError } from '@trpc/server';

export function createSafeInternalError(
  cause: unknown,
  message = '操作失败，请稍后重试',
) {
  return new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message,
    cause,
  });
}
