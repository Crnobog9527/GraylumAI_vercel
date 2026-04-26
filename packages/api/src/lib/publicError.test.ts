import { TRPCError } from '@trpc/server';
import { describe, expect, it } from 'vitest';
import { createSafeInternalError } from './publicError';

describe('createSafeInternalError', () => {
  it('uses the provided user-facing fallback message', () => {
    const cause = { message: 'duplicate key value violates unique constraint profiles_pkey' };

    const error = createSafeInternalError(cause, '保存失败，请稍后重试');

    expect(error).toBeInstanceOf(TRPCError);
    expect(error.code).toBe('INTERNAL_SERVER_ERROR');
    expect(error.message).toBe('保存失败，请稍后重试');
    expect(error.cause).toMatchObject(cause);
  });

  it('falls back to a generic safe message when none is provided', () => {
    const error = createSafeInternalError(new Error('raw database error'));

    expect(error.message).toBe('操作失败，请稍后重试');
  });
});
