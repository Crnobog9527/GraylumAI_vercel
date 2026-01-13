import { router, protectedProcedure } from '../../trpc';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';

// ============================================================================
// 类型定义
// ============================================================================

const TransactionType = z.enum([
  'purchase',
  'consumption',
  'refund',
  'bonus',
  'adjustment',
  'transfer_in',
  'transfer_out',
  'expiration',
]);

type TransactionType = z.infer<typeof TransactionType>;

const TransactionStatus = z.enum([
  'pending',
  'completed',
  'failed',
  'cancelled',
]);

// ============================================================================
// 输入验证 Schema
// ============================================================================

const DeductCreditsInput = z.object({
  amount: z.number().positive('扣除金额必须为正数').int('积分必须为整数'),
  reason: z.string().min(1).max(500).optional(),
  referenceId: z.string().optional(),
  referenceType: z.string().optional(),
  idempotencyKey: z.string().optional(),
});

const AddCreditsInput = z.object({
  amount: z.number().positive('添加金额必须为正数').int('积分必须为整数'),
  type: TransactionType.default('bonus'),
  reason: z.string().min(1).max(500).optional(),
  referenceId: z.string().optional(),
  referenceType: z.string().optional(),
  idempotencyKey: z.string().optional(),
});

const GetTransactionsInput = z.object({
  limit: z.number().min(1).max(100).default(20),
  cursor: z.string().optional(),
  type: TransactionType.optional(),
  status: TransactionStatus.optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
});

// ============================================================================
// 积分路由器（使用数据库 RPC 确保原子性）
// ============================================================================

export const creditsRouter = router({
  /**
   * 获取当前用户积分余额
   */
  getBalance: protectedProcedure.query(async ({ ctx }) => {
    const { data: profile, error } = await ctx.supabase
      .from('profiles')
      .select('credits, credits_expiring_soon, credits_expiry_date')
      .eq('id', ctx.user.id)
      .single();

    if (error || !profile) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: '用户资料不存在',
      });
    }

    return {
      credits: profile.credits ?? 0,
      creditsExpiringSoon: profile.credits_expiring_soon ?? 0,
      creditsExpiryDate: profile.credits_expiry_date,
    };
  }),

  /**
   * 扣除积分（使用数据库 RPC 确保原子性）
   * 
   * 这是生产环境推荐的方式，使用 PostgreSQL 事务保证原子性
   */
  deductCredits: protectedProcedure
    .input(DeductCreditsInput)
    .mutation(async ({ ctx, input }) => {
      const { amount, reason, referenceId, referenceType, idempotencyKey } = input;

      // 调用数据库 RPC 函数执行原子性操作
      const { data, error } = await ctx.supabase.rpc('deduct_credits_atomic', {
        p_user_id: ctx.user.id,
        p_amount: amount,
        p_reason: reason ?? null,
        p_reference_id: referenceId ?? null,
        p_reference_type: referenceType ?? null,
        p_idempotency_key: idempotencyKey ?? null,
      });

      if (error) {
        // 解析数据库错误
        const errorMessage = error.message || '积分扣除失败';
        
        if (errorMessage.includes('积分不足')) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: errorMessage,
          });
        }
        
        if (errorMessage.includes('用户不存在')) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: '用户资料不存在',
          });
        }

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: errorMessage,
        });
      }

      return {
        success: data.success,
        transactionId: data.transaction_id,
        previousCredits: data.previous_credits,
        newCredits: data.new_credits,
        amountDeducted: data.amount_deducted,
        message: data.message,
      };
    }),

  /**
   * 添加积分（使用数据库 RPC 确保原子性）
   */
  addCredits: protectedProcedure
    .input(AddCreditsInput)
    .mutation(async ({ ctx, input }) => {
      const { amount, type, reason, referenceId, referenceType, idempotencyKey } = input;

      // 调用数据库 RPC 函数执行原子性操作
      const { data, error } = await ctx.supabase.rpc('add_credits_atomic', {
        p_user_id: ctx.user.id,
        p_amount: amount,
        p_type: type,
        p_reason: reason ?? null,
        p_reference_id: referenceId ?? null,
        p_reference_type: referenceType ?? null,
        p_idempotency_key: idempotencyKey ?? null,
      });

      if (error) {
        const errorMessage = error.message || '积分添加失败';
        
        if (errorMessage.includes('用户不存在')) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: '用户资料不存在',
          });
        }

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: errorMessage,
        });
      }

      return {
        success: data.success,
        transactionId: data.transaction_id,
        previousCredits: data.previous_credits,
        newCredits: data.new_credits,
        amountAdded: data.amount_added,
        message: data.message,
      };
    }),

  /**
   * 获取积分交易记录（分页）
   */
  getCreditTransactions: protectedProcedure
    .input(GetTransactionsInput)
    .query(async ({ ctx, input }) => {
      const { limit, cursor, type, status, startDate, endDate } = input;

      let query = ctx.supabase
        .from('credit_transactions')
        .select('*', { count: 'exact' })
        .eq('user_id', ctx.user.id)
        .order('created_at', { ascending: false })
        .limit(limit + 1);

      if (type) query = query.eq('type', type);
      if (status) query = query.eq('status', status);
      if (startDate) query = query.gte('created_at', startDate);
      if (endDate) query = query.lte('created_at', endDate);
      if (cursor) query = query.lt('created_at', cursor);

      const { data: transactions, error, count } = await query;

      if (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: '获取交易记录失败',
          cause: error,
        });
      }

      const hasNextPage = transactions && transactions.length > limit;
      const items = hasNextPage ? transactions.slice(0, limit) : transactions ?? [];
      const nextCursor = hasNextPage && items.length > 0
        ? items[items.length - 1].created_at
        : undefined;

      return {
        items,
        nextCursor,
        hasNextPage,
        totalCount: count ?? 0,
      };
    }),

  /**
   * 获取积分统计摘要
   */
  getCreditsSummary: protectedProcedure
    .input(z.object({
      period: z.enum(['day', 'week', 'month', 'year']).default('month'),
    }))
    .query(async ({ ctx, input }) => {
      const now = new Date();
      let startDate: Date;

      switch (input.period) {
        case 'day':
          startDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
          break;
        case 'week':
          startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
          break;
        case 'month':
          startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
          break;
        case 'year':
          startDate = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
          break;
      }

      const { data: transactions, error } = await ctx.supabase
        .from('credit_transactions')
        .select('type, amount')
        .eq('user_id', ctx.user.id)
        .eq('status', 'completed')
        .gte('created_at', startDate.toISOString());

      if (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: '获取统计数据失败',
        });
      }

      const summary = {
        totalEarned: 0,
        totalSpent: 0,
        transactionCount: transactions?.length ?? 0,
        byType: {} as Record<string, { count: number; amount: number }>,
      };

      transactions?.forEach((txn) => {
        if (txn.amount > 0) {
          summary.totalEarned += txn.amount;
        } else {
          summary.totalSpent += Math.abs(txn.amount);
        }

        if (!summary.byType[txn.type]) {
          summary.byType[txn.type] = { count: 0, amount: 0 };
        }
        summary.byType[txn.type].count += 1;
        summary.byType[txn.type].amount += txn.amount;
      });

      return summary;
    }),

  /**
   * 检查积分是否足够
   */
  checkSufficientCredits: protectedProcedure
    .input(z.object({ amount: z.number().positive() }))
    .query(async ({ ctx, input }) => {
      const { data: profile } = await ctx.supabase
        .from('profiles')
        .select('credits')
        .eq('id', ctx.user.id)
        .single();

      const currentCredits = profile?.credits ?? 0;
      const sufficient = currentCredits >= input.amount;

      return {
        sufficient,
        currentCredits,
        requiredAmount: input.amount,
        shortfall: sufficient ? 0 : input.amount - currentCredits,
      };
    }),
});
