import { TRPCError } from '@trpc/server';
import { describe, expect, it, vi } from 'vitest';
import { logger } from '../lib/logger';
import { creditsRouter } from './credits';

function createProfileSupabase(role: 'user' | 'admin', credits = 123) {
  return {
    from(table: string) {
      if (table !== 'profiles') {
        throw new Error(`Unexpected user-scoped table ${table}`);
      }

      let selection = '';

      return {
        select(value: string) {
          selection = value;
          return this;
        },
        eq() {
          return this;
        },
        single() {
          if (selection === 'credits') {
            return Promise.resolve({
              data: { credits },
              error: null,
            });
          }

          return Promise.resolve({
            data: {
              id: `${role}-1`,
              role,
              status: 'active',
              nickname: role,
              email: `${role}@example.com`,
              credits,
            },
            error: null,
          });
        },
      };
    },
  };
}

function createBalanceSupabase(options: {
  credits?: unknown;
  data?: Record<string, unknown> | null;
  error?: { code?: string; message?: string } | null;
  thrown?: unknown;
} = {}) {
  return {
    from(table: string) {
      if (table !== 'profiles') {
        throw new Error(`Unexpected balance table ${table}`);
      }

      let selection = '';
      return {
        select(value: string) {
          selection = value;
          return this;
        },
        eq() {
          return this;
        },
        single() {
          if (selection !== 'credits') {
            return Promise.resolve({
              data: {
                id: 'user-1',
                role: 'user',
                status: 'active',
                nickname: 'User',
                email: 'user@example.com',
                credits: 123,
                membership_level: 'free',
                created_at: '2026-07-19T00:00:00.000Z',
              },
              error: null,
            });
          }
          if (options.thrown !== undefined) {
            return Promise.reject(options.thrown);
          }

          const data = 'data' in options
            ? options.data
            : { credits: 'credits' in options ? options.credits : 123 };
          return Promise.resolve({
            data,
            error: options.error ?? null,
          });
        },
      };
    },
  };
}

function createCreditTransactionsSupabase(
  rows: Array<Record<string, unknown>> = [],
  error: Record<string, unknown> | null = null,
) {
  const result = Promise.resolve({
    data: error ? null : rows,
    error,
    count: error ? null : rows.length,
  });

  return {
    from(table: string) {
      if (table !== 'credit_transactions') {
        throw new Error(`Unexpected table ${table}`);
      }

      return {
        select() {
          return this;
        },
        eq() {
          return this;
        },
        order() {
          return this;
        },
        limit() {
          return this;
        },
        lt() {
          return this;
        },
        gte() {
          return this;
        },
        lte() {
          return this;
        },
        then: result.then.bind(result),
        catch: result.catch.bind(result),
        finally: result.finally.bind(result),
      };
    },
  };
}

function createCreditsCaller(args: {
  role?: 'user' | 'admin';
  supabase?: any;
  supabaseAdmin?: any;
}) {
  const role = args.role ?? 'user';
  const userScopedSupabase = args.supabase ?? createProfileSupabase(role);

  return creditsRouter.createCaller({
    headers: new Headers(),
    user: {
      id: `${role}-1`,
      email: `${role}@example.com`,
      app_metadata: { provider: 'email' },
      user_metadata: { email_verified: true },
    },
    isEmailVerified: true,
    authProvider: 'email',
    supabase: userScopedSupabase,
    supabaseAuth: userScopedSupabase,
    supabasePublic: {},
    supabaseAdmin: args.supabaseAdmin ?? {},
    hasSupabaseAdminPrivileges: true,
  } as any);
}

describe('creditsRouter permissions', () => {
  it('does not expose balance writes that bypass the credit ledger function', () => {
    const procedures = Object.keys(creditsRouter._def.procedures);
    for (const name of ['addCredits', 'deductCredits', 'checkSufficientCredits']) {
      expect(procedures).not.toContain(name);
    }
  });

  it('allows ordinary users to read their balance', async () => {
    const caller = createCreditsCaller({ role: 'user' });

    await expect(caller.getBalance()).resolves.toMatchObject({
      credits: 123,
    });
  });

  it('preserves a real zero balance as a successful ready value', async () => {
    const caller = createCreditsCaller({
      supabase: createBalanceSupabase({ credits: 0 }),
    });

    await expect(caller.getBalance()).resolves.toMatchObject({ credits: 0 });
  });

  it.each([
    ['query error', createBalanceSupabase({ error: { code: '42501', message: 'private database detail' } })],
    ['profile missing', createBalanceSupabase({ data: null })],
    ['null balance', createBalanceSupabase({ credits: null })],
    ['undefined balance', createBalanceSupabase({ credits: undefined })],
    ['string balance', createBalanceSupabase({ credits: '0' })],
    ['NaN balance', createBalanceSupabase({ credits: Number.NaN })],
    ['infinite balance', createBalanceSupabase({ credits: Number.POSITIVE_INFINITY })],
    ['fractional balance', createBalanceSupabase({ credits: 1.5 })],
    ['negative balance', createBalanceSupabase({ credits: -1 })],
    ['thrown network failure', createBalanceSupabase({ thrown: new TypeError('private network detail') })],
  ])('returns a safe unavailable error for %s', async (_name, supabase) => {
    const caller = createCreditsCaller({ supabase });

    const error = await caller.getBalance().catch((caught) => caught as TRPCError);
    expect(error).toMatchObject<Partial<TRPCError>>({
      code: 'SERVICE_UNAVAILABLE',
      message: '余额暂时无法验证，请稍后重试',
    });
    expect(error.message).not.toMatch(/private database detail|private network detail/);
  });

  it('allows ordinary users to read their credit transactions', async () => {
    const supabase = {
      from(table: string) {
        if (table === 'profiles') {
          return createProfileSupabase('user').from(table);
        }
        return createCreditTransactionsSupabase([
          {
            id: 'txn-1',
            amount: -5,
            type: 'deduction',
            description: 'AI 对话消费',
            created_at: '2026-05-09T00:00:00.000Z',
          },
          {
            id: 'txn-2',
            amount: -20,
            type: 'deduction',
            description: 'Stripe refund credit clawback [refund:re_test]',
            idempotency_key: 'stripe_refund:re_test',
            created_at: '2026-05-10T00:00:00.000Z',
          },
        ]).from(table);
      },
    };
    const caller = createCreditsCaller({ role: 'user', supabase });

    await expect(caller.getCreditTransactions({ limit: 20 })).resolves.toMatchObject({
      items: [
        {
          id: 'txn-1',
          amount: -5,
          type: 'deduction',
          ledger_type: 'spend',
          counts_as_spend: true,
        },
        {
          id: 'txn-2',
          amount: -20,
          type: 'deduction',
          ledger_type: 'refund_clawback',
          counts_as_spend: false,
        },
      ],
      totalCount: 2,
    });
  });

  it('summarizes monthly spend with credit ledger v2 semantics', async () => {
    const supabase = {
      from(table: string) {
        if (table === 'profiles') {
          return createProfileSupabase('user').from(table);
        }
        return createCreditTransactionsSupabase([
          { id: 'txn-grant', amount: 100, type: 'purchase', ledger_type: 'grant', counts_as_spend: false },
          { id: 'txn-spend', amount: -40, type: 'deduction', ledger_type: 'spend', counts_as_spend: true },
          { id: 'txn-refund-clawback', amount: -25, type: 'deduction', ledger_type: 'refund_clawback', counts_as_spend: false },
          { id: 'txn-adjustment', amount: -5, type: 'deduction', ledger_type: 'adjustment', counts_as_spend: false },
          {
            id: 'txn-positive-admin-adjustment',
            amount: 25,
            type: 'addition',
            description: '[Admin] manual top-up',
            idempotency_key: 'admin_adjustment:admin-1:user-1:request-1',
          },
          { id: 'txn-legacy-spend', amount: -10, type: 'deduction', description: 'AI 对话消费' },
          {
            id: 'txn-legacy-refund-clawback',
            amount: -50,
            type: 'deduction',
            description: 'Stripe refund credit clawback [refund:re_legacy]',
            idempotency_key: 'stripe_refund:re_legacy',
          },
        ]).from(table);
      },
    };
    const caller = createCreditsCaller({ role: 'user', supabase });

    await expect(caller.getCreditsSummary({ period: 'month' })).resolves.toMatchObject({
      totalEarned: 100,
      totalSpent: 50,
      transactionCount: 7,
      byLedgerType: {
        grant: { count: 1, amount: 100 },
        spend: { count: 2, amount: -50 },
        refund_clawback: { count: 2, amount: -75 },
        adjustment: { count: 2, amount: 20 },
      },
    });
  });

  it('reports the summary as unavailable instead of fabricated zeros when the ledger read fails', async () => {
    const logSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const supabase = {
      from(table: string) {
        if (table === 'profiles') {
          return createProfileSupabase('user').from(table);
        }
        return createCreditTransactionsSupabase([], {
          code: '57014',
          message: 'private timeout detail for user@example.com',
        }).from(table);
      },
    };
    const caller = createCreditsCaller({ role: 'user', supabase });

    await expect(caller.getCreditsSummary({ period: 'month' })).rejects.toMatchObject<Partial<TRPCError>>({
      code: 'SERVICE_UNAVAILABLE',
      message: '积分汇总暂时无法读取，请稍后重试',
    });
    expect(logSpy).toHaveBeenCalledWith('billing', 'credits_summary_query_failed', { code: '57014' });
    expect(JSON.stringify(logSpy.mock.calls)).not.toContain('user@example.com');
    logSpy.mockRestore();
  });
});
