/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import { adminProcedure } from '../trpc';
import { createSafeInternalError } from '../lib/publicError';
import {
  defaultMembershipEntitlements, entitlementInputShape, membershipEntitlementPatch,
} from '../services/membershipEntitlementConfig';
import { assertExplicitEntitlementsOnLevelChange } from '../services/membershipPlanChanges';

export const membershipPlanMutations = {
  /**
   * Create a new membership plan
   */
  createMembershipPlan: adminProcedure
    .input(z.object({
      ...entitlementInputShape,
      name: z.string().min(1).max(100),
      level: z.enum(['free', 'pro', 'gold']).default('pro'),
      monthlyPrice: z.number().int().min(0), // In cents
      yearlyPrice: z.number().int().min(0), // In cents
      stripeMonthlyPriceId: z.string().trim().min(1).max(255).optional(),
      stripeYearlyPriceId: z.string().trim().min(1).max(255).optional(),
      monthlyCredits: z.number().int().min(0),
      yearlyCredits: z.number().int().min(0),
      monthlyBonusCredits: z.number().int().min(0).default(0),
      packageDiscount: z.number().int().min(0).max(100).default(100),
      features: z.array(z.string()).default([]),
      maxContextMessages: z.number().int().min(5).max(100).default(20), // 上下文消息数限制
      sortOrder: z.number().int().min(0).default(0),
    }))
    .mutation(async ({ ctx, input }) => {
      const { data, error } = await ctx.supabase
        .from('membership_plans')
        .insert({
          ...defaultMembershipEntitlements(input.level),
          ...membershipEntitlementPatch(input),
          name: input.name,
          level: input.level,
          monthly_price: input.monthlyPrice,
          yearly_price: input.yearlyPrice,
          stripe_monthly_price_id: input.stripeMonthlyPriceId ?? null,
          stripe_yearly_price_id: input.stripeYearlyPriceId ?? null,
          monthly_credits: input.monthlyCredits,
          yearly_credits: input.yearlyCredits,
          monthly_bonus_credits: input.monthlyBonusCredits,
          package_discount: input.packageDiscount,
          features: input.features,
          max_context_messages: input.maxContextMessages,
          is_active: 'true',
          sort_order: input.sortOrder,
        })
        .select()
        .single();

      if (error) {
        throw createSafeInternalError(error, '创建会员方案失败，请稍后重试');
      }

      return data;
    }),

  /**
   * Update a membership plan
   */
  updateMembershipPlan: adminProcedure
    .input(z.object({
      ...entitlementInputShape,
      id: z.string().uuid(),
      name: z.string().min(1).max(100).optional(),
      level: z.enum(['free', 'pro', 'gold']).optional(),
      monthlyPrice: z.number().int().min(0).optional(),
      yearlyPrice: z.number().int().min(0).optional(),
      stripeMonthlyPriceId: z.string().trim().min(1).max(255).nullable().optional(),
      stripeYearlyPriceId: z.string().trim().min(1).max(255).nullable().optional(),
      monthlyCredits: z.number().int().min(0).optional(),
      yearlyCredits: z.number().int().min(0).optional(),
      monthlyBonusCredits: z.number().int().min(0).optional(),
      packageDiscount: z.number().int().min(0).max(100).optional(),
      features: z.array(z.string()).optional(),
      maxContextMessages: z.number().int().min(5).max(100).optional(), // 上下文消息数限制
      allowExport: z.enum(['true', 'false']).optional(),
      allowBatchExport: z.enum(['true', 'false']).optional(),
      isActive: z.enum(['true', 'false']).optional(),
      sortOrder: z.number().int().min(0).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const previousLevel = await assertExplicitEntitlementsOnLevelChange(ctx.supabase, input);
      const updateData: Record<string, unknown> = {
        ...membershipEntitlementPatch(input),
        updated_at: new Date().toISOString(),
      };
      if (input.name !== undefined) updateData.name = input.name;
      if (input.level !== undefined) updateData.level = input.level;
      if (input.monthlyPrice !== undefined) updateData.monthly_price = input.monthlyPrice;
      if (input.yearlyPrice !== undefined) updateData.yearly_price = input.yearlyPrice;
      if (input.stripeMonthlyPriceId !== undefined) updateData.stripe_monthly_price_id = input.stripeMonthlyPriceId || null;
      if (input.stripeYearlyPriceId !== undefined) updateData.stripe_yearly_price_id = input.stripeYearlyPriceId || null;
      if (input.monthlyCredits !== undefined) updateData.monthly_credits = input.monthlyCredits;
      if (input.yearlyCredits !== undefined) updateData.yearly_credits = input.yearlyCredits;
      if (input.monthlyBonusCredits !== undefined) updateData.monthly_bonus_credits = input.monthlyBonusCredits;
      if (input.packageDiscount !== undefined) updateData.package_discount = input.packageDiscount;
      if (input.features !== undefined) updateData.features = input.features;
      if (input.maxContextMessages !== undefined) updateData.max_context_messages = input.maxContextMessages;
      if (input.allowExport !== undefined) updateData.allow_export = input.allowExport;
      if (input.allowBatchExport !== undefined) updateData.allow_batch_export = input.allowBatchExport;
      if (input.isActive !== undefined) updateData.is_active = input.isActive;
      if (input.sortOrder !== undefined) updateData.sort_order = input.sortOrder;

      const query = ctx.supabase.from('membership_plans').update(updateData).eq('id', input.id);
      // A concurrent tier edit cannot bypass the explicit-entitlements requirement.
      if (previousLevel !== undefined) query.eq('level', previousLevel);
      const { data, error } = await query.select().single();

      if (error || !data) {
        throw createSafeInternalError(error, '更新会员方案失败，请稍后重试');
      }

      return data;
    }),

};
