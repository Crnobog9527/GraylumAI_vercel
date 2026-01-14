import { router, protectedProcedure } from '../trpc';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 积分交易类型
 */
const TransactionType = z.enum([
  'purchase',      // 购买充值
  'consumption',   // 消费扣除
  'refund',        // 退款
  'bonus',         // 奖励/赠送
  'adjustment',    // 手动调整
  'transfer_in',   // 转入
  'transfer_out',  // 转出
  'expiration',    // 过期
]);

type TransactionType = z.infer<typeof TransactionType>;

/**
 * 积分交易状态
 */
const TransactionStatus = z.enum([
  'pending',    // 处理中
  'completed',  // 已完成
  'failed',     // 失败
  'cancelled',  // 已取消
]);

type TransactionStatus = z.infer<typeof TransactionStatus>;

// ============================================================================
// 输入验证 Schema
// ============================================================================

const DeductCreditsInput = z.object({
  amount: z.number().positive('扣除金额必须为正数').int('积分必须为整数'),
  reason: z.string().min(1, '请提供扣除原因').max(500).optional(),
  referenceId: z.string().optional(), // 关联的业务ID（如订单ID）
  referenceType: z.string().optional(), // 关联类型（如 'order', 'service'）
  idempotencyKey: z.string().optional(), // 幂等键，防止重复扣除
});

const AddCreditsInput = z.object({
  amount: z.number().positive('添加金额必须为正数').int('积分必须为整数'),
  type: TransactionType.default('bonus'),
  reason: z.string().min(1).max(500).optional(),
  referenceId: z.string().optional(),
  referenceType: z.string().optional(),
  idempotencyKey: z.string().optional(),
  expiresAt: z.string().datetime().optional(), // 积分过期时间
});

const GetTransactionsInput = z.object({
  limit: z.number().min(1).max(100).default(20),
  cursor: z.string().optional(), // 分页游标
  type: TransactionType.optional(), // 按类型筛选
  status: TransactionStatus.optional(), // 按状态筛选
  startDate: z.string().datetime().optional(), // 开始日期
  endDate: z.string().datetime().optional(), // 结束日期
});

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 生成交易ID
 */
function generateTransactionId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 10);
  return `txn_${timestamp}_${random}`;
}

/**
 * 检查幂等性（防止重复操作）
 */
async function checkIdempotency(
  supabase: any,
  userId: string,
  idempotencyKey: string
): Promise<{ exists: boolean; transactionId?: string }> {
  const { data } = await supabase
    .from('credit_transactions')
    .select('id')
    .eq('user_id', userId)
    .eq('idempotency_key', idempotencyKey)
    .single();

  return {
    exists: !!data,
    transactionId: data?.id,
  };
}

// ============================================================================
// 积分路由器
// ============================================================================

export const creditsRouter = router({
  /**
   * 获取当前用户积分余额
   */
  getBalance: protectedProcedure.query(async ({ ctx }) => {
    const { data: profile, error } = await ctx.supabase
      .from('profiles')
      .select('credits, credits_expiring_soon, credits_expiry_date')
      .eq('id', ctx.profileId)
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
   * 扣除积分
   * 
   * 注意：生产环境建议使用数据库事务（Supabase RPC）确保原子性
   * 这里使用乐观锁定策略作为替代方案
   */
  deductCredits: protectedProcedure
    .input(DeductCreditsInput)
    .mutation(async ({ ctx, input }) => {
      const { amount, reason, referenceId, referenceType, idempotencyKey } = input;

      // 1. 幂等性检查
      if (idempotencyKey) {
        const idempotencyCheck = await checkIdempotency(
          ctx.supabase,
          ctx.profileId,
          idempotencyKey
        );
        if (idempotencyCheck.exists) {
          // 返回已存在的交易结果
          const { data: existingTxn } = await ctx.supabase
            .from('credit_transactions')
            .select('*')
            .eq('id', idempotencyCheck.transactionId)
            .single();

          return {
            success: true,
            transactionId: idempotencyCheck.transactionId,
            message: '交易已处理（幂等性检查）',
            transaction: existingTxn,
          };
        }
      }

      // 2. 获取当前余额（带版本号用于乐观锁）
      const { data: profile, error: profileError } = await ctx.supabase
        .from('profiles')
        .select('credits, updated_at')
        .eq('id', ctx.profileId)
        .single();

      if (profileError || !profile) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: '用户资料不存在',
        });
      }

      // 3. 余额检查
      if (profile.credits < amount) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `积分不足。当前余额: ${profile.credits}，需要: ${amount}`,
        });
      }

      const newCredits = profile.credits - amount;
      const transactionId = generateTransactionId();

      // 4. 使用乐观锁更新余额
      // 只有当 updated_at 没变时才更新（防止并发修改）
      const { data: updateResult, error: updateError } = await ctx.supabase
        .from('profiles')
        .update({
          credits: newCredits,
          updated_at: new Date().toISOString(),
        })
        .eq('id', ctx.profileId)
        .eq('updated_at', profile.updated_at) // 乐观锁条件
        .select()
        .single();

      if (updateError || !updateResult) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: '积分更新冲突，请重试。可能有其他操作正在进行。',
        });
      }

      // 5. 记录交易
      const { data: transaction, error: txnError } = await ctx.supabase
        .from('credit_transactions')
        .insert({
          id: transactionId,
          user_id: ctx.profileId,
          type: 'consumption',
          amount: -amount, // 负数表示扣除
          balance_before: profile.credits,
          balance_after: newCredits,
          reason: reason ?? '积分消费',
          reference_id: referenceId,
          reference_type: referenceType,
          idempotency_key: idempotencyKey,
          status: 'completed',
          created_at: new Date().toISOString(),
        })
        .select()
        .single();

      if (txnError) {
        // 交易记录失败，但积分已扣除
        // 生产环境应该有补偿机制或告警
        console.error('Failed to record transaction:', txnError);
      }

      return {
        success: true,
        transactionId,
        previousCredits: profile.credits,
        newCredits,
        amountDeducted: amount,
        transaction,
      };
    }),

  /**
   * 添加积分
   */
  addCredits: protectedProcedure
    .input(AddCreditsInput)
    .mutation(async ({ ctx, input }) => {
      const { amount, type, reason, referenceId, referenceType, idempotencyKey, expiresAt } = input;

      // 1. 幂等性检查
      if (idempotencyKey) {
        const idempotencyCheck = await checkIdempotency(
          ctx.supabase,
          ctx.profileId,
          idempotencyKey
        );
        if (idempotencyCheck.exists) {
          const { data: existingTxn } = await ctx.supabase
            .from('credit_transactions')
            .select('*')
            .eq('id', idempotencyCheck.transactionId)
            .single();

          return {
            success: true,
            transactionId: idempotencyCheck.transactionId,
            message: '交易已处理（幂等性检查）',
            transaction: existingTxn,
          };
        }
      }

      // 2. 获取当前余额
      const { data: profile, error: profileError } = await ctx.supabase
        .from('profiles')
        .select('credits, updated_at')
        .eq('id', ctx.profileId)
        .single();

      if (profileError || !profile) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: '用户资料不存在',
        });
      }

      const newCredits = profile.credits + amount;
      const transactionId = generateTransactionId();

      // 3. 乐观锁更新余额
      const updateData: Record<string, any> = {
        credits: newCredits,
        updated_at: new Date().toISOString(),
      };

      // 如果有过期时间，更新过期相关字段
      if (expiresAt) {
        updateData.credits_expiring_soon = amount;
        updateData.credits_expiry_date = expiresAt;
      }

      const { data: updateResult, error: updateError } = await ctx.supabase
        .from('profiles')
        .update(updateData)
        .eq('id', ctx.profileId)
        .eq('updated_at', profile.updated_at)
        .select()
        .single();

      if (updateError || !updateResult) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: '积分更新冲突，请重试',
        });
      }

      // 4. 记录交易
      const { data: transaction, error: txnError } = await ctx.supabase
        .from('credit_transactions')
        .insert({
          id: transactionId,
          user_id: ctx.profileId,
          type,
          amount: amount, // 正数表示增加
          balance_before: profile.credits,
          balance_after: newCredits,
          reason: reason ?? getDefaultReason(type),
          reference_id: referenceId,
          reference_type: referenceType,
          idempotency_key: idempotencyKey,
          expires_at: expiresAt,
          status: 'completed',
          created_at: new Date().toISOString(),
        })
        .select()
        .single();

      if (txnError) {
        console.error('Failed to record transaction:', txnError);
      }

      return {
        success: true,
        transactionId,
        previousCredits: profile.credits,
        newCredits,
        amountAdded: amount,
        transaction,
      };
    }),

  /**
   * 获取积分交易记录（分页）
   */
  getCreditTransactions: protectedProcedure
    .input(GetTransactionsInput)
    .query(async ({ ctx, input }) => {
      const { limit, cursor, type, status, startDate, endDate } = input;

      // 构建查询
      let query = ctx.supabase
        .from('credit_transactions')
        .select('*', { count: 'exact' })
        .eq('user_id', ctx.profileId)
        .order('created_at', { ascending: false })
        .limit(limit + 1); // 多取一条用于判断是否有下一页

      // 应用筛选条件
      if (type) {
        query = query.eq('type', type);
      }

      if (status) {
        query = query.eq('status', status);
      }

      if (startDate) {
        query = query.gte('created_at', startDate);
      }

      if (endDate) {
        query = query.lte('created_at', endDate);
      }

      // 游标分页
      if (cursor) {
        query = query.lt('created_at', cursor);
      }

      const { data: transactions, error, count } = await query;

      if (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: '获取交易记录失败',
          cause: error,
        });
      }

      // 处理分页
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
      const { period } = input;

      // 计算时间范围
      const now = new Date();
      let startDate: Date;

      switch (period) {
        case 'day':
          startDate = new Date(now.setDate(now.getDate() - 1));
          break;
        case 'week':
          startDate = new Date(now.setDate(now.getDate() - 7));
          break;
        case 'month':
          startDate = new Date(now.setMonth(now.getMonth() - 1));
          break;
        case 'year':
          startDate = new Date(now.setFullYear(now.getFullYear() - 1));
          break;
      }

      // 获取交易统计
      const { data: transactions, error } = await ctx.supabase
        .from('credit_transactions')
        .select('type, amount')
        .eq('user_id', ctx.profileId)
        .eq('status', 'completed')
        .gte('created_at', startDate.toISOString());

      if (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: '获取统计数据失败',
        });
      }

      // 计算统计数据
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
   * 检查积分是否足够（用于前端预检）
   */
  checkSufficientCredits: protectedProcedure
    .input(z.object({ amount: z.number().positive() }))
    .query(async ({ ctx, input }) => {
      const { data: profile } = await ctx.supabase
        .from('profiles')
        .select('credits')
        .eq('id', ctx.profileId)
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

// ============================================================================
// 辅助函数
// ============================================================================

function getDefaultReason(type: TransactionType): string {
  const reasons: Record<TransactionType, string> = {
    purchase: '积分购买',
    consumption: '积分消费',
    refund: '退款返还',
    bonus: '奖励积分',
    adjustment: '系统调整',
    transfer_in: '积分转入',
    transfer_out: '积分转出',
    expiration: '积分过期',
  };
  return reasons[type] ?? '积分变动';
}
