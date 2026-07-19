import { router, publicProcedure, adminProcedure } from '../trpc';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { isStripeCheckoutConfigured } from '../services/stripe';
import { createSafeInternalError, createSafeServiceUnavailableError } from '../lib/publicError';
import { logger } from '../lib/logger';

const USER_FACING_SYSTEM_SETTING_KEYS = [
  'site_name',
  'support_email',
  'maintenance_mode',
  'home_show_onboarding',
  'home_show_featured_modules',
  'chat_show_model_selector',
  'max_input_characters',
  'enable_free_tier',
  'free_tier_messages',
  'enable_long_text_warning',
  'long_text_warning_threshold',
  'show_token_usage_stats',
  'chat_prompt_text',
  'chat_welcome_message',
  'chat_billing_hint',
  'input_credits_per_1k',
  'output_credits_per_1k',
] as const;

const creditPackageCatalogRowSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1),
  price: z.number().int().nonnegative(),
  credits_amount: z.number().int().positive(),
  bonus_credits: z.number().int().nonnegative().nullable(),
  is_popular: z.enum(['true', 'false']).nullable(),
  sort_order: z.number().int().nonnegative(),
  stripe_price_id: z.string().trim().min(1).nullable(),
});

const membershipPlanCatalogRowSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1),
  level: z.enum(['free', 'pro', 'gold']),
  is_active: z.literal('true'),
  monthly_price: z.number().int().nonnegative(),
  yearly_price: z.number().int().nonnegative(),
  monthly_credits: z.number().int().nonnegative().nullable(),
  monthly_bonus_credits: z.number().int().nonnegative().nullable(),
  yearly_credits: z.number().int().nonnegative().nullable(),
  yearly_bonus_credits: z.number().int().nonnegative().nullable(),
  package_discount: z.number().int().min(0).max(100).nullable(),
  history_retention_days: z.number().int().positive().nullable(),
  features: z.array(z.string()).nullable(),
  stripe_monthly_price_id: z.string().trim().min(1).nullable(),
  stripe_yearly_price_id: z.string().trim().min(1).nullable(),
}).passthrough();

const CATALOG_UNAVAILABLE_MESSAGE = '套餐服务暂不可用，请稍后重试';

function parseCatalogRows<T>(
  value: unknown,
  schema: z.ZodType<T>,
  catalog: 'credit_packages' | 'membership_plans',
): T[] {
  const result = z.array(schema).safeParse(value);

  if (!result.success) {
    logger.warn('billing', 'settings_catalog_parse_failed', {
      catalog,
      issueCount: result.error.issues.length,
    });
    throw createSafeServiceUnavailableError(result.error, CATALOG_UNAVAILABLE_MESSAGE);
  }

  return result.data;
}

function reduceSettings(data: Array<{ key: string; value: unknown }>) {
  return data.reduce((acc: Record<string, unknown>, setting) => ({
    ...acc,
    [setting.key]: setting.value,
  }), {});
}

export function getPublicReadClient(ctx: {
  supabase: SupabaseClient<any, 'public', any>;
  supabasePublic: SupabaseClient<any, 'public', any>;
  supabaseAdmin: SupabaseClient<any, 'public', any>;
  hasSupabaseAdminPrivileges: boolean;
}) {
  return ctx.supabasePublic ?? ctx.supabase;
}

export const settingsRouter = router({
  /**
   * 获取首页公告 (公开接口)
   * 返回 announcement_type = 'homepage' 的活跃公告列表
   */
  getActiveAnnouncements: publicProcedure.query(async ({ ctx }) => {
    const now = new Date().toISOString();
    const readClient = getPublicReadClient(ctx);

    const { data, error } = await readClient
      .from('announcements')
      .select('id, title, content, type, icon, icon_color, tag, tag_color, banner_link, priority, start_date, end_date, created_at')
      .eq('active', 'true')  // active 是字符串类型
      .eq('announcement_type', 'homepage')  // 首页公告
      .lte('start_date', now)
      .or(`end_date.is.null,end_date.gt.${now}`)
      .order('priority', { ascending: false })
      .order('created_at', { ascending: false });

    if (error) {
      logger.warn('system', 'settings_homepage_announcements_fetch_failed', {
        code: error.code,
      });
      return [];
    }

    // 映射字段名以兼容前端
    return (data ?? []).map(item => ({
      id: item.id,
      title: item.title,
      description: item.content,  // content -> description
      type: item.type,
      icon: item.icon,
      tag: item.tag,
      tag_color: item.tag_color,
      link_url: item.banner_link,
      priority: item.priority,
      created_at: item.created_at,
    }));
  }),

  /**
   * 获取横幅公告 (公开接口)
   * 返回 announcement_type = 'banner' 的活跃公告
   */
  getBannerAnnouncement: publicProcedure.query(async ({ ctx }) => {
    const now = new Date().toISOString();
    const readClient = getPublicReadClient(ctx);

    const { data, error } = await readClient
      .from('announcements')
      .select('id, title, content, type, banner_style, banner_link, tag')
      .eq('active', 'true')  // active 是字符串类型
      .eq('announcement_type', 'banner')  // 横幅公告
      .lte('start_date', now)
      .or(`end_date.is.null,end_date.gt.${now}`)
      .order('priority', { ascending: false })
      .limit(1)
      .single();

    if (error) {
      // 没有横幅公告时返回 null
      return null;
    }

    return {
      id: data.id,
      title: data.title,
      description: data.content,
      type: data.type,
      banner_style: data.banner_style,
      link_url: data.banner_link,
      tag: data.tag,
    };
  }),

  // Public: Get system settings (for display purposes)
  getSystemSettings: publicProcedure.query(async ({ ctx }) => {
    const readClient = getPublicReadClient(ctx);
    const { data, error } = await readClient
      .from('system_settings')
      .select('key, value')
      .in('key', [...USER_FACING_SYSTEM_SETTING_KEYS]);

    if (error) {
      throw createSafeInternalError(error, '获取系统设置失败，请稍后重试');
    }

    return reduceSettings(data ?? []);
  }),

  getAdminSystemSettings: adminProcedure.query(async ({ ctx }) => {
    const { data, error } = await ctx.supabase
      .from('system_settings')
      .select('key, value');

    if (error) {
      throw createSafeInternalError(error, '读取系统设置失败，请稍后重试');
    }

    return reduceSettings(data ?? []);
  }),

  // Admin only: Update system settings
  updateSystemSettings: adminProcedure
    .input(z.object({ key: z.string(), value: z.any() }))
    .mutation(async ({ ctx, input }) => {
      const { data, error } = await ctx.supabase
        .from('system_settings')
        .upsert({ key: input.key, value: input.value }, { onConflict: 'key' })
        .select();

      if (error) {
        throw createSafeInternalError(error, '更新系统设置失败，请稍后重试');
      }
      return data;
    }),

  updateSystemSettingsBulk: adminProcedure
    .input(z.array(z.object({ key: z.string(), value: z.any() })).min(1))
    .mutation(async ({ ctx, input }) => {
      const { data, error } = await ctx.supabase
        .from('system_settings')
        .upsert(input, { onConflict: 'key' })
        .select();

      if (error) {
        throw createSafeInternalError(error, '批量更新系统设置失败，请稍后重试');
      }

      return data;
    }),

  /**
   * 获取积分加油包列表 (公开接口)
   * 返回活跃的积分加油包供用户购买
   */
  getCreditPackages: publicProcedure.query(async ({ ctx }) => {
    const stripeReady = isStripeCheckoutConfigured();
    const readClient = getPublicReadClient(ctx);
    let result;

    try {
      result = await readClient
        .from('credit_packages')
        .select('id, name, price, credits_amount, bonus_credits, is_popular, sort_order, stripe_price_id')
        .eq('active', 'true')
        .order('sort_order', { ascending: true })
        .order('price', { ascending: true });
    } catch (error) {
      logger.warn('billing', 'settings_credit_packages_fetch_failed', {
        failureType: 'request_rejected',
      });
      throw createSafeServiceUnavailableError(error, CATALOG_UNAVAILABLE_MESSAGE);
    }

    const { data, error } = result;

    if (error) {
      logger.warn('billing', 'settings_credit_packages_fetch_failed', {
        code: error.code,
      });
      throw createSafeServiceUnavailableError(error, CATALOG_UNAVAILABLE_MESSAGE);
    }

    const packages = parseCatalogRows(
      data,
      creditPackageCatalogRowSchema,
      'credit_packages',
    );

    // 映射字段名以兼容前端
    return packages.map(pkg => ({
      id: pkg.id,
      name: pkg.name,
      credits: pkg.credits_amount,
      bonus_credits: pkg.bonus_credits ?? 0,
      price: (pkg.price ?? 0) / 100, // 从分转换为美元
      is_popular: pkg.is_popular === 'true',
      checkout_ready: stripeReady && Boolean(pkg.stripe_price_id),
    }));
  }),

  /**
   * 获取会员等级列表 (公开接口)
   * 返回所有会员等级供用户查看和订阅
   */
  getMembershipPlans: publicProcedure.query(async ({ ctx }) => {
    const stripeReady = isStripeCheckoutConfigured();
    const readClient = getPublicReadClient(ctx);
    let result;

    try {
      result = await readClient
        .from('membership_plans')
        .select('*')
        .eq('is_active', 'true')
        .order('sort_order', { ascending: true });
    } catch (error) {
      logger.warn('billing', 'settings_membership_plans_fetch_failed', {
        failureType: 'request_rejected',
      });
      throw createSafeServiceUnavailableError(error, CATALOG_UNAVAILABLE_MESSAGE);
    }

    const { data, error } = result;

    if (error) {
      logger.warn('billing', 'settings_membership_plans_fetch_failed', {
        code: error.code,
      });
      throw createSafeServiceUnavailableError(error, CATALOG_UNAVAILABLE_MESSAGE);
    }

    const plans = parseCatalogRows(
      data,
      membershipPlanCatalogRowSchema,
      'membership_plans',
    );

    // 映射字段名以兼容前端
    return plans.map(plan => ({
      id: plan.id,
      name: plan.name,
      level: plan.level,
      price: {
        monthly: (plan.monthly_price ?? 0) / 100, // 从分转换为美元
        yearly: (plan.yearly_price ?? 0) / 100,
      },
      credits: {
        monthly: plan.monthly_credits ?? 0,
        monthlyBonus: plan.monthly_bonus_credits ?? 0,
        yearly: plan.yearly_credits ?? 0,
        yearlyBonus: plan.yearly_bonus_credits ?? 0,
      },
      // package_discount: 100 = no discount, 95 = 5% off
      discount: plan.package_discount ? (100 - plan.package_discount) / 100 : 0,
      historyRetentionDays: plan.history_retention_days ?? 7,
      features: Array.isArray(plan.features) ? plan.features : [],
      // 使用 level 判断推荐：gold 为推荐/高亮
      recommended: plan.level === 'gold',
      highlight: plan.level === 'gold',
      checkoutReady: {
        monthly: stripeReady && Boolean(plan.stripe_monthly_price_id),
        yearly: stripeReady && Boolean(plan.stripe_yearly_price_id),
      },
    }));
  }),
});
