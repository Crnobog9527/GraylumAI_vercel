import { router, publicProcedure, protectedProcedure } from '../trpc';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';

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

      let query = ctx.supabase
        .from('modules')
        .select('*', { count: 'exact' })
        .eq('active', true);

      // Apply category filter
      if (category && category !== 'all') {
        if (category === 'other') {
          // 'other' includes misc categories
          query = query.in('category', ['tool', 'analysis', 'coding', 'creative', 'audio', 'other']);
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
        modules: modules ?? [],
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

      const { data: modules, error } = await ctx.supabase
        .from('modules')
        .select('*')
        .eq('active', true)
        .eq('is_featured', true)
        .order('sort_order', { ascending: true })
        .limit(limit);

      if (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: '获取精选模块失败',
          cause: error,
        });
      }

      return modules ?? [];
    }),

  /**
   * Get module by ID (public endpoint)
   */
  getModuleById: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const { data: module, error } = await ctx.supabase
        .from('modules')
        .select('*')
        .eq('id', input.id)
        .eq('active', true)
        .single();

      if (error || !module) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: '模块不存在',
        });
      }

      return module;
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
