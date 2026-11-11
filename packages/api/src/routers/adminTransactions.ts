/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { adminProcedure } from '../trpc';
import { z } from 'zod';
import { ADMIN_TRANSACTION_COLUMNS } from '../services/adminUserAccess';
import { createAdminOperationError } from './adminShared';

// Part of the admin router (merged in ./admin.ts): the procedure paths stay `admin.<name>`.
export const adminTransactionProcedures = {
  /**
   * Get all credit transactions (for admin)
   */
  getAllTransactions: adminProcedure
    .input(z.object({
      limit: z.number().min(1).max(100).default(20),
      offset: z.number().min(0).default(0),
      type: z.enum(['deduction', 'addition', 'checkin', 'purchase', 'refund']).optional(),
      userId: z.string().uuid().optional(),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
    }))
    .query(async ({ ctx, input }) => {
      let query = ctx.supabase
        .from('credit_transactions')
        .select(ADMIN_TRANSACTION_COLUMNS, { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(input.offset, input.offset + input.limit - 1);

      if (input.type) {
        query = query.eq('type', input.type);
      }

      if (input.userId) {
        query = query.eq('user_id', input.userId);
      }

      if (input.startDate) {
        query = query.gte('created_at', input.startDate);
      }

      if (input.endDate) {
        query = query.lte('created_at', input.endDate);
      }

      let statsQuery = ctx.supabase
        .from('credit_transactions')
        .select('type, amount');

      if (input.type) {
        statsQuery = statsQuery.eq('type', input.type);
      }

      if (input.userId) {
        statsQuery = statsQuery.eq('user_id', input.userId);
      }

      if (input.startDate) {
        statsQuery = statsQuery.gte('created_at', input.startDate);
      }

      if (input.endDate) {
        statsQuery = statsQuery.lte('created_at', input.endDate);
      }

      const [transactionsResult, statsResult] = await Promise.all([
        query,
        statsQuery,
      ]);

      const { data, error, count } = transactionsResult;

      if (error) {
        throw createAdminOperationError('读取积分流水', error);
      }

      const userIds = Array.from(new Set((data ?? []).map((transaction) => transaction.user_id).filter(Boolean)));
      let profilesById = new Map<string, {
        id: string;
        email: string | null;
        nickname: string | null;
        avatar_url: string | null;
      }>();

      if (userIds.length > 0) {
        const { data: profiles, error: profilesError } = await ctx.supabase
          .from('profiles')
          .select('id, email, nickname, avatar_url')
          .in('id', userIds);

        if (profilesError) {
          throw createAdminOperationError('读取积分流水', profilesError);
        }

        profilesById = new Map(
          (profiles ?? []).map((profile) => [profile.id, profile]),
        );
      }

      const stats = {
        totalAdditions: 0,
        totalCheckins: 0,
        totalDeductions: 0,
        totalPurchases: 0,
        totalRefunds: 0,
      };

      statsResult.data?.forEach((t: { type: string; amount: number }) => {
        if (t.type === 'addition') stats.totalAdditions += t.amount;
        else if (t.type === 'checkin') stats.totalCheckins += t.amount;
        else if (t.type === 'deduction') stats.totalDeductions += Math.abs(t.amount);
        else if (t.type === 'purchase') stats.totalPurchases += t.amount;
        else if (t.type === 'refund') stats.totalRefunds += t.amount;
      });

      return {
        transactions: (data ?? []).map((transaction) => ({
          ...transaction,
          profiles: profilesById.get(transaction.user_id) ?? null,
        })),
        total: count ?? 0,
        hasMore: (count ?? 0) > input.offset + input.limit,
        stats,
      };
    }),
};
