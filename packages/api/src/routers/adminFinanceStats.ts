/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { withRealModelUsedResult } from '../services/modelIdentity/usageAliases';
import { modelPriceView } from '../shared/modelPriceView';
import { parseSearchSurcharge } from '../services/searchPricing';
import { adminProcedure } from '../trpc';
import { z } from 'zod';
import { readAllReportRows } from '../services/reportRows';
import { buildFinanceUsdOverview, buildFinanceTransactionStats } from '../services/financeReport';
import { picoToUsd, usdToPico } from '../services/reportUsd';
import { describeBillingUnitSettings } from '../services/billingUnit';
import { adminDateStringSchema, createAdminOperationError, assertValidAdminRows, systemSettingsTable } from './adminShared';

const adminFiniteNumericValueSchema = z.union([
  z.number().finite(),
  z.string().trim().min(1).refine(
    (value) => Number.isFinite(Number(value)),
    'Invalid admin numeric value',
  ),
]);

const adminFinanceCreditTransactionRowSchema = z.object({
  amount: z.number().finite(),
  type: z.string().trim().min(1),
  created_at: adminDateStringSchema,
  description: z.string().nullable().optional(),
}).passthrough();

const adminFinanceCreditPackageRowSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  price: z.number().finite(),
  credits_amount: z.number().finite(),
  active: z.string().trim().min(1),
}).passthrough();

const adminFinanceProfileRowSchema = z.object({
  credits: z.number().finite(),
  created_at: adminDateStringSchema,
}).passthrough();

const adminFinanceModelRowSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  model_id: z.string().min(1),
  provider: z.string().min(1),
  is_active: z.union([z.string().trim().min(1), z.boolean()]),
  max_tokens: z.number().finite(),
  config: z.unknown().optional(),
}).passthrough();

const adminFinanceConversationRowSchema = z.object({
  id: z.string().min(1),
  model_id: z.string().nullable(),
  created_at: adminDateStringSchema,
}).passthrough();

const adminFinanceTokenStatRowSchema = z.object({
  model_used: z.string().min(1),
  total_credits: z.number().finite(),
  total_cost_usd: adminFiniteNumericValueSchema,
  cached_tokens: z.number().finite().nullable(),
  created_at: adminDateStringSchema,
}).passthrough();

const adminFinancePaymentOrderRowSchema = z.object({
  amount_total: z.number().finite().nullable(),
  currency: z.string().min(1),
  status: z.string().min(1),
  payment_status: z.string().nullable(),
  created_at: adminDateStringSchema,
}).passthrough().superRefine((order, ctx) => {
  const isPaidCompletedOrder =
    order.status === 'completed'
    && (order.payment_status === 'paid' || order.payment_status === 'no_payment_required')
    && order.currency.toLowerCase() === 'usd';
  if (isPaidCompletedOrder && order.amount_total === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['amount_total'],
      message: 'Completed payment order amount is required',
    });
  }
});

const adminFinanceUsageLogRowSchema = z.object({
  status: z.string().min(1),
  created_at: adminDateStringSchema,
}).passthrough();

const adminFinanceBillingHistoryRowSchema = z.object({
  operation_type: z.string().min(1),
  amount: z.number().finite(),
  created_at: adminDateStringSchema,
  metadata: z.unknown().optional(),
}).passthrough();

const adminFinanceSettingRowSchema = z.object({
  key: z.string().trim().min(1),
  value: z.unknown(),
}).passthrough();

function parseNumericSetting<F extends number | null>(
  settings: Record<string, unknown>,
  key: string,
  fallback: F,
): number | F {
  if (!Object.prototype.hasOwnProperty.call(settings, key)) {
    return fallback;
  }

  const value = settings[key];

  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  throw createAdminOperationError(
    '读取财务统计',
    new Error(`Admin finance setting ${key} is invalid`),
  );
}

function formatRange(values: number[]): { min: number; max: number } | null {
  if (values.length === 0) {
    return null;
  }

  return {
    min: parseFloat(Math.min(...values).toFixed(2)),
    max: parseFloat(Math.max(...values).toFixed(2)),
  };
}

function convertUsdPer1MToCreditsPer1K(
  usdPer1M: number,
  creditsPerUsd: number,
  tokenPriceMultiplier: number,
): number {
  return parseFloat(
    (
      (usdPer1M * creditsPerUsd * tokenPriceMultiplier) /
      1000
    ).toFixed(2),
  );
}

function convertUsdPer1KSearchToCreditsPer1KSearch(
  usdPer1K: number,
  creditsPerUsd: number,
  tokenPriceMultiplier: number,
): number {
  return parseFloat(
    (
      usdPer1K * creditsPerUsd * tokenPriceMultiplier
    ).toFixed(2),
  );
}

// Part of the admin router (merged in ./admin.ts): the procedure paths stay `admin.<name>`.
export const adminFinanceProcedures = {
  /**
   * Get financial statistics
   */
  getFinanceStats: adminProcedure
    .query(async ({ ctx }) => {
      const { data: creditTransactions, error: creditTransactionsError } = await readAllReportRows((from, to) => ctx.supabase
        .from('credit_transactions')
        .select('amount, type, created_at, description')
        .order('created_at', { ascending: false }).order('id').range(from, to));

      if (creditTransactionsError) {
        throw createAdminOperationError('读取财务统计', creditTransactionsError);
      }

      assertValidAdminRows(
        creditTransactions,
        adminFinanceCreditTransactionRowSchema,
        '读取财务统计',
        'credit transactions',
      );

      const { data: packages, error: packagesError } = await readAllReportRows((from, to) => ctx.supabase
        .from('credit_packages')
        .select('*').order('id').range(from, to));

      if (packagesError) {
        throw createAdminOperationError('读取积分包财务统计', packagesError);
      }

      assertValidAdminRows(
        packages,
        adminFinanceCreditPackageRowSchema,
        '读取积分包财务统计',
        'credit packages',
      );

      const { data: users, error: usersError } = await readAllReportRows((from, to) => ctx.supabase
        .from('profiles')
        .select('credits, created_at').order('id').range(from, to));

      if (usersError) {
        throw createAdminOperationError('读取财务统计', usersError);
      }

      assertValidAdminRows(
        users,
        adminFinanceProfileRowSchema,
        '读取财务统计',
        'profiles',
      );

      const { data: models, error: modelsError } = await readAllReportRows((from, to) => ctx.supabase
        .from('ai_models')
        .select('id,name,model_id,provider,is_active,max_tokens,config')
        .order('name', { ascending: true }).order('id').range(from, to));

      if (modelsError) {
        throw createAdminOperationError('读取财务统计', modelsError);
      }

      assertValidAdminRows(
        models,
        adminFinanceModelRowSchema,
        '读取财务统计',
        'AI models',
      );

      const { data: conversations, error: conversationsError } = await readAllReportRows((from, to) => ctx.supabase
        .from('conversations')
        .select('id, model_id, created_at').order('id').range(from, to));

      if (conversationsError) {
        throw createAdminOperationError('读取财务统计', conversationsError);
      }

      assertValidAdminRows(
        conversations,
        adminFinanceConversationRowSchema,
        '读取财务统计',
        'conversations',
      );

      // MODEL-IDENTITY-GUARD: token_stats stores aliases; reports use the real model.
      const { data: tokenStats, error: tokenStatsError } = await withRealModelUsedResult(ctx.supabase,
        readAllReportRows((from, to) => ctx.supabase.from('token_stats')
          .select('model_used, total_credits, total_cost_usd, cached_tokens, created_at').order('id').range(from, to)));
      if (tokenStatsError) {
        throw createAdminOperationError('读取财务统计', tokenStatsError);
      }

      assertValidAdminRows(
        tokenStats,
        adminFinanceTokenStatRowSchema,
        '读取财务统计',
        'token stats',
      );

      const { data: paymentOrders, error: paymentOrdersError } = await readAllReportRows((from, to) => ctx.supabase
        .from('payment_orders')
        .select('amount_total, currency, status, payment_status, created_at')
        .order('id').range(from, to));

      if (paymentOrdersError) {
        throw createAdminOperationError('读取财务统计', paymentOrdersError);
      }

      assertValidAdminRows(
        paymentOrders,
        adminFinancePaymentOrderRowSchema,
        '读取财务统计',
        'payment orders',
      );

      const { data: usageLogs, error: usageLogsError } = await readAllReportRows((from, to) => ctx.supabase
        .from('ai_usage_logs')
        .select('status, created_at').order('id').range(from, to));

      if (usageLogsError) {
        throw createAdminOperationError('读取财务统计', usageLogsError);
      }

      assertValidAdminRows(
        usageLogs,
        adminFinanceUsageLogRowSchema,
        '读取财务统计',
        'AI usage logs',
      );

      const { data: billingHistory, error: billingHistoryError } = await readAllReportRows((from, to) => ctx.supabase
        .from('billing_history')
        .select('operation_type, amount, created_at, metadata').order('id').range(from, to));

      if (billingHistoryError) {
        throw createAdminOperationError('读取财务统计', billingHistoryError);
      }

      assertValidAdminRows(
        billingHistory,
        adminFinanceBillingHistoryRowSchema,
        '读取财务统计',
        'billing history',
      );

      const { data: settings, error: settingsError } = await readAllReportRows((from, to) => systemSettingsTable(ctx.supabase)
        .select('*')
        .in('key', [
          'new_user_credits',
          'search_surcharge_credits',
          'billing_credits_per_usd',
          'billing_token_price_multiplier',
        ]).order('key').range(from, to));

      if (settingsError) {
        throw createAdminOperationError('读取财务统计', settingsError);
      }

      assertValidAdminRows(
        settings,
        adminFinanceSettingRowSchema,
        '读取财务统计',
        'system settings',
      );

      // Calculate overall stats
      const now = new Date();
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const { transactionStats, dailyStats } = buildFinanceTransactionStats(creditTransactions, tokenStats, billingHistory, now);

      // User statistics
      const userStats = {
        totalUsers: users.length,
        totalCreditsInSystem: users.reduce((sum, u) => sum + u.credits, 0),
        averageCreditsPerUser: 0,
        newUsersThisMonth: 0,
        newUsersThisWeek: 0,
      };

      users.forEach(u => {
        const createdAt = new Date(u.created_at);
        if (createdAt >= thirtyDaysAgo) userStats.newUsersThisMonth++;
        if (createdAt >= sevenDaysAgo) userStats.newUsersThisWeek++;
      });

      if (userStats.totalUsers > 0) {
        userStats.averageCreditsPerUser = Math.round(userStats.totalCreditsInSystem / userStats.totalUsers);
      }

      // Package statistics
      const packageStats = {
        totalPackages: packages.length,
        activePackages: packages.filter(p => p.active === 'true').length,
        unknownActiveCount: packages.filter(p => p.active !== 'true' && p.active !== 'false').length,
        packages: packages.map(p => ({
          id: p.id,
          name: p.name,
          price: p.price,
          creditsAmount: p.credits_amount,
          active: p.active,
        })),
      };

      // Convert daily stats to array for charting
      const dailyChartData = Object.entries(dailyStats)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, data]) => ({
          date,
          ...data,
        }));

      // API/Model statistics
      const apiStats = {
        totalRequests: usageLogs.length,
        totalConversations: conversations.length,
        messagesThisMonth: usageLogs.filter(log => new Date(log.created_at) >= thirtyDaysAgo).length,
        messagesThisWeek: usageLogs.filter(log => new Date(log.created_at) >= sevenDaysAgo).length,
      };

      // Model statistics with usage count
      const modelUsageByConversation: Record<string, number> = {};
      conversations.forEach((conv) => {
        if (conv.model_id) {
          modelUsageByConversation[conv.model_id] = (modelUsageByConversation[conv.model_id] || 0) + 1;
        }
      });

      const modelUsageByToken: Record<string, { requests: number; credits: number; costPico: bigint }> = {};
      tokenStats.forEach((stat) => {
        const key = stat.model_used;
        if (!key) return;
        const current = modelUsageByToken[key] ?? { requests: 0, credits: 0, costPico: 0n };
        current.requests += 1;
        current.credits += stat.total_credits;
        current.costPico += usdToPico(stat.total_cost_usd);
        modelUsageByToken[key] = current;
      });

      const modelStats = models.map(model => ({
        id: model.id,
        name: model.name,
        modelId: model.model_id,
        provider: model.provider,
        isActive: model.is_active,
        pricing: modelPriceView(model),
        maxTokens: model.max_tokens,
        conversationCount: modelUsageByConversation[model.id] || 0,
        requestCount: modelUsageByToken[model.model_id]?.requests || 0,
        creditsConsumed: modelUsageByToken[model.model_id]?.credits || 0,
        costUsd: picoToUsd(modelUsageByToken[model.model_id]?.costPico ?? 0n),
      }));

      const financeOverview = {
        ...buildFinanceUsdOverview(paymentOrders, tokenStats),
        creditsConsumed: transactionStats.totalDeductions,
        creditsPurchased: transactionStats.totalPurchases,
        creditsGiven: transactionStats.totalAdditions + transactionStats.totalCheckins,
        netCreditsFlow: transactionStats.totalAdditions + transactionStats.totalCheckins
          + transactionStats.totalPurchases - transactionStats.totalDeductions,
      };

      // Runtime billing reference derived from active model pricing
      const settingsMap: Record<string, unknown> = {};
      settings.forEach(s => {
        settingsMap[s.key] = s.value;
      });

      const activeMeteredModels = models.filter((model) =>
        model.is_active === 'true' || model.is_active === true,
      );
      // q / m come only from stored rows; a missing row is null ("not configured"), never a made-up number.
      const creditsPerUsd = parseNumericSetting(settingsMap, 'billing_credits_per_usd', null);
      const tokenPriceMultiplier = parseNumericSetting(settingsMap, 'billing_token_price_multiplier', null);
      // Whether q / the default m is a stored row, a fallback for a missing row, or an invalid stored value.
      const billingUnitSource = describeBillingUnitSettings(settingsMap);

      const currentPrices = creditsPerUsd === null || tokenPriceMultiplier === null ? [] : activeMeteredModels.map(modelPriceView);
      const inputCreditsPer1KValues = currentPrices.flatMap(({ frozen }) => frozen
        ? [convertUsdPer1MToCreditsPer1K(Number(frozen.promptUsdPerMillion), creditsPerUsd ?? 0, tokenPriceMultiplier ?? 0)] : []);
      const outputCreditsPer1KValues = currentPrices.flatMap(({ frozen }) => frozen
        ? [convertUsdPer1MToCreditsPer1K(Number(frozen.completionUsdPerMillion), creditsPerUsd ?? 0, tokenPriceMultiplier ?? 0)] : []);
      const searchCreditsPer1KValues = currentPrices.flatMap(({ base }) => base?.web_search !== undefined
        ? [convertUsdPer1KSearchToCreditsPer1KSearch(Number(base.web_search) * 1000, creditsPerUsd ?? 0, tokenPriceMultiplier ?? 0)] : []);

      const runtimeBilling = {
        creditsPerUsd,
        tokenPriceMultiplier,
        billingUnitSource,
        activeModelCount: activeMeteredModels.length,
        unknownModelActiveCount: models.filter(model =>
          ![true, false, 'true', 'false'].includes(model.is_active)).length,
        inputCreditsPer1KRange: formatRange(inputCreditsPer1KValues),
        outputCreditsPer1KRange: formatRange(outputCreditsPer1KValues),
        searchCreditsPer1KRange: formatRange(searchCreditsPer1KValues),
        searchSurchargeCredits: parseSearchSurcharge(settingsMap['search_surcharge_credits']),
        newUserCredits: parseNumericSetting(settingsMap, 'new_user_credits', 500),
      };

      return {
        transactions: transactionStats,
        users: userStats,
        packages: packageStats,
        dailyChart: dailyChartData,
        apiStats,
        modelStats,
        financeOverview,
        runtimeBilling,
      };
    }),
};
