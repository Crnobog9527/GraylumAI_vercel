/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { adminProcedure } from '../trpc';
import { z } from 'zod';
import { hydrateStripeCatalogPrices, saveStripeCatalog } from '../services/payments/stripeCatalog';
import { adminDateStringSchema, createAdminOperationError, assertValidAdminRows } from './adminShared';

const adminPackageDashboardRowSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  price: z.number().finite(),
  credits_amount: z.number().finite(),
  bonus_credits: z.number().finite(),
  stripe_price_id: z.string().nullable(),
  sort_order: z.number().finite(),
  is_popular: z.enum(['true', 'false']),
  active: z.enum(['true', 'false']),
  created_at: adminDateStringSchema,
}).passthrough();

const adminPackageMembershipPlanRowSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  level: z.enum(['free', 'pro', 'gold']),
  monthly_price: z.number().finite(),
  yearly_price: z.number().finite(),
  stripe_monthly_price_id: z.string().nullable(),
  stripe_yearly_price_id: z.string().nullable(),
  monthly_credits: z.number().finite(),
  yearly_credits: z.number().finite(),
  monthly_bonus_credits: z.number().finite(),
  package_discount: z.number().finite(),
  features: z.array(z.string()),
  max_context_messages: z.number().finite(),
  is_active: z.enum(['true', 'false']),
  sort_order: z.number().finite(),
  created_at: adminDateStringSchema,
}).passthrough();

// Part of the admin router (merged in ./admin.ts): the procedure paths stay `admin.<name>`.
export const adminPackageProcedures = {
  /**
   * Get packages page bootstrap data
   */
  getPackagesDashboard: adminProcedure
    .query(async ({ ctx }) => {
      const [packagesResult, membershipPlansResult] = await Promise.all([
        ctx.supabase
          .from('credit_packages')
          .select('*')
          .order('sort_order', { ascending: true })
          .order('price', { ascending: true }),
        ctx.supabase
          .from('membership_plans')
          .select('*')
          .order('sort_order', { ascending: true }),
      ]);

      if (packagesResult.error) {
        throw createAdminOperationError('读取积分包列表', packagesResult.error);
      }

      if (membershipPlansResult.error) {
        throw createAdminOperationError('读取会员方案列表', membershipPlansResult.error);
      }

      assertValidAdminRows(
        packagesResult.data,
        adminPackageDashboardRowSchema,
        '读取套餐列表',
        'packages dashboard packages',
      );
      assertValidAdminRows(
        membershipPlansResult.data,
        adminPackageMembershipPlanRowSchema,
        '读取套餐列表',
        'packages dashboard membership plans',
      );

      return {
        packages: await hydrateStripeCatalogPrices({ db: ctx.supabaseAdmin, kind: 'credit_package', rows: packagesResult.data }),
        membershipPlans: await hydrateStripeCatalogPrices({ db: ctx.supabaseAdmin, kind: 'membership_plan', rows: membershipPlansResult.data }),
      };
    }),

  /**
   * Create a new credit package
   */
  createPackage: adminProcedure
    .input(z.object({
      name: z.string().min(1).max(100),
      price: z.number().int().positive(), // In cents
      creditsAmount: z.number().int().positive(),
      bonusCredits: z.number().int().min(0).default(0),
      stripePriceId: z.string().trim().min(1).max(255).optional(),
      sortOrder: z.number().int().min(0).default(0),
      isPopular: z.enum(['true', 'false']).default('false'),
      active: z.enum(['true', 'false']).default('true'),
    }))
    .mutation(async ({ ctx, input }) => {
      const { data, error } = await saveStripeCatalog({ db: ctx.supabaseAdmin, kind: 'credit_package',
        prices: { one_time: input.stripePriceId }, values: {
          name: input.name,
          price: input.price,
          credits_amount: input.creditsAmount,
          bonus_credits: input.bonusCredits,
          sort_order: input.sortOrder,
          is_popular: input.isPopular,
          active: input.active,
        },
      });

      if (error) {
        throw createAdminOperationError('创建积分包', error);
      }

      return data;
    }),

  /**
   * Update a credit package
   */
  updatePackage: adminProcedure
    .input(z.object({
      id: z.string().uuid(),
      name: z.string().min(1).max(100).optional(),
      price: z.number().int().positive().optional(),
      creditsAmount: z.number().int().positive().optional(),
      bonusCredits: z.number().int().min(0).optional(),
      stripePriceId: z.string().trim().min(1).max(255).nullable().optional(),
      sortOrder: z.number().int().min(0).optional(),
      isPopular: z.enum(['true', 'false']).optional(),
      active: z.enum(['true', 'false']).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const updateData: Record<string, unknown> = {};
      if (input.name) updateData.name = input.name;
      if (input.price) updateData.price = input.price;
      if (input.creditsAmount) updateData.credits_amount = input.creditsAmount;
      if (input.bonusCredits !== undefined) updateData.bonus_credits = input.bonusCredits;
      if (input.sortOrder !== undefined) updateData.sort_order = input.sortOrder;
      if (input.isPopular) updateData.is_popular = input.isPopular;
      if (input.active) updateData.active = input.active;

      const { data, error } = await saveStripeCatalog({ db: ctx.supabaseAdmin, kind: 'credit_package',
        id: input.id, values: updateData, prices: { one_time: input.stripePriceId },
      });

      if (error) {
        throw createAdminOperationError('更新积分包', error);
      }

      return data;
    }),

  /**
   * Delete a credit package
   */
  deletePackage: adminProcedure
    .input(z.object({
      id: z.string().uuid(),
    }))
    .mutation(async ({ ctx, input }) => {
      const { error } = await ctx.supabase
        .from('credit_packages')
        .delete()
        .eq('id', input.id);

      if (error) {
        throw createAdminOperationError('删除积分包', error);
      }

      return { success: true };
    }),
};
