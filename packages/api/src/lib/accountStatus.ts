import { TRPCError } from '@trpc/server';

export type UserStatus = 'active' | 'disabled' | 'banned' | 'deleted';

/** Unknown values stay 'active' for legacy rows; 'deleted' is set only by account erasure. */
export function normalizeUserStatus(status: unknown): UserStatus {
  if (status === 'disabled' || status === 'banned' || status === 'deleted') {
    return status;
  }

  return 'active';
}

export const ACCOUNT_CLOSED_MESSAGE = 'ACCOUNT_CLOSED: 账号已注销';

/** Rejects every status that must not use the product. */
export function assertUsableUserStatus(status: UserStatus): void {
  if (status === 'disabled') {
    throw new TRPCError({ code: 'FORBIDDEN', message: '账号已被禁用，请联系管理员' });
  }
  if (status === 'banned') {
    throw new TRPCError({ code: 'FORBIDDEN', message: '账号已被封禁' });
  }
  if (status === 'deleted') {
    throw new TRPCError({ code: 'FORBIDDEN', message: ACCOUNT_CLOSED_MESSAGE });
  }
}
