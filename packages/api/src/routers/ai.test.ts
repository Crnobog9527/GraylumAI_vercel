import { TRPCError } from '@trpc/server';
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const billingState = vi.hoisted(() => ({
  settleAbort: vi.fn(),
  recordUsageLog: vi.fn(),
}));

vi.mock('../services', async () => {
  const actual = await vi.importActual<typeof import('../services')>('../services');

  class BillingService {
    settleAbort = billingState.settleAbort;
    recordUsageLog = billingState.recordUsageLog;
  }

  return {
    ...actual,
    BillingService,
  };
});

import { aiRouter } from './ai';

function createSingleQueryBuilder(result: Promise<unknown>) {
  return {
    select() {
      return this;
    },
    eq() {
      return this;
    },
    single() {
      return result;
    },
  };
}

function createProtectedCaller(supabase: { from(table: string): unknown }) {
  return aiRouter.createCaller({
    headers: new Headers(),
    user: {
      id: 'user-1',
      email: 'user@example.com',
      app_metadata: { provider: 'email' },
      user_metadata: { email_verified: true },
    },
    isEmailVerified: true,
    authProvider: 'email',
    supabase,
    supabaseAuth: supabase,
    supabasePublic: {},
    supabaseAdmin: {},
    hasSupabaseAdminPrivileges: true,
  } as any);
}

describe('aiRouter error sanitization', () => {
  it('does not use hardcoded estimateRequestCost in the non-stream router', () => {
    const source = readFileSync(new URL('./ai.ts', import.meta.url), 'utf8');

    expect(source).not.toContain('estimateRequestCost');
    expect(source).toContain('getBillingRuntimeSettings');
    expect(source).toContain('estimatePreDeductCredits');
  });

  it('sanitizes abortRequest settlement failures', async () => {
    billingState.settleAbort.mockRejectedValueOnce(
      new Error('relation ai_usage_logs does not exist'),
    );

    const supabase = {
      from(table: string) {
        if (table === 'profiles') {
          return createSingleQueryBuilder(
            Promise.resolve({
              data: {
                id: 'user-1',
                role: 'user',
                status: 'active',
                nickname: 'User',
                email: 'user@example.com',
              },
              error: null,
            }),
          );
        }

        throw new Error(`Unexpected table ${table}`);
      },
    };

    const caller = createProtectedCaller(supabase);

    await expect(
      caller.abortRequest({
        requestId: '123e4567-e89b-42d3-a456-426614174000',
        preDeductId: '123e4567-e89b-42d3-a456-426614174001',
        consumedTokens: {
          inputTokens: 10,
          outputTokens: 20,
        },
        modelId: 'claude-3-5-sonnet',
      }),
    ).rejects.toMatchObject<Partial<TRPCError>>({
      code: 'INTERNAL_SERVER_ERROR',
      message: '中断结算失败，请稍后重试',
    });
  });
});
