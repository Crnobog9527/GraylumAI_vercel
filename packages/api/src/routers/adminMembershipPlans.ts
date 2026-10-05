/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { adminProcedure } from '../trpc';
import { createSafeInternalError } from '../lib/publicError';
import {
  defaultMembershipEntitlements, entitlementInputShape, membershipEntitlementPatch,
} from '../services/membershipEntitlementConfig';
import { saveStripeCatalog } from '../services/payments/stripeCatalog';
import { assertExplicitEntitlementsOnLevelChange } from '../services/membershipPlanChanges';

export const membershipPlanMutations = {
  // UNIQUE(level) makes every valid plan the sole configuration for its tier.
  // No read-then-delete race: this admin endpoint never hard-deletes a plan.
  deleteMembershipPlan: adminProcedure.input(z.object({ id: z.string().uuid() })).mutation(() => {
    throw new TRPCError({ code: 'BAD_REQUEST', message: '每个等级必须保留唯一的会员方案，请改用下架。' });
  }),
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
      const { data, error } = await saveStripeCatalog({ db: ctx.supabaseAdmin, kind: 'membership_plan',
        prices: { monthly: input.stripeMonthlyPriceId, yearly: input.stripeYearlyPriceId },
        values: {
          ...defaultMembershipEntitlements(input.level),
          ...membershipEntitlementPatch(input),
          name: input.name,
          level: input.level,
          monthly_price: input.monthlyPrice,
          yearly_price: input.yearlyPrice,
          monthly_credits: input.monthlyCredits,
          yearly_credits: input.yearlyCredits,
          monthly_bonus_credits: input.monthlyBonusCredits,
          package_discount: input.packageDiscount,
          features: input.features,
          max_context_messages: input.maxContextMessages,
          is_active: 'true',
          sort_order: input.sortOrder,
        },
      });

      if (error?.code === '23505') {
        throw new TRPCError({ code: 'CONFLICT', message: '该会员等级已存在方案，请编辑现有方案。' });
      }
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
      };
      if (input.name !== undefined) updateData.name = input.name;
      if (input.level !== undefined) updateData.level = input.level;
      if (input.monthlyPrice !== undefined) updateData.monthly_price = input.monthlyPrice;
      if (input.yearlyPrice !== undefined) updateData.yearly_price = input.yearlyPrice;
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

      const { data, error } = await saveStripeCatalog({ db: ctx.supabaseAdmin, kind: 'membership_plan',
        id: input.id, values: updateData, expectedLevel: previousLevel,
        prices: { monthly: input.stripeMonthlyPriceId, yearly: input.stripeYearlyPriceId },
      });

      if (error?.code === '23505') {
        throw new TRPCError({ code: 'CONFLICT', message: '该会员等级已存在方案，请编辑现有方案。' });
      }
      if (error || !data) {
        throw createSafeInternalError(error, '更新会员方案失败，请稍后重试');
      }

      return data;
    }),

};
