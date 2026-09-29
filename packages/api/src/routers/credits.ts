import { router, protectedProcedure } from '../trpc';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { createSafeServiceUnavailableError } from '../lib/publicError';
import { logger } from '../lib/logger';
import {
  countsAsCreditSpend,
  normalizeCreditLedgerType,
  normalizeCreditTransactionRow,
} from '../services/creditLedger';
import {
  CREDIT_BALANCE_UNAVAILABLE_MESSAGE,
  classifyCreditBalanceFailure,
  readCreditBalance,
} from '../services/creditBalance';

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
  'checkin',       // 每日签到
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

const GetTransactionsInput = z.object({
  limit: z.number().min(1).max(100).default(20),
  cursor: z.string().optional(), // 分页游标
  type: TransactionType.optional(), // 按类型筛选
  status: TransactionStatus.optional(), // 按状态筛选
  startDate: z.string().datetime().optional(), // 开始日期
  endDate: z.string().datetime().optional(), // 结束日期
});

// ============================================================================
// 积分路由器
// ============================================================================

export const creditsRouter = router({
  /**
   * 获取当前用户积分余额
   */
  getBalance: protectedProcedure.query(async ({ ctx }) => {
    try {
      const credits = await readCreditBalance(ctx.supabase, ctx.profileId);
      logger.info('billing', 'credits_balance_read', {
        outcome: credits === 0 ? 'real_zero' : 'ready',
      });

      return {
        credits,
        creditsExpiringSoon: 0,
        creditsExpiryDate: null,
      };
    } catch (error) {
      logger.error('billing', 'credits_balance_unavailable', {
        reason: classifyCreditBalanceFailure(error),
      });
      throw createSafeServiceUnavailableError(error, CREDIT_BALANCE_UNAVAILABLE_MESSAGE);
    }
  }),

  /**
   * 获取积分交易记录（分页）
   */
  getCreditTransactions: protectedProcedure
    .input(GetTransactionsInput)
    .query(async ({ ctx, input }) => {
      const { limit, cursor, type, status: _status, startDate, endDate } = input;

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
      const rawItems = hasNextPage ? transactions.slice(0, limit) : transactions ?? [];
      const items = rawItems.map((transaction: any) => normalizeCreditTransactionRow(transaction));
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
      period: z.enum(['day', 'week', 'month', 'year', 'all']).default('month'),
    }))
    .query(async ({ ctx, input }) => {
      const { period } = input;

      // 计算时间范围
      const now = new Date();
      let startDate: Date | null = null;

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
        case 'all':
          startDate = null;
          break;
      }

      // 获取交易统计
      let query = ctx.supabase
        .from('credit_transactions')
        .select('*')
        .eq('user_id', ctx.profileId);

      if (startDate) {
        query = query.gte('created_at', startDate.toISOString());
      }

      const { data: transactions, error } = await query;

      // 查询失败时报错，不返回全 0 冒充真实汇总
      if (error) {
        logger.error('billing', 'credits_summary_query_failed', {
          code: error.code,
        });
        throw createSafeServiceUnavailableError(error, '积分汇总暂时无法读取，请稍后重试');
      }

      // 计算统计数据
      const summary = {
        totalEarned: 0,
        totalSpent: 0,
        transactionCount: transactions?.length ?? 0,
        byType: {} as Record<string, { count: number; amount: number }>,
        byLedgerType: {} as Record<string, { count: number; amount: number }>,
      };

      transactions?.forEach((txn) => {
        const ledgerType = normalizeCreditLedgerType(txn);
        if (ledgerType === 'grant' && txn.amount > 0) {
          summary.totalEarned += txn.amount;
        }
        if (countsAsCreditSpend(txn)) {
          summary.totalSpent += Math.abs(txn.amount);
        }

        if (!summary.byType[txn.type]) {
          summary.byType[txn.type] = { count: 0, amount: 0 };
        }
        summary.byType[txn.type].count += 1;
        summary.byType[txn.type].amount += txn.amount;

        if (!summary.byLedgerType[ledgerType]) {
          summary.byLedgerType[ledgerType] = { count: 0, amount: 0 };
        }
        summary.byLedgerType[ledgerType].count += 1;
        summary.byLedgerType[ledgerType].amount += txn.amount;
      });

      return summary;
    }),
});
