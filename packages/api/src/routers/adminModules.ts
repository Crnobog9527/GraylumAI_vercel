/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { adminProcedure } from '../trpc';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { createAdminOperationError, logAdminEndpointMetric } from './adminShared';

const promptCategorySchema = z.enum(['writing', 'marketing', 'video', 'business', 'education', 'coding', 'analysis', 'creative', 'other']);

const promptPlatformSchema = z.enum(['all', 'web', 'mobile', 'desktop', 'api']);

const moduleBadgeTypeSchema = z.enum(['new', 'hot', 'recommend']).nullable().optional();

const moduleBooleanSchema = z.boolean();

const promptBatchPatchSchema = z.object({
  description: z.string().max(500).nullable().optional(),
  fullDescription: z.string().max(5000).nullable().optional(),
  content: z.string().min(1).max(10000).optional(),
  systemPrompt: z.string().max(10000).nullable().optional(),
  userPromptTemplate: z.string().max(10000).nullable().optional(),
  modelId: z.string().uuid().nullable().optional(),
  platform: promptPlatformSchema.optional(),
  features: z.array(z.string()).nullable().optional(),
  examples: z.array(z.string()).nullable().optional(),
  userQuestions: z.array(z.string()).nullable().optional(),
  icon: z.string().max(50).optional(),
  imageUrl: z.string().max(1000).nullable().optional(),
  badgeType: moduleBadgeTypeSchema,
  badgeText: z.string().max(80).nullable().optional(),
  creditsDisplay: z.string().max(80).nullable().optional(),
  category: promptCategorySchema.optional(),
  sortOrder: z.number().int().min(0).max(1000).optional(),
  isFeatured: moduleBooleanSchema.optional(), requiredMemberLevel: z.enum(['pro', 'gold']).nullable().optional(),
}).refine(
  (patch) => Object.values(patch).some((value) => value !== undefined),
  { message: 'At least one patch field is required' },
);

function serializeTextList(value: string[] | null | undefined) {
  if (!value || value.length === 0) {
    return null;
  }

  const cleaned = value.map((item) => item.trim()).filter(Boolean);
  return cleaned.length > 0 ? JSON.stringify(cleaned) : null;
}

function summarizeModules(rows: Array<{ active?: boolean | null; category?: string | null; is_featured?: boolean | null }>) {
  const categoryKeys = ['writing', 'marketing', 'video', 'business', 'education', 'coding', 'analysis', 'creative', 'other'];

  return {
    total: rows.length,
    active: rows.filter((module) => module.active === true).length,
    inactive: rows.filter((module) => module.active !== true).length,
    featured: rows.filter((module) => module.is_featured === true).length,
    byCategory: Object.fromEntries(
      categoryKeys.map((category) => [
        category,
        rows.filter((module) => module.category === category).length,
      ]),
    ),
  };
}

// Part of the admin router (merged in ./admin.ts): the procedure paths stay `admin.<name>`.
// Feature Module / Module Prompt Management. Kept under the legacy "prompts" procedure names because /admin/prompts is
// the owner-confirmed feature module management entry.
export const adminModuleProcedures = {
  getPromptsDashboard: adminProcedure
    .input(z.object({
      limit: z.number().min(1).max(100).default(50),
      offset: z.number().min(0).default(0),
      category: promptCategorySchema.optional(),
      activeOnly: z.boolean().default(false),
    }))
    .query(async ({ ctx, input }) => {
      const startedAt = Date.now();
      let modulesQuery = ctx.supabase
        .from('modules')
        .select('*', { count: 'planned' })
        .order('sort_order', { ascending: false })
        .order('created_at', { ascending: false })
        .range(input.offset, input.offset + input.limit - 1);

      if (input.category) {
        modulesQuery = modulesQuery.eq('category', input.category);
      }

      if (input.activeOnly) {
        modulesQuery = modulesQuery.eq('active', true);
      }

      const [modulesResult, statsQuery, modelsResult] = await Promise.all([
        modulesQuery,
        ctx.supabase
          .from('modules')
          .select('active, category, is_featured'),
        ctx.supabase
          .from('ai_models')
          .select('id, name, model_id, provider, description, enable_web_search, max_tokens')
          .eq('is_active', 'true')
          .order('name'),
      ]);

      if (modulesResult.error) {
        throw createAdminOperationError('读取功能模块列表', modulesResult.error);
      }
      if (statsQuery.error) {
        throw createAdminOperationError('读取功能模块统计', statsQuery.error);
      }
      if (modelsResult.error) {
        throw createAdminOperationError('读取模型列表', modelsResult.error);
      }

      const modules = modulesResult.data ?? [];
      const result = {
        prompts: modules,
        modules,
        total: modulesResult.count ?? 0,
        hasMore: (modulesResult.count ?? 0) > input.offset + input.limit,
        stats: summarizeModules(statsQuery.data ?? []),
        models: modelsResult.data ?? [],
      };

      logAdminEndpointMetric('admin.getPromptsDashboard', startedAt, {
        queryCount: 3,
        countStrategy: 'planned',
        pageSize: input.limit,
        returnedCount: result.modules.length,
        modelCount: result.models.length,
      });

      return result;
    }),

  createPrompt: adminProcedure
    .input(z.object({
      name: z.string().min(1).max(100),
      description: z.string().max(500).optional(),
      fullDescription: z.string().max(5000).optional(),
      content: z.string().min(1).max(10000),
      systemPrompt: z.string().max(10000).optional(),
      userPromptTemplate: z.string().max(10000).optional(),
      modelId: z.string().uuid().optional(),
      platform: promptPlatformSchema.default('all'),
      features: z.array(z.string()).optional(),
      examples: z.array(z.string()).optional(),
      userQuestions: z.array(z.string()).optional(),
      icon: z.string().max(50).default('Wand2'),
      imageUrl: z.string().max(1000).optional(),
      badgeType: z.enum(['new', 'hot', 'recommend']).optional(),
      badgeText: z.string().max(80).optional(),
      creditsDisplay: z.string().max(80).optional(),
      category: promptCategorySchema.default('other'),
      sortOrder: z.number().int().min(0).max(1000).default(0),
      isFeatured: moduleBooleanSchema.default(false),
      active: moduleBooleanSchema.default(true),
    }))
    .mutation(async ({ ctx, input }) => {
      const { data, error } = await ctx.supabase
        .from('modules')
        .insert({
          title: input.name,
          description: input.description ?? null,
          full_description: input.fullDescription ?? null,
          prompt_content: input.content,
          system_prompt: input.systemPrompt ?? null,
          user_prompt_template: input.userPromptTemplate ?? null,
          model_id: input.modelId ?? null,
          platform: input.platform,
          features: serializeTextList(input.features),
          examples: serializeTextList(input.examples),
          preparation_questions: serializeTextList(input.userQuestions),
          icon: input.icon,
          image_url: input.imageUrl ?? null,
          badge_type: input.badgeType ?? null,
          badge_text: input.badgeText ?? null,
          credits_display: input.creditsDisplay ?? null,
          category: input.category,
          sort_order: input.sortOrder,
          is_featured: input.isFeatured,
          active: input.active,
          created_by: ctx.profileId,
        })
        .select()
        .single();

      if (error) {
        throw createAdminOperationError('创建功能模块', error);
      }

      return data;
    }),

  updatePrompt: adminProcedure
    .input(z.object({
      id: z.string().uuid(),
      name: z.string().min(1).max(100).optional(),
      description: z.string().max(500).nullable().optional(),
      fullDescription: z.string().max(5000).nullable().optional(),
      content: z.string().min(1).max(10000).optional(),
      systemPrompt: z.string().max(10000).nullable().optional(),
      userPromptTemplate: z.string().max(10000).nullable().optional(),
      modelId: z.string().uuid().nullable().optional(),
      platform: promptPlatformSchema.optional(),
      features: z.array(z.string()).nullable().optional(),
      examples: z.array(z.string()).nullable().optional(),
      userQuestions: z.array(z.string()).nullable().optional(),
      icon: z.string().max(50).optional(),
      imageUrl: z.string().max(1000).nullable().optional(),
      badgeType: moduleBadgeTypeSchema,
      badgeText: z.string().max(80).nullable().optional(),
      creditsDisplay: z.string().max(80).nullable().optional(),
      category: promptCategorySchema.optional(),
      sortOrder: z.number().int().min(0).max(1000).optional(),
      active: moduleBooleanSchema.optional(),
      isFeatured: moduleBooleanSchema.optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const updateData: Record<string, unknown> = {
        updated_at: new Date().toISOString(),
      };
      if (input.name !== undefined) updateData.title = input.name;
      if (input.description !== undefined) updateData.description = input.description;
      if (input.fullDescription !== undefined) updateData.full_description = input.fullDescription;
      if (input.content !== undefined) updateData.prompt_content = input.content;
      if (input.systemPrompt !== undefined) updateData.system_prompt = input.systemPrompt;
      if (input.userPromptTemplate !== undefined) updateData.user_prompt_template = input.userPromptTemplate;
      if (input.modelId !== undefined) updateData.model_id = input.modelId;
      if (input.platform !== undefined) updateData.platform = input.platform;
      if (input.features !== undefined) updateData.features = serializeTextList(input.features);
      if (input.examples !== undefined) updateData.examples = serializeTextList(input.examples);
      if (input.userQuestions !== undefined) updateData.preparation_questions = serializeTextList(input.userQuestions);
      if (input.icon !== undefined) updateData.icon = input.icon;
      if (input.imageUrl !== undefined) updateData.image_url = input.imageUrl;
      if (input.badgeType !== undefined) updateData.badge_type = input.badgeType;
      if (input.badgeText !== undefined) updateData.badge_text = input.badgeText;
      if (input.creditsDisplay !== undefined) updateData.credits_display = input.creditsDisplay;
      if (input.category !== undefined) updateData.category = input.category;
      if (input.sortOrder !== undefined) updateData.sort_order = input.sortOrder;
      if (input.active !== undefined) updateData.active = input.active;
      if (input.isFeatured !== undefined) updateData.is_featured = input.isFeatured;

      const { data, error } = await ctx.supabase
        .from('modules')
        .update(updateData)
        .eq('id', input.id)
        .select()
        .single();

      if (error) {
        throw createAdminOperationError('更新功能模块', error);
      }

      return data;
    }),

  batchUpdatePrompts: adminProcedure
    .input(z.object({
      ids: z.array(z.string().uuid()).min(1).max(100),
      patch: promptBatchPatchSchema,
    }))
    .mutation(async ({ ctx, input }) => {
      const updateData: Record<string, unknown> = {
        updated_at: new Date().toISOString(), ...(input.patch.requiredMemberLevel !== undefined && { required_member_level: input.patch.requiredMemberLevel }),
      };

      if (input.patch.description !== undefined) updateData.description = input.patch.description;
      if (input.patch.fullDescription !== undefined) updateData.full_description = input.patch.fullDescription;
      if (input.patch.content !== undefined) updateData.prompt_content = input.patch.content;
      if (input.patch.systemPrompt !== undefined) updateData.system_prompt = input.patch.systemPrompt;
      if (input.patch.userPromptTemplate !== undefined) updateData.user_prompt_template = input.patch.userPromptTemplate;
      if (input.patch.modelId !== undefined) updateData.model_id = input.patch.modelId;
      if (input.patch.platform !== undefined) updateData.platform = input.patch.platform;
      if (input.patch.features !== undefined) updateData.features = serializeTextList(input.patch.features);
      if (input.patch.examples !== undefined) updateData.examples = serializeTextList(input.patch.examples);
      if (input.patch.userQuestions !== undefined) updateData.preparation_questions = serializeTextList(input.patch.userQuestions);
      if (input.patch.icon !== undefined) updateData.icon = input.patch.icon;
      if (input.patch.imageUrl !== undefined) updateData.image_url = input.patch.imageUrl;
      if (input.patch.badgeType !== undefined) updateData.badge_type = input.patch.badgeType;
      if (input.patch.badgeText !== undefined) updateData.badge_text = input.patch.badgeText;
      if (input.patch.creditsDisplay !== undefined) updateData.credits_display = input.patch.creditsDisplay;
      if (input.patch.category !== undefined) updateData.category = input.patch.category;
      if (input.patch.sortOrder !== undefined) updateData.sort_order = input.patch.sortOrder;
      if (input.patch.isFeatured !== undefined) updateData.is_featured = input.patch.isFeatured;

      const { data, error } = await ctx.supabase
        .from('modules')
        .update(updateData)
        .in('id', input.ids)
        .select('id');

      if (error) {
        throw createAdminOperationError('批量更新功能模块', error);
      }

      return {
        updatedIds: (data ?? []).map((module) => module.id),
        updatedCount: data?.length ?? 0,
      };
    }),

  batchSetPromptActive: adminProcedure
    .input(z.object({
      ids: z.array(z.string().uuid()).min(1).max(100),
      active: z.boolean(),
    }))
    .mutation(async ({ ctx, input }) => {
      const { data, error } = await ctx.supabase
        .from('modules')
        .update({
          active: input.active,
          updated_at: new Date().toISOString(),
        })
        .in('id', input.ids)
        .select('id');

      if (error) {
        throw createAdminOperationError('批量启停功能模块', error);
      }

      return {
        updatedIds: (data ?? []).map((module) => module.id),
        updatedCount: data?.length ?? 0,
        active: input.active,
      };
    }),

  batchDeletePrompts: adminProcedure
    .input(z.object({
      ids: z.array(z.string().uuid()).min(1).max(100),
    }))
    .mutation(async ({ ctx, input }) => {
      const { data, error } = await ctx.supabase
        .from('modules')
        .update({
          active: false,
          updated_at: new Date().toISOString(),
        })
        .in('id', input.ids)
        .select('id');

      if (error) {
        throw createAdminOperationError('批量下架功能模块', error);
      }

      return {
        disabledIds: (data ?? []).map((module) => module.id),
        disabledCount: data?.length ?? 0,
      };
    }),

  removePrompts: adminProcedure
    .input(z.object({ ids: z.array(z.string().uuid()).min(1).max(100) }))
    .mutation(async ({ ctx, input }) => {
      // One statement keeps the batch atomic and lets existing foreign keys
      // protect references, including references created concurrently.
      const { data, error } = await ctx.supabase.from('modules')
        .delete().in('id', [...new Set(input.ids)]).select('id');
      if (error?.code === '23503') {
        throw new TRPCError({ code: 'CONFLICT', message: '选中的模块存在功能卡片、对话或项目引用，本次未删除任何模块。请取消选择被引用的模块，或使用下架。' });
      }
      if (error) throw createAdminOperationError('批量删除功能模块', error);
      return { success: true, deletedIds: (data ?? []).map(module => module.id) };
    }),

  removePrompt: adminProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      // Foreign keys prevent deleting modules used by conversations or Skill projects.
      const { data, error } = await ctx.supabase.from('modules')
        .delete().eq('id', input.id).select('id').maybeSingle();
      if (error?.code === '23503') {
        throw new TRPCError({ code: 'CONFLICT', message: '这个模块已被功能卡片、对话或 Skill 项目引用，不能删除。请使用下架，已有记录会保留。' });
      }
      if (error) throw createAdminOperationError('删除功能模块', error);
      return { success: true, deletedId: data?.id ?? input.id };
    }),
};
