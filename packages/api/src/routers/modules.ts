import { router, publicProcedure, protectedProcedure } from '../trpc';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import type { SupabaseClient } from '@supabase/supabase-js';

export const PUBLIC_MODULE_SELECT = [
  'id',
  'title',
  'description',
  'full_description',
  'icon',
  'category',
  'platform',
  'features',
  'examples',
  'preparation_questions',
  'usage_count',
  'credits_multiplier',
  'sort_order',
  'is_featured',
  'active',
  'created_at',
  'updated_at',
  'image_url',
  'badge_type',
  'badge_text',
  'credits_display',
  'link_url',
  'link_module_id',
].join(',');

export type PublicModule = {
  id: any;
  title: any;
  description: any;
  full_description: any;
  icon: any;
  category: any;
  platform: any;
  features: any;
  examples: any;
  preparation_questions: any;
  usage_count: any;
  credits_multiplier: any;
  sort_order: any;
  is_featured: any;
  active: any;
  created_at: any;
  updated_at: any;
  image_url?: any;
  badge_type?: any;
  badge_text?: any;
  credits_display?: any;
  link_url?: any;
  link_module_id?: any;
};

export function toPublicModule(module: any): PublicModule {
  return {
    id: module.id,
    title: module.title,
    description: module.description,
    full_description: module.full_description,
    icon: module.icon,
    category: module.category,
    platform: module.platform,
    features: module.features,
    examples: module.examples,
    preparation_questions: module.preparation_questions,
    usage_count: module.usage_count,
    credits_multiplier: module.credits_multiplier,
    sort_order: module.sort_order,
    is_featured: module.is_featured,
    active: module.active,
    created_at: module.created_at,
    updated_at: module.updated_at,
    image_url: module.image_url,
    badge_type: module.badge_type,
    badge_text: module.badge_text,
    credits_display: module.credits_display,
    link_url: module.link_url,
    link_module_id: module.link_module_id,
  };
}

export function getPublicReadClient(ctx: {
  supabase: SupabaseClient<any, 'public', any>;
  supabasePublic: SupabaseClient<any, 'public', any>;
  supabaseAdmin: SupabaseClient<any, 'public', any>;
  hasSupabaseAdminPrivileges: boolean;
}) {
  return ctx.supabasePublic ?? ctx.supabase;
}

export const modulesRouter = router({
  /**
   * Get all active modules (public endpoint)
   */
  getModules: publicProcedure
    .input(z.object({
      category: z.string().optional(),
      limit: z.number().min(1).max(100).default(50),
      offset: z.number().min(0).default(0),
      sortBy: z.enum(['newest', 'popular']).default('newest'),
    }).optional())
    .query(async ({ ctx, input }) => {
      const { category, limit = 50, offset = 0, sortBy = 'newest' } = input ?? {};
      const readClient = getPublicReadClient(ctx);

      let query = readClient
        .from('modules')
        .select(PUBLIC_MODULE_SELECT, { count: 'exact' })
        .eq('active', 'true');

      // Apply category filter
      if (category && category !== 'all') {
        if (category === 'other') {
          query = query.eq('category', 'other');
        } else {
          query = query.eq('category', category);
        }
      }

      // Apply sorting
      if (sortBy === 'popular') {
        query = query.order('usage_count', { ascending: false });
      } else {
        query = query.order('created_at', { ascending: false });
      }

      // Apply pagination
      query = query.range(offset, offset + limit - 1);

      const { data: modules, error, count } = await query;

      if (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: '获取模块列表失败',
          cause: error,
        });
      }

      return {
        modules: (modules ?? []).map((module) => toPublicModule(module)),
        total: count ?? 0,
        hasMore: (count ?? 0) > offset + limit,
      };
    }),

  /**
   * Get featured modules (public endpoint)
   */
  getFeaturedModules: publicProcedure
    .input(z.object({
      limit: z.number().min(1).max(10).default(4),
    }).optional())
    .query(async ({ ctx, input }) => {
      const { limit = 4 } = input ?? {};
      const readClient = getPublicReadClient(ctx);

      const { data: modules, error } = await readClient
        .from('modules')
        .select(PUBLIC_MODULE_SELECT)
        .eq('active', 'true')
        .eq('is_featured', 'true')
        .order('sort_order', { ascending: true })
        .limit(limit);

      if (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: '获取精选模块失败',
          cause: error,
        });
      }

      return (modules ?? []).map((module) => toPublicModule(module));
    }),

  /**
   * Get module by ID (public endpoint)
   */
  getModuleById: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const readClient = getPublicReadClient(ctx);
      const { data: module, error } = await readClient
        .from('modules')
        .select(PUBLIC_MODULE_SELECT)
        .eq('id', input.id)
        .eq('active', 'true')
        .single();

      if (error || !module) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: '模块不存在',
        });
      }

      return toPublicModule(module);
    }),

  /**
   * Increment module usage count (protected endpoint)
   */
  incrementUsage: protectedProcedure
    .input(z.object({ moduleId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const { error } = await ctx.supabase.rpc('increment_module_usage', {
        module_id: input.moduleId,
      });

      // If RPC doesn't exist, fall back to manual increment
      if (error) {
        const { data: module } = await ctx.supabase
          .from('modules')
          .select('usage_count')
          .eq('id', input.moduleId)
          .single();

        if (module) {
          await ctx.supabase
            .from('modules')
            .update({ usage_count: (module.usage_count ?? 0) + 1 })
            .eq('id', input.moduleId);
        }
      }

      return { success: true };
    }),
});
