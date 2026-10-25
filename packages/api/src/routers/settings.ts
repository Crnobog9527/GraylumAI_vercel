import { setPaymentFailover, assertNoFailoverChange } from './paymentFailover';
import { PAYMENT_METHOD_ROUTES_KEY, paymentMethodRoutesSchema, readPaymentMethodRoutes, newPurchaseChannel } from '../services/payments/methodRouting';
import { FUSION_SETTINGS_KEY } from '../services/fusion/settings';
import { validateCompareLimit } from '../services/fusion/compareLimit';
import { PAYMENT_CHANNEL_KEY, paymentChannelSettingSchema, readPaymentChannel } from '../services/payments/channelSettings';
import { validatePaygAdminSetting } from '../services/adminSettings';
import {
  entitlementRowShape, FUSION_COMPARE_SETTING, fusionCompareLimitSchema,
} from '../services/membershipEntitlementConfig';
import { RUNTIME_RATE_LIMIT_KEY } from '../services/runtime/rateLimitSettings';
import { parseSearchSurcharge } from '../services/searchPricing';
import { BILLING_UNIT_SETTING_KEYS, parseCreditsPerUsd, parseMultiplier } from '../services/billingUnit';
import { PROVIDER_PRICES_KEY } from '../services/billingProviderPrices';
import { RUNTIME_MODEL_COLUMNS, runtimeModelOption } from "../services/models/runtimeEligibility";
import { openRouterKeyConfigured } from "../services/models/openRouterKey";
import { router, publicProcedure, adminProcedure } from '../trpc';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { validateReportPrice } from '../services/report/fees';
import type { SupabaseClient } from '@supabase/supabase-js';
import { isSellableMemberPack, loadConfiguredStripePrices, loadSelectedMemberPackReadiness, legacyStripeCatalogReady, loadWaffoMembershipReadiness }
  from '../services/payments/stripeCatalog';
import {
  LAUNCH_BASELINE_SETTING_KEY,
  parseLaunchBaselineAt,
  readLaunchBaselineAt,
} from '../services/billingReconciliation';
import { createSafeInternalError, createSafeServiceUnavailableError } from '../lib/publicError';
import { logger } from '../lib/logger';
import { MODEL_IDENTITY_GUARD_KEY } from '../services/modelIdentity/guardSetting';
import { getPublicOffers } from './publicOffers';
import { swallow } from '../lib/swallow';

const USER_FACING_SYSTEM_SETTING_KEYS = [
  FUSION_COMPARE_SETTING,
  'site_name',
  'support_email',
  'maintenance_mode',
  'home_show_onboarding',
  'home_analysis_module_id',
  'home_show_featured_modules',
  'max_input_characters',
] as const;

const creditPackageCatalogRowSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1),
  price: z.number().int().nonnegative(),
  credits_amount: z.number().int().positive(),
  bonus_credits: z.number().int().nonnegative().nullable(),
  is_popular: z.enum(['true', 'false']).nullable(),
  sort_order: z.number().int().nonnegative(),
});

const membershipPlanCatalogRowSchema = z.object({
  ...entitlementRowShape,
  id: z.string().uuid(),
  name: z.string().trim().min(1),
  level: z.enum(['free', 'pro', 'gold']),
  is_active: z.literal('true'),
  monthly_price: z.number().int().nonnegative(),
  yearly_price: z.number().int().nonnegative(),
  monthly_credits: z.number().int().nonnegative().nullable(),
  monthly_bonus_credits: z.number().int().nonnegative().nullable(),
  yearly_credits: z.number().int().nonnegative().nullable(),
  package_discount: z.number().int().min(0).max(100).nullable(),
  features: z.array(z.string()).nullable(),
}).passthrough();

const CATALOG_UNAVAILABLE_MESSAGE = '套餐服务暂不可用，请稍后重试';

function accepts(parse: (value: unknown) => string, value: unknown): boolean {
  try {
    parse(value);
    return true;
  } catch {
    return false;
  }
}

const systemSettingInputSchema = z.object({
  key: z.string().trim().min(1),
  value: z.any(),
}).superRefine((setting, ctx) => {
  if (['billing_platform_absorb_alert', 'billing_platform_absorb_ack'].includes(setting.key)) {
    ctx.addIssue({ code: 'custom', path: ['key'], message: '平台承担提醒请通过专用接口保存' });
  }
  if (setting.key === PAYMENT_METHOD_ROUTES_KEY && !paymentMethodRoutesSchema.safeParse(setting.value).success) {
    ctx.addIssue({ code: 'custom', path: ['value'], message: '付款方式配置或版本无效，请刷新后重试' });
  }
  if (setting.key === PAYMENT_CHANNEL_KEY && !paymentChannelSettingSchema.safeParse(setting.value).success) {
    ctx.addIssue({ code: 'custom', path: ['value'], message: '支付渠道或版本无效，请刷新后重试' });
  }
  if ([RUNTIME_RATE_LIMIT_KEY, 'runtime_stop_loss'].includes(setting.key)) {
    ctx.addIssue({ code: 'custom', path: ['key'], message: '使用额度请通过专用管理接口保存' });
  }
  if (setting.key === MODEL_IDENTITY_GUARD_KEY) {
    ctx.addIssue({ code: 'custom', path: ['key'], message: '模型身份保护请通过专用管理接口保存' });
  }
  if (setting.key === PROVIDER_PRICES_KEY) {
    ctx.addIssue({ code: 'custom', path: ['key'], message: '第三方价格请通过专用管理接口保存' });
  }
  if (setting.key === 'runtime_purpose_budgets') {
    ctx.addIssue({ code: 'custom', path: ['key'], message: '用途预算请通过专用管理接口保存' });
  }
  if (setting.key === FUSION_SETTINGS_KEY) {
    ctx.addIssue({ code: 'custom', path: ['key'], message: 'Fusion 设置请通过专用管理接口保存' });
  }
  validatePaygAdminSetting(setting, ctx);
  if (setting.key === FUSION_COMPARE_SETTING && !fusionCompareLimitSchema.safeParse(setting.value).success) {
    ctx.addIssue({ code: 'custom', path: ['value'], message: '对比模型上限须为 2 至 8 的整数' });
  }
  if (setting.key === BILLING_UNIT_SETTING_KEYS.creditsPerUsd && !accepts(parseCreditsPerUsd, setting.value)) {
    ctx.addIssue({ code: 'custom', path: ['value'], message: '每美元积分数须为正数，最多 12 位小数' });
  }
  if (setting.key === BILLING_UNIT_SETTING_KEYS.multiplier && !accepts(parseMultiplier, setting.value)) {
    ctx.addIssue({ code: 'custom', path: ['value'], message: '全站默认加价倍数须在 1 到 20 之间，最多两位小数' });
  }
  if (setting.key === 'search_surcharge_credits' && parseSearchSurcharge(setting.value) === null) {
    ctx.addIssue({code:'custom',path:['value'],message:'联网附加积分须为0至999999的整数；受控Skill搜索仍须配置正数'});
  }
  if (setting.key === 'v3_summary_model_id' && setting.value !== '' && !z.string().uuid().safeParse(setting.value).success) {
    ctx.addIssue({ code: 'custom', path: ['value'], message: '请选择有效的步骤成果整理模型' });
  }
  if (setting.key === 'v3_summary_max_tokens' && !z.coerce.number().int().min(128).max(4096).safeParse(setting.value).success) {
    ctx.addIssue({ code: 'custom', path: ['value'], message: '整理输出上限须为128至4096的整数' });
  }
  if (setting.key !== LAUNCH_BASELINE_SETTING_KEY) return;
  if (parseLaunchBaselineAt(setting.value).status === 'BLOCKED') {
    ctx.addIssue({
      code: 'custom',
      path: ['value'],
      message: 'launch_baseline_at 必须是可解析的时间戳',
    });
  }
});

function hasConfiguredStripePriceId(value: string | null): boolean {
  return Boolean(value?.trim());
}

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

async function assertSettingsWriter(client: SupabaseClient<any, 'public', any>, profileId:string) {
  const {data,error}=await client.from('profiles').select('role,status,is_deleted').eq('id',profileId).single();
  if (error) {
    logger.warn('system', 'settings_writer_profile_read_failed', { code: error.code });
    throw createSafeServiceUnavailableError(error, '暂时无法验证设置保存权限，请稍后重试');
  }
  if(data?.role!=='admin' || data?.status!=='active' || data?.is_deleted!=='false')
    throw new TRPCError({code:'FORBIDDEN',message:'当前账号无权修改系统设置'});
}

/** Whether the platform OpenRouter key is filled in (OR-1); an unreadable key is an error, not "not filled". */
async function keyConfigured(client: Pick<SupabaseClient, 'rpc'>) {
  try { return await openRouterKeyConfigured(client); }
  catch { throw new TRPCError({code:'INTERNAL_SERVER_ERROR',message:'暂时无法读取第三方密钥状态，请稍后重试'}); }
}

async function validateSummarySelection(client: SupabaseClient<any, 'public', any>, input: Array<{key:string;value:unknown}>) {
  const value=input.find(item=>item.key==='v3_summary_model_id')?.value;
  if(typeof value!=='string' || !value)return;
  const {data,error}=await client.from('ai_models').select(RUNTIME_MODEL_COLUMNS).eq('id',value).single();
  if(error || !data)throw new TRPCError({code:'BAD_REQUEST',message:'所选整理模型不存在，请刷新模型列表'});
  const option=runtimeModelOption(data,'organizer',await keyConfigured(client));
  if(!option.available)throw new TRPCError({code:'BAD_REQUEST',message:option.reason??'整理模型不可用'});
}

async function validateRoutingSelections(client: SupabaseClient<any, 'public', any>, input: Array<{key:string;value:unknown}>) {
  await assertNoFailoverChange(client, input);
  for (const setting of input) {
    if (setting.key !== 'primary_model_id') continue;
    if (setting.value === '') continue;
    const label = '主力模型';
    if (!z.string().uuid().safeParse(setting.value).success) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: `请从列表中选择${label}，不要填写模型名称` });
    }
    const { data, error } = await client.from('ai_models').select('id,is_active').eq('id', setting.value).maybeSingle();
    if (error) throw createSafeServiceUnavailableError(error, '暂时无法验证模型配置，请稍后重试');
    if (!data || data.is_active !== 'true') {
      throw new TRPCError({ code: 'BAD_REQUEST', message: `所选${label}已删除或停用，请刷新模型列表后重新选择` });
    }
  }
}

function throwSettingsWriteError(error: { code?: string }, fallback: string) {
  if (error.code === 'PT409' || error.code === '40001') {
    throw new TRPCError({ code: 'CONFLICT', message: '支付渠道已被修改，请刷新后重新保存' });
  }
  if (error.code === '23503') {
    throw new TRPCError({ code: 'BAD_REQUEST', message: '模型配置已变化，请刷新模型列表后重新选择' });
  }
  throw createSafeInternalError(error, fallback);
}

export const settingsRouter = router({
  getPaymentMethodRoutes: adminProcedure.query(({ ctx }) => readPaymentMethodRoutes(ctx.supabase).catch(error => {
    throw createSafeServiceUnavailableError(error, '付款方式配置暂时无法读取，请稍后重试');
  })),
  setPaymentFailover,
  getPaymentChannel: adminProcedure.query(({ ctx }) => readPaymentChannel(ctx.supabase)),
  getRoutingModels: adminProcedure.query(async ({ ctx }) => {
    const { data, error } = await ctx.supabase.from('ai_models')
      .select('id,name,model_id').eq('is_active', 'true').order('name');
    if (error) throw createSafeServiceUnavailableError(error, '无法读取模型列表，请稍后重试');
    return (data ?? []).map(({ id, name, model_id }) => ({ id, name, model_id }));
  }),
  // Organizer choices by default; the Skill page asks for its own eligibility.
  getSummaryModels: adminProcedure.input(z.object({use:z.enum(['organizer','skill'])}).strict().optional()).query(async ({ctx,input}) => {
    const {data,error}=await ctx.supabase.from('ai_models').select(RUNTIME_MODEL_COLUMNS).eq('is_active','true').order('name');
    if(error)throw new TRPCError({code:'INTERNAL_SERVER_ERROR',message:'无法读取整理模型列表'});
    // The platform OpenRouter key participates only in server eligibility checks and never leaves this projection.
    const configured=await keyConfigured(ctx.supabase);
    return (data??[]).map(row=>runtimeModelOption(row,input?.use??'organizer',configured));
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

  getLaunchBaseline: adminProcedure.query(async ({ ctx }) => {
    const result = await readLaunchBaselineAt(ctx.supabase);
    if (result.status === 'BLOCKED' && result.reason === 'READ_FAILED') {
      throw createSafeInternalError(new Error('launch baseline read failed'), '读取 Launch baseline 失败，请稍后重试');
    }
    return result;
  }),

  // Admin only: Update system settings
  updateSystemSettings: adminProcedure
    .input(systemSettingInputSchema)
    .mutation(async ({ ctx, input }) => {
      await assertSettingsWriter(ctx.supabase,ctx.profileId); validateReportPrice([input]);
      await validateRoutingSelections(ctx.supabase, [input]);
      await validateCompareLimit(ctx.supabase, [input]);
      await validateSummarySelection(ctx.supabase,Array.isArray(input)?input:[input]);
      const { data, error } = await ctx.supabase
        .from('system_settings')
        .upsert({ key: input.key, value: input.value }, { onConflict: 'key' })
        .select();

      if (error) {
        throwSettingsWriteError(error, '更新系统设置失败，请稍后重试');
      }
      return data;
    }),

  updateSystemSettingsBulk: adminProcedure
    .input(z.array(systemSettingInputSchema).min(1))
    .mutation(async ({ ctx, input }) => {
      await assertSettingsWriter(ctx.supabase,ctx.profileId); validateReportPrice(input);
      await validateRoutingSelections(ctx.supabase, input);
      await validateCompareLimit(ctx.supabase, input);
      await validateSummarySelection(ctx.supabase,Array.isArray(input)?input:[input]);
      const { data, error } = await ctx.supabase
        .from('system_settings')
        .upsert(input, { onConflict: 'key' })
        .select();

      if (error) {
        throwSettingsWriteError(error, '批量更新系统设置失败，请稍后重试');
      }

      return data;
    }),

  /**
   * 获取积分加油包列表 (公开接口)
   * 返回活跃的积分加油包供用户购买
   */
  getCreditPackages: publicProcedure.query(async ({ ctx }) => {
    const selectedChannel = ctx.hasSupabaseAdminPrivileges && ctx.supabaseAdmin
      ? await swallow('payment_channel_read_failed', readPaymentChannel(ctx.supabaseAdmin), null) : null;
    const stripeReady = ctx.hasSupabaseAdminPrivileges && Boolean(ctx.supabaseAdmin)
      && await swallow('stripe_catalog_read_failed', legacyStripeCatalogReady(ctx.supabaseAdmin, selectedChannel?.channel), false);
    const routeChannel = ctx.hasSupabaseAdminPrivileges && ctx.supabaseAdmin
      ? await readPaymentMethodRoutes(ctx.supabaseAdmin).then(newPurchaseChannel, () => null) : null;
    const readClient = getPublicReadClient(ctx);
    let result;

    try {
      result = await readClient
        .from('credit_packages')
        .select('id, name, price, credits_amount, bonus_credits, is_popular, sort_order')
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

    const priceRefs = stripeReady && ctx.hasSupabaseAdminPrivileges
      ? await loadConfiguredStripePrices({ db: ctx.supabaseAdmin,
        kind: 'credit_package', ids: packages.map(pkg => pkg.id) }).catch(() => new Map<string, string>()) : new Map<string, string>();
    // Member pack availability follows the audited new-purchase route; catalog reads survive provider failures.
    const memberReady = ctx.hasSupabaseAdminPrivileges && ctx.supabaseAdmin
      ? await loadSelectedMemberPackReadiness(ctx.supabaseAdmin, packages.map(pkg => pkg.id)).catch(() => {
        logger.warn('billing', 'settings_member_pack_prices_unavailable', {});
        return new Map<string, boolean>();
      }) : new Map<string, boolean>();
    return packages.map(pkg => ({
      id: pkg.id,
      name: pkg.name,
      credits: pkg.credits_amount,
      bonus_credits: pkg.bonus_credits ?? 0,
      price: (pkg.price ?? 0) / 100, // 从分转换为美元
      is_popular: pkg.is_popular === 'true',
      paymentChannel: routeChannel, // the audited failover switch users buy through, not the legacy key
      checkout_ready: stripeReady && pkg.price > 0 && hasConfiguredStripePriceId(priceRefs.get(`${pkg.id}:one_time`) ?? null),
      member_checkout_ready: {
        pro: isSellableMemberPack(pkg) && memberReady.get(`${pkg.id}:pro`) === true,
        gold: isSellableMemberPack(pkg) && memberReady.get(`${pkg.id}:gold`) === true,
      },
    }));
  }),

  /** Public offer facts (Gold first month, founder price and seats left); see routers/publicOffers.ts. */
  getPublicOffers,

  // Public membership catalog.
  getMembershipPlans: publicProcedure.query(async ({ ctx }) => {
    // Membership uses method checkout: only its audited route controls new sales, never the old global channel.
    const stripeReady = ctx.hasSupabaseAdminPrivileges && Boolean(ctx.supabaseAdmin)
      && await swallow('stripe_catalog_read_failed', legacyStripeCatalogReady(ctx.supabaseAdmin, 'stripe'), false);
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

    const priceRefs = stripeReady && ctx.hasSupabaseAdminPrivileges
      ? await swallow('stripe_prices_read_failed', loadConfiguredStripePrices({ db: ctx.supabaseAdmin,
        kind: 'membership_plan', ids: plans.map(plan => plan.id) }), new Map<string, string>()) : new Map<string, string>();
    const emergencyReady = ctx.hasSupabaseAdminPrivileges && ctx.supabaseAdmin
      ? await swallow('waffo_readiness_read_failed', loadWaffoMembershipReadiness(ctx.supabaseAdmin, plans.map(plan => plan.id)), undefined) : undefined;
    return plans.map(plan => ({
      id: plan.id,
      name: plan.name,
      level: plan.level,
      allowFusionReview: plan.allow_fusion_review,
      allowFusionCompare: plan.allow_fusion_compare,
      libraryStorageBytes: plan.library_storage_bytes,
      price: {
        monthly: (plan.monthly_price ?? 0) / 100, // 从分转换为美元
        yearly: (plan.yearly_price ?? 0) / 100,
      },
      credits: {
        monthly: plan.monthly_credits ?? 0,
        monthlyBonus: plan.monthly_bonus_credits ?? 0,
        yearly: plan.yearly_credits ?? 0,
        yearlyBonus: 0,
      },
      // package_discount: 100 = no discount, 95 = 5% off
      discount: plan.package_discount ? (100 - plan.package_discount) / 100 : 0,
      features: Array.isArray(plan.features) ? plan.features : [],
      // 使用 level 判断推荐：gold 为推荐/高亮
      recommended: plan.level === 'gold',
      highlight: plan.level === 'gold',
      paymentChannel: emergencyReady ? 'waffo' : emergencyReady === null ? 'stripe' : null,
      checkoutReady: {
        monthly: plan.level !== 'free' && plan.monthly_price > 0 && (emergencyReady === null
          ? stripeReady && hasConfiguredStripePriceId(priceRefs.get(`${plan.id}:monthly`) ?? null) : emergencyReady?.get(`${plan.id}:monthly`) === true),
        yearly: plan.level !== 'free' && plan.yearly_price > 0 && (emergencyReady === null
          ? stripeReady && hasConfiguredStripePriceId(priceRefs.get(`${plan.id}:yearly`) ?? null) : emergencyReady?.get(`${plan.id}:yearly`) === true),
      },
    }));
  }),
});
