import { TRPCError } from '@trpc/server';
import { describe, expect, it } from 'vitest';
import { checkIdempotency, creditsRouter } from './credits';

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

function createCreditTransactionsSupabase(rows: Array<Record<string, unknown>> = []) {
  const result = Promise.resolve({
    data: rows,
    error: null,
    count: rows.length,
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

function createAdminMutationSupabase(options: { startingCredits?: number } = {}) {
  const startingCredits = options.startingCredits ?? 100;

  return {
    from(table: string) {
      if (table === 'profiles') {
        return {
          select() {
            return this;
          },
          eq() {
            return this;
          },
          single() {
            return Promise.resolve({
              data: { credits: startingCredits, updated_at: '2026-05-09T00:00:00.000Z' },
              error: null,
            });
          },
          update() {
            return this;
          },
        };
      }

      if (table === 'credit_transactions') {
        return {
          insert(payload: { amount: number }) {
            return {
              select() {
                return this;
              },
              single() {
                return Promise.resolve({
                  data: {
                    id: 'txn-1',
                    amount: payload.amount,
                  },
                  error: null,
                });
              },
            };
          },
        };
      }

      throw new Error(`Unexpected admin table ${table}`);
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
  it('rejects ordinary users calling addCredits', async () => {
    const caller = createCreditsCaller({ role: 'user' });

    await expect(caller.addCredits({ amount: 10 })).rejects.toMatchObject<Partial<TRPCError>>({
      code: 'FORBIDDEN',
    });
  });

  it('rejects ordinary users calling deductCredits', async () => {
    const caller = createCreditsCaller({ role: 'user' });

    await expect(caller.deductCredits({ amount: 10 })).rejects.toMatchObject<Partial<TRPCError>>({
      code: 'FORBIDDEN',
    });
  });

  it('allows admins to call addCredits and enter the existing mutation logic', async () => {
    const adminSupabase = createAdminMutationSupabase({ startingCredits: 100 });
    const caller = createCreditsCaller({
      role: 'admin',
      supabaseAdmin: adminSupabase,
    });

    await expect(caller.addCredits({ amount: 25, reason: 'Admin top-up' })).resolves.toMatchObject({
      success: true,
      previousCredits: 100,
      newCredits: 125,
      amountAdded: 25,
    });
  });

  it('allows admins to call deductCredits and enter the existing mutation logic', async () => {
    const adminSupabase = createAdminMutationSupabase({ startingCredits: 100 });
    const caller = createCreditsCaller({
      role: 'admin',
      supabaseAdmin: adminSupabase,
    });

    await expect(caller.deductCredits({ amount: 25, reason: 'Admin deduction' })).resolves.toMatchObject({
      success: true,
      previousCredits: 100,
      newCredits: 75,
      amountDeducted: 25,
    });
  });

  it('allows ordinary users to read their balance', async () => {
    const caller = createCreditsCaller({ role: 'user' });

    await expect(caller.getBalance()).resolves.toMatchObject({
      credits: 123,
    });
  });

  it('allows ordinary users to read their credit transactions', async () => {
    const supabase = {
      from(table: string) {
        if (table === 'profiles') {
          return createProfileSupabase('user').from(table);
        }
        return createCreditTransactionsSupabase([
          { id: 'txn-1', amount: -5, type: 'deduction', created_at: '2026-05-09T00:00:00.000Z' },
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
      transactionCount: 6,
      byLedgerType: {
        grant: { count: 1, amount: 100 },
        spend: { count: 2, amount: -50 },
        refund_clawback: { count: 2, amount: -75 },
        adjustment: { count: 1, amount: -5 },
      },
    });
  });
});

describe('checkIdempotency', () => {
  it('returns an existing transaction when the idempotency key is already recorded', async () => {
    const supabase = {
      from(table: string) {
        expect(table).toBe('credit_transactions');
        return {
          select(selection: string) {
            expect(selection).toBe('id');
            return this;
          },
          eq(column: string, value: string) {
            expect(['user_id', 'idempotency_key']).toContain(column);
            if (column === 'user_id') {
              expect(value).toBe('user-1');
            }
            if (column === 'idempotency_key') {
              expect(value).toBe('idem-1');
            }
            return this;
          },
          maybeSingle() {
            return Promise.resolve({
              data: { id: 'txn-1' },
              error: null,
            });
          },
        };
      },
    };

    await expect(checkIdempotency(supabase, 'user-1', 'idem-1')).resolves.toEqual({
      exists: true,
      transactionId: 'txn-1',
    });
  });

  it('returns exists false when no transaction is recorded for the idempotency key', async () => {
    const supabase = {
      from() {
        return {
          select() {
            return this;
          },
          eq() {
            return this;
          },
          maybeSingle() {
            return Promise.resolve({
              data: null,
              error: null,
            });
          },
        };
      },
    };

    await expect(checkIdempotency(supabase, 'user-1', 'idem-miss')).resolves.toEqual({
      exists: false,
    });
  });

  it('sanitizes storage errors during idempotency checks', async () => {
    const supabase = {
      from() {
        return {
          select() {
            return this;
          },
          eq() {
            return this;
          },
          maybeSingle() {
            return Promise.resolve({
              data: null,
              error: { message: 'column idempotency_key does not exist' },
            });
          },
        };
      },
    };

    await expect(checkIdempotency(supabase, 'user-1', 'idem-fail')).rejects.toMatchObject<Partial<TRPCError>>({
      code: 'INTERNAL_SERVER_ERROR',
      message: '积分操作校验失败，请稍后重试',
    });
  });
});
